/**
 * multikey — one pi provider, many API keys.
 *
 * Every pool in ~/.pi/agent/multikey.json is registered as a pi provider.
 * Requests are spread across the pool's keys (least-loaded, least-recently-used),
 * and any 429/401/403 rotates to the next key with a cooldown — including across
 * concurrent subagents, since each in-flight request holds its own key lease.
 *
 * Manage everything with the /multikey command (better-custom style TUI).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getApiProvider, type Api } from "@earendil-works/pi-ai";
import { configPath, endpointHeaders, loadConfig, saveConfig, toProviderModels, type KeypoolConfig, type PoolConfig } from "./config.ts";
import { KeyPool } from "./pool.ts";
import { createRotatingStreamSimple } from "./stream.ts";
import { runManager, type ManagerHooks } from "./manage.ts";

type CommandContext = Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1];

export default function multikey(pi: ExtensionAPI) {
	let config: KeypoolConfig;
	let created = false;
	let migratedFrom: string | undefined;
	try {
		const loaded = loadConfig();
		config = loaded.config;
		created = loaded.created;
		migratedFrom = loaded.migratedFrom;
	} catch (error) {
		// Never break pi startup over config problems.
		console.error(`[multikey] failed to load config: ${error instanceof Error ? error.message : String(error)}`);
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

	/**
	 * Register a pool as a pi provider. Returns undefined on success, or a
	 * human-readable reason why the pool was skipped (unknown api, incomplete).
	 */
	function registerPool(pool: PoolConfig): string | undefined {
		if (pool.keys.length === 0 || pool.models.length === 0) {
			return pool.keys.length === 0 ? "no API keys" : "no models";
		}
		const api = pool.api ?? "openai-completions";
		if (!getApiProvider(api as Api)) {
			// Never throw at startup over a bad api value; report it instead so
			// the user gets a fix hint (and /multikey marks the pool broken).
			return `unknown api type "${api}" (edit the pool and pick a valid API type)`;
		}
		const keyPool = pools.get(pool.id) ?? new KeyPool(pool);
		keyPool.updateConfig(pool);
		pools.set(pool.id, keyPool);

		pi.registerProvider(pool.id, {
			name: pool.name ?? pool.id,
			baseUrl: pool.baseUrl,
			// Real keys are injected per-request by the rotating stream function.
			apiKey: "multikey-managed",
			api,
			headers: { ...pool.headers, ...endpointHeaders(pool.baseUrl) },
			models: toProviderModels(pool),
			streamSimple: createRotatingStreamSimple(keyPool, api, notify),
		});
		return undefined;
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
		const error = registerPool(pool);
		if (error) notify(`multikey[${poolId}]: provider not registered: ${error}`);
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
			const error = registerPool(pool);
			if (error) notify(`multikey[${pool.id}]: provider not registered: ${error}`);
		}
		for (const id of [...pools.keys()]) {
			if (!seen.has(id)) removePool(id);
		}
	}

	// Register every pool up front so models are available during startup
	// and to `pi --list-models`. Broken pools are collected for a friendly
	// session-start hint instead of a bare console error.
	const skipped: { id: string; reason: string }[] = [];
	for (const pool of config.pools) {
		try {
			const error = registerPool(pool);
			if (error) skipped.push({ id: pool.id, reason: error });
		} catch (error) {
			skipped.push({ id: pool.id, reason: error instanceof Error ? error.message : String(error) });
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		ui = ctx.ui;
		for (const { id, reason } of skipped) {
			notify(`multikey: provider "${id}" not available — ${reason}. Fix it via /multikey → Manage pools.`);
		}
		skipped.length = 0;
		if (migratedFrom) {
			notify(`multikey: migrated config from ${migratedFrom} to ${configPath()} (old file kept as backup).`);
		}
		if (created) {
			const path = configPath();
			if (config.pools.length > 0) {
				const summary = config.pools.map((p) => `"${p.id}" (${p.keys.length} keys, ${p.models.length} models)`).join(", ");
				notify(`multikey: created ${path} from your models.json — pool ${summary}. Manage with /multikey.`);
			} else {
				notify(`multikey: no multi-key providers found in models.json — run /multikey → Add pool to create one at ${path}.`);
			}
		}
	});

	const managerHandler = async (_args: unknown, ctx: CommandContext) => {
		if (!ctx.hasUI) {
			ctx.ui.notify("multikey: interactive management requires a TUI session", "error");
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
	};

	pi.registerCommand("multikey", {
		description: "Many API keys per provider: 429 rotation, cooldowns, live status",
		handler: managerHandler,
	});
	// Legacy alias from the pre-rename days — same manager.
	pi.registerCommand("keypool", {
		description: "Alias of /multikey",
		handler: managerHandler,
	});
}
