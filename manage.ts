/**
 * /keypool management menus: pools, keys, models, settings — better-custom style.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { maskKey, type KeypoolConfig, type PoolConfig, type PoolKeyConfig, type PoolModelConfig } from "./config.ts";
import type { KeyPool } from "./pool.ts";
import { findPreset, poolFromPreset, type Preset } from "./presets.ts";
import { inputNumber, pickMany, selectOne, showInfo } from "./tui.ts";

type CommandContext = Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1];

export interface ManagerHooks {
	config: KeypoolConfig;
	pools: Map<string, KeyPool>;
	saveAndReregister(poolId: string): void;
	removePool(poolId: string): void;
	notify(message: string): void;
}

const DEFAULT_MODEL_TEMPLATE: PoolModelConfig = {
	id: "new-model",
	name: "new-model",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 16_384,
};

export async function runManager(pi: ExtensionAPI, ctx: CommandContext, hooks: ManagerHooks): Promise<void> {
	for (;;) {
		const pools = hooks.config.pools;
		const action = await selectOne(ctx, "Key Pool Manager", [
			{ value: "status", label: "Status", description: "Live per-key state: in-flight, cooldowns, 429 counts" },
			{ value: "manage", label: "Manage pools…", description: "Keys, models, endpoints, cooldowns" },
			{ value: "add", label: "Add pool…", description: "Register another provider (b.ai, nvidia, opencode, …)" },
			{ value: "reload", label: "Reload config from disk", description: "Re-read keypool.json and re-register providers" },
			{ value: "usage", label: "Usage tips" },
			{ value: "exit", label: "Close" },
		]);
		if (action === null || action === "exit") return;

		if (action === "reload") {
			reloadFromDiskSafe(hooks);
			continue;
		}
		if (action === "status") {
			await showInfo(ctx, "Key Pool Status", renderStatus(hooks));
			continue;
		}
		if (action === "usage") {
			await showInfo(ctx, "Usage tips", [
				"• Concurrency: every in-flight request (main agent or subagents) picks the least-loaded key,",
				"  so parallel subagents automatically land on different keys.",
				"• 429: the key gets a cooldown (default 20s, retry-after honored) and the request instantly",
				"  retries on the next key — no error reaches the agent unless every key is exhausted.",
				"• Point subagents at e.g. <pool-id>/<model-id> in settings.json agentOverrides (pool id = provider name).",
				`• Config file: ${process.env.KEYPOOL_CONFIG ?? "~/.pi/agent/keypool.json"}`,
			]);
			continue;
		}
		if (action === "add") {
			await addPoolWizard(ctx, hooks);
			continue;
		}
		if (action === "manage") {
			const poolId = await selectOne(
				ctx,
				"Select pool",
				pools.map((p) => ({
					value: p.id,
					label: p.id,
					suffix: p.name && p.name !== p.id ? ` — ${p.name}` : "",
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
		hooks.notify("keypool: reloaded config from disk");
	} catch (error) {
		hooks.notify(`keypool: reload failed: ${error instanceof Error ? error.message : String(error)}`);
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
					? `cooldown ${Math.ceil(row.cooldownRemainingMs / 1000)}s (${row.cooldownReason ?? "?"})`
					: row.inflight > 0
						? `active ×${row.inflight}`
						: "idle";
			lines.push(
				`  ${row.label.padEnd(12)} ${row.masked.padEnd(16)} ${state.padEnd(24)} ok:${row.ok} 429:${row.rateLimited} bad:${row.invalid} err:${row.errors}`,
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
		const action = await selectOne(ctx, `Pool: ${pool.id}`, [
			{ value: "keys", label: "Keys…", description: pool.keys.map((k) => `${k.label ?? maskKey(k.key)}${k.enabled === false ? " (disabled)" : ""}`).join(", ") || "none" },
			{ value: "models", label: "Models…", description: `${pool.models.length} models` },
			{ value: "settings", label: "Endpoint & settings…", description: `${pool.baseUrl} · api: ${pool.api ?? "openai-completions"}` },
			{ value: "delete", label: "Delete pool", description: "Removes the provider from pi and the config file" },
			{ value: "back", label: "Back" },
		]);
		if (action === null || action === "back") return;
		if (action === "keys") await keysMenu(ctx, hooks, pool);
		else if (action === "models") await modelsMenu(ctx, hooks, pool);
		else if (action === "settings") await settingsMenu(ctx, hooks, pool);
		else if (action === "delete") {
			const ok = await ctx.ui.confirm("Delete pool", `Remove provider "${pool.id}" and its ${pool.keys.length} key(s)?`);
			if (ok) {
				hooks.removePool(pool.id);
				hooks.notify(`keypool: removed provider "${pool.id}"`);
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
					? `cooldown ${Math.ceil(row.cooldownRemainingMs / 1000)}s`
					: row && row.inflight > 0
						? `active ×${row.inflight}`
						: "idle";
			return {
				value: String(i),
				label: k.label ?? maskKey(k.key),
				suffix: `  ${maskKey(k.key)}  ${state}`,
				description: `ok:${row?.ok ?? 0} 429:${row?.rateLimited ?? 0} bad:${row?.invalid ?? 0}`,
			};
		});
		const action = await selectOne(ctx, `Keys: ${pool.id}`, [...items, { value: "__add", label: "＋ Add key…" }, { value: "__back", label: "Back" }]);
		if (action === null || action === "__back") return;
		if (action === "__add") {
			const raw = await ctx.ui.input(`Add API key #${pool.keys.length + 1}`, "paste an API key");
			const value = raw?.trim();
			if (value) {
				if (pool.keys.some((k) => k.key === value)) {
					hooks.notify(`keypool[${pool.id}]: key already in pool`);
				} else {
					pool.keys.push({ key: value, label: `key-${pool.keys.length + 1}`, enabled: true });
					hooks.saveAndReregister(pool.id);
					hooks.notify(`keypool[${pool.id}]: added key ${value.length > 10 ? value.slice(0, 6) + "…" + value.slice(-4) : value}`);
				}
			}
			continue;
		}
		const index = Number(action);
		const key = pool.keys[index];
		if (!key) continue;
		const keyAction = await selectOne(ctx, `Key: ${key.label ?? maskKey(key.key)}`, [
			{ value: "toggle", label: key.enabled === false ? "Enable" : "Disable" },
			{ value: "label", label: "Edit label…" },
			{ value: "replace", label: "Replace value…" },
			{ value: "remove", label: "Remove key" },
			{ value: "back", label: "Back" },
		]);
		if (keyAction === null || keyAction === "back") continue;
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
			hooks.notify(`keypool[${pool.id}]: removed key`);
		}
	}
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

async function modelsMenu(ctx: CommandContext, hooks: ManagerHooks, pool: PoolConfig): Promise<void> {
	for (;;) {
		const items = pool.models.map((m) => ({
			value: m.id,
			label: m.id,
			suffix: m.reasoning ? "  🧠" : "",
			description: `ctx: ${m.contextWindow ?? 128000} · max: ${m.maxTokens ?? 16384} · in: ${(m.input ?? ["text"]).join("+")}`,
		}));
		const action = await selectOne(ctx, `Models: ${pool.id}`, [
			...items,
			{ value: "__add", label: "＋ Add model…" },
			{ value: "__back", label: "Back" },
		]);
		if (action === null || action === "__back") return;
		if (action === "__add") {
			const id = await ctx.ui.input("Model id", "e.g. deepseek-v4-flash");
			if (id === undefined || !id.trim()) continue;
			if (pool.models.some((m) => m.id === id.trim())) {
				hooks.notify(`keypool[${pool.id}]: model "${id}" already exists`);
				continue;
			}
			const model = { ...DEFAULT_MODEL_TEMPLATE, id: id.trim(), name: id.trim() };
			const edited = await editModelJson(ctx, model);
			if (edited) {
				pool.models.push(edited);
				hooks.saveAndReregister(pool.id);
				hooks.notify(`keypool[${pool.id}]: added model ${edited.id}`);
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
			hooks.notify(`keypool[${pool.id}]: removed model`);
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
			const api = await ctx.ui.input("API type", pool.api ?? "openai-completions");
			if (api !== undefined && api.trim()) {
				pool.api = api.trim();
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
		{ value: "custom", label: "Custom…", description: "Enter endpoint, API type, and models yourself" },
	]);
	if (choice === null) return;
	if (choice === "custom") {
		await addCustomPool(ctx, hooks);
		return;
	}
	const preset = findPreset(choice.slice("preset:".length));
	if (preset) await addPresetPool(ctx, hooks, preset);
}

async function askPoolId(ctx: CommandContext, hooks: ManagerHooks, suggested: string): Promise<string | undefined> {
	for (;;) {
		const id = await ctx.ui.input("Provider id in pi", suggested);
		if (id === undefined) return undefined;
		const poolId = id.trim() || suggested;
		if (hooks.config.pools.some((p) => p.id === poolId)) {
			hooks.notify(`keypool: pool "${poolId}" already exists — pick another id`);
			continue;
		}
		return poolId;
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
			hooks.notify("keypool: duplicate key ignored");
			continue;
		}
		keys.push(value);
	}
	return keys;
}

async function addPresetPool(ctx: CommandContext, hooks: ManagerHooks, preset: Preset): Promise<void> {
	const poolId = await askPoolId(ctx, hooks, preset.defaultPoolId);
	if (poolId === undefined) return;
	const keys = await askKeys(ctx, hooks, preset.keyHint);
	if (keys === undefined) return;

	const pool = poolFromPreset(preset, poolId, keys);
	hooks.config.pools.push(pool);
	hooks.saveAndReregister(poolId);
	hooks.notify(
		`keypool: created "${poolId}" from ${preset.name} preset — ${pool.keys.length} key(s), ${pool.models.length} models ready`,
	);
	await showInfo(ctx, `Preset applied: ${preset.name}`, [
		`Provider:  ${poolId}/<model-id>  (e.g. ${poolId}/${pool.models[0]?.id ?? "..."})`,
		`Endpoint:  ${pool.baseUrl}`,
		`Keys:      ${pool.keys.length} loaded`,
		`Models:    ${pool.models.map((m) => m.id).join(", ")}`,
		"",
		"Add more keys anytime: /keypool → Manage pools → Keys.",
		"Model specs (thinking tiers, context, modalities) are preconfigured.",
	]);
}

async function addCustomPool(ctx: CommandContext, hooks: ManagerHooks): Promise<void> {
	const id = await ctx.ui.input("Provider id", "e.g. bai, nvidia, opencode");
	if (id === undefined || !id.trim()) return;
	const poolId = await (async () => {
		if (!hooks.config.pools.some((p) => p.id === id.trim())) return id.trim();
		hooks.notify(`keypool: pool "${id.trim()}" already exists — pick another id`);
		return await askPoolId(ctx, hooks, id.trim());
	})();
	if (poolId === undefined) return;
	const baseUrl = await ctx.ui.input("Base URL", "https://api.example.com/v1");
	if (baseUrl === undefined || !baseUrl.trim()) return;
	const api = await ctx.ui.input("API type", "openai-completions");
	if (api === undefined) return;
	const keys = await askKeys(ctx, hooks);
	if (keys === undefined) return;

	const pool: PoolConfig = {
		id: poolId,
		name: poolId,
		baseUrl: baseUrl.trim(),
		api: api.trim() || "openai-completions",
		cooldownMs: 20_000,
		invalidKeyCooldownMs: 600_000,
		keys: keys.map((key, i) => ({ key, label: `key-${i + 1}`, enabled: true } satisfies PoolKeyConfig)),
		models: [],
	};
	hooks.config.pools.push(pool);
	hooks.saveAndReregister(poolId);
	hooks.notify(`keypool: created pool "${poolId}" with ${keys.length} key(s) — add models next`);

	await modelsMenu(ctx, hooks, pool);
}
