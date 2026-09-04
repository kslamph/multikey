/**
 * multikey config: load / save / normalize / seed
 *
 * Config lives at ~/.pi/agent/multikey.json. Each "pool" becomes one pi provider
 * whose requests are spread across multiple API keys with automatic 429 rotation.
 * (Pools created before the rename live in keypool.json and are migrated once.)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { AuthStyle } from "./probe.ts";
import { currentRequestId, currentSessionId, currentTaskId, turnKeyOf } from "./identity.ts";

/** Safe model defaults applied when a spec doesn't say otherwise (edit in multikey.json). */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;
export const DEFAULT_INPUT: ("text" | "image")[] = ["text"];

export const KNOWN_API_TYPES = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
	"mistral-conversations",
	"openai-codex-responses",
	"azure-openai-responses",
	"google-vertex",
	"bedrock-converse-stream",
	"pi-messages",
] as const;

export interface PoolKeyConfig {
	/** The literal API key. */
	key: string;
	/** Optional human label, e.g. "main", "spare-1". */
	label?: string;
	/** Disabled keys are never selected. Default: true. */
	enabled?: boolean;
	/**
	 * Credential-backed key (Cline account OAuth). When present, `key` holds the
	 * current access token and is refreshed transparently from `credential`
	 * before requests and again on 401 — see cline-auth.ts.
	 */
	credential?: KeyCredential;
}

/** OAuth-style credential for endpoints without static API keys (Cline free tier). */
export interface KeyCredential {
	kind: "cline-oauth";
	/** Long-lived refresh token; access tokens are minted from it. */
	refreshToken: string;
	/** Last known access token (mirrors `key`). */
	accessToken?: string;
	/** Access token expiry (epoch ms), when known. */
	expiresAt?: number;
}

/**
 * Tracks which shipped preset a pool was created from / last aligned with.
 * Lives in multikey.json as `_preset`. The fingerprint (see presetFingerprint
 * in presets.ts) is persisted the moment an update prompt is shown — that is
 * what guarantees each preset version is asked about at most once.
 */
export interface PresetMarker {
	/** Preset id in presets.ts, e.g. "b-ai". */
	id: string;
	/** Fingerprint of the preset's model list at pool creation / last sync. */
	fingerprint: string;
}

export interface PoolModelConfig {
	id: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	input?: ("text" | "image")[];
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow?: number;
	maxTokens?: number;
	compat?: Record<string, unknown>;
	headers?: Record<string, string>;
}

export interface PoolConfig {
	/** Provider id in pi, e.g. "bai". Model refs become "<id>/<modelId>". */
	id: string;
	name?: string;
	baseUrl: string;
	/** Streaming API type, e.g. "openai-completions". Default: openai-completions. */
	api?: string;
	/** Auth header style. Default: bearer (Authorization: Bearer). "api-key" sends x-api-key instead. */
	auth?: AuthStyle;
	/** Provider-level compat defaults merged into every model. */
	compat?: Record<string, unknown>;
	headers?: Record<string, string>;
	/** Cooldown after a 429 on a key. Default 20000ms. */
	cooldownMs?: number;
	/** Cooldown after a 401/403 (bad key). Default 600000ms. */
	invalidKeyCooldownMs?: number;
	/** Present when the pool was created from (or adopted) a shipped preset. */
	_preset?: PresetMarker;
	keys: PoolKeyConfig[];
	models: PoolModelConfig[];
}

export interface KeypoolConfig {
	pools: PoolConfig[];
}

export function configPath(): string {
	return process.env.MULTIKEY_CONFIG ?? process.env.KEYPOOL_CONFIG ?? join(homedir(), ".pi", "agent", "multikey.json");
}

/** Pre-rename default location; only consulted for migration when no env override is set. */
function legacyConfigPath(): string | undefined {
	if (process.env.MULTIKEY_CONFIG || process.env.KEYPOOL_CONFIG) return undefined;
	return join(homedir(), ".pi", "agent", "keypool.json");
}

const DEFAULT_COOLDOWN_MS = 20_000;
const DEFAULT_INVALID_KEY_COOLDOWN_MS = 600_000;
/**
 * First-run seed: discover pools from ~/.pi/agent/models.json instead of shipping
 * any baked-in credentials. A pool is created for every group of providers that
 * share one baseUrl (the "I duplicated a provider per key" pattern) plus any
 * provider already pointing at api.b.ai.
 */

