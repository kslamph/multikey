/**
 * Rotating streamSimple: wraps the underlying pi-ai API implementation, picks a
 * key from the pool for every request, and transparently retries on 429/401/403
 * with the next key (marking a cooldown on the failed key). OAuth-backed keys
 * (Cline accounts) refresh their access token pre-request and on 401, and a
 * Cline daily-quota 429 cools the key down until the server-reported reset
 * time instead of triggering normal rotation.
 *
 * Events are only relayed to the caller once the attempt is known to be healthy,
 * so a rotated attempt never produces duplicate/partial output.
 */

import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Api,
	type Context,
	createAssistantMessageEventStream,
	getApiProvider,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { KeyOutcome, KeyPool, Lease } from "./pool.ts";
import { endpointIdentityHeaders } from "./config.ts";
import { ensureClineAccessToken } from "./cline-auth.ts";

const RATE_LIMIT_RE = /\b429\b|rate\s*limit|too many requests|quota\s*(exceed|limit)|requests per minute|requests per day/i;
const INVALID_KEY_RE = /\b40[13]\b|unauthorized|forbidden|invalid\s*(api\s*)?key|incorrect\s*(api\s*)?key|authentication/i;
/**
 * Cline free models enforce a daily per-account quota and answer with
 * `"Daily free limit reached on model X. Try again in 23h 59m"`. This is NOT
 * a rotation-worthy 429 — the cooldown is the server-reported reset time.
 */
const CLINE_QUOTA_RE = /free limit reached on model/i;
const CLINE_RESET_RE = /try again in\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i;

/** Parse the "Try again in Xh Ym Zs" countdown from a Cline quota 429 body. */
export function parseClineQuotaResetMs(message: string): number | undefined {
	const match = CLINE_RESET_RE.exec(message.toLowerCase());
	if (!match) return undefined;
	const hours = Number(match[1] ?? 0);
	const minutes = Number(match[2] ?? 0);
	const seconds = Number(match[3] ?? 0);
	const ms = hours * 3_600_000 + minutes * 60_000 + seconds * 1000;
	return ms > 0 ? ms : undefined;
}

interface CapturedResponse {
	status: number;
	retryAfterMs?: number;
}

export type Notifier = (message: string) => void;

