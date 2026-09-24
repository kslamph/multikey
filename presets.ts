/**
 * Built-in provider presets.
 *
 * A preset carries everything except credentials, so adding a provider is just
 * "paste your keys". Model specs here are verified against provider docs and
 * live probes — see README "Presets" for the evidence trail.
 */

import { createHash } from "node:crypto";

import type { PoolConfig, PoolModelConfig } from "./config.ts";

export interface Preset {
	/** Stable id used in the config file's `_preset` marker. */
	id: string;
	name: string;
	description: string;
	/** Suggested pi provider id (user can override). */
	defaultPoolId: string;
	baseUrl: string;
	api: string;
	compat?: Record<string, unknown>;
	/** Where to create/copy API keys. */
	keyHint?: string;
	models: PoolModelConfig[];
}

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Build a thinkingLevelMap that always writes every level (null = hidden in the UI). */
function levels(
	supported: Partial<Record<(typeof LEVELS)[number], string | null>>,
): Record<string, string | null> {
	const map: Record<string, string | null> = {};
	for (const level of LEVELS) {
		map[level] = level in supported ? (supported[level] ?? null) : null;
	}
	return map;
}

const BAI_COMPAT = {
	supportsDeveloperRole: false,
	thinkingFormat: "deepseek",
	requiresReasoningContentOnAssistantMessages: true,
	supportsReasoningEffort: true,
};

// Shared compat for OpenCode Zen's openai-completions free models, mirroring pi's
// built-in opencode catalog (dist/bundle/chunks/chunk-OMWWHBTG.js).
const ZEN_CHAT_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	maxTokensField: "max_tokens",
};

