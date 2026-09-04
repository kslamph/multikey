/**
 * Cline account authentication: WorkOS device flow + access token refresh.
 *
 * Cline's free models are tied to a Cline account (no static API keys), so a
 * pool key can carry a `credential: { kind: "cline-oauth", refreshToken }`
 * instead of a long-lived secret. Endpoints/port/response shapes are ported
 * from the cline SDK (sdk/packages/core/src/auth/cline.ts, production env).
 *
 * Flow:
 *   1. POST api.workos.com/user_management/authorize/device  → device + user code
 *   2. User opens the verification URL in a browser and approves
 *   3. Poll api.workos.com/user_management/authenticate      → WorkOS tokens
 *   4. POST api.cline.bot/api/v1/auth/register               → Cline tokens
 *   5. Refresh: POST api.cline.bot/api/v1/auth/refresh
 *
 * Tokens rotate on every refresh (the refresh token in the response replaces
 * the old one), so callers must persist the result — stream.ts does this via
 * KeyPool.applyClineCredential + the config save hook.
 */

import type { KeyCredential } from "./config.ts";

const WORKOS_API_BASE_URL = "https://api.workos.com";
const WORKOS_DEVICE_AUTHORIZATION_PATH = "/user_management/authorize/device";
const WORKOS_AUTHENTICATE_PATH = "/user_management/authenticate";
/** WorkOS client id of the official Cline CLI (production environment). */
const WORKOS_CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR";

const CLINE_API_BASE_URL = "https://api.cline.bot";
const CLINE_REGISTER_PATH = "/api/v1/auth/register";
const CLINE_REFRESH_PATH = "/api/v1/auth/refresh";

const REQUEST_TIMEOUT_MS = 30_000;
const DEVICE_AUTH_EXPIRES_IN_SECONDS = 300;
const DEVICE_AUTH_INTERVAL_SECONDS = 5;
/** Refresh this long before expiry so requests never race the clock. */
export const REFRESH_BUFFER_MS = 5 * 60_000;

/** Headers sent to Cline API auth endpoints (same client identity as chat requests). */
function clineAuthHeaders(): Record<string, string> {
	return { "Content-Type": "application/json", "User-Agent": "Cline/3.0.61" };
}

export interface ClineTokenUpdate {
	/** New access token (stored as the key's `key` value). */
	accessToken: string;
	/** Replacement refresh token; WorkOS/Cline rotate it on every refresh. */
	refreshToken: string;
	/** Access token expiry in epoch ms, when the server reports one. */
	expiresAt?: number;
}

interface ClineTokenResponse {
	success: boolean;
	data?: {
		accessToken?: string;
		refreshToken?: string;
		expiresAt?: string;
	};
}

function parseExpiresAt(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : undefined;
}

function requireClineTokens(payload: ClineTokenResponse, message: string): ClineTokenUpdate {
	const accessToken = payload.data?.accessToken;
	const refreshToken = payload.data?.refreshToken;
	if (!payload.success || !accessToken || !refreshToken) {
		throw new Error(message);
	}
	// Return the RAW token; the workos: prefix is applied at request time by
	// formatClineAccessToken (idempotent), so it is never doubled.
	return { accessToken, refreshToken, expiresAt: parseExpiresAt(payload.data?.expiresAt) };
}

/** True when the stored access token is missing, expired, or inside the refresh buffer. */
export function isClineTokenStale(credential: KeyCredential, bufferMs = REFRESH_BUFFER_MS): boolean {
	if (!credential.accessToken) return true;
	if (credential.expiresAt === undefined) return false; // unknown expiry: use until a 401 says otherwise
	return credential.expiresAt - Date.now() <= bufferMs;
}