/** Builtin provider ids we must not shadow with a pool registration. */
const BUILTIN_ID_DENYLIST = new Set([
	"anthropic",
	"openai",
	"openai-codex",
	"azure-openai",
	"google",
	"google-vertex",
	"amazon-bedrock",
	"mistral",
	"groq",
	"openrouter",
	"xai",
	"deepseek",
	"moonshot",
	"zai",
	"minimax",
	"github-copilot",
]);

interface RawModelJsonProvider {
	baseUrl?: string;
	apiKey?: string;
	api?: string;
	name?: string;
	compat?: Record<string, unknown>;
	headers?: Record<string, string>;
	models?: PoolModelConfig[];
}

function hostOf(url: string): string {
	try {
		return new URL(url).host.toLowerCase();
	} catch {
		return "";
	}
}

/** Resolve a models.json config value: literal or $ENV/${ENV}. Skips `!command` (never shell out during seed). */
function resolveConfigValue(value: string): string | undefined {
	if (value.startsWith("!")) return undefined;
	const names: string[] = [];
	const pattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
	let match = pattern.exec(value);
	while (match) {
		names.push(match[1] ?? match[2]!);
		match = pattern.exec(value);
	}
	if (names.length === 0) return value.trim() || undefined;
	let resolved = value;
	for (const name of names) {
		const envValue = process.env[name];
		if (!envValue) return undefined;
		resolved = resolved.replace(new RegExp(`\\$\\{?${name}\\}?`, "g"), envValue);
	}
	return resolved.trim() || undefined;
}

function mergeModel(base: PoolModelConfig | undefined, extra: PoolModelConfig): PoolModelConfig {
	if (!base) return { ...extra };
	const merged: PoolModelConfig = { ...base };
	for (const [key, value] of Object.entries(extra)) {
		if (value === undefined) continue;
		const current = (base as unknown as Record<string, unknown>)[key];
		if (current === undefined || current === null) (merged as unknown as Record<string, unknown>)[key] = value;
	}
	// Prefer a definition that actually declares the sizing fields over a stub.
	if (base.contextWindow === undefined && extra.contextWindow !== undefined) merged.contextWindow = extra.contextWindow;
	if (base.maxTokens === undefined && extra.maxTokens !== undefined) merged.maxTokens = extra.maxTokens;
	return merged;
}

function discoverPools(): PoolConfig[] {
	const modelsPath = join(homedir(), ".pi", "agent", "models.json");
	if (!existsSync(modelsPath)) return [];

	let providers: Record<string, RawModelJsonProvider>;
	try {
		const parsed = JSON.parse(readFileSync(modelsPath, "utf-8")) as {
			providers?: Record<string, RawModelJsonProvider>;
		};
		providers = parsed.providers ?? {};
	} catch {
		return [];
	}

	// Group by baseUrl.
	const groups = new Map<string, { id: string; cfg: RawModelJsonProvider }[]>();
	for (const [id, cfg] of Object.entries(providers)) {
		if (!cfg || typeof cfg.baseUrl !== "string" || !cfg.baseUrl.trim()) continue;
		const key = cfg.baseUrl.trim();
		const bucket = groups.get(key) ?? [];
		bucket.push({ id, cfg });
		groups.set(key, bucket);
	}

	const pools: PoolConfig[] = [];
	for (const [baseUrl, bucket] of groups) {
		const isBai = hostOf(baseUrl) === "api.b.ai";
		if (!isBai && bucket.length < 2) continue;

		// Collect distinct keys.
		const keys: PoolKeyConfig[] = [];
		const seenKeys = new Set<string>();
		for (const entry of bucket) {
			if (typeof entry.cfg.apiKey !== "string") continue;
			const resolved = resolveConfigValue(entry.cfg.apiKey);
			if (!resolved || seenKeys.has(resolved)) continue;
			seenKeys.add(resolved);
			keys.push({ key: resolved, label: `${entry.id}`, enabled: true });
		}
		if (keys.length === 0) continue;

		// Union of models across the duplicated providers.
		const modelById = new Map<string, PoolModelConfig>();
		for (const entry of bucket) {
			for (const model of entry.cfg.models ?? []) {
				if (!model || typeof model.id !== "string") continue;
				modelById.set(model.id, mergeModel(modelById.get(model.id), model));
			}
		}

		const primary = bucket[0]!;
		let poolId = primary.id;
		if (BUILTIN_ID_DENYLIST.has(poolId.toLowerCase())) poolId = `${poolId}-pool`;
		if (pools.some((p) => p.id === poolId)) poolId = `${poolId}-2`;

		pools.push({
			id: poolId,
			name: `${primary.cfg.name ?? primary.id} (Key Pool)`,
			baseUrl,
			api: bucket.find((entry) => entry.cfg.api)?.cfg.api ?? "openai-completions",
			compat: primary.cfg.compat,
			headers: primary.cfg.headers,
			cooldownMs: DEFAULT_COOLDOWN_MS,
			invalidKeyCooldownMs: DEFAULT_INVALID_KEY_COOLDOWN_MS,
			keys,
			models: [...modelById.values()],
		});
	}
	return pools;
}

