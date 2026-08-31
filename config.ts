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
	return { config: normalize(raw), created: false };
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

function normalizePool(pool: PoolConfig): PoolConfig {
	const keys = (Array.isArray(pool.keys) ? pool.keys : [])
		.filter((k) => k && typeof k.key === "string" && k.key.trim())
		.map((k) => ({
			key: k.key.trim(),
			label: typeof k.label === "string" && k.label.trim() ? k.label.trim() : undefined,
			enabled: k.enabled !== false,
		}));
	const models = (Array.isArray(pool.models) ? pool.models : []).filter((m) => m && typeof m.id === "string" && m.id.trim());
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

/** OpenCode Zen free tier endpoint that requires a specific User-Agent header. */
const OPENCODE_ZEN_BASE_URL = "https://opencode.ai/zen/v1";
const OPENCODE_ZEN_USER_AGENT =
	"opencode/1.15.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13";

/**
 * Headers that must be sent to known endpoints.
 *
 * Currently: OpenCode Zen's free tier endpoint requires this exact User-Agent;
 * anything else returns an empty object.
 *
 * The comparison is case-insensitive and tolerates a trailing slash.
 */
export function endpointHeaders(baseUrl: string): Record<string, string> {
	const normalized = baseUrl.replace(/\/+$/, "").toLowerCase();
	if (normalized === OPENCODE_ZEN_BASE_URL) return { "User-Agent": OPENCODE_ZEN_USER_AGENT };
	return {};
}
