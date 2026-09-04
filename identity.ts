/**
 * Client identity for endpoints that expect an OpenCode-style client.
 *
 * OpenCode Zen keys its per-conversation routing/telemetry off two headers we
 * have to synthesize: `x-opencode-session` (one id per conversation, reused for
 * its whole lifetime) and `x-opencode-request` (one UUID per device, persisted
 * in multikey.json). Both are generated here; persistence stays in config.ts.
 */

import { randomBytes, randomUUID } from "node:crypto";

/** OpenCode's identifier alphabet: 12 hex chars of time, then 14 base62 chars. */
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_LENGTH = 26;
const TIME_HEX_LENGTH = 12;

// Monotonic counter within a millisecond, reset when the clock ticks — same
// rule OpenCode uses so ids sort correctly by creation time.
let lastTimestamp = 0;
let counter = 0;

/**
 * Reproduce OpenCode's `Identifier.create()`:
 * `timestamp_ms * 0x1000 + counter`, bitwise-NOTed for descending order, as
 * 6 big-endian bytes of hex, followed by 14 random base62 characters.
 *
 * The 48-bit window truncates today's millisecond timestamps, which is exactly
 * what OpenCode ships — the low bits still order ids newest-first.
 */
export function createIdentifier(descending = true, timestamp = Date.now()): string {
	if (timestamp !== lastTimestamp) {
		lastTimestamp = timestamp;
		counter = 0;
	}
	counter++;

	const current = BigInt(timestamp) * 0x1000n + BigInt(counter);
	const value = descending ? ~current : current;
	let time = "";
	for (let index = 0; index < 6; index++) {
		const byte = Number((value >> BigInt(40 - 8 * index)) & 0xffn);
		time += byte.toString(16).padStart(2, "0");
	}

	const bytes = randomBytes(ID_LENGTH - TIME_HEX_LENGTH);
	let rest = "";
	for (const byte of bytes) rest += BASE62[byte % 62];
	return `${time}${rest}`;
}

/** A session id in OpenCode's format: `ses_` + 26 descending-sortable chars. */
export function createSessionId(): string {
	return `ses_${createIdentifier(true)}`;
}

/** A fresh device identifier (plain v4 UUID, like OpenCode's client). */
export function createDeviceId(): string {
	return randomUUID();
}

/** A per-conversation task id (plain v4 UUID, like Cline's X-Task-ID). */
export function createTaskId(): string {
	return randomUUID();
}

let sessionId: string | undefined;
let deviceId: string | undefined;
let taskId: string | undefined;

/** Current conversation's session id, created on first use. */
export function currentSessionId(): string {
	if (!sessionId) sessionId = createSessionId();
	return sessionId;
}

/** Drop the cached session id so the next request starts a new conversation. */
export function resetSessionId(): void {
	sessionId = undefined;
}

/** Seed the device id from config (call once at startup). */
export function setDeviceId(id: string): void {
	if (id) deviceId = id;
}

/** Current device id, generated on first use if config had none. */
export function currentDeviceId(): string {
	if (!deviceId) deviceId = createDeviceId();
	return deviceId;
}

/** Current conversation's task id (Cline X-Task-ID), created on first use. */
export function currentTaskId(): string {
	if (!taskId) taskId = createTaskId();
	return taskId;
}

/** Drop the cached task id so the next request starts a new conversation. */
export function resetTaskId(): void {
	taskId = undefined;
}
