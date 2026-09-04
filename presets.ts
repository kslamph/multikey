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
		description: "api.b.ai — Hunyuan Hy3, MiMo V2.5, Qwen3.8, GLM 5.3 (4 models)",
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
				// docs.b.ai/llmservice/models/glm-5-3-flash — always thinks (off unsupported);
				// reasoning_effort: low/high/max, default max.
				id: "glm-5.3-flash",
				name: "GLM 5.3 Flash",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 1_000_000,
				maxTokens: 131_072,
				thinkingLevelMap: levels({ low: "low", high: "high", max: "max" }),
			},
		],
	},
	{
		id: "opencode-zen",
		name: "OpenCode Zen",
		description: "opencode.ai/zen free tier — Big Pickle, MiMo V2.5, Ling 3.0 Fin, Nemotron 3 Ultra/Lightning, Muse Spark 1.3 (6 free models)",
		defaultPoolId: "zen",
		baseUrl: "https://opencode.ai/zen/v1",
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
				// Xiaomi MiMo V2.5 omni; raw model is 1M ctx but the Zen FREE tier serves 200K/32K.
				// Repo metadata: inputs text/image/audio/video (pi tracks text + image),
				// reasoning via separate reasoning_content stream, no reasoning_options.
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
			"api.cline.bot — Cline account free tier: DeepSeek V4 Flash, Longcat 2.0, Laguna S 2.1, GLM 5.2 (daily per-model quota, lineup rotates)",
		defaultPoolId: "cline",
		baseUrl: "https://api.cline.bot/api/v1",
		api: "openai-completions",
		keyHint: "Cline account — use 'Sign in with Cline (device flow)', or paste an access token from ~/.cline/data/secrets.json",
		models: [
			{
				id: "deepseek/deepseek-v4-flash",
				name: "DeepSeek V4 Flash",
				reasoning: true,
				input: ["text"],
				contextWindow: 1_000_000,
				maxTokens: 131_072,
			},
			{
				id: "meituan/longcat-2.0",
				name: "Longcat 2.0",
				reasoning: true,
				input: ["text"],
				contextWindow: 1_000_000,
				maxTokens: 131_072,
			},
			{
				id: "poolside/laguna-s-2.1:free",
				name: "Laguna S 2.1 (Free)",
				reasoning: true,
				input: ["text"],
				// Poolside doesn't publish the window; safe default, tune if needed.
				contextWindow: 128_000,
				maxTokens: 16_384,
			},
			{
				id: "z-ai/glm-5.2:free",
				name: "GLM 5.2 (Free)",
				reasoning: true,
				input: ["text"],
				contextWindow: 200_000,
				maxTokens: 131_072,
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
