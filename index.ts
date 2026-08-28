/**
 * keypool — one pi provider, many API keys.
 *
 * Every pool in ~/.pi/agent/keypool.json is registered as a pi provider.
 * Requests are spread across the pool's keys (least-loaded, least-recently-used),
 * and any 429/401/403 rotates to the next key with a cooldown — including across
 * concurrent subagents, since each in-flight request holds its own key lease.
 *
 * Manage everything with the /keypool command (better-custom style TUI).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig, toProviderModels, type KeypoolConfig, type PoolConfig } from "./config.ts";
import { KeyPool } from "./pool.ts";
import { createRotatingStreamSimple } from "./stream.ts";
import { runManager, type ManagerHooks } from "./manage.ts";

export default function keypool(pi: ExtensionAPI) {
	let config: KeypoolConfig;
	let created = false;
	try {
		const loaded = loadConfig();
		config = loaded.config;
		created = loaded.created;
	} catch (error) {
		// Never break pi startup over config problems.
		console.error(`[keypool] failed to load config: ${error instanceof Error ? error.message : String(error)}`);
		config = { pools: [] };
	}

	const pools = new Map<string, KeyPool>();
	for (const pool of config.pools) pools.set(pool.id, new KeyPool(pool));

	let ui: ExtensionContext["ui"] | undefined;
	const notify = (message: string) => {
		try {
			ui?.notify(message, "info");
		} catch {
			// UI may be gone (reload/shutdown); notifications are best-effort.
		}
	};

	function registerPool(pool: PoolConfig) {
		if (pool.keys.length === 0 || pool.models.length === 0) return;
		const keyPool = pools.get(pool.id) ?? new KeyPool(pool);
		keyPool.updateConfig(pool);
		pools.set(pool.id, keyPool);

		pi.registerProvider(pool.id, {
			name: pool.name ?? pool.id,
			baseUrl: pool.baseUrl,
			// Real keys are injected per-request by the rotating stream function.
			apiKey: "keypool-managed",
			api: pool.api ?? "openai-completions",
			headers: pool.headers,
			models: toProviderModels(pool),
			streamSimple: createRotatingStreamSimple(keyPool, pool.api ?? "openai-completions", notify),
		});
	}

	function saveAndReregister(poolId: string) {
		saveConfig(config);
		const pool = config.pools.find((p) => p.id === poolId);
		if (!pool) return;
		if (pool.keys.length === 0 || pool.models.length === 0) {
			// Nothing usable to expose; drop any previous registration.
			try {
				pi.unregisterProvider(poolId);
			} catch {
				// Not registered yet.
			}
			return;
		}
		registerPool(pool);
	}

	function removePool(poolId: string) {
		config.pools = config.pools.filter((p) => p.id !== poolId);
		pools.delete(poolId);
		saveConfig(config);
		try {
			pi.unregisterProvider(poolId);
		} catch {
			// Not registered yet.
		}
	}

	function reloadFromDisk() {
		const loaded = loadConfig();
		config = loaded.config;
		const seen = new Set<string>();
		for (const pool of config.pools) {
			seen.add(pool.id);
			registerPool(pool);
		}
		for (const id of [...pools.keys()]) {
			if (!seen.has(id)) removePool(id);
		}
	}

	// Register every pool up front so models are available during startup
	// and to `pi --list-models`.
	for (const pool of config.pools) {
		try {
			registerPool(pool);
		} catch (error) {
			console.error(`[keypool] failed to register provider "${pool.id}": ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		ui = ctx.ui;
		if (created) {
			const path = process.env.KEYPOOL_CONFIG ?? "~/.pi/agent/keypool.json";
			if (config.pools.length > 0) {
				const summary = config.pools.map((p) => `"${p.id}" (${p.keys.length} keys, ${p.models.length} models)`).join(", ");
				notify(`keypool: created ${path} from your models.json — pool ${summary}. Manage with /keypool.`);
			} else {
				notify(`keypool: no multi-key providers found in models.json — run /keypool → Add pool to create one at ${path}.`);
			}
		}
	});

	pi.registerCommand("keypool", {
		description: "Manage key pools: keys, models, endpoints, cooldowns, live status",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("keypool: interactive management requires a TUI session", "error");
				return;
			}
			const hooks: ManagerHooks = {
				get config() {
					return config;
				},
				pools,
				saveAndReregister,
				removePool,
				reloadFromDisk,
				notify,
			};
			await runManager(pi, ctx, hooks);
		},
	});
}