export function createRotatingStreamSimple(pool: KeyPool, apiName: string, notify: Notifier, onConfigDirty?: () => void) {
	const impl = getApiProvider(apiName as Api);
	if (!impl) throw new Error(`multikey: no API provider registered for api: ${apiName}`);
	// Auth style: "api-key" providers want the key in x-api-key (some reject
	// Authorization entirely); bearer is the pi-ai default and needs no help.
	const authStyle = pool.config.auth ?? "bearer";

	return function rotatingStreamSimple(
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream {
		const out = createAssistantMessageEventStream();

		void (async () => {
			const maxAttempts = Math.max(1, pool.size);
			let lastProblem = "no attempts made";

			for (let attempt = 0; attempt < maxAttempts; attempt++) {
				let lease: Lease;
				// One forced-token-refresh retry per acquired lease (401 → refresh → retry).
				let refreshedForLease = false;
				try {
					lease = await pool.acquire(options?.signal);
				} catch {
					emitAborted(out, model);
					return;
				}
				// OAuth-backed keys (Cline accounts) don't carry a static key: mint a
				// fresh access token from the stored refresh token before every request.
				let apiKey = lease.key;
				if (lease.credential?.kind === "cline-oauth") {
					try {
						const fresh = await ensureClineAccessToken(lease.credential);
						if (fresh.refreshed) {
							pool.applyClineCredential(lease, fresh);
							onConfigDirty?.();
						}
						apiKey = fresh.accessToken;
					} catch (error) {
						// The stale token may still work; if not, the 401 path below
						// force-refreshes once before giving up on this key.
						notify(
							`multikey[${pool.config.id}]: token refresh failed on ${lease.label} (${error instanceof Error ? error.message : String(error)}) — trying stored token`,
						);
					}
				}

				try {
					const captured: CapturedResponse = { status: 0 };
					// Identity headers (session / device) are per-request, so they are merged
					// here rather than baked into the provider registration. Providers apply
					// options.headers last, so these win over the static pool headers.
					const identityBaseUrl = model.baseUrl || pool.config.baseUrl;
					const attemptOptions: SimpleStreamOptions = {
						...options,
						apiKey,
						headers: {
							...options?.headers,
							...endpointIdentityHeaders(identityBaseUrl),
							...(authStyle === "api-key" ? { "x-api-key": apiKey } : {}),
						},
						onResponse: (response) => {
							captured.status = response.status;
							const ra = response.headers?.["retry-after"];
							const seconds = typeof ra === "string" ? Number(ra) : Number.NaN;
							if (Number.isFinite(seconds) && seconds > 0) captured.retryAfterMs = seconds * 1000;
						},
					};

					const sub = impl.streamSimple(model, context, attemptOptions);
					const verdict = await pump(sub, out, captured);

					if (verdict.kind === "completed") {
						pool.report(lease, "ok");
						return;
					}

					// Attempt failed. Only rotate when nothing was relayed yet; if content
					// already streamed, the failure is surfaced as-is (mid-stream 429 is rare).
					if (verdict.kind === "rotate" && !verdict.relayedAny) {
						// 401 on an OAuth key usually means an expired access token: force a
						// refresh and retry the same account once, without burning a rotation.
						if (
							verdict.outcome === "invalid" &&
							lease.credential?.kind === "cline-oauth" &&
							!refreshedForLease
						) {
							refreshedForLease = true;
							try {
								const fresh = await ensureClineAccessToken(lease.credential, { force: true });
								pool.applyClineCredential(lease, fresh);
								onConfigDirty?.();
								notify(`multikey[${pool.config.id}]: 401 on ${lease.label} — Cline token refreshed, retrying`);
								attempt--; // retry the same key; the request never got going
								continue;
							} catch (error) {
								notify(
									`multikey[${pool.config.id}]: Cline token refresh failed on ${lease.label} (${error instanceof Error ? error.message : String(error)})`,
								);
							}
						}
						lastProblem = verdict.problem;
						pool.report(lease, verdict.outcome, verdict.cooldownMs);
						notify(
							`multikey[${pool.config.id}]: ${describeOutcome(verdict.outcome)} on ${lease.label} (${pool.mask(lease.key)}), rotating to another key`,
						);
						continue;
					}

					// Non-rotatable failure relayed to caller already.
					pool.report(lease, verdict.kind === "rotate" ? verdict.outcome : "error");
					return;
				} catch (error) {
					if (options?.signal?.aborted) {
						emitAborted(out, model);
						return;
					}
					pool.report(lease, "error");
					lastProblem = error instanceof Error ? error.message : String(error);
					notify(`multikey[${pool.config.id}]: request error on ${lease.label}, trying another key`);
				} finally {
					pool.release(lease);
				}
			}

			// All keys exhausted — surface a rate-limit-flavored error so pi's own
			// retry/backoff kicks in; by then some cooldowns have expired.
			emitError(out, model, `multikey[${pool.config.id}]: all ${maxAttempts} keys exhausted (last: ${lastProblem})`);
		})();

		return out;
	};
}

type Verdict =
	| { kind: "completed" }
	| { kind: "rotate"; outcome: KeyOutcome; problem: string; cooldownMs?: number; relayedAny: boolean }
	| { kind: "failed"; relayedAny: boolean };

/**
 * Relay events from `sub` into `out`. Buffer the initial "start" event until we
 * know the HTTP status, so a 429 attempt can be dropped without the caller ever
 * seeing it.
 */
async function pump(
	sub: AsyncIterable<AssistantMessageEvent>,
	out: AssistantMessageEventStream,
	captured: CapturedResponse,
): Promise<Verdict> {
	const buffered: AssistantMessageEvent[] = [];
	let relayedAny = false;

	for await (const event of sub) {
		if (event.type === "done") {
			flush(buffered, out);
			out.push(event);
			out.end();
			return { kind: "completed" };
		}

		if (event.type === "error") {
			const problem = event.error?.errorMessage ?? "unknown provider error";
			const rotation = classify(problem, captured);
			if (rotation && !relayedAny) {
				return { kind: "rotate", outcome: rotation.outcome, problem, cooldownMs: rotation.cooldownMs, relayedAny };
			}
			flush(buffered, out);
			out.push(event);
			out.end();
			return { kind: "failed", relayedAny };
		}

		if (!relayedAny) {
			if (captured.status !== 0) {
				const rotation = classifyStatus(captured);
				if (rotation) {
					return { kind: "rotate", outcome: rotation.outcome, problem: `HTTP ${captured.status}`, cooldownMs: rotation.cooldownMs, relayedAny };
				}
				flush(buffered, out);
				out.push(event);
				relayedAny = true;
				continue;
			}
			// Response headers not seen yet: buffer (this can only be "start").
			buffered.push(event);
			continue;
		}

		out.push(event);
	}

	// Stream ended without done/error (should not happen) — treat as failure.
	if (!relayedAny && buffered.length === 0) {
		return { kind: "rotate", outcome: "error", problem: "stream ended without events", relayedAny };
	}
	flush(buffered, out);
	out.end();
	return { kind: "failed", relayedAny: true };
}

function flush(buffered: AssistantMessageEvent[], out: AssistantMessageEventStream): void {
	for (const event of buffered) out.push(event);
	buffered.length = 0;
}

function classifyStatus(
	captured: CapturedResponse,
): { outcome: KeyOutcome; cooldownMs?: number } | undefined {
	if (captured.status === 429) return { outcome: "rate_limited", cooldownMs: captured.retryAfterMs };
	if (captured.status === 401 || captured.status === 403) return { outcome: "invalid" };
	return undefined;
}

function classify(
	message: string,
	captured: CapturedResponse,
): { outcome: KeyOutcome; cooldownMs?: number } | undefined {
	// Quota marker wins over the generic 429/status rules: the reset countdown
	// in the body is the real cooldown, not the retry-after header.
	if (CLINE_QUOTA_RE.test(message)) {
		return { outcome: "quota_exhausted", cooldownMs: parseClineQuotaResetMs(message) };
	}
	const fromStatus = classifyStatus(captured);
	if (fromStatus) return fromStatus;
	if (RATE_LIMIT_RE.test(message)) return { outcome: "rate_limited" };
	if (INVALID_KEY_RE.test(message)) return { outcome: "invalid" };
	return undefined;
}

/** Short human label for a rotation notify line. */
function describeOutcome(outcome: KeyOutcome): string {
	switch (outcome) {
		case "rate_limited":
			return "429";
		case "quota_exhausted":
			return "daily free limit reached";
		case "invalid":
			return "auth error";
		default:
			return "error";
	}
}

function baseMessage(model: Model<Api>, stopReason: "error" | "aborted", errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
}

function emitError(out: AssistantMessageEventStream, model: Model<Api>, message: string): void {
	out.push({ type: "error", reason: "error", error: baseMessage(model, "error", message) });
	out.end();
}

function emitAborted(out: AssistantMessageEventStream, model: Model<Api>): void {
	out.push({ type: "error", reason: "aborted", error: baseMessage(model, "aborted") });
	out.end();
}
