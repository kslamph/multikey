/**
 * KeyPool: per-pool API key state, lease acquisition, cooldowns, stats.
 *
 * Selection policy: among enabled keys not in cooldown, pick the one with the
 * fewest in-flight requests, tie-broken by least-recently-used. This spreads
 * concurrent subagents across different keys automatically.
 */

import type { KeyCredential, PoolConfig } from "./config.ts";
import { maskKey } from "./config.ts";

export type KeyOutcome = "ok" | "rate_limited" | "quota_exhausted" | "invalid" | "error";

export interface Lease {
	key: string;
	label: string;
	acquiredAt: number;
	/** OAuth credential behind this key, when it has one (Cline accounts). */
	credential?: KeyCredential;
}

interface KeyStat {
	ok: number;
	rateLimited: number;
	quotaLimited: number;
	invalid: number;
	errors: number;
	inflight: number;
	cooldownUntil: number;
	cooldownReason?: string;
	lastUsed: number;
}

function newStat(): KeyStat {
	return { ok: 0, rateLimited: 0, quotaLimited: 0, invalid: 0, errors: 0, inflight: 0, cooldownUntil: 0, lastUsed: 0 };
}

export class KeyPool {
	config: PoolConfig;
	private stats = new Map<string, KeyStat>();

	constructor(config: PoolConfig) {
		this.config = config;
	}

	private stat(key: string): KeyStat {
		let s = this.stats.get(key);
		if (!s) {
			s = newStat();
			this.stats.set(key, s);
		}
		return s;
	}

	private enabledKeys(): { key: string; label: string; credential?: KeyCredential }[] {
		return this.config.keys
			.filter((k) => k.enabled !== false)
			.map((k) => ({ key: k.key, label: k.label ?? maskKey(k.key), credential: k.credential }));
	}

	get size(): number {
		return this.enabledKeys().length;
	}

	mask(key: string): string {
		return maskKey(key);
	}

	/** Replace config in place (keeps live stats). */
	updateConfig(config: PoolConfig): void {
		Object.assign(this.config, config);
	}

	/**
	 * Acquire a key lease. If every key is in cooldown, waits (signal-aware)
	 * until the earliest cooldown expires, then acquires that key.
	 */
	async acquire(signal?: AbortSignal): Promise<Lease> {
		for (;;) {
			if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
			const now = Date.now();
			const candidates = this.enabledKeys()
				.map((entry) => ({ ...entry, stat: this.stat(entry.key) }))
				.filter((entry) => entry.stat.cooldownUntil <= now);

			if (candidates.length > 0) {
				candidates.sort((a, b) => a.stat.inflight - b.stat.inflight || a.stat.lastUsed - b.stat.lastUsed);
				const chosen = candidates[0]!;
				chosen.stat.inflight++;
				chosen.stat.lastUsed = now;
				return { key: chosen.key, label: chosen.label, acquiredAt: now, credential: chosen.credential };
			}

			// All keys cooling: wait for the earliest recovery (bounded to 60s).
			const cooldowns = this.enabledKeys().map((entry) => this.stat(entry.key).cooldownUntil);
			const earliest = Math.min(...cooldowns);
			const waitMs = Math.max(250, Math.min(earliest - now, 60_000));
			await this.sleep(waitMs, signal);
		}
	}

	release(lease: Lease): void {
		const s = this.stat(lease.key);
		s.inflight = Math.max(0, s.inflight - 1);
	}

	report(lease: Lease, outcome: KeyOutcome, cooldownMs?: number): void {
		const s = this.stat(lease.key);
		const now = Date.now();
		switch (outcome) {
			case "ok":
				s.ok++;
				s.cooldownUntil = 0;
				s.cooldownReason = undefined;
				break;
			case "rate_limited":
				s.rateLimited++;
				s.cooldownUntil = Math.max(s.cooldownUntil, now + (cooldownMs ?? this.config.cooldownMs ?? 20_000));
				s.cooldownReason = "429";
				break;
			case "quota_exhausted":
				// Daily per-account quota (Cline free models): the server tells us when
				// it resets ("Try again in 23h 59m"), so the cooldown is hours, not the
				// 20s rate-limit rotation. A sane fallback if the parse ever fails.
				s.quotaLimited++;
				s.cooldownUntil = Math.max(s.cooldownUntil, now + (cooldownMs ?? 30 * 60_000));
				s.cooldownReason = "daily limit";
				break;
			case "invalid":
				s.invalid++;
				s.cooldownUntil = Math.max(s.cooldownUntil, now + (this.config.invalidKeyCooldownMs ?? 600_000));
				s.cooldownReason = "invalid";
				break;
			case "error":
				s.errors++;
				break;
		}
	}

	private sleep(ms: number, signal?: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			const onAbort = () => {
				clearTimeout(timer);
				reject(new DOMException("Aborted", "AbortError"));
			};
			if (signal) {
				if (signal.aborted) {
					clearTimeout(timer);
					reject(new DOMException("Aborted", "AbortError"));
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			}
		});
	}

	/**
	 * Persist a refreshed OAuth credential onto the key's config entry (the
	 * access token also becomes the key value so every consumer sees the same
	 * token). Live stats move with the rotation — they are keyed by the key
	 * string, so the entry's counters (including its in-flight count) must be
	 * re-keyed to the new token. The caller saves the config to disk.
	 */
	applyClineCredential(lease: Lease, update: { accessToken: string; refreshToken: string; expiresAt?: number }): void {
		const entry = this.config.keys.find(
			(k) => k.credential === lease.credential || (k.credential && lease.credential && k.credential.refreshToken === lease.credential.refreshToken),
		);
		if (!entry?.credential) return;
		const oldKey = entry.key;
		entry.credential.refreshToken = update.refreshToken;
		entry.credential.accessToken = update.accessToken;
		entry.credential.expiresAt = update.expiresAt;
		entry.key = update.accessToken;
		if (oldKey !== update.accessToken) {
			const stat = this.stats.get(oldKey);
			if (stat) {
				this.stats.delete(oldKey);
				this.stats.set(update.accessToken, stat);
			}
		}
		lease.key = update.accessToken;
		lease.credential = entry.credential;
	}

	/** One row per configured key, for TUI status display. */
	statusRows(): {
		label: string;
		masked: string;
		enabled: boolean;
		inflight: number;
		ok: number;
		rateLimited: number;
		quotaLimited: number;
		invalid: number;
		errors: number;
		cooldownRemainingMs: number;
		cooldownReason?: string;
		credential?: KeyCredential;
	}[] {
		const now = Date.now();
		return this.config.keys.map((k) => {
			const s = this.stat(k.key);
			return {
				label: k.label ?? maskKey(k.key),
				masked: maskKey(k.key),
				enabled: k.enabled !== false,
				inflight: s.inflight,
				ok: s.ok,
				rateLimited: s.rateLimited,
				quotaLimited: s.quotaLimited,
				invalid: s.invalid,
				errors: s.errors,
				cooldownRemainingMs: Math.max(0, s.cooldownUntil - now),
				cooldownReason: s.cooldownReason,
				credential: k.credential,
			};
		});
	}
}
