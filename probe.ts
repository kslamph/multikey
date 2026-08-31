import { endpointHeaders } from "./config.ts";

/**
 * Endpoint probing: auto-detect the auth header style and fetch the model list.
 *
 * Strategy (no questions asked):
 *   1. GET <baseUrl>/models with `Authorization: Bearer <key>` — if 200, we have
 *      the model list. If 401/403, retry with `x-api-key: <key>`.
 *   2. /models is public on some gateways, so a 200 there doesn't prove the key
 *      works. We therefore verify auth with a tiny 1-token chat request using
 *      the detected style; 401/403 there rotates to the other style.
 *   3. If even the chat probe accepts a bogus key, the endpoint simply doesn't
 *      check keys — we proceed with the default (bearer) and say so.
 *
 * Everything degrades gracefully: probe failures never block pool creation,
 * they only downgrade to manual model entry.
 */

export type AuthStyle = "bearer" | "api-key";

export interface RemoteModel {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	input?: ("text" | "image")[];
	reasoning?: boolean;
}

export interface ProbeResult {
	/** True when a model list was fetched (even from an open endpoint). */
	ok: boolean;
	/** Auth header style that verified (or the safe default when unverifiable). */
	auth: AuthStyle;
	/** "confirmed" = chat probe proved it · "unverified" = endpoint open / unreachable · "rejected" = both styles got 401/403. */
	authStatus: "confirmed" | "unverified" | "rejected";
	modelsUrl?: string;
	models?: RemoteModel[];
	/** Human-readable attempt log for transparency in the TUI. */
	log: string[];
}

const MODELS_TIMEOUT_MS = 12_000;
const CHAT_TIMEOUT_MS = 25_000;

function trimSlash(url: string): string {
	return url.replace(/\/+$/, "");
}

/** Candidate /models URLs: <base>/models, and <base>/v1/models when the base doesn't already end in a version segment. */
export function modelsUrlCandidates(baseUrl: string): string[] {
	const base = trimSlash(baseUrl);
	const candidates = [`${base}/models`];
	if (!/\/v\d+(?:beta|preview)?$/.test(base)) candidates.push(`${base}/v1/models`);
	return [...new Set(candidates)];
}

function authHeaders(style: AuthStyle, key: string): Record<string, string> {
	return style === "bearer" ? { Authorization: `Bearer ${key}` } : { "x-api-key": key };
}

async function fetchJson(url: string, headers: Record<string, string>, timeoutMs: number, baseUrl?: string): Promise<{ status: number; body?: unknown }> {
	try {
		const response = await fetch(url, {
			method: "GET",
			headers: { Accept: "application/json", ...endpointHeaders(baseUrl ?? url), ...headers },
			signal: AbortSignal.timeout(timeoutMs),
		});
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			// Non-JSON body (HTML error page etc.) — status is still meaningful.
		}
		return { status: response.status, body };
	} catch (error) {
		throw new Error(error instanceof Error ? error.message : String(error));
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function firstNumber(source: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	}
	return undefined;
}

/** Extract model entries from the many /models response shapes (OpenAI `{data:[]}`, bare array, `{models:[]}`). */
export function parseModelsResponse(body: unknown): RemoteModel[] {
	const root = asRecord(body);
	const list = Array.isArray(body) ? body : (root?.data ?? root?.models);
	if (!Array.isArray(list)) return [];

	const models: RemoteModel[] = [];
	for (const entry of list) {
		if (typeof entry === "string") {
			if (entry.trim()) models.push({ id: entry.trim() });
			continue;
		}
		const record = asRecord(entry);
		if (!record) continue;
		const id = typeof record.id === "string" && record.id.trim()
			? record.id.trim()
			: typeof record.model === "string" && record.model.trim()
				? record.model.trim()
				: typeof record.name === "string" && record.name.trim()
					? record.name.trim()
					: undefined;
		if (!id) continue;

		const model: RemoteModel = { id };
		if (typeof record.name === "string" && record.name.trim() && record.name.trim() !== id) model.name = record.name.trim();
		else if (typeof record.display_name === "string" && record.display_name.trim() && record.display_name.trim() !== id) model.name = record.display_name.trim();

		const contextWindow = firstNumber(record, ["context_length", "context_window", "max_model_len", "max_context_length", "context_size"]);
		if (contextWindow) model.contextWindow = contextWindow;

		const maxTokens = firstNumber(record, ["max_output_tokens", "max_completion_tokens", "output_token_limit"]);
		if (maxTokens) model.maxTokens = maxTokens;

		const modalities = record.input_modalities ?? asRecord(record.architecture)?.input_modalities;
		if (Array.isArray(modalities)) {
			const input: ("text" | "image")[] = ["text"];
			if (modalities.some((m) => typeof m === "string" && m.toLowerCase() === "image")) input.push("image");
			model.input = input;
		} else if (typeof modalities === "string" && modalities.toLowerCase() === "image") {
			model.input = ["text", "image"];
		}

		const reasoningFlag = asRecord(record.reasoning)?.supported ?? record.reasoning_supported;
		if (typeof reasoningFlag === "boolean") model.reasoning = reasoningFlag;

		models.push(model);
	}
	return models;
}