/** Exchange a refresh token for a fresh access (+ rotated refresh) token. */
export async function refreshClineToken(refreshToken: string): Promise<ClineTokenUpdate> {
	const response = await fetch(`${CLINE_API_BASE_URL}${CLINE_REFRESH_PATH}`, {
		method: "POST",
		headers: clineAuthHeaders(),
		body: JSON.stringify({ refreshToken, grantType: "refresh_token" }),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Cline token refresh failed: HTTP ${response.status}${text ? ` — ${text.slice(0, 200)}` : ""}`);
	}
	const payload = (await response.json().catch(() => ({}))) as ClineTokenResponse;
	return requireClineTokens(payload, "Invalid Cline token refresh response");
}

const WORKOS_ACCESS_TOKEN_PREFIX = "workos:";

/**
 * Cline's API requires the WorkOS access token prefixed with the literal
 * string "workos:" in the Authorization header — the official client formats
 * every stored access token this way before sending (formatAccessToken in
 * cline core). A raw JWT gets a generic 401 that looks like a bad key.
 */
export function formatClineAccessToken(accessToken: string): string {
	const token = accessToken.trim();
	return token.toLowerCase().startsWith(WORKOS_ACCESS_TOKEN_PREFIX) ? token : `${WORKOS_ACCESS_TOKEN_PREFIX}${token}`;
}

// Single-flight per refresh token: concurrent subagents hitting the same
// account must share one in-flight refresh instead of racing each other.
const inFlight = new Map<string, Promise<ClineTokenUpdate>>();

/**
 * Return a usable access token for the credential, refreshing when stale.
 * Pass `force` after a 401 to refresh even if the token looks valid.
 */
export async function ensureClineAccessToken(
	credential: KeyCredential,
	options?: { force?: boolean },
): Promise<ClineTokenUpdate & { refreshed: boolean }> {
	const force = options?.force === true;
	if (!force && !isClineTokenStale(credential) && credential.accessToken) {
		return {
			accessToken: formatClineAccessToken(credential.accessToken),
			refreshToken: credential.refreshToken,
			expiresAt: credential.expiresAt,
			refreshed: false,
		};
	}
	const existing = inFlight.get(credential.refreshToken);
	if (existing) return { ...(await existing), refreshed: true };
	const task = refreshClineToken(credential.refreshToken).finally(() => {
		inFlight.delete(credential.refreshToken);
	});
	inFlight.set(credential.refreshToken, task);
	const update = await task;
	return { ...update, accessToken: formatClineAccessToken(update.accessToken), refreshed: true };
}
// ── Device flow (initial sign-in) ───────────────────────────────────────────

interface WorkOSDeviceAuthorizationResponse {
	device_code?: string;
	user_code?: string;
	verification_uri?: string;
	verification_uri_complete?: string;
	expires_in?: number;
	interval?: number;
	error?: string;
	error_description?: string;
}

interface WorkOSTokenResponse {
	access_token?: string;
	refresh_token?: string;
	token_type?: string;
	error?: string;
	error_description?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Interactive sign-in: request a device code, hand the verification URL to
 * `onAuthInfo`, and start polling immediately — `onAuthInfo` must NOT block
 * until dismissal (the old code awaited a modal dialog here, so polling only
 * began after the user pressed enter and a completed browser approval sat
 * unnoticed). Call `onAuthorized` (via the options below) once the first poll
 * succeeds so the UI can auto-close the panel; the panel's dismissal promise
 * is awaited before returning so the two UI layers never interleave.
 */
export async function loginClineDeviceFlow(options: {
	/** Show the verification URL/user code; resolve without waiting for dismissal. */
	onAuthInfo: (info: { url: string; userCode: string }) => Promise<void>;
	/** Called when the browser approval is confirmed — the UI can auto-close its auth panel. */
	onAuthorized?: () => void;
	/** Optional progress lines while polling (e.g. append to a progress panel). */
	onProgress?: (message: string) => void;
}): Promise<ClineTokenUpdate> {
	// One retry: a transient network blip here aborts the whole sign-in before
	// the user even sees a URL (observed: "fetch failed" after ~12s once).
	let authResponse: Response | undefined;
	let lastFetchError: unknown;
	for (let attempt = 1; attempt <= 2 && !authResponse; attempt++) {
		try {
			authResponse = await fetch(`${WORKOS_API_BASE_URL}${WORKOS_DEVICE_AUTHORIZATION_PATH}`, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ client_id: WORKOS_CLIENT_ID }),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (error) {
			lastFetchError = error;
			if (attempt < 2) await sleep(1500);
		}
	}
	if (!authResponse) {
		const detail = lastFetchError instanceof Error ? `${lastFetchError.message}${lastFetchError.cause instanceof Error ? ` (${lastFetchError.cause.message})` : ""}` : String(lastFetchError);
		throw new Error(`Cline device authorization failed: could not reach api.workos.com (${detail})`);
	}
	const device = (await authResponse.json().catch(() => ({}))) as WorkOSDeviceAuthorizationResponse;
	if (!authResponse.ok || !device.device_code || !device.user_code || !device.verification_uri) {
		const detail = device.error_description ?? (authResponse.ok ? "invalid WorkOS response" : `HTTP ${authResponse.status}`);
		throw new Error(`Cline device authorization failed: ${detail}`);
	}

	// Hand the URL to the UI but do NOT wait for the panel to be dismissed —
	// polling must start now, or an already-completed browser approval goes
	// unnoticed until the user dismisses the panel manually.
	const panelDismissed = options.onAuthInfo({
		url: device.verification_uri_complete ?? device.verification_uri,
		userCode: device.user_code,
	}).catch(() => {});

	const expiresInSeconds = device.expires_in ?? DEVICE_AUTH_EXPIRES_IN_SECONDS;
	const deadline = Date.now() + expiresInSeconds * 1000;
	let intervalSeconds = Math.max(1, device.interval ?? DEVICE_AUTH_INTERVAL_SECONDS);
	let workosTokens: { access: string; refresh: string } | undefined;
	let pollCount = 0;

	while (Date.now() <= deadline) {
		pollCount++;
		const pollResponse = await fetch(`${WORKOS_API_BASE_URL}${WORKOS_AUTHENTICATE_PATH}`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				device_code: device.device_code,
				client_id: WORKOS_CLIENT_ID,
			}),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		const payload = (await pollResponse.json().catch(() => ({}))) as WorkOSTokenResponse;
		if (pollResponse.ok) {
			if (!payload.access_token || !payload.refresh_token) {
				throw new Error("Invalid WorkOS token response");
			}
			workosTokens = { access: payload.access_token, refresh: payload.refresh_token };
			options.onAuthorized?.();
			await panelDismissed;
			break;
		}
		switch (payload.error) {
			case "authorization_pending":
				options.onProgress?.("Waiting for browser authentication confirmation…");
				await sleep(intervalSeconds * 1000);
				break;
			case "slow_down":
				intervalSeconds += 1;
				await sleep(intervalSeconds * 1000);
				break;
			case "access_denied":
				throw new Error(`Cline authorization failed: ${payload.error_description ?? payload.error}`);
			case "expired_token":
				throw new Error(`Cline authorization timed out: ${payload.error_description ?? payload.error}`);
			case "invalid_grant":
				throw new Error(`Cline authorization failed: ${payload.error_description ?? payload.error}`);
			default:
				throw new Error(`WorkOS token polling failed: HTTP ${pollResponse.status}${payload.error_description ? ` — ${payload.error_description}` : ""}`);
		}
	}
	if (!workosTokens) throw new Error("WorkOS device authorization timed out");

	// Exchange the WorkOS tokens for Cline account tokens.
	const registerResponse = await fetch(`${CLINE_API_BASE_URL}${CLINE_REGISTER_PATH}`, {
		method: "POST",
		headers: clineAuthHeaders(),
		body: JSON.stringify({ accessToken: workosTokens.access, refreshToken: workosTokens.refresh }),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!registerResponse.ok) {
		const text = await registerResponse.text().catch(() => "");
		throw new Error(`Cline token registration failed: HTTP ${registerResponse.status}${text ? ` — ${text.slice(0, 200)}` : ""}`);
	}
	const payload = (await registerResponse.json().catch(() => ({}))) as ClineTokenResponse;
	return requireClineTokens(payload, "Invalid Cline token registration response");
}

/** Human-readable expiry line for the TUI (token state only; quota lives server-side). */
export function describeClineCredential(credential: KeyCredential): string {
	if (credential.expiresAt === undefined) return "token expiry unknown";
	const remaining = credential.expiresAt - Date.now();
	if (remaining <= 0) return `token expired ${Math.round(-remaining / 60_000)}m ago`;
	if (remaining < 90_000) return `token expires in ${Math.round(remaining / 1000)}s`;
	if (remaining < 90 * 60_000) return `token expires in ${Math.round(remaining / 60_000)}m`;
	return `token expires in ${Math.round(remaining / 3_600_000)}h`;
}

