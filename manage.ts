/**
 * /multikey management menus: pools, keys, models, settings — better-custom style.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getApiProvider, type Api } from "@earendil-works/pi-ai";
import {
	configPath,
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_INPUT,
	DEFAULT_MAX_TOKENS,
	isClineEndpoint,
	KNOWN_API_TYPES,
	maskKey,
	type KeypoolConfig,
	type KeyCredential,
	type PoolConfig,
	type PoolKeyConfig,
	type PoolModelConfig,
} from "./config.ts";
import type { KeyPool } from "./pool.ts";
import { PRESETS, findPreset, poolFromPreset, presetFingerprint, diffPresetModels, describePresetDiff, type Preset, type PresetModelDiff } from "./presets.ts";
import { probeEndpoint, type ProbeResult, type RemoteModel } from "./probe.ts";
import { spawn } from "node:child_process";
import { describeClineCredential, ensureClineAccessToken, formatClineAccessToken, loginClineDeviceFlow } from "./cline-auth.ts";
import { inputNumber, pickMany, selectOne, showInfo, showInfoWithHandle, withProgress, type InfoPanelHandle } from "./tui.ts";

type CommandContext = Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1];

export interface ManagerHooks {
	config: KeypoolConfig;
	pools: Map<string, KeyPool>;
	saveAndReregister(poolId: string): void;
	removePool(poolId: string): void;
	reloadFromDisk(): void;
	/** Persist the current config without re-registering (preset sync bookkeeping). */
	saveConfig(): void;
	notify(message: string): void;
}

const DEFAULT_MODEL_TEMPLATE: PoolModelConfig = {
	id: "new-model",
	name: "new-model",
	reasoning: true,
	input: DEFAULT_INPUT,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: DEFAULT_CONTEXT_WINDOW,
	maxTokens: DEFAULT_MAX_TOKENS,
};

/** True when the pool's api names a registered pi-ai streaming implementation. */
function isKnownApi(api: string | undefined): boolean {
	return getApiProvider((api ?? "openai-completions") as Api) !== undefined;
}

function firstEnabledKey(pool: PoolConfig): string | undefined {
	return pool.keys.find((k) => k.enabled !== false)?.key;
}

/** Convert a probed remote model into a pool model, filling safe defaults. */
function remoteToPoolModel(remote: RemoteModel): PoolModelConfig {
	return {
		...DEFAULT_MODEL_TEMPLATE,
		id: remote.id,
		name: remote.name ?? remote.id,
		contextWindow: remote.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: remote.maxTokens ?? DEFAULT_MAX_TOKENS,
		input: remote.input ?? DEFAULT_INPUT,
	};
}

function describeRemote(m: RemoteModel): string {
	const bits: string[] = [];
	if (m.contextWindow) bits.push(`ctx ${(m.contextWindow / 1000).toLocaleString()}k`);
	if (m.input?.includes("image")) bits.push("image in");
	if (m.reasoning === true) bits.push("reasoning");
	return bits.join(" · ");
}

function describeAuth(probe: ProbeResult): string {
	if (probe.authStatus === "confirmed") {
		return probe.auth === "bearer" ? "key verified via Authorization: Bearer ✓" : "key verified via x-api-key ✓";
	}
	if (probe.authStatus === "rejected") return "⚠ endpoint rejected the key (401/403) — double-check it";
	return probe.auth === "bearer"
		? "endpoint did not verify the key (open endpoint) — using default Bearer auth"
		: "using x-api-key auth (could not fully verify)";
}

// ---------------------------------------------------------------------------
// Cline account credentials (device flow sign-in + pasted tokens)
// ---------------------------------------------------------------------------

/** Humanize a duration for display: 90s+ → minutes, 90m+ → hours. */
function formatCooldown(ms: number): string {
	if (ms < 90_000) return `${Math.ceil(ms / 1000)}s`;
	if (ms < 90 * 60_000) return `${Math.ceil(ms / 60_000)}m`;
	return `${Math.ceil(ms / 3_600_000)}h`;
}

/**
 * Best-effort browser open for device-flow verification URLs. Never throws;
 * a missing opener only means the user has to paste the URL manually (the
 * auth panel always shows the URL as a fallback).
 */
function tryOpenBrowser(url: string): boolean {
	const platform = process.platform;
	const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
	const args = platform === "win32" ? ["/c", "start", "", url] : [url];
	try {
		const child = spawn(cmd, args, { stdio: "ignore", detached: true });
		child.on("error", () => {}); // opener missing — the panel shows the URL anyway
		child.unref();
		return true;
	} catch {
		return false;
	}
}

/**
 * Collect a Cline account credential: the WorkOS device flow (recommended —
 * refresh tokens keep the access token alive) or a manually pasted access
 * token (works until it expires). Returns one key entry, or undefined on cancel.
 */