/**
 * Verify a key with a minimal chat completion (a few tokens at most). Returns
 * "ok" when auth was accepted (2xx, or 4xx that clearly got past auth like a
 * bad-model/params 400/404), "rejected" on 401/403, "error" on network trouble.
 */
async function chatProbe(baseUrl: string, style: AuthStyle, key: string, modelId: string): Promise<"ok" | "rejected" | "error"> {
	try {
		const response = await fetch(`${trimSlash(baseUrl)}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...endpointHeaders(baseUrl), ...authHeaders(style, key) },
			body: JSON.stringify({ model: modelId, max_tokens: 4, messages: [{ role: "user", content: "ping" }] }),
			signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
		});
		if (response.status === 401 || response.status === 403) return "rejected";
		return "ok"; // 2xx, or 4xx past auth (bad model / params) — auth itself worked.
	} catch {
		return "error";
	}
}

/**
 * Probe an endpoint with the user's key: detect auth style, verify the key,
 * and fetch the selectable model list. `chatModelId` (from the fetched list or
 * a previously configured model) enables the chat auth verification.
 */
export async function probeEndpoint(
	baseUrl: string,
	key: string,
	options?: { chatModelId?: string; authHint?: AuthStyle; onLog?: (line: string) => void },
): Promise<ProbeResult> {
	const log: string[] = [];
	const emit = (line: string) => {
		log.push(line);
		options?.onLog?.(line);
	};
	const styles: AuthStyle[] = options?.authHint === "api-key" ? ["api-key", "bearer"] : ["bearer", "api-key"];

	// --- 1. Fetch the model list, rotating auth styles on 401/403. ---
	let models: RemoteModel[] | undefined;
	let modelsUrl: string | undefined;
	let auth: AuthStyle = styles[0]!;
	let listAuthRejected = true; // did /models itself reject every style?

	for (const style of styles) {
		for (const url of modelsUrlCandidates(baseUrl)) {
			let result: { status: number; body?: unknown };
			try {
				emit(`GET ${url} (${style === "bearer" ? "Authorization: Bearer" : "x-api-key"})…`);
				result = await fetchJson(url, authHeaders(style, key), MODELS_TIMEOUT_MS, baseUrl);
			} catch (error) {
				emit(`   network error: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			if (result.status === 200) {
				const parsed = parseModelsResponse(result.body);
				if (parsed.length > 0) {
					models = parsed;
					modelsUrl = url;
					auth = style;
					listAuthRejected = false;
					emit(`   200 — ${parsed.length} model(s) listed`);
					break;
				}
				emit(`   200 but no models recognized in response`);
				continue;
			}
			emit(`   HTTP ${result.status}`);
			if (result.status !== 401 && result.status !== 403) continue; // 404 etc: try next URL form
		}
		if (models) break;
	}

	// --- 2. Verify auth with a tiny chat request (models lists can be public). ---
	const chatModelId =
		options?.chatModelId ?? (models && models.length > 0 ? models.find((m) => m.id.toLowerCase().includes("free"))?.id ?? models[0]!.id : undefined);
	let authStatus: ProbeResult["authStatus"] = "unverified";

	if (chatModelId) {
		let verified: AuthStyle | undefined;
		for (const style of styles) {
			emit(`auth check: 1-token chat on "${chatModelId}" with ${style === "bearer" ? "Bearer" : "x-api-key"}…`);
			const verdict = await chatProbe(baseUrl, style, key, chatModelId);
			if (verdict === "ok") {
				verified = style;
				emit(`   accepted ✓ (style: ${style === "bearer" ? "Authorization: Bearer" : "x-api-key"})`);
				break;
			}
			emit(`   ${verdict === "rejected" ? "rejected (401/403)" : "network error"}`);
		}

		if (verified) {
			auth = verified;
			authStatus = "confirmed";
		} else if (listAuthRejected) {
			// /models also rejected the key with every style — likely a bad key.
			authStatus = "rejected";
		} else {
			// Models listed fine but chat auth unverifiable: maybe the endpoint is open.
			try {
				emit(`auth check: same chat with a dummy key to detect open endpoints…`);
				const bogus = await chatProbe(baseUrl, "bearer", "multikey-open-endpoint-check", chatModelId);
				if (bogus === "ok") {
					emit(`   accepted — endpoint does not verify keys (open endpoint)`);
				} else {
					emit(`   rejected — key was not verified; double-check it`);
					authStatus = "rejected";
				}
			} catch {
				authStatus = "unverified";
			}
		}
	} else {
		emit("no model id available — skipping chat auth check");
	}

	return {
		ok: models !== undefined,
		auth,
		authStatus,
		modelsUrl,
		models,
		log,
	};
}