function seedConfig(): KeypoolConfig {
	return { pools: discoverPools() };
}

export function loadConfig(): { config: KeypoolConfig; created: boolean; migratedFrom?: string } {
	const path = configPath();
	if (!existsSync(path)) {
		const legacy = legacyConfigPath();
		if (legacy && existsSync(legacy)) {
			// One-time rename migration: adopt the old keypool.json as-is.
			const raw = JSON.parse(readFileSync(legacy, "utf-8")) as KeypoolConfig;
			const config = normalize(raw);
			saveConfig(config);
			return { config, created: false, migratedFrom: legacy };
		}
		const config = seedConfig();
		saveConfig(config);
		return { config, created: true };
	}
	const raw = JSON.parse(readFileSync(path, "utf-8")) as KeypoolConfig;
	const config = normalize(raw);
	return { config, created: false };
}

export function saveConfig(config: KeypoolConfig): void {
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

export function normalize(config: KeypoolConfig): KeypoolConfig {
	const pools = Array.isArray(config.pools) ? config.pools : [];
	const normalized: PoolConfig[] = [];
	for (const pool of pools) {
		if (!pool || typeof pool.id !== "string" || !pool.id.trim()) continue;
		if (!pool.baseUrl || typeof pool.baseUrl !== "string") continue;
		normalized.push(normalizePool(pool));
	}
	return { pools: normalized };
}

/** Structural check so a malformed credential in the JSON file can't break a pool. */
function isValidCredential(credential: unknown): credential is KeyCredential {
	return (
		!!credential &&
		typeof credential === "object" &&
		(credential as KeyCredential).kind === "cline-oauth" &&
		typeof (credential as KeyCredential).refreshToken === "string" &&
		(credential as KeyCredential).refreshToken.trim().length > 0
	);
}

function normalizePool(pool: PoolConfig): PoolConfig {
	const keys = (Array.isArray(pool.keys) ? pool.keys : [])
		.filter((k) => k && typeof k.key === "string" && k.key.trim())
		.map((k) => ({
			key: k.key.trim(),
			label: typeof k.label === "string" && k.label.trim() ? k.label.trim() : undefined,
			enabled: k.enabled !== false,
			// OAuth-backed keys keep their credential; only well-formed ones survive.
			...(isValidCredential(k.credential) ? { credential: k.credential } : {}),
		}));
	const models = (Array.isArray(pool.models) ? pool.models : []).filter((m) => m && typeof m.id === "string" && m.id.trim());
	const preset =
		pool._preset && typeof pool._preset.id === "string" && typeof pool._preset.fingerprint === "string"
			? { id: pool._preset.id, fingerprint: pool._preset.fingerprint }
			: undefined;
	return {
		id: pool.id.trim(),
		name: pool.name ?? pool.id,
		baseUrl: pool.baseUrl,
		api: pool.api ?? "openai-completions",
		auth: pool.auth === "api-key" ? "api-key" : undefined,
		compat: pool.compat,
		headers: pool.headers,
		cooldownMs: typeof pool.cooldownMs === "number" && pool.cooldownMs >= 0 ? pool.cooldownMs : DEFAULT_COOLDOWN_MS,
		invalidKeyCooldownMs:
			typeof pool.invalidKeyCooldownMs === "number" && pool.invalidKeyCooldownMs >= 0
				? pool.invalidKeyCooldownMs
				: DEFAULT_INVALID_KEY_COOLDOWN_MS,
		_preset: preset,
		keys,
		models,
	};
}

/** Convert a pool config into pi ProviderModelConfig-style definitions (provider-level compat merged in). */
export function toProviderModels(pool: PoolConfig): ProviderModelConfig[] {
	return pool.models.map(
		(m): ProviderModelConfig => ({
			id: m.id,
			name: m.name ?? m.id,
			api: m.api,
			baseUrl: m.baseUrl,
			reasoning: m.reasoning ?? true,
			thinkingLevelMap: m.thinkingLevelMap as ProviderModelConfig["thinkingLevelMap"],
			input: m.input ?? DEFAULT_INPUT,
			cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: m.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
			maxTokens: m.maxTokens ?? DEFAULT_MAX_TOKENS,
			compat: mergeCompat(pool.compat, m.compat) as ProviderModelConfig["compat"],
		}),
	);
}

function mergeCompat(
	base: Record<string, unknown> | undefined,
	override: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!base && !override) return undefined;
	return { ...(base ?? {}), ...(override ?? {}) };
}

