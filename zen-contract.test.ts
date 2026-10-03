/**
 * zen-contract tests: the OpenCode Zen client version contract.
 *
 * Covers the live update-service resolution, the never-stale guard (a version
 * older than the baked one is discarded — a stale User-Agent draws HTTP 426),
 * and the lazy TTL cache that feeds endpointHeaders()/stream.ts.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
	BAKED_CLI_VERSION,
	UPDATE_API_URL,
	buildZenUserAgent,
	compareSemver,
	resetZenContractCache,
	resolveLatestCliVersion,
	setZenContractDeps,
	zenClientHeadersSync,
	zenContractRefresh,
} from "./zen-contract.ts";

/** Minimal fetch stand-in returning `body` with `status`. */
function jsonFetch(body: unknown, status = 200): typeof fetch {
	return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

/** A payload shaped like the real update-service response. */
function updatePayload(artifacts: unknown): unknown {
	return { channel: "latest", name: "cli", artifacts };
}

function latestArtifact(version: string, distribution = "npm"): Record<string, unknown> {
	return { channel: "latest", name: "cli", distribution, version, active: true };
}

describe("resolveLatestCliVersion", () => {
	test("prefers the npm distribution artifact", async () => {
		const fetcher = jsonFetch(
			updatePayload([
				{ ...latestArtifact("2.0.20", "aur"), active: true },
				{ ...latestArtifact("2.0.22", "npm"), active: true },
			]),
		);
		assert.equal(await resolveLatestCliVersion(fetcher), "2.0.22");
	});

	test("falls back to the first artifact that is not inactive", async () => {
		const fetcher = jsonFetch(
			updatePayload([
				{ distribution: "aur", version: "2.0.20", active: false },
				{ distribution: "homebrew", version: "2.0.21", active: true },
			]),
		);
		assert.equal(await resolveLatestCliVersion(fetcher), "2.0.21");
	});

	test("undefined on a non-OK response", async () => {
		assert.equal(await resolveLatestCliVersion(jsonFetch({}, 500)), undefined);
	});

	test("undefined when the network throws", async () => {
		const failing = (async () => {
			throw new Error("offline");
		}) as unknown as typeof fetch;
		assert.equal(await resolveLatestCliVersion(failing), undefined);
	});

	test("undefined for a payload with no usable artifacts", async () => {
		assert.equal(await resolveLatestCliVersion(jsonFetch(updatePayload([{ distribution: "aur" }]))), undefined);
		assert.equal(await resolveLatestCliVersion(jsonFetch({})), undefined);
		assert.equal(await resolveLatestCliVersion(jsonFetch(updatePayload("nope"))), undefined);
	});

	test("requests the official update endpoint", async () => {
		let seen = "";
		const fetcher = (async (url: string) => {
			seen = String(url);
			return new Response(JSON.stringify(updatePayload([latestArtifact("2.0.22")])), { status: 200 });
		}) as unknown as typeof fetch;
		await resolveLatestCliVersion(fetcher);
		assert.equal(seen, UPDATE_API_URL);
	});
});

describe("buildZenUserAgent", () => {
	test("uses a version newer than the baked one", () => {
		assert.equal(buildZenUserAgent("9.9.9"), "opencode/latest/9.9.9/cli");
	});

	test("falls back to the baked version when nothing resolved", () => {
		assert.equal(buildZenUserAgent(undefined), `opencode/latest/${BAKED_CLI_VERSION}/cli`);
	});

	test("rejects a malformed version", () => {
		assert.equal(buildZenUserAgent("not-a-version"), `opencode/latest/${BAKED_CLI_VERSION}/cli`);
	});

	test("rejects a version older than the baked one (stale UA draws 426)", () => {
		assert.equal(buildZenUserAgent("0.1.50"), `opencode/latest/${BAKED_CLI_VERSION}/cli`);
		assert.equal(buildZenUserAgent("1.16.9"), `opencode/latest/${BAKED_CLI_VERSION}/cli`);
	});

	test("accepts a pre-release of the baked line", () => {
		assert.equal(buildZenUserAgent(`${BAKED_CLI_VERSION}-beta.1`), `opencode/latest/${BAKED_CLI_VERSION}-beta.1/cli`);
	});
});

describe("compareSemver", () => {
	test("orders numerically, not lexically", () => {
		assert.ok(compareSemver("2.0.9", "2.0.10") < 0);
		assert.ok(compareSemver("2.1.0", "2.0.99") > 0);
		assert.equal(compareSemver("2.0.22", "2.0.22"), 0);
	});

	test("treats a shorter version as equal, not smaller", () => {
		assert.ok(compareSemver("2.0", "2.0.1") < 0);
		assert.equal(compareSemver("2.0", "2.0.0"), 0);
		assert.equal(compareSemver("2", "2.0.0"), 0);
	});
});

describe("lazy TTL cache", () => {
	test("serves the baked headers synchronously while a refresh is pending", async () => {
		resetZenContractCache();
		let calls = 0;
		let release = () => {};
		const gate = new Promise<void>((resolve) => (release = resolve));
		setZenContractDeps({
			fetcher: (async () => {
				calls++;
				await gate;
				return new Response(JSON.stringify(updatePayload([latestArtifact("9.9.9")])), { status: 200 });
			}) as unknown as typeof fetch,
			now: () => 0,
		});
		// The fetch is started but never awaited on the request path, so the
		// headers come back baked-in even though 9.9.9 is already on the wire.
		const headers = zenClientHeadersSync();
		assert.equal(headers["x-opencode-client"], "cli");
		assert.equal(headers["User-Agent"], `opencode/latest/${BAKED_CLI_VERSION}/cli`);
		assert.equal(calls, 1, "a background refresh was scheduled");
		release();
		await zenContractRefresh();
	});

	test("a background refresh upgrades the cached headers", async () => {
		resetZenContractCache();
		let calls = 0;
		setZenContractDeps({
			fetcher: (async () => {
				calls++;
				return new Response(JSON.stringify(updatePayload([latestArtifact("9.9.9")])), { status: 200 });
			}) as unknown as typeof fetch,
			now: () => 0,
		});
		zenClientHeadersSync();
		await zenContractRefresh();
		assert.equal(zenClientHeadersSync()["User-Agent"], "opencode/latest/9.9.9/cli");
		assert.equal(calls, 1);
	});

	test("stale-UA rejection keeps the cached headers baked", async () => {
		resetZenContractCache();
		setZenContractDeps({
			fetcher: jsonFetch(updatePayload([latestArtifact("0.1.50")])),
			now: () => 0,
		});
		zenClientHeadersSync();
		await zenContractRefresh();
		assert.equal(zenClientHeadersSync()["User-Agent"], `opencode/latest/${BAKED_CLI_VERSION}/cli`);
	});

	test("a failed refresh never throws outward", async () => {
		resetZenContractCache();
		const failing = (async () => {
			throw new Error("offline");
		}) as unknown as typeof fetch;
		setZenContractDeps({ fetcher: failing, now: () => 0 });
		assert.doesNotThrow(() => zenClientHeadersSync());
		await assert.doesNotReject(zenContractRefresh());
		assert.equal(zenClientHeadersSync()["User-Agent"], `opencode/latest/${BAKED_CLI_VERSION}/cli`);
	});

	test("refetches only after the TTL expires", async () => {
		resetZenContractCache();
		let calls = 0;
		let clock = 0;
		setZenContractDeps({
			fetcher: (async () => {
				calls++;
				return new Response(JSON.stringify(updatePayload([latestArtifact("9.9.9")])), { status: 200 });
			}) as unknown as typeof fetch,
			now: () => clock,
			minIntervalMs: 30 * 60_000,
		});
		zenClientHeadersSync();
		await zenContractRefresh();
		assert.equal(calls, 1);

		clock = 29 * 60_000;
		zenClientHeadersSync();
		await zenContractRefresh();
		assert.equal(calls, 1, "inside the TTL the cache is reused");

		clock = 31 * 60_000;
		zenClientHeadersSync();
		await zenContractRefresh();
		assert.equal(calls, 2, "past the TTL a refresh runs");
	});

	test("concurrent callers share one in-flight refresh", async () => {
		resetZenContractCache();
		let calls = 0;
		let release = () => {};
		const gate = new Promise<void>((resolve) => (release = resolve));
		setZenContractDeps({
			fetcher: (async () => {
				calls++;
				await gate;
				return new Response(JSON.stringify(updatePayload([latestArtifact("9.9.9")])), { status: 200 });
			}) as unknown as typeof fetch,
			now: () => 0,
		});
		zenClientHeadersSync();
		zenClientHeadersSync();
		zenClientHeadersSync();
		assert.equal(calls, 1, "three callers, one fetch");
		release();
		await zenContractRefresh();
		assert.equal(zenClientHeadersSync()["User-Agent"], "opencode/latest/9.9.9/cli");
	});

	test("reset restores the baked headers", async () => {
		resetZenContractCache();
		setZenContractDeps({ fetcher: jsonFetch(updatePayload([latestArtifact("9.9.9")])), now: () => 0 });
		zenClientHeadersSync();
		await zenContractRefresh();
		assert.equal(zenClientHeadersSync()["User-Agent"], "opencode/latest/9.9.9/cli");
		resetZenContractCache();
		assert.equal(zenClientHeadersSync()["User-Agent"], `opencode/latest/${BAKED_CLI_VERSION}/cli`);
	});
});