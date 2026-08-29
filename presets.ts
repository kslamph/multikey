/**
 * Built-in provider presets.
 *
 * A preset carries everything except credentials, so adding a provider is just
 * "paste your keys". Model specs here are verified against provider docs and
 * live probes — see README "Presets" for the evidence trail.
 */

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
		description: "api.b.ai — DeepSeek V4 Flash (+vision), Hunyuan Hy3, MiMo V2.5, Qwen3.8, GLM 5.3 (6 models)",
		defaultPoolId: "bai",
		baseUrl: "https://api.b.ai/v1",
		api: "openai-completions",
		compat: BAI_COMPAT,
		keyHint: "https://www.b.ai/ → API Keys (one entry per key; multiple keys share the load)",
		models: [
			{
				// docs.b.ai/llmservice/models/deepseek-v4-flash + api-docs.deepseek.com/guides/thinking_mode
				// Native effort tiers: low/high/max (medium & xhigh alias to high server-side).
				id: "deepseek-v4-flash",
				name: "DeepSeek V4 Flash",
				reasoning: true,
				input: ["text"],
				contextWindow: 1_000_000,
				maxTokens: 384_000,
				thinkingLevelMap: levels({ off: "none", low: "low", high: "high", max: "max" }),
			},
			{
				// No public card; experimental vision build on the same V4 Flash backbone.
				id: "deepseek-v4-flash-vision-exp",
				name: "DeepSeek V4 Flash Vision (exp)",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 1_000_000,
				maxTokens: 384_000,
				thinkingLevelMap: levels({ off: "none", low: "low", high: "high", max: "max" }),
			},
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
		description: "opencode.ai/zen free tier — Big Pickle, MiMo V2.5, Hy3, Ling 3.0 Fin, Nemotron 3 Ultra/Lightning, Muse Spark 1.2 (7 free models)",
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
				id: "mimo-v2.5-free",
				name: "MiMo V2.5 Free",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 200_000,
				maxTokens: 32_000,
				compat: ZEN_CHAT_COMPAT,
			},
			{
				// Tencent Hy3; raw model is 262K ctx but the Zen FREE tier serves 190K/64K.
				// thinkingFormat defaults to reasoning_effort: levels map straight to Hy3's
				// low/medium/high effort tiers; no off toggle on the free endpoint.
				id: "hy3-free",
				name: "Hy3 Free",
				reasoning: true,
				input: ["text"],
				contextWindow: 190_000,
				maxTokens: 64_000,
				thinkingLevelMap: levels({ low: "low", medium: "medium", high: "high" }),
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
				// Meta Muse Spark 1.2 Contributor Free — OpenAI Responses API endpoint (not chat
				// completions), effort tiers minimal..xhigh, no off. compat mirrors pi's catalog.
				id: "muse-spark-1.2-contributor-free",
				name: "Muse Spark 1.2 Contributor Free",
				api: "openai-responses",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 1_048_576,
				maxTokens: 131_072,
				thinkingLevelMap: levels({ minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh" }),
				compat: { sessionAffinityFormat: "openai-nosession" },
			},
		],
	},
];

export function findPreset(id: string): Preset | undefined {
	return PRESETS.find((p) => p.id === id);
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
	};
}