/** Mask a key for display: sk-1234…abcd */
export function maskKey(key: string): string {
	if (key.length <= 10) return "…";
	return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

// ── Endpoint-required headers ────────────────────────────────────────────────

/** OpenCode Zen free tier endpoint that mimics the official OpenCode client. */
const OPENCODE_ZEN_BASE_URL = "https://opencode.ai/zen/v1";
const OPENCODE_ZEN_USER_AGENT = "opencode/0.1.50 ai-sdk/openai-compatible/3.0.41";
const OPENCODE_ZEN_CLIENT = "tui";

/** True when a baseUrl points at OpenCode Zen (case-insensitive, trailing slash ok). */
export function isOpenCodeZenEndpoint(baseUrl: string | undefined): boolean {
	if (!baseUrl) return false;
	return baseUrl.replace(/\/+$/, "").toLowerCase() === OPENCODE_ZEN_BASE_URL;
}

/**
 * Constant headers a known endpoint expects on every request.
 *
 * OpenCode Zen's free tier wants the full OpenCode client header set; the
 * per-conversation / per-device halves live in {@link endpointIdentityHeaders}.
 * Cline's API gates on its official client's header set (versioned client
 * identity + platform metadata), so we send the same shape the Cline CLI
 * sends (mirroring sdk request-headers.ts). Anything else returns an empty object.
 */
export function endpointHeaders(baseUrl: string): Record<string, string> {
	if (isClineEndpoint(baseUrl)) return clineClientHeaders();
	if (!isOpenCodeZenEndpoint(baseUrl)) return {};
	return { "x-opencode-client": OPENCODE_ZEN_CLIENT, "User-Agent": OPENCODE_ZEN_USER_AGENT };
}

/**
 * Per-request identity headers a known endpoint expects.
 *
 * OpenCode Zen reads `x-opencode-session` as the conversation id and
 * `x-opencode-request` as the id of the user message being answered, so these
 * must be computed at request time rather than baked into the provider
 * registration. `messages` lets the caller key the request id to the current
 * turn (see turnKeyOf); omit it for one-shot calls outside a conversation.
 * Cline reads `X-Task-ID` as a per-conversation correlation id.
 */
export function endpointIdentityHeaders(baseUrl: string | undefined, messages?: readonly unknown[]): Record<string, string> {
	if (isClineEndpoint(baseUrl ?? "")) return { "X-Task-ID": currentTaskId() };
	if (!isOpenCodeZenEndpoint(baseUrl ?? "")) return {};
	return {
		"x-opencode-session": currentSessionId(),
		"x-opencode-request": currentRequestId(messages ? turnKeyOf(messages) : undefined),
	};
}

// ── Cline (api.cline.bot) ────────────────────────────────────────────────────

const CLINE_API_BASE_URL = "https://api.cline.bot";

/**
 * Header set the official Cline CLI sends to api.cline.bot (mirrors
 * cline sdk request-headers.ts buildClineRequestHeaders with source "cli").
 * The values track the cline repo versions: CLI 3.0.61, SDK core 0.0.82.
 */
const CLINE_CLIENT_HEADERS: Record<string, string> = {
	"HTTP-Referer": "https://cline.bot",
	"X-Title": "Cline",
	"X-IS-MULTIROOT": "false",
	"X-CLIENT-TYPE": "cline-cli",
	"User-Agent": "Cline/3.0.61",
	"X-CLIENT-VERSION": "3.0.61",
	"X-PLATFORM": "cli",
	"X-PLATFORM-VERSION": "3.0.61",
	"X-CORE-VERSION": "0.0.82",
};

function clineClientHeaders(): Record<string, string> {
	return { ...CLINE_CLIENT_HEADERS };
}

/** True when a baseUrl points at Cline's API (any path depth, trailing slash ok). */
export function isClineEndpoint(baseUrl: string | undefined): boolean {
	if (!baseUrl) return false;
	return baseUrl.replace(/\/+$/, "").toLowerCase().startsWith(CLINE_API_BASE_URL);
}
