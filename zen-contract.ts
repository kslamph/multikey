/**
 * The OpenCode Zen request contract: the client identity headers that the free
 * tier gates on, and the live client version behind them.
 *
 * opencode identifies its client with four headers, set in
 * packages/core/src/session/model-request.ts whenever the provider id starts
 * with "opencode":
 *
 *   x-opencode-client   constant "cli"
 *   User-Agent          opencode/<channel>/<version>/<name>, i.e.
 *                       App.useragent(app) with channel "latest" and name "cli"
 *   x-opencode-session  "ses_" + Identifier.create(descending)  (identity.ts)
 *   x-opencode-request  "msg_" + Identifier.create(ascending)   (identity.ts)
 *
 * The free tier parses the version out of the User-Agent and answers HTTP 426
 * "OpenCode 1.17.0 or newer is required" below its floor — and the floor moves
 * with every official release, so a pinned constant silently rots. The version
 * therefore comes from the official update service
 * (`https://opencode.ai/update/api/latest/cli`; npm registry and GitHub
 * releases do not carry the 2.x line), with a live-verified baked-in snapshot
 * as the fallback.
 *
 * Resolution is lazy and never blocks a request: `zenClientHeadersSync()`
 * returns the currently cached headers immediately (the baked snapshot on a
 * cold cache) and kicks off a background refresh when the cache has aged out.
 * A refresh that fails, resolves malformed, or resolves a version *older* than
 * the baked snapshot is discarded — a stale User-Agent draws 426, so it is
 * never sent on purpose.
 */

/** Official update service carrying the latest CLI version per distribution. */
export const UPDATE_API_URL = "https://opencode.ai/update/api/latest/cli";

/**
 * Client version to fall back to when the update service is unreachable.
 * Bump alongside official releases; it doubles as the floor below which a
 * resolved version is treated as stale and rejected.
 */
export const BAKED_CLI_VERSION = "2.0.22";

/** The Zen provider id the official client reports (OPENCODE_CLIENT / OPENCODE_ARTIFACT). */
const OPENCODE_ZEN_CLIENT = "cli";
/** Release channel observed live on a working install. */
const OPENCODE_CHANNEL = "latest";

const DEFAULT_MIN_INTERVAL_MS = 30 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface ZenContractDeps {
	fetcher?: typeof fetch;
	now?: () => number;
	minIntervalMs?: number;
}

let deps: Required<ZenContractDeps> = {
	fetcher: (...args) => fetch(...args),
	now: () => Date.now(),
	minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
};

/** Injectable fetcher/clock/TTL (tests). Merged into the current settings. */
export function setZenContractDeps(next: ZenContractDeps): void {
	deps = { ...deps, ...next };
}

interface UpdateArtifact {
	distribution?: string;
	version?: string;
	active?: boolean;
}

/** Numeric `a.b.c` compare; missing components count as 0. */
export function compareSemver(a: string, b: string): number {
	const parse = (value: string): number[] =>
		value
			.split("-", 1)[0]!
			.split(".")
			.map((part) => Number.parseInt(part, 10) || 0);
	const left = parse(a);
	const right = parse(b);
	for (let i = 0; i < 3; i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) return diff < 0 ? -1 : 1;
	}
	return 0;
}

function isUsableVersion(version: string | undefined): version is string {
	return version !== undefined && /^\d+\.\d+\.\d+/.test(version) && compareSemver(version, BAKED_CLI_VERSION) >= 0;
}

/**
 * Latest official CLI version from the update service: prefer the npm
 * distribution artifact, else the first one that is not inactive. Undefined on
 * any failure — the caller keeps the baked snapshot.
 */
export async function resolveLatestCliVersion(fetcher: typeof fetch = deps.fetcher): Promise<string | undefined> {
	try {
		const response = await fetcher(UPDATE_API_URL, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
		if (!response.ok) return undefined;
		const payload = (await response.json()) as { artifacts?: UpdateArtifact[] };
		const artifacts = Array.isArray(payload?.artifacts) ? payload.artifacts : [];
		const pick =
			artifacts.find((a) => a?.distribution === "npm" && typeof a.version === "string") ??
			artifacts.find((a) => a?.active !== false && typeof a.version === "string");
		return pick?.version;
	} catch {
		return undefined;
	}
}

/** The identity headers for a resolved version; the baked version when unusable. */
export function buildZenUserAgent(version: string | undefined): string {
	const usable = isUsableVersion(version) ? version : BAKED_CLI_VERSION;
	return `opencode/${OPENCODE_CHANNEL}/${usable}/${OPENCODE_ZEN_CLIENT}`;
}

let cachedVersion: string = BAKED_CLI_VERSION;
let cachedAt: number | undefined;
let inFlight: Promise<void> | undefined;

/**
 * The Zen client headers for this instant. Always synchronous: a cold or aged
 * cache yields the baked headers and schedules a background refresh.
 */
export function zenClientHeadersSync(): Record<string, string> {
	if (cachedAt === undefined || deps.now() - cachedAt >= deps.minIntervalMs) void refreshZenContract();
	return { "x-opencode-client": OPENCODE_ZEN_CLIENT, "User-Agent": buildZenUserAgent(cachedVersion) };
}

/** Resolves when the pending refresh settles (immediately when none is pending). */
export function zenContractRefresh(): Promise<void> {
	return inFlight ?? Promise.resolve();
}

async function refreshZenContract(): Promise<void> {
	if (inFlight) return inFlight;
	inFlight = (async () => {
		const resolved = await resolveLatestCliVersion();
		// A failed / stale / malformed resolution leaves the previous version in
		// place and stamps the cache anyway, so a dead update service is not hit
		// on every single request.
		cachedVersion = isUsableVersion(resolved) ? resolved : BAKED_CLI_VERSION;
		cachedAt = deps.now();
	})().finally(() => {
		inFlight = undefined;
	});
	return inFlight;
}

/** Drop the cached version and any pending refresh (tests). */
export function resetZenContractCache(): void {
	cachedVersion = BAKED_CLI_VERSION;
	cachedAt = undefined;
	inFlight = undefined;
}