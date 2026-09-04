/**
 * Client identity headers for endpoints that gate on them.
 *
 * OpenCode Zen — opencode.ai/zen identifies the calling client with four headers,
 * set in packages/opencode/src/session/llm/request.ts (LLMRequestPrep.prepare)
 * whenever the provider id starts with "opencode":
 *
 *   x-opencode-client   flags.client ("tui" for the terminal client)
 *   User-Agent          opencode/<InstallationVersion>
 *   x-opencode-session  input.sessionID  ("ses_" + Identifier.create(descending))
 *   x-opencode-request  input.user.id, the id of the user message being answered
 *                       ("msg_" + Identifier.create(ascending))
 *
 * prompt.ts resolves `lastUser` once per turn and passes that same message into
 * every step of the agentic loop, so one user turn — including retries — reuses
 * one request id. pi exposes neither a session id nor message ids to a custom
 * stream function (UserMessage is just { role, content, timestamp }), so we mint
 * ids in the same format and keep them alive for the same span opencode would.
 *
 * Cline — api.cline.bot correlates a conversation with `X-Task-ID`, a v4 uuid.
 */

import { createHash, randomBytes } from "node:crypto";

/** Alphabet used by opencode's Identifier.create (packages/schema/src/identifier.ts). */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Port of opencode's Identifier.create(): a sortable, KSUID-like 26-char suffix.
 * The first 12 chars are the hex of `(timestamp_ms * 0x1000 + counter)`, bitwise
 * NOT'd for descending ids so newer ids sort first; the last 14 are random base62.
 * The counter resets whenever the millisecond changes.
 */
let lastTs = 0;
let count = 0;
export function createIdentifier(descending: boolean, ts: number = Date.now()): string {
	if (ts !== lastTs) {
		lastTs = ts;
		count = 0;
	}
	const time = BigInt(ts) * 0x1000n + BigInt(count++);
	const value = descending ? ~time & 0xffffffffffffn : time;
	const hex = value.toString(16).padStart(12, "0");
	let id = hex;
	for (const byte of randomBytes(14)) id += ALPHABET[byte % ALPHABET.length];
	return id;
}

/** New session identifier, matching opencode's `SessionID.ascending()` ("ses_" + 26). */
export function createSessionId(): string {
	return `ses_${createIdentifier(true)}`;
}

/** New message identifier, matching opencode's `MessageID.ascending()` ("msg_" + 26). */
export function createMessageId(): string {
	return `msg_${createIdentifier(false)}`;
}

/**
 * Stable key for "the turn we are currently answering" — opencode's `lastUser`.
 * pi rebuilds message objects between requests, so object identity is useless;
 * the last user message's timestamp plus a digest of its content stays equal
 * across every step of the same turn.
 */
export function turnKeyOf(messages: readonly unknown[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; timestamp?: number; content?: unknown } | undefined;
		if (m?.role !== "user") continue;
		const digest = createHash("sha1").update(JSON.stringify(m.content ?? "")).digest("hex");
		return `${m.timestamp ?? 0}:${digest}`;
	}
	return undefined;
}

let sessionId: string | undefined;
let requestId: string | undefined;
let turnKey: string | undefined;
let taskId: string | undefined;

/** Forget the current conversation (called on session_start for new/resume/fork). */
export function resetConversation(): void {
	sessionId = undefined;
	requestId = undefined;
	turnKey = undefined;
	taskId = undefined;
}

/** The session id for the current conversation, created on first use. */
export function currentSessionId(): string {
	if (!sessionId) sessionId = createSessionId();
	return sessionId;
}

/**
 * The request id for the turn identified by `key` (opencode's `input.user.id`
 * equivalent). A new key mints a fresh "msg_" id and the same key keeps returning
 * it; a missing key means there is no conversation context to key on (a probe,
 * say), so it mints a fresh id without disturbing the cached turn.
 */
export function currentRequestId(key: string | undefined): string {
	if (key === undefined) return createMessageId();
	if (!requestId || key !== turnKey) {
		requestId = createMessageId();
		turnKey = key;
	}
	return requestId;
}

/** Cline's X-Task-ID: one v4 uuid per conversation. */
export function currentTaskId(): string {
	if (!taskId) taskId = crypto.randomUUID();
	return taskId;
}