async function collectClineKeys(ctx: CommandContext, hooks: ManagerHooks): Promise<PoolKeyConfig[] | undefined> {
	const how = await selectOne(ctx, "Cline credentials", [
		{
			value: "device",
			label: "Sign in with Cline (device flow)…",
			description: "Authorize your Cline account in the browser; the token refreshes automatically",
		},
		{
			value: "paste",
			label: "Paste a Cline access token…",
			description: "From ~/.cline/data/secrets.json — stops working when it expires",
		},
	]);
	if (how === "device") {
		let credential: KeyCredential;
		let panel: InfoPanelHandle | undefined;
		try {
			// withProgress swallows task errors and resolves undefined, so capture
			// the real error here and rethrow it below — `undefined` tokens used to
			// crash with "cannot read properties of undefined" and mask the failure.
			let loginError: unknown;
			const tokens = await withProgress(ctx, "Cline sign-in", async (update) => {
				try {
					return await loginClineDeviceFlow({
							onAuthInfo: async ({ url, userCode }) => {
								const opened = tryOpenBrowser(url);
								panel = showInfoWithHandle(ctx, "Authorize Cline", [
									opened
										? "A browser window should have opened — approve the sign-in there."
										: "Open this URL in your browser and approve the sign-in:",
									"",
									...(opened ? ["If no window opened, paste this URL:", url] : [url]),
									"",
									`User code: ${userCode}`,
									"",
									"Sign-in continues automatically once you approve — you can dismiss this panel any time.",
								]);
								await panel.closed;
							},
						onAuthorized: () => {
							update("Browser authorization confirmed — exchanging tokens…");
							panel?.close();
						},
						onProgress: (message) => update(message),
					});
				} catch (error) {
					loginError = error;
					throw error;
				}
			});
			if (!tokens) throw loginError ?? new Error("Cline sign-in failed");
			// Store the access token with Cline's required "workos:" prefix (same
			// convention as the official CLI's providers.json); formatting is
			// idempotent, so the request path can safely format again.
			const accessToken = formatClineAccessToken(tokens.accessToken);
			credential = {
				kind: "cline-oauth",
				refreshToken: tokens.refreshToken,
				accessToken,
				expiresAt: tokens.expiresAt,
			};
		} catch (error) {
			await showInfo(ctx, "Cline sign-in failed", [error instanceof Error ? error.message : String(error)]);
			return undefined;
		} finally {
			panel?.close();
		}
		return [{ key: formatClineAccessToken(credential.accessToken ?? credential.refreshToken), label: "cline-account", enabled: true, credential }];
	}
	if (how === "paste") {
		const raw = await ctx.ui.input("Cline access token", "paste the token");
		const value = raw?.trim();
		if (!value) return undefined;
		// Cline's API rejects raw JWTs — the access token must carry the
		// "workos:" prefix (formatClineAccessToken is idempotent).
		return [{ key: formatClineAccessToken(value), label: "cline-account", enabled: true }];
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Preset sync: offer to align preset-created pools with updated presets
// ---------------------------------------------------------------------------

interface PresetDrift {
	pool: PoolConfig;
	preset: Preset;
	diff: PresetModelDiff;
	/** Stored fingerprint differs from the shipped preset — the ask-once trigger. */
	fingerprintStale: boolean;
	/** Matched by baseUrl only (pool created before preset tracking existed). */
	legacy: boolean;
}

function hasModelDiff(diff: PresetModelDiff | undefined): boolean {
	return !!diff && (diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0);
}

/**
 * Resolve the shipped preset a pool belongs to (via the `_preset` marker, or
 * by baseUrl for legacy pools created before tracking existed) and diff its
 * current models against the preset.
 *
 * The marker's fingerprint is written at pool creation and again the moment a
 * startup prompt is displayed — so each preset version is asked about at most
 * once, and declining only mutes the current version (a later preset change
 * prompts again). Hand-tuning models never triggers the automatic prompt;
 * those pools stay reachable via /multikey → Check preset updates.
 */
function presetDrift(pool: PoolConfig): PresetDrift | undefined {
	const preset = pool._preset ? findPreset(pool._preset.id) : PRESETS.find((p) => p.baseUrl === pool.baseUrl);
	if (!preset) return undefined;
	const fingerprintStale = !pool._preset || pool._preset.fingerprint !== presetFingerprint(preset);
	return { pool, preset, diff: diffPresetModels(pool.models, preset.models), fingerprintStale, legacy: !pool._preset };
}

function presetDriftPools(config: KeypoolConfig): PresetDrift[] {
	return config.pools.map(presetDrift).filter((d): d is PresetDrift => !!d);
}

/**
 * Replace the pool's models with the preset's (deep copy) and stamp the
 * marker with the preset's current fingerprint. Keys, cooldowns, id, and
 * endpoint are untouched; afterwards the provider is re-registered.
 */
function applyPresetModels(hooks: ManagerHooks, pool: PoolConfig, preset: Preset): void {
	pool.models = JSON.parse(JSON.stringify(preset.models)) as PoolModelConfig[];
	pool._preset = { id: preset.id, fingerprint: presetFingerprint(preset) };
	hooks.saveAndReregister(pool.id);
}

/**
 * Startup hook: asks once per preset version when shipped presets moved on
 * from what a pool was created/aligned with. The offered fingerprint is
 * persisted before the dialog shows, so declining — or the process dying
 * mid-prompt — never causes a repeat for the same version.
 */
export async function maybeOfferPresetUpdates(hooks: ManagerHooks, ctx: CommandContext): Promise<void> {
	try {
		const stale = presetDriftPools(hooks.config).filter((d) => d.fingerprintStale);
		if (stale.length === 0) return;
		// Persist-on-display: mute this exact preset version before any dialog.
		for (const { pool, preset } of stale) pool._preset = { id: preset.id, fingerprint: presetFingerprint(preset) };
		hooks.saveConfig();
		// Reorder-only drift (no model differences): silently refreshed above.
		const actionable = stale.filter((d) => hasModelDiff(d.diff));
		if (actionable.length === 0) return;
		const summary = actionable.map((d) => `"${d.pool.id}" (${d.preset.name})`).join(", ");
		const ok = await ctx.ui.confirm(
			"Preset update available",
			`Built-in presets changed for pool(s): ${summary}. Review and align now? ` +
				"(Asked once per preset version; /multikey → Check preset updates always works.)",
		);
		if (ok) await checkPresetUpdatesMenu(ctx, hooks);
	} catch {
		// Never break session startup over the sync hint.
	}
}

/**
 * /multikey → Check preset updates: lists every pool whose model list differs
 * from its (tracked or baseUrl-matched) preset — always visible, regardless
 * of muting, so declined updates stay reachable.
 */
export async function checkPresetUpdatesMenu(ctx: CommandContext, hooks: ManagerHooks): Promise<void> {
	for (;;) {
		const drifts = presetDriftPools(hooks.config).filter((d) => hasModelDiff(d.diff));
		if (drifts.length === 0) {
			await showInfo(ctx, "Preset updates", [
				"All pools match the current built-in presets.",
				"",
				"Pools created from a preset are tracked; pools that predate tracking",
				"are matched by baseUrl.",
			]);
			return;
		}
		const action = await selectOne(
			ctx,
			"Pools differing from their preset",
			drifts.map(({ pool, preset, diff }) => ({
				value: pool.id,
				label: `${pool.id} ← ${preset.name}`,
				suffix: "  (differs)",
				description: describePresetDiff(diff).join("\n"),
			})),
		);
		if (action === null) return;
		const drift = drifts.find((d) => d.pool.id === action);
		if (drift) await offerPoolAlignment(ctx, hooks, drift);
	}
}

/** Show the diff for one pool and ask whether to align. */
async function offerPoolAlignment(ctx: CommandContext, hooks: ManagerHooks, drift: PresetDrift): Promise<void> {
	const { pool, preset, diff } = drift;
	const choice = await selectOne(ctx, `Align "${pool.id}" with ${preset.name} preset?`, [
		{
			value: "align",
			label: "Align — apply preset models",
			description:
				[...describePresetDiff(diff), "", `Result: ${preset.models.map((m) => m.id).join(", ")}`, "Keys, endpoint and settings are untouched."].join("\n"),
		},
		{
			value: "keep",
			label: "Keep my models",
			description: drift.fingerprintStale
				? "No automatic prompt for this preset version; revisit via Check preset updates."
				: "Your models are kept (preset hasn't changed since the last sync).",
		},
	]);
	if (choice === "align") {
		applyPresetModels(hooks, pool, preset);
		hooks.notify(`multikey[${pool.id}]: aligned with ${preset.name} preset — ${pool.models.length} models`);
	} else if (choice === "keep" && drift.fingerprintStale) {
		// Seen-and-kept: mute this preset version's automatic prompt.
		pool._preset = { id: preset.id, fingerprint: presetFingerprint(preset) };
		hooks.saveConfig();
	}
}

export async function runManager(pi: ExtensionAPI, ctx: CommandContext, hooks: ManagerHooks): Promise<void> {
	for (;;) {
		const pools = hooks.config.pools;
		const action = await selectOne(ctx, "Multikey", [
			{ value: "status", label: "Status", description: "Live per-key state: in-flight, cooldowns, 429 counts" },
			{ value: "manage", label: "Manage pools…", description: "Keys, models, endpoints, cooldowns" },
			{ value: "add", label: "Add pool…", description: "Register another provider (b.ai, nvidia, opencode, …)" },
			{ value: "presetsync", label: "Check preset updates…", description: "Align preset-created pools with updated built-in presets" },
			{ value: "reload", label: "Reload config from disk", description: "Re-read multikey.json and re-register providers" },
			{ value: "usage", label: "Usage tips" },
			{ value: "exit", label: "Close" },
		]);
		if (action === null || action === "exit") return;

		if (action === "reload") {
			reloadFromDiskSafe(hooks);
			continue;
		}
		if (action === "status") {
			await showInfo(ctx, "Multikey Status", renderStatus(hooks));
			continue;
		}
		if (action === "usage") {
			await showInfo(ctx, "Usage tips", [
				"• Concurrency: every in-flight request (main agent or subagents) picks the least-loaded key,",
				"  so parallel subagents automatically land on different keys.",
				"• 429: the key gets a cooldown (default 20s, retry-after honored) and the request instantly",
				"  retries on the next key — no error reaches the agent unless every key is exhausted.",
				"• Point subagents at e.g. <pool-id>/<model-id> in settings.json agentOverrides (pool id = provider name).",
				`• Config file: ${configPath()}`,
			]);
			continue;
		}
		if (action === "add") {
			await addPoolWizard(ctx, hooks);
			continue;
		}
		if (action === "presetsync") {
			await checkPresetUpdatesMenu(ctx, hooks);
			continue;
		}
		if (action === "manage") {
			const poolId = await selectOne(
				ctx,
				"Select pool",
				pools.map((p) => ({
					value: p.id,
					label: p.id,
					suffix:
						(p.name && p.name !== p.id ? ` — ${p.name}` : "") +
						(!isKnownApi(p.api) ? "  ⚠ broken api" : p.keys.length === 0 || p.models.length === 0 ? "  (incomplete)" : ""),
					description: `${p.baseUrl} · ${p.keys.length} keys · ${p.models.length} models`,
				})),
			);
			if (poolId) await poolMenu(ctx, hooks, poolId);
		}
	}
}

function reloadFromDiskSafe(hooks: ManagerHooks): void {
	try {
		hooks.reloadFromDisk();
		hooks.notify("multikey: reloaded config from disk");
	} catch (error) {
		hooks.notify(`multikey: reload failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function renderStatus(hooks: ManagerHooks): string[] {
	const lines: string[] = [];
	for (const pool of hooks.config.pools) {
		const kp = hooks.pools.get(pool.id);
		lines.push(`▶ ${pool.id} — ${pool.name ?? ""}  (${pool.baseUrl})`);
		if (!kp) {
			lines.push("  (not registered)");
			continue;
		}
		const rows = kp.statusRows();
		if (rows.length === 0) lines.push("  (no keys configured)");
		for (const row of rows) {
			const state = !row.enabled
				? "disabled"
				: row.cooldownRemainingMs > 0
					? `cooldown ${formatCooldown(row.cooldownRemainingMs)} (${row.cooldownReason ?? "?"})`
					: row.inflight > 0
						? `active ×${row.inflight}`
						: "idle";
			const credentialNote = row.credential ? `  ·  ${describeClineCredential(row.credential)}` : "";
			lines.push(
				`  ${row.label.padEnd(12)} ${row.masked.padEnd(16)} ${state.padEnd(28)} ok:${row.ok} 429:${row.rateLimited} quota:${row.quotaLimited} bad:${row.invalid} err:${row.errors}${credentialNote}`,
			);
		}
		lines.push("");
	}
	return lines.length > 0 ? lines : ["(no pools configured)"];
}

// ---------------------------------------------------------------------------
// Pool menu
// ---------------------------------------------------------------------------

async function poolMenu(ctx: CommandContext, hooks: ManagerHooks, poolId: string): Promise<void> {
	for (;;) {
		const pool = hooks.config.pools.find((p) => p.id === poolId);
		if (!pool) return;
		const incomplete = pool.keys.length === 0 || pool.models.length === 0;
		const apiBroken = !isKnownApi(pool.api);
		const items: { value: string; label: string; suffix?: string; description?: string }[] = [];
		if (apiBroken) {
			items.push({
				value: "fixapi",
				label: "⚠ Fix API type…",
				description: `"${pool.api}" is not a known pi API — this provider can't register until fixed`,
			});
		}
		items.push(
			{ value: "keys", label: "Keys…", description: pool.keys.map((k) => `${k.label ?? maskKey(k.key)}${k.enabled === false ? " (disabled)" : ""}`).join(", ") || "none" },
			{ value: "models", label: "Models…", description: `${pool.models.length} models${pool.models.length === 0 ? " — provider stays hidden until it has models" : ""}` },
			{ value: "settings", label: "Endpoint & settings…", description: `${pool.baseUrl} · api: ${pool.api ?? "openai-completions"}${incomplete ? " · ⚠ incomplete" : ""}` },
			{ value: "delete", label: "Delete pool", description: "Removes the provider from pi and the config file" },
			{ value: "back", label: "Back" },
		);
		const action = await selectOne(ctx, `Pool: ${pool.id}${apiBroken ? "  ⚠ broken api" : incomplete ? "  (incomplete)" : ""}`, items);
		if (action === null || action === "back") return;
		if (action === "fixapi") {
			const api = await selectOne(ctx, "API type (streaming protocol)", [
				...KNOWN_API_TYPES.map((t) => ({ value: t, label: t })),
				{ value: "__other", label: "Other (type it)…", description: "Free text, for custom-registered pi APIs" },
			]);
			if (api && api !== "__other") {
				pool.api = api;
				hooks.saveAndReregister(pool.id);
				hooks.notify(`multikey[${pool.id}]: api set to ${api}`);
			}
			continue;
		}
		if (action === "keys") await keysMenu(ctx, hooks, pool);
		else if (action === "models") await modelsMenu(ctx, hooks, pool);
		else if (action === "settings") await settingsMenu(ctx, hooks, pool);
		else if (action === "delete") {
			const ok = await ctx.ui.confirm("Delete pool", `Remove provider "${pool.id}" and its ${pool.keys.length} key(s)?`);
			if (ok) {
				hooks.removePool(pool.id);
				hooks.notify(`multikey: removed provider "${pool.id}"`);
				return;
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

async function keysMenu(ctx: CommandContext, hooks: ManagerHooks, pool: PoolConfig): Promise<void> {
	for (;;) {
		const kp = hooks.pools.get(pool.id);
		const rows = kp?.statusRows() ?? [];
		const items = pool.keys.map((k, i) => {
			const row = rows[i];
			const state = !k.enabled
				? "disabled"
				: row && row.cooldownRemainingMs > 0
					? `cooldown ${formatCooldown(row.cooldownRemainingMs)}${row.cooldownReason ? ` (${row.cooldownReason})` : ""}`
					: row && row.inflight > 0
						? `active ×${row.inflight}`
						: "idle";
			return {
				value: String(i),
				label: k.label ?? maskKey(k.key),
				suffix: `  ${maskKey(k.key)}  ${state}`,
				description: [
					`ok:${row?.ok ?? 0} 429:${row?.rateLimited ?? 0} quota:${row?.quotaLimited ?? 0} bad:${row?.invalid ?? 0}`,
					k.credential ? describeClineCredential(k.credential) : undefined,
				]
					.filter(Boolean)
					.join(" · "),
			};
		});
		const action = await selectOne(ctx, `Keys: ${pool.id}`, [...items, { value: "__add", label: "＋ Add key…", description: isClineEndpoint(pool.baseUrl) ? "Sign in with Cline (device flow) or paste a token" : undefined }, { value: "__back", label: "Back" }]);
		if (action === null || action === "__back") return;
		if (action === "__add") {
			// Cline accounts authenticate via OAuth instead of static API keys.
			if (isClineEndpoint(pool.baseUrl)) {
				const collected = await collectClineKeys(ctx, hooks);
				if (collected && collected.length > 0) {
					const entry = collected[0]!;
					if (pool.keys.some((k) => k.credential?.refreshToken === entry.credential?.refreshToken || k.key === entry.key)) {
						hooks.notify(`multikey[${pool.id}]: this Cline credential is already in the pool`);
					} else {
						pool.keys.push(entry);
						hooks.saveAndReregister(pool.id);
						hooks.notify(`multikey[${pool.id}]: added Cline credential ${entry.label ?? entry.key.slice(0, 6)}…`);
					}
				}
				continue;
			}
			const raw = await ctx.ui.input(`Add API key #${pool.keys.length + 1}`, "paste an API key");
			const value = raw?.trim();
			if (value) {
				if (pool.keys.some((k) => k.key === value)) {
					hooks.notify(`multikey[${pool.id}]: key already in pool`);
				} else {
					pool.keys.push({ key: value, label: `key-${pool.keys.length + 1}`, enabled: true });
					hooks.saveAndReregister(pool.id);
					hooks.notify(`multikey[${pool.id}]: added key ${value.length > 10 ? value.slice(0, 6) + "…" + value.slice(-4) : value}`);
				}
			}
			continue;
		}
		const index = Number(action);
		const key = pool.keys[index];
		if (!key) continue;
		const keyAction = await selectOne(ctx, `Key: ${key.label ?? maskKey(key.key)}`, [
			...(key.credential
				? [
						{
							value: "refresh",
							label: "Refresh Cline token now…",
							description: describeClineCredential(key.credential),
						},
					]
				: []),
			{ value: "toggle", label: key.enabled === false ? "Enable" : "Disable" },
			{ value: "label", label: "Edit label…" },
			{ value: "replace", label: "Replace value…" },
			{ value: "remove", label: "Remove key" },
			{ value: "back", label: "Back" },
		]);
		if (keyAction === null || keyAction === "back") continue;
		if (keyAction === "refresh" && key.credential) {
			try {
				const fresh = await withProgress(ctx, "Refreshing Cline token…", () =>
					ensureClineAccessToken(key.credential!, { force: true }),
				);
				key.credential.refreshToken = fresh.refreshToken;
				key.credential.accessToken = fresh.accessToken;
				key.credential.expiresAt = fresh.expiresAt;
				key.key = fresh.accessToken;
				hooks.saveAndReregister(pool.id);
				hooks.notify(`multikey[${pool.id}]: Cline token refreshed for ${key.label ?? maskKey(key.key)}`);
			} catch (error) {
				hooks.notify(`multikey[${pool.id}]: Cline token refresh failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			continue;
		}
		if (keyAction === "toggle") {
			key.enabled = key.enabled === false;
			hooks.saveAndReregister(pool.id);
		} else if (keyAction === "label") {
			const label = await ctx.ui.input("Key label", key.label ?? "");
			if (label !== undefined && label.trim()) {
				key.label = label.trim();
				hooks.saveAndReregister(pool.id);
			}
		} else if (keyAction === "replace") {
			const value = await ctx.ui.input("Replace API key value", maskKey(key.key));
			if (value !== undefined && value.trim()) {
				key.key = value.trim();
				hooks.saveAndReregister(pool.id);
			}
		} else if (keyAction === "remove") {
			pool.keys.splice(index, 1);
			hooks.saveAndReregister(pool.id);
			hooks.notify(`multikey[${pool.id}]: removed key`);
		}
	}
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

async function modelsMenu(ctx: CommandContext, hooks: ManagerHooks, pool: PoolConfig): Promise<void> {
	for (;;) {
		const stale = hasModelDiff(presetDrift(pool)?.diff);
		const items = pool.models.map((m) => ({
			value: m.id,
			label: m.id,
			suffix: m.reasoning ? "  🧠" : "",
			description: `ctx: ${m.contextWindow ?? 128000} · max: ${m.maxTokens ?? 16384} · in: ${(m.input ?? ["text"]).join("+")}`,
		}));
		const action = await selectOne(ctx, `Models: ${pool.id}${stale ? "  (preset outdated)" : ""}`, [
			...items,
			{ value: "__add", label: "＋ Add model…" },
			{ value: "__back", label: "Back" },
		]);
		if (action === null || action === "__back") return;
		if (action === "__add") {
			const how = await selectOne(ctx, "Add model", [
				{ value: "fetch", label: "Fetch from endpoint (/models)…", description: `Pick from models ${pool.baseUrl} offers` },
				{ value: "manual", label: "Enter manually (JSON)…", description: "Type an id, edit the full spec" },
			]);
			if (how === "fetch") {
				const added = await fetchAndPickModels(ctx, hooks, pool);
				if (added && added.length > 0) {
					pool.models.push(...added);
					hooks.saveAndReregister(pool.id);
					hooks.notify(`multikey[${pool.id}]: added ${added.length} model(s): ${added.map((m) => m.id).join(", ")}`);
				}
				continue;
			}
			if (how === null) continue;
			const id = await ctx.ui.input("Model id", "e.g. deepseek-v4-flash");
			if (id === undefined || !id.trim()) continue;
			if (pool.models.some((m) => m.id === id.trim())) {
				hooks.notify(`multikey[${pool.id}]: model "${id}" already exists`);
				continue;
			}
			const model = { ...DEFAULT_MODEL_TEMPLATE, id: id.trim(), name: id.trim() };
			const edited = await editModelJson(ctx, model);
			if (edited) {
				pool.models.push(edited);
				hooks.saveAndReregister(pool.id);
				hooks.notify(`multikey[${pool.id}]: added model ${edited.id}`);
			}
			continue;
		}
		const model = pool.models.find((m) => m.id === action);
		if (model) await modelMenu(ctx, hooks, pool, model);
	}
}

async function modelMenu(ctx: CommandContext, hooks: ManagerHooks, pool: PoolConfig, model: PoolModelConfig): Promise<void> {
	for (;;) {
		const action = await selectOne(ctx, `Model: ${pool.id}/${model.id}`, [
			{ value: "id", label: "Edit id…", description: model.id },
			{ value: "contextWindow", label: "Edit contextWindow…", description: String(model.contextWindow ?? 128_000) },
			{ value: "maxTokens", label: "Edit maxTokens…", description: String(model.maxTokens ?? 16_384) },
			{ value: "reasoning", label: "Toggle reasoning", description: String(model.reasoning ?? true) },
			{ value: "input", label: "Input modalities…", description: (model.input ?? ["text"]).join(", ") },
			{ value: "thinkingLevelMap", label: "Edit thinkingLevelMap (JSON)…", description: summarizeJson(model.thinkingLevelMap) },
			{ value: "compat", label: "Edit compat (JSON)…", description: summarizeJson(model.compat) },
			{ value: "cost", label: "Edit cost (JSON)…", description: summarizeJson(model.cost) },
			{ value: "raw", label: "Edit raw JSON…" },
			{ value: "remove", label: "Remove model" },
			{ value: "back", label: "Back" },
		]);
		if (action === null || action === "back") return;

		if (action === "id") {
			const id = await ctx.ui.input("Model id", model.id);
			if (id !== undefined && id.trim()) {
				model.id = id.trim();
				hooks.saveAndReregister(pool.id);
			}
		} else if (action === "contextWindow") {
			const value = await inputNumber(ctx, "Context window (tokens)", model.contextWindow ?? 128_000);
			if (value !== undefined) {
				model.contextWindow = value;
				hooks.saveAndReregister(pool.id);
			}
		} else if (action === "maxTokens") {
			const value = await inputNumber(ctx, "Max output tokens", model.maxTokens ?? 16_384);
			if (value !== undefined) {
				model.maxTokens = value;
				hooks.saveAndReregister(pool.id);
			}
		} else if (action === "reasoning") {
			model.reasoning = !(model.reasoning ?? true);
			hooks.saveAndReregister(pool.id);
		} else if (action === "input") {
			const chosen = await pickMany(
				ctx,
				"Input modalities",
				[
					{ value: "text", label: "text" },
					{ value: "image", label: "image" },
				],
			);
			if (chosen && chosen.length > 0) {
				model.input = chosen as ("text" | "image")[];
				hooks.saveAndReregister(pool.id);
			}
		} else if (action === "thinkingLevelMap" || action === "compat" || action === "cost") {
			const field = action as "thinkingLevelMap" | "compat" | "cost";
			const edited = await editJsonField(ctx, field, model[field]);
			if (edited !== undefined) {
				if (edited === null) delete model[field];
				else model[field] = edited as never;
				hooks.saveAndReregister(pool.id);
			}
		} else if (action === "raw") {
			const edited = await editModelJson(ctx, model);
			if (edited) {
				Object.assign(model, edited);
				hooks.saveAndReregister(pool.id);
			}
		} else if (action === "remove") {
			const index = pool.models.indexOf(model);
			if (index >= 0) pool.models.splice(index, 1);
			hooks.saveAndReregister(pool.id);
			hooks.notify(`multikey[${pool.id}]: removed model`);
			return;
		}
	}
}

function summarizeJson(value: unknown): string {
	if (value === undefined) return "(not set)";
	const text = JSON.stringify(value);
	return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

async function editJsonField(
	ctx: CommandContext,
	name: string,
	current: unknown,
): Promise<Record<string, unknown> | null | undefined> {
	const prefilled = current === undefined ? "{}" : JSON.stringify(current, null, 2);
	const text = await ctx.ui.editor(`Edit ${name} (JSON)`, prefilled);
	if (text === undefined) return undefined;
	const trimmed = text.trim();
	if (trimmed === "" || trimmed === "{}") return null;
	try {
		return JSON.parse(trimmed) as Record<string, unknown>;
	} catch (error) {
		await ctx.ui.notify(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`, "error");
		return undefined;
	}
}

async function editModelJson(ctx: CommandContext, model: PoolModelConfig): Promise<PoolModelConfig | undefined> {
	const text = await ctx.ui.editor("Edit model (JSON)", JSON.stringify(model, null, 2));
	if (text === undefined) return undefined;
	try {
		const parsed = JSON.parse(text) as PoolModelConfig;
		if (!parsed.id || typeof parsed.id !== "string") {
			await ctx.ui.notify("Model JSON must include a string \"id\"", "error");
			return undefined;
		}
		return parsed;
	} catch (error) {
		await ctx.ui.notify(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`, "error");
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Settings / add pool
// ---------------------------------------------------------------------------

async function settingsMenu(ctx: CommandContext, hooks: ManagerHooks, pool: PoolConfig): Promise<void> {
	for (;;) {
		const action = await selectOne(ctx, `Settings: ${pool.id}`, [
			{ value: "name", label: "Display name…", description: pool.name ?? pool.id },
			{ value: "baseUrl", label: "Base URL…", description: pool.baseUrl },
			{ value: "api", label: "API type…", description: pool.api ?? "openai-completions" },
			{ value: "auth", label: "Auth style…", description: pool.auth === "api-key" ? "x-api-key header" : "Authorization: Bearer (default)" },
			{ value: "cooldownMs", label: "429 cooldown (ms)…", description: String(pool.cooldownMs ?? 20_000) },
			{ value: "invalidKeyCooldownMs", label: "Invalid-key cooldown (ms)…", description: String(pool.invalidKeyCooldownMs ?? 600_000) },
			{ value: "compat", label: "Provider compat (JSON)…", description: summarizeJson(pool.compat) },
			{ value: "headers", label: "Headers (JSON)…", description: summarizeJson(pool.headers) },
			{ value: "back", label: "Back" },
		]);
		if (action === null || action === "back") return;

		if (action === "name") {
			const name = await ctx.ui.input("Display name", pool.name ?? pool.id);
			if (name !== undefined && name.trim()) {
				pool.name = name.trim();
				hooks.saveAndReregister(pool.id);
			}
		} else if (action === "baseUrl") {
			const url = await ctx.ui.input("Base URL", pool.baseUrl);
			if (url !== undefined && url.trim()) {
				pool.baseUrl = url.trim();
				hooks.saveAndReregister(pool.id);
			}
		} else if (action === "api") {
			const api = await selectOne(ctx, "API type (streaming protocol)", [
				...KNOWN_API_TYPES.map((t) => ({ value: t, label: t })),
				{ value: "__other", label: "Other (type it)…", description: "Free text, for custom-registered pi APIs" },
			]);
			if (api === "__other") {
				const custom = await ctx.ui.input("API type", pool.api ?? "openai-completions");
				if (custom !== undefined && custom.trim()) {
					pool.api = custom.trim();
					hooks.saveAndReregister(pool.id);
				}
			} else if (api !== null) {
				pool.api = api;
				hooks.saveAndReregister(pool.id);
			}
		} else if (action === "auth") {
			const auth = await selectOne(ctx, "Auth style (how the API key is sent)", [
				{ value: "bearer", label: "Authorization: Bearer (default)", description: "Used by most OpenAI-compatible endpoints" },
				{ value: "api-key", label: "x-api-key header", description: "Used by some gateways (Anthropic-style)" },
			]);
			if (auth !== null) {
				pool.auth = auth === "api-key" ? "api-key" : undefined;
				hooks.saveAndReregister(pool.id);
			}
		} else if (action === "cooldownMs") {
			const value = await inputNumber(ctx, "429 cooldown (ms)", pool.cooldownMs ?? 20_000);
			if (value !== undefined) {
				pool.cooldownMs = value;
				hooks.saveAndReregister(pool.id);
			}
		} else if (action === "invalidKeyCooldownMs") {
			const value = await inputNumber(ctx, "Invalid-key cooldown (ms)", pool.invalidKeyCooldownMs ?? 600_000);
			if (value !== undefined) {
				pool.invalidKeyCooldownMs = value;
				hooks.saveAndReregister(pool.id);
			}
		} else if (action === "compat" || action === "headers") {
			const field = action as "compat" | "headers";
			const edited = await editJsonField(ctx, field, pool[field]);
			if (edited !== undefined) {
				if (edited === null) delete pool[field];
				else pool[field] = edited as never;
				hooks.saveAndReregister(pool.id);
			}
		}
	}
}

async function addPoolWizard(ctx: CommandContext, hooks: ManagerHooks): Promise<void> {
	const choice = await selectOne(ctx, "Add provider: choose setup", [
		...PRESETS.map((p) => ({
			value: `preset:${p.id}`,
			label: `Preset: ${p.name}`,
				description: `${p.description}\n${p.baseUrl}`,
		})),
		{ value: "custom", label: "Custom…", description: "Enter endpoint + keys; auth is auto-probed and models fetched" },
	]);
	if (choice === null) return;
	if (choice === "custom") {
		await addCustomPool(ctx, hooks);
		return;
	}
	const preset = findPreset(choice.slice("preset:".length));
	if (preset) await addPresetPool(ctx, hooks, preset);
}

/**
 * Ask for a pool id exactly once. If it collides with an existing pool, offer
 * to open that pool instead of silently re-prompting (the old double-prompt).
 */
async function askPoolId(
	ctx: CommandContext,
	hooks: ManagerHooks,
	suggested: string,
): Promise<{ kind: "new"; id: string } | { kind: "existing"; id: string } | undefined> {
	for (;;) {
		const id = await ctx.ui.input("Provider id in pi", suggested || "e.g. bai, nvidia, opencode");
		if (id === undefined) return undefined;
		const poolId = (id.trim() || suggested).trim();
		if (!poolId) continue;
		if (!hooks.config.pools.some((p) => p.id === poolId)) return { kind: "new", id: poolId };

		const choice = await selectOne(ctx, `Pool "${poolId}" already exists`, [
			{ value: "manage", label: `Open existing pool "${poolId}"…`, description: "Keys, models, endpoint settings" },
			{ value: "rename", label: "Use a different id…" },
			{ value: "cancel", label: "Cancel" },
		]);
		if (choice === "manage") return { kind: "existing", id: poolId };
		if (choice !== "rename") return undefined;
	}
}

/**
 * Collect keys one per line (user's preference). Esc finishes with whatever is
 * collected; empty input on the first prompt cancels the whole wizard.
 */
async function askKeys(ctx: CommandContext, hooks: ManagerHooks, hint?: string): Promise<string[] | undefined> {
	const keys: string[] = [];
	const placeholder = hint ?? "paste an API key";
	for (;;) {
		const prompt = keys.length === 0 ? "API key (empty = cancel)" : `API key #${keys.length + 1} (empty = done)`;
		const raw = await ctx.ui.input(prompt, placeholder);
		const value = raw === undefined ? "" : raw.trim();
		if (!value) {
			if (keys.length === 0) return undefined;
			break;
		}
		if (keys.includes(value)) {
			hooks.notify("multikey: duplicate key ignored");
			continue;
		}
		keys.push(value);
	}
	return keys;
}

async function addPresetPool(ctx: CommandContext, hooks: ManagerHooks, preset: Preset): Promise<void> {
	const idChoice = await askPoolId(ctx, hooks, preset.defaultPoolId);
	if (idChoice === undefined) return;
	if (idChoice.kind === "existing") {
		await poolMenu(ctx, hooks, idChoice.id);
		return;
	}
	const poolId = idChoice.id;
	// Cline accounts have no static API keys — collect an OAuth credential
	// (device flow) or a pasted access token instead of the generic key prompt.
	let keyConfigs: PoolKeyConfig[];
	if (preset.id === "cline-free") {
		const collected = await collectClineKeys(ctx, hooks);
		if (collected === undefined) return;
		keyConfigs = collected;
	} else {
		const keys = await askKeys(ctx, hooks, preset.keyHint);
		if (keys === undefined) return;
		keyConfigs = keys.map((key, i) => ({ key, label: `key-${i + 1}`, enabled: true }));
	}

	// Light-touch verification: probe the preset endpoint with the first key.
	// The model specs are curated, so this is only a key sanity check.
	let probe: ProbeResult | undefined;
	let authNote = "keys not verified (offline?)";
	try {
		probe = await withProgress(ctx, `Verifying key against ${preset.baseUrl}…`, (update) =>
			probeEndpoint(preset.baseUrl, keyConfigs[0]!.key, {
				chatModelId: preset.models[0]?.id,
				onLog: (line) => update(line.trimEnd()),
			}),
		);
		authNote = keyConfigs[0]!.credential ? `Cline account credential (${describeClineCredential(keyConfigs[0]!.credential)})` : describeAuth(probe);
		if (probe.authStatus === "rejected") {
			const proceed = await ctx.ui.confirm(
				"Key rejected",
				`The endpoint answered 401/403 for your key. Save the pool anyway (you can fix keys later)?`,
			);
			if (!proceed) return;
		}
	} catch {
		// Probe must never block pool creation.
	}

	const pool = poolFromPreset(preset, poolId, keyConfigs.map((k) => k.key));
	pool.keys = keyConfigs;
	if (probe?.authStatus === "confirmed" && probe.auth === "api-key") pool.auth = "api-key";
	hooks.config.pools.push(pool);
	hooks.saveAndReregister(poolId);
	hooks.notify(
		`multikey: created "${poolId}" from ${preset.name} preset — ${pool.keys.length} key(s), ${pool.models.length} models ready`,
	);
	await showInfo(ctx, `Preset applied: ${preset.name}`, [
		`Provider:  ${poolId}/<model-id>  (e.g. ${poolId}/${pool.models[0]?.id ?? "..."})`,
		`Endpoint:  ${pool.baseUrl}`,
		`Keys:      ${pool.keys.length} loaded — ${authNote}`,
		`Models:    ${pool.models.map((m) => m.id).join(", ")}`,
		"",
		"Add more keys anytime: /multikey → Manage pools → Keys.",
		"Model specs (thinking tiers, context, modalities) are preconfigured.",
	]);
}

async function addCustomPool(ctx: CommandContext, hooks: ManagerHooks): Promise<void> {
	// 1. Provider id — asked exactly once; collisions offer to open the pool.
	const idChoice = await askPoolId(ctx, hooks, "");
	if (idChoice === undefined) return;
	if (idChoice.kind === "existing") {
		await poolMenu(ctx, hooks, idChoice.id);
		return;
	}
	const poolId = idChoice.id;

	// 2. Base URL.
	const baseUrl = await ctx.ui.input("Base URL", "https://api.example.com/v1");
	if (baseUrl === undefined || !baseUrl.trim()) return;

	// 3. API key(s). No "API type" question: auth is auto-probed next.
	const keys = await askKeys(ctx, hooks);
	if (keys === undefined) return;

	// 4. Probe: detect Bearer vs x-api-key, verify the key, list /models.
	const probe = await withProgress(ctx, `Probing ${baseUrl.trim()}…`, (update) =>
		probeEndpoint(baseUrl.trim(), keys[0]!, { onLog: (line) => update(line.trimEnd()) }),
	);

	// 5. Pick models (multi-select straight from the server's list).
	const models = await pickModelsForNewPool(ctx, hooks, poolId, baseUrl.trim(), keys[0]!, probe);
	if (models === undefined) return; // user cancelled — nothing was saved (atomic wizard)

	// 6. Safe defaults immediately; common params (context, input modes,
	//    max tokens) optionally tuned here; everything else stays editable in
	//    multikey.json.
	let tuned = false;
	if (models.length > 0) {
		const params = await selectOne(ctx, "Model parameters", [
			{
				value: "defaults",
				label: "Use safe defaults (recommended)",
				description: `${DEFAULT_CONTEXT_WINDOW / 1000}k context · text input · ${DEFAULT_MAX_TOKENS / 1000}k max output — edit later via Models menu or multikey.json`,
			},
			{ value: "tune", label: "Tune common params now…", description: "Context size, input modes, max output — per model" },
		]);
		// null (esc) falls back to safe defaults rather than cancelling the wizard.
		if (params === "tune") {
			await tuneCommonParams(ctx, models);
			tuned = true;
		}
	}

	// 7. Save atomically — only now does the pool enter the config.
	const pool: PoolConfig = {
		id: poolId,
		name: poolId,
		baseUrl: baseUrl.trim(),
		api: "openai-completions",
		auth: probe.auth === "api-key" ? "api-key" : undefined,
		cooldownMs: 20_000,
		invalidKeyCooldownMs: 600_000,
		keys: keys.map((key, i) => ({ key, label: `key-${i + 1}`, enabled: true }) satisfies PoolKeyConfig),
		models,
	};
	hooks.config.pools.push(pool);
	hooks.saveAndReregister(poolId);

	const modelSummary = models.length > 0 ? models.map((m) => m.id).join(", ") : "(none yet — add via Models menu)";
	await showInfo(ctx, `Pool created: ${poolId}`, [
		`Endpoint:  ${pool.baseUrl}`,
		`Auth:      ${describeAuth(probe)}`,
		`Keys:      ${pool.keys.length} loaded`,
		`Models:    ${modelSummary}${tuned ? " (tuned)" : models.length > 0 ? " (safe defaults)" : ""}`,
		"",
		"Use it as: /model  →  " + poolId + "/<model-id>",
		`Advanced params (thinking maps, compat, cost): edit ${configPath()},`,
		"then /multikey → Reload config from disk.",
	]);
}

/**
 * Model selection step of the add wizard. Returns pool models, or undefined
 * when the user cancelled (so the wizard stays atomic — nothing saved). An
 * empty array means "save the pool without models" (explicit choice).
 */
async function pickModelsForNewPool(
	ctx: CommandContext,
	hooks: ManagerHooks,
	poolId: string,
	baseUrl: string,
	key: string,
	probe: ProbeResult,
): Promise<PoolModelConfig[] | undefined> {
	for (;;) {
		let choice: string | null;
		if (probe.ok && probe.models && probe.models.length > 0) {
			// Straight to multi-select: every offered model preselected.
			const selectedIds = await pickMany(
				ctx,
				`Add models from ${probe.modelsUrl} — space to toggle, enter to confirm`,
				probe.models.map((m) => ({ value: m.id, label: m.id, description: describeRemote(m) })),
				{ preselected: probe.models.map((m) => m.id) },
			);
			if (selectedIds === null) return undefined;
			const byId = new Map(probe.models.map((m) => [m.id, m]));
			return selectedIds.map((id) => remoteToPoolModel(byId.get(id)!));
		}

		// No model list available — offer paths instead of a dead end.
		choice = await selectOne(ctx, "Could not list models from the endpoint", [
			{ value: "manual", label: "Enter model ids manually…", description: "Type ids, edit specs as JSON" },
			{ value: "retry", label: "Retry probe" },
			{ value: "empty", label: `Create "${poolId}" without models`, description: "Add models later via /multikey → Models" },
			{ value: "cancel", label: "Cancel (nothing saved)" },
		]);
		if (choice === null || choice === "cancel") return undefined;
		if (choice === "retry") {
			const retried = await withProgress(ctx, "Probing again…", (update) =>
				probeEndpoint(baseUrl, key, { onLog: (line) => update(line.trimEnd()) }),
			);
			// Merge results, keeping the original probe's key/auth findings.
			if (retried.ok) {
				probe.ok = true;
				probe.models = retried.models;
				probe.modelsUrl = retried.modelsUrl;
			}
			continue;
		}
		if (choice === "empty") return [];
		if (choice === "manual") {
			const manual = await collectManualModels(ctx, hooks);
			if (manual === undefined) continue; // back to this menu
			return manual;
		}
	}
}

/** Loop of manual model entries (id prompt + JSON editor). undefined = user backed out. */
async function collectManualModels(ctx: CommandContext, hooks: ManagerHooks): Promise<PoolModelConfig[] | undefined> {
	const models: PoolModelConfig[] = [];
	for (;;) {
		const id = await ctx.ui.input(`Model id #${models.length + 1}`, "e.g. deepseek-v4-flash  (empty = done)");
		if (id === undefined) return undefined;
		if (!id.trim()) return models;
		const model = { ...DEFAULT_MODEL_TEMPLATE, id: id.trim(), name: id.trim() };
		const edited = await editModelJson(ctx, model);
		if (edited) models.push(edited);
	}
}

/** Per-model quick tune of the common params: context size, input modes, max output. */
async function tuneCommonParams(ctx: CommandContext, models: PoolModelConfig[]): Promise<void> {
	for (let i = 0; i < models.length; i++) {
		const model = models[i]!;
		const tag = `[${i + 1}/${models.length}] ${model.id}`;
		const contextWindow = await inputNumber(ctx, `${tag} — context window (tokens)`, model.contextWindow ?? DEFAULT_CONTEXT_WINDOW);
		if (contextWindow !== undefined) model.contextWindow = contextWindow;
		const input = await pickMany(
			ctx,
			`${tag} — input modalities`,
			[
				{ value: "text", label: "text" },
				{ value: "image", label: "image" },
			],
			{ preselected: model.input ?? DEFAULT_INPUT },
		);
		if (input && input.length > 0) model.input = input as ("text" | "image")[];
		const maxTokens = await inputNumber(ctx, `${tag} — max output tokens`, model.maxTokens ?? DEFAULT_MAX_TOKENS);
		if (maxTokens !== undefined) model.maxTokens = maxTokens;
	}
}

/**
 * Fetch the live /models list for an existing pool and let the user pick new
 * models to add (duplicates filtered). Returns added models, or undefined on cancel.
 */
async function fetchAndPickModels(ctx: CommandContext, hooks: ManagerHooks, pool: PoolConfig): Promise<PoolModelConfig[] | undefined> {
	const key = firstEnabledKey(pool);
	if (!key) {
		hooks.notify(`multikey[${pool.id}]: add a key first — the probe needs one`);
		return undefined;
	}
	const probe = await withProgress(ctx, `Fetching models from ${pool.baseUrl}…`, (update) =>
		probeEndpoint(pool.baseUrl, key, {
			authHint: pool.auth,
			chatModelId: pool.models[0]?.id,
			onLog: (line) => update(line.trimEnd()),
		}),
	);
	if (!probe.ok || !probe.models || probe.models.length === 0) {
		await showInfo(ctx, "No models found", probe.log.length > 0 ? probe.log : ["The endpoint did not return a usable model list."]);
		return undefined;
	}
	const existing = new Set(pool.models.map((m) => m.id));
	const fresh = probe.models.filter((m) => !existing.has(m.id));
	if (fresh.length === 0) {
		hooks.notify(`multikey[${pool.id}]: all ${probe.models.length} listed models are already added`);
		return undefined;
	}
	const selectedIds = await pickMany(
		ctx,
		`Add models from ${probe.modelsUrl} — ${fresh.length} new (${probe.models.length - fresh.length} already added)`,
		fresh.map((m) => ({ value: m.id, label: m.id, description: describeRemote(m) })),
	);
	if (selectedIds === null) return undefined;
	const byId = new Map(fresh.map((m) => [m.id, m]));
	return selectedIds.map((id) => remoteToPoolModel(byId.get(id)!));
}