export const PRESETS: Preset[] = [
	{
		id: "b-ai",
		name: "B.AI",
		description: "api.b.ai — Hunyuan Hy3, MiMo V2.5, Qwen3.8, DeepSeek V4.1 Flash, GLM 5.3 Flash (5 models)",
		defaultPoolId: "bai",
		baseUrl: "https://api.b.ai/v1",
		api: "openai-completions",
		compat: BAI_COMPAT,
		keyHint: "https://www.b.ai/ → API Keys (one entry per key; multiple keys share the load)",
		models: [
			{
				// docs.b.ai/llmservice/models/hy3 — Tencent modes: no_think / think_low / think_high.
				id: "hy3",
				name: "Hunyuan Hy3",
				reasoning: true,
				input: ["text"],
				contextWindow: 262_144,
				maxTokens: 131_072,
				thinkingLevelMap: levels({ off: "none", low: "low", high: "high" }),
			},
			{
				// docs.b.ai/llmservice/models/mimo-v2.5 + Xiaomi official: only `none` disables
				// thinking; low/medium/high are accepted but behave identically. b.ai rejects
				// minimal/xhigh/max with HTTP 400.
				id: "mimo-v2.5",
				name: "Xiaomi MiMo V2.5",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 1_000_000,
				maxTokens: 131_072,
				thinkingLevelMap: levels({ off: "none", high: "high" }),
			},
			{
				// docs.b.ai/llmservice/models/qwen3-8-flash — tiers offered: off/low/medium/xhigh.
				id: "qwen3.8-flash",
				name: "Qwen3.8 Flash",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 1_000_000,
				maxTokens: 131_072,
				thinkingLevelMap: levels({ off: "none", low: "low", medium: "medium", xhigh: "xhigh" }),
			},
			{
				// b.ai /v1/models lists `deepseek-v4.1-flash` (bare ids only, no
				// limit fields — verified live 2026-09-21). Sizes from catalog
				// consensus (models.dev opencode/greenpt rows + the same model
				// behind cline-free/deepseek-v4.1-flash, verified live 2026-09-17):
				// ctx 1M, out 384K. Text+image input (models.dev opencode row).
				// Thinking tiers probed live on b.ai 2026-09-25 (paid key, exact pi
				// request shape: thinking.enabled + reasoning_effort): every level is
				// accepted — the mimo-v2.5-style HTTP 400 for minimal/xhigh/max does
				// NOT apply to this model. DeepSeek official exposes only
				// low/high/max, and low vs high are behaviorally distinct in reasoning
				// length, so minimal/medium/xhigh stay hidden (b.ai accepts them but
				// treats them as duplicates).
				id: "deepseek-v4.1-flash",
				name: "DeepSeek V4.1 Flash",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 1_000_000,
				maxTokens: 384_000,
				thinkingLevelMap: levels({ off: "none", low: "low", high: "high", max: "max" }),
			},
			{
				// b.ai /v1/models lists `glm-5.3-flash` (bare ids only — verified
				// live 2026-09-21). Sizes from catalog consensus (models.dev
				// zhipuai/zai rows): ctx 1M, out 128K. Upstream inputs
				// text/image/video/pdf (pi tracks text + image, like mimo-v2.5).
				// Thinking tiers UNVERIFIED on b.ai: conservative off/high only
				// (deepseek-v4.1-flash was verified and widened 2026-09-25 — probe this
				// model the same way before widening).
				id: "glm-5.3-flash",
				name: "GLM 5.3 Flash",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 1_000_000,
				maxTokens: 131_072,
				thinkingLevelMap: levels({ off: "none", high: "high" }),
			},
		],
	},
	{
		id: "opencode-zen",
		name: "OpenCode Zen",
		description: "opencode.ai/zen free tier — Big Pickle, MiMo V2.6 Flash, MiMo V2.5, Ling 3.0 Fin, Nemotron 3 Ultra/Lightning, Muse Spark 1.3 (7 free models)",
		defaultPoolId: "zen",
		// Inference gateway, not zen/v1: the v2 client's console /api/v2/config
		// prescribes this as the opencode provider baseURL, and the free lineup
		// is served here against workspace quota. zen/v1 only has the anonymous
		// per-IP quota, which datacenter egress IPs exhaust almost immediately
		// (HTTP 429 FreeUsageLimitError on every request). Verified live 2026-09-21.
		baseUrl: "https://opencode.ai/inference/openai/v1",
		api: "openai-completions",
		keyHint: "https://opencode.ai/auth → sign in → workspace Keys page (one entry per key; multiple keys share the load)",
		models: [
			{
				// models.dev `opencode` provider + pi built-in catalog. Stealth model;
				// always-on reasoning with no effort control (no thinkingLevelMap, like pi's catalog).
				id: "big-pickle",
				name: "Big Pickle",
				reasoning: true,
				input: ["text"],
				contextWindow: 200_000,
				maxTokens: 32_000,
				compat: ZEN_CHAT_COMPAT,
			},
			{
				// Xiaomi MiMo-V2.6-Flash, released to the Zen free tier 2026-09-22 and
				// the successor of mimo-v2.5-free (docs opencode.ai/docs/zen lists both,
				// in that order). Limits are authoritative from console /api/v2/config
				// `providers.opencode.models` and mirrored exactly by models.dev:
				// ctx 200,000 / out 32,000, tools on, cost 0. Upstream inputs
				// text/image/audio/video/pdf (pi tracks text + image, like mimo-v2.5).
				// Reasoning is always-on with no effort control: models.dev reports
				// `reasoning: true`, `reasoning_options: []`, `interleaved.field =
				// reasoning_content`; verified live 2026-09-22 that reasoning_content
				// streams separately and usage reports reasoning_tokens — so, like the
				// rest of the free lineup, no thinkingLevelMap.
				// Verified live 2026-09-22 (agentic probe shape, see probe.ts): streaming
				// chat with the read/shell/edit/write quartet → 200, content "PONG",
				// finish stop, usage {prompt 191, completion 13, reasoning 9}; the same
				// request without tools/stream → 403 FreeTierError, confirming the gate
				// still applies to this model id.
				id: "mimo-v2.6-flash-free",
				name: "MiMo V2.6 Flash Free",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 200_000,
				maxTokens: 127_000,
				compat: ZEN_CHAT_COMPAT,
			},
			{
				// Xiaomi MiMo V2.5 omni; raw model is 1M ctx but the Zen FREE tier serves 200K/32K.
				// Repo metadata: inputs text/image/audio/video (pi tracks text + image),
				// reasoning via separate reasoning_content stream, no reasoning_options.
				// Still listed in opencode.ai/docs/zen's free lineup and still answers 200
				// (verified live 2026-09-22), but it disappeared from the console
				// /api/v2/config model map that day when mimo-v2.6-flash-free landed —
				// kept because it demonstrably works; drop it when it 404s.
				id: "mimo-v2.5-free",
				name: "MiMo V2.5 Free",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 200_000,
				maxTokens: 32_000,
				compat: ZEN_CHAT_COMPAT,
			},
			{
				// Finance-tuned Ling 3.0 Flash; reasoning toggle only (no effort tiers).
				id: "ling-3.0-flash-fin-free",
				name: "Ling 3.0 Flash Fin Free",
				reasoning: true,
				input: ["text"],
				contextWindow: 262_144,
				maxTokens: 32_768,
				compat: ZEN_CHAT_COMPAT,
			},
			{
				// NVIDIA Nemotron 3 Ultra; largest open-weight reasoning model on the free tier.
				id: "nemotron-3-ultra-free",
				name: "Nemotron 3 Ultra Free",
				reasoning: true,
				input: ["text"],
				contextWindow: 1_000_000,
				maxTokens: 128_000,
				compat: ZEN_CHAT_COMPAT,
			},
			{
				// NVIDIA Nemotron 3.5 Lightning (MoE); fast agentic model, 262K output cap.
				id: "nemotron-3.5-lightning-free",
				name: "Nemotron 3.5 Lightning Free",
				reasoning: true,
				input: ["text"],
				contextWindow: 262_144,
				maxTokens: 262_144,
				compat: ZEN_CHAT_COMPAT,
			},
			{
				// Meta Muse Spark 1.3 Contributor Free — OpenAI Responses API endpoint (not chat
				// completions). Repo metadata: no reasoning_options (always-on reasoning, no
				// effort control), reasoning bundled into content (no separate stream field);
				// inputs text/image/video/pdf/audio (pi tracks text + image).
				// muse-spark-1.2-contributor-free was removed: legacy variant no longer in the
				// free-model list at opencode.ai/docs/zen.
				id: "muse-spark-1.3-contributor-free",
				name: "Muse Spark 1.3 Contributor Free",
				api: "openai-responses",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 1_048_576,
				maxTokens: 131_072,
				compat: { sessionAffinityFormat: "openai-nosession" },
			},
		],
	},
	{
		// Cline's free-model promotion: a Cline account (OAuth, no static API key)
		// gets a daily per-model quota on api.cline.bot's OpenAI-compatible API.
		// The lineup rotates — retired ids answer "model not found" — so the
		// `_preset` sync machinery is the intended way to receive lineup updates.
		// Context/output limits are best-effort (server-enforced); tune per model
		// in multikey.json if a provider rejects long conversations.
		id: "cline-free",
		name: "Cline Free",
		description:
			"api.cline.bot — Cline account free tier: DeepSeek V4.1 Flash, Laguna S 2.1, GLM 5.3, Solar Pro 4, Muse Spark 1.3, Union Alpha (daily per-model quota, lineup rotates)",
		defaultPoolId: "cline",
		baseUrl: "https://api.cline.bot/api/v1",
		api: "openai-completions",
		keyHint: "Cline account — use 'Sign in with Cline (device flow)', or paste an access token from ~/.cline/data/secrets.json",
		// FREE-TIER MODEL IDS ARE EXACT — copy them from the `free` bucket of
		// GET /api/v1/ai/cline/recommended-models, NOT from GET /models (the
		// OpenRouter catalog dump). Entries prefixed `cline-free/` are only free
		// under that exact id: their raw vendor id (e.g. deepseek/deepseek-v4.1-flash)
		// routes to usage-based billing and answers 402 insufficient_credits on a
		// zero-balance account, while the cline-free/ id rides the daily per-model
		// quota ($0). The cline-free/ namespace is additionally gated on the
		// X-CLIENT-TYPE header — already sent on every request via
		// endpointHeaders() in config.ts, so no extra config is needed.
		// Verified live 2026-09-17 (probe account, multikey's exact header set):
		// raw deepseek-v4.1-flash → 402; cline-free/deepseek-v4.1-flash → 200, $0.
		models: [
			{
				// Feed id: cline-free/deepseek-v4.1-flash. The raw id
				// (deepseek/deepseek-v4.1-flash) is usage-billed — see the comment above.
				// Catalog (openrouter): ctx 1048576, out 384000 (both verified live), text+image.
				// Effort tiers verified live via reasoning:{effort} (incl. "none" = reasoning off).
				// DeepSeek official tiers are only low/high/max, so minimal/medium/xhigh stay hidden.
				id: "cline-free/deepseek-v4.1-flash",
				name: "DeepSeek V4.1 Flash (Free)",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 1_048_576,
				maxTokens: 384_000,
				compat: { thinkingFormat: "openrouter" },
				thinkingLevelMap: levels({ off: "none", low: "low", high: "high", max: "max" }),
			},
			{
				// Free at its raw id (no cline-free/ prefix in the feed); 262K window measured
				// live by the preset author. Not in any catalog (stealth) — sizes unverified.
				id: "poolside/laguna-s-2.1:free",
				name: "Laguna S 2.1 (Free)",
				reasoning: true,
				input: ["text"],
				contextWindow: 262_144,
				maxTokens: 32_768,
			},
			{
				// z-ai/glm-5.2:free retired from the Cline lineup (id answers "model not found");
				// succeeded by glm-5.3-flash. Always-on reasoning, no effort tiers; vision input.
				id: "z-ai/glm-5.3-flash",
				name: "GLM 5.3 (Free)",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 1_048_576,
				maxTokens: 128_000,
			},
			{
				// Feed id: cline-free/solar-pro4 (raw upstage/solar-pro4 is usage-billed).
				// Catalog: ctx 524288 (1M rejected live: "maximum context length is 524288"),
				// out 131072 (accepted live). Effort: none/high only (verified live).
				id: "cline-free/solar-pro4",
				name: "Upstage Solar Pro 4 (Free)",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 524_288,
				maxTokens: 131_072,
				compat: { thinkingFormat: "openrouter" },
				thinkingLevelMap: levels({ off: "none", high: "high" }),
			},
			{
				// Same Meta model as OpenCode Zen's muse-spark-1.3-contributor-free, served
				// through Cline's chat-completions endpoint (no Responses API / session
				// affinity needed). Always-on reasoning; text + image input.
				// Feed id: cline-free/muse-spark-1.3-contributor (raw meta/… is usage-billed).
				// Catalog: ctx 1048576, out 943718, effort minimal..max (no toggle = always on).
				// NOTE: the cline-free/ id answered "not available in your region" from the
				// PH (2026-09-17 probe); the model may be region-gated on the free tier, so
				// catalog values are unverified against the live free route.
				id: "cline-free/muse-spark-1.3-contributor",
				name: "Meta Muse Spark 1.3 Contributor (Free)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_048_576,
				maxTokens: 943_718,
				compat: { thinkingFormat: "openrouter" },
				thinkingLevelMap: levels({ minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" }),
			},
			{
				// Stealth promo model; free at its raw id (no cline-free/ prefix in the feed).
				// Not in any catalog (stealth) — sizes/reasoning copied from the live pool,
				// unverified.
				id: "stealth/union-alpha",
				name: "Union Alpha",
				reasoning: true,
				input: ["text"],
				contextWindow: 262_000,
				maxTokens: 16_384,
			},
		],
	},
];

export function findPreset(id: string): Preset | undefined {
	return PRESETS.find((p) => p.id === id);
}

/**
 * Stable fingerprint of a preset's model list (sha256, first 16 hex chars).
 * Both sides of the comparison come from presets.ts builds, so JSON key order
 * is deterministic. Covers models only — compat/api/description changes don't
 * trigger update prompts.
 */
export function presetFingerprint(preset: Preset): string {
	return createHash("sha256").update(JSON.stringify(preset.models)).digest("hex").slice(0, 16);
}

export interface PresetModelDiff {
	/** Shipped by the preset but missing from the pool. */
	added: PoolModelConfig[];
	/** Still in the pool but no longer shipped by the preset. */
	removed: PoolModelConfig[];
	/** Same model id, different spec (per-field comparison, order-insensitive). */
	changed: { id: string; fields: string[] }[];
}

/** Compare a pool's current models against the shipped preset models. */
export function diffPresetModels(poolModels: PoolModelConfig[], presetModels: PoolModelConfig[]): PresetModelDiff {
	const poolById = new Map(poolModels.map((m) => [m.id, m]));
	const presetById = new Map(presetModels.map((m) => [m.id, m]));
	const added = presetModels.filter((m) => !poolById.has(m.id));
	const removed = poolModels.filter((m) => !presetById.has(m.id));
	const changed: PresetModelDiff["changed"] = [];
	for (const presetModel of presetModels) {
		const poolModel = poolById.get(presetModel.id);
		if (!poolModel) continue;
		const keys = new Set([...Object.keys(poolModel), ...Object.keys(presetModel)]);
		const pool = poolModel as unknown as Record<string, unknown>;
		const preset = presetModel as unknown as Record<string, unknown>;
		const fields = [...keys].filter((key) => JSON.stringify(pool[key]) !== JSON.stringify(preset[key]));
		if (fields.length > 0) changed.push({ id: presetModel.id, fields });
	}
	return { added, removed, changed };
}

/** Human-readable diff lines for prompts and menus (may be empty). */
export function describePresetDiff(diff: PresetModelDiff): string[] {
	const lines: string[] = [];
	if (diff.added.length > 0) lines.push(`+ added by preset: ${diff.added.map((m) => m.id).join(", ")}`);
	if (diff.removed.length > 0) lines.push(`− removed from preset: ${diff.removed.map((m) => m.id).join(", ")}`);
	for (const change of diff.changed) lines.push(`~ changed: ${change.id} (${change.fields.join(", ")})`);
	return lines;
}

/** Materialize a preset into a pool config with the given keys. */
export function poolFromPreset(preset: Preset, poolId: string, keys: string[]): PoolConfig {
	return {
		id: poolId,
		name: `${preset.name} (Key Pool)`,
		baseUrl: preset.baseUrl,
		api: preset.api,
		compat: preset.compat ? { ...preset.compat } : undefined,
		cooldownMs: 20_000,
		invalidKeyCooldownMs: 600_000,
		keys: keys.map((key, i) => ({ key, label: `key-${i + 1}`, enabled: true })),
		// Deep copy so per-pool edits never mutate the shipped preset.
		models: JSON.parse(JSON.stringify(preset.models)) as PoolModelConfig[],
		// Track the preset version so future preset updates can offer a one-time align.
		_preset: { id: preset.id, fingerprint: presetFingerprint(preset) },
	};
}
