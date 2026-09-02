# Review: OpenCode Zen 429 + rotation robustness

Status: **proposal only — no code changed yet.** Working tree is clean.
Scope: `pi-multikey` (this repo). Author: assistant investigation of
[pi issue #2824](https://github.com/earendil-works/pi/issues/2824) applied to our
`opencode` pool.

---

## 1. Reported symptom

```
Error: multikey[opencode]: all 1 keys exhausted (last: 429: {"type":"FreeUsageLimitError",
"message":"Error from provider (Console): Rate limit exceeded. Please try again later."})
```

The **same API key works fine in the official opencode CLI.** Our pool is:

```jsonc
// ~/.pi/agent/multikey.json
{ "id": "opencode", "baseUrl": "https://opencode.ai/zen/v1",
  "api": "openai-completions", "keys": [ "sk-P2P…hJI6" /* 1 key */ ] }
```

---

## 2. Root cause of the 429 — and why we are NOT "fixing" it

### What the upstream issue actually says
Issue #2824 ("fix(ai): send opencode-cli compatible headers for zen") claims the
OpenCode Zen backend fingerprints the HTTP client and gives non-official clients an
effectively-zero anonymous quota. Its proposed "solution" is to **forge the official
CLI's identity**:

- `x-opencode-client: "cli"`
- `x-opencode-session` / `x-opencode-project` / `x-opencode-request`: random IDs
- `User-Agent: "opencode/latest/1.3.15/cli"`

…explicitly "to match the format of the official CLI and **avoid detection** based on
repeated static values", making the caller "**indistinguishable from the official
opencode CLI**".

### Verified facts (not taken on faith)
- **pi never shipped this.** Grepped the installed `@earendil-works/pi-ai` dist: there is
  **no `x-opencode-*` header logic anywhere**. `openai-completions.js` sends only
  `User-Agent: getPiUserAgent()` (+ optional session-affinity headers). The issue was
  **closed as rejected** — maintainer `badlogic` replied `nope`.
- **OpenCode intends the gate.** Web search confirms the free-tier gateway (upstream
  "Console" provider serving the `-free` models) gates on the `User-Agent`/client headers,
  and OpenCode has publicly stated the free models are restricted to the official TUI.
  Third-party "zen-proxy" projects exist solely to defeat this fingerprint.
- A commenter on the issue flags the approach as **API identity forgery** with
  DMCA/lawsuit exposure.

### Decision
**We will not add header spoofing to `pi-multikey`.** It circumvents an access control the
service owner deliberately put in place, is almost certainly a ToS violation, and — because
`pi-multikey` is a published npm package — would distribute that circumvention to every
user. This is the same reason pi's maintainer rejected it.

**Legitimate ways to use these models:**
1. OpenCode **paid** tier (not gated to the official client the way free is).
2. A provider that permits third-party clients for the same models — our built-in **`b-ai`
   preset** already carries DeepSeek V4 Flash / MiMo V2.5 / Hy3 / etc.; OpenRouter free tier
   is another.
3. The **official opencode CLI** when you specifically want Zen free models.

> The rest of this document is a **separate, legitimate bug** in our own code that the
> 429 happened to expose.

---

## 3. The real bug in *our* package: rotation gives up without waiting

### Where
`stream.ts` → `createRotatingStreamSimple`.

### What
```ts
const maxAttempts = Math.max(1, pool.size);   // ← 1 key ⇒ exactly one attempt
for (let attempt = 0; attempt < maxAttempts; attempt++) {
  lease = await pool.acquire(options?.signal);
  ...
  if (verdict.kind === "rotate" && !verdict.relayedAny) {
    pool.report(lease, verdict.outcome, cooldownMs);   // sets cooldownUntil = now + cooldown
    continue;                                          // ← loop ends here for a 1-key pool
  }
}
emitError(out, model, `multikey[${id}]: all ${maxAttempts} keys exhausted (last: ${lastProblem})`);
```

`pool.acquire()` **already knows how to wait** for the earliest cooldown to expire — but the
loop bound (`maxAttempts = pool.size`) means a single-key pool never calls `acquire()` a
second time, so the cooldown is never waited out. The first 429 fails instantly.

This also hurts multi-key pools: once every key has been tried once and 429'd, the loop
exits immediately instead of waiting for the first key to recover.

The final message `all ${maxAttempts} keys exhausted` is also **wrong** — `maxAttempts` is an
*attempt* count, not a key count, and for a 1-key pool it reads "all 1 keys exhausted" after
zero waiting.

### Secondary finding: `Retry-After` is not observable on a 429
`stream.ts` parses `retry-after` inside `onResponse`, but pi-ai only calls `onResponse`
**after a 2xx** (`openai-completions.js:218`, reached only when the SDK call resolves). On a
429 the OpenAI SDK throws first, so `captured.status` stays `0` and `retryAfterMs` is never
set. Classification still works (the message contains `429`, matched by `RATE_LIMIT_RE`), but
the cooldown falls back to `pool.config.cooldownMs`. **We cannot recover the server's actual
`Retry-After` from the event stream** (the raw error's headers are gone by then), so the fix
relies on the configured cooldown, not the server hint. Noted so nobody "fixes" it wrongly.

---

## 4. Proposed fix (design)

Give the rotation loop a real, **bounded** retry budget and let `acquire()` do its waiting.

- **`attemptsPerKey`** (default **2**): each key may be tried up to N times across cooldown
  recovery ⇒ `maxAttempts = size * attemptsPerKey`. A 1-key pool now gets one genuine
  retry *after* waiting out its cooldown.
- **`retryBudgetMs`** (default **60_000**): total wall-clock the rotation may spend
  waiting/rotating before declaring failure. Prevents a long cooldown from hanging a request.
- **Deadline-bounded wait**: `pool.acquire(signal, deadlineAt)` throws a typed
  `PoolUnavailableError` when no key recovers before `deadlineAt`, instead of waiting forever.
- **Distinguish** user-abort (`AbortError`) from budget-timeout (`PoolUnavailableError`) from
  a normal failed attempt.
- **Accurate messaging**: rotation notice says "waiting out cooldown, retrying" for single-key
  pools (not "rotating to another key"); final error reports attempts/keys/budget and keeps a
  `429`-flavored tail so pi's own higher-level backoff still triggers.

Net effect on the reported case: with 1 key + 20s cooldown, a 429 now waits ~20s and retries
once, then fails with a clear message — instead of failing in ~0ms. It does **not** (and will
not) defeat the OpenCode gate; it just makes genuine transient 429s behave correctly.

---

## 5. Proposed diffs (for review — not applied)

### 5.1 `pool.ts`
```diff
 export type KeyOutcome = "ok" | "rate_limited" | "invalid" | "error";
+
+/**
+ * Thrown by KeyPool.acquire when every key is in cooldown and none recovers before
+ * the caller's deadline, so the rotation loop can stop waiting instead of hanging.
+ */
+export class PoolUnavailableError extends Error {
+  readonly retryAfterMs: number;
+  constructor(retryAfterMs: number) {
+    super(`all keys in cooldown (earliest recovery in ${Math.ceil(Math.max(0, retryAfterMs) / 1000)}s)`);
+    this.name = "PoolUnavailableError";
+    this.retryAfterMs = retryAfterMs;
+  }
+}
```
```diff
-  async acquire(signal?: AbortSignal): Promise<Lease> {
+  async acquire(signal?: AbortSignal, deadlineAt?: number): Promise<Lease> {
     for (;;) {
       if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
       const now = Date.now();
-      const candidates = this.enabledKeys()
-        .map((entry) => ({ ...entry, stat: this.stat(entry.key) }))
-        .filter((entry) => entry.stat.cooldownUntil <= now);
+      const entries = this.enabledKeys().map((e) => ({ ...e, stat: this.stat(e.key) }));
+      const candidates = entries.filter((entry) => entry.stat.cooldownUntil <= now);
       if (candidates.length > 0) { /* …unchanged: sort, inflight++, return lease… */ }
-      const cooldowns = this.enabledKeys().map((entry) => this.stat(entry.key).cooldownUntil);
-      const earliest = Math.min(...cooldowns);
+      if (entries.length === 0) throw new PoolUnavailableError(Number.POSITIVE_INFINITY);
+      const earliest = Math.min(...entries.map((e) => e.stat.cooldownUntil));
+      if (deadlineAt !== undefined && earliest > deadlineAt) throw new PoolUnavailableError(earliest - now);
       const waitMs = Math.max(250, Math.min(earliest - now, 60_000));
       await this.sleep(waitMs, signal);
     }
   }
```

### 5.2 `config.ts`
```diff
   cooldownMs?: number;
   invalidKeyCooldownMs?: number;
+  /** Total wall-clock to spend rotating/waiting through cooldowns before failing. Default 60000ms. */
+  retryBudgetMs?: number;
+  /** Times each key may be tried (across cooldown recovery) within the budget. Default 2. */
+  attemptsPerKey?: number;
   keys: PoolKeyConfig[];
```
```diff
 const DEFAULT_INVALID_KEY_COOLDOWN_MS = 600_000;
+const DEFAULT_RETRY_BUDGET_MS = 60_000;
+const DEFAULT_ATTEMPTS_PER_KEY = 2;
```
```diff
     invalidKeyCooldownMs:
       typeof pool.invalidKeyCooldownMs === "number" && pool.invalidKeyCooldownMs >= 0
         ? pool.invalidKeyCooldownMs : DEFAULT_INVALID_KEY_COOLDOWN_MS,
+    retryBudgetMs:
+      typeof pool.retryBudgetMs === "number" && pool.retryBudgetMs >= 0
+        ? pool.retryBudgetMs : DEFAULT_RETRY_BUDGET_MS,
+    attemptsPerKey:
+      typeof pool.attemptsPerKey === "number" && pool.attemptsPerKey >= 1
+        ? Math.floor(pool.attemptsPerKey) : DEFAULT_ATTEMPTS_PER_KEY,
     keys,
```

### 5.3 `stream.ts` (loop skeleton)
```diff
-      const maxAttempts = Math.max(1, pool.size);
-      let lastProblem = "no attempts made";
+      const startedAt = Date.now();
+      const retryBudgetMs = pool.config.retryBudgetMs ?? 60_000;
+      const attemptsPerKey = Math.max(1, pool.config.attemptsPerKey ?? 2);
+      const size = Math.max(1, pool.size);
+      const maxAttempts = size * attemptsPerKey;
+      const deadlineAt = startedAt + retryBudgetMs;
+      let lastProblem = "no attempts made";
+      let attempts = 0;

       for (let attempt = 0; attempt < maxAttempts; attempt++) {
+        if (Date.now() >= deadlineAt) { lastProblem += ` (rotation budget ${Math.round(retryBudgetMs/1000)}s spent)`; break; }
         let lease: Lease;
         try {
-          lease = await pool.acquire(options?.signal);
-        } catch {
-          emitAborted(out, model); return;
+          lease = await pool.acquire(options?.signal, deadlineAt);
+        } catch (error) {
+          if (options?.signal?.aborted || (error as { name?: string })?.name === "AbortError") { emitAborted(out, model); return; }
+          if (error instanceof PoolUnavailableError) { lastProblem += ` (${error.message})`; break; }
+          emitAborted(out, model); return;
         }
+        attempts++;
         try {
           /* …attempt unchanged… */
           if (verdict.kind === "rotate" && !verdict.relayedAny) {
             lastProblem = verdict.problem;
             pool.report(lease, verdict.outcome, /* cooldownMs */);
-            notify(`… ${reason} on ${lease.label} (${pool.mask(lease.key)}), rotating to another key`);
+            const action = size > 1 ? "rotating to another key" : "waiting out cooldown, retrying";
+            notify(`… ${reason} on ${lease.label} (${pool.mask(lease.key)}), ${action}`);
             continue;
           }
           /* … */
         } finally { pool.release(lease); }
       }

-      emitError(out, model, `multikey[${pool.config.id}]: all ${maxAttempts} keys exhausted (last: ${lastProblem})`);
+      emitError(out, model,
+        `multikey[${pool.config.id}]: ${attempts} attempt(s) across ${size} key(s) failed within ${Math.round(retryBudgetMs/1000)}s (last: ${lastProblem})`);
```
(`stream.ts` gains `import { PoolUnavailableError } from "./pool.ts"`, and the existing
`import type { KeyOutcome, KeyPool, Lease }` stays.)

### 5.4 `manage.ts` (settings menu)
```diff
   { value: "invalidKeyCooldownMs", label: "Invalid-key cooldown (ms)…", description: String(pool.invalidKeyCooldownMs ?? 600_000) },
+  { value: "retryBudgetMs", label: "Rotation budget (ms)…", description: String(pool.retryBudgetMs ?? 60_000) },
+  { value: "attemptsPerKey", label: "Attempts per key…", description: String(pool.attemptsPerKey ?? 2) },
```
plus two `inputNumber` handlers mirroring the existing `cooldownMs` handler
(`attemptsPerKey` clamped to `Math.max(1, Math.floor(v))`).

---

## 6. Behavior / edge cases

| Scenario | Before | After |
|---|---|---|
| 1 key, 429, 20s cooldown | fails in ~0ms, "all 1 keys exhausted" | waits ~20s, retries once, then clear failure |
| N keys, all 429 | fails after N tries, no wait | waits for earliest recovery within budget, retries |
| Long cooldown > budget | (1-key) instant fail; (multi) could hang | stops at `retryBudgetMs`, `PoolUnavailableError` → clear message |
| User aborts mid-wait | `emitAborted` | `emitAborted` (AbortError still wins over deadline) |
| `error` (non-429) outcome | no cooldown, next acquire instant | unchanged; bounded by `maxAttempts` + budget (no spin) |
| Existing configs w/o new fields | — | `normalize` fills defaults; runtime also `?? default` |

**Backward compatible:** new fields are optional with defaults; no config migration needed.
**No new deps.** **No change to the OpenCode gate behavior** beyond honest backoff.

## 7. Test plan
- Unit-ish: fake `impl.streamSimple` that emits a 429 error event on attempt 1, success on
  attempt 2 → assert one retry happened after a wait and final result is `completed`.
- Budget: fake impl always 429 with `cooldownMs > retryBudgetMs` → assert it stops at the
  budget with `PoolUnavailableError`-derived message, does not hang.
- Abort: fire `signal` during a cooldown wait → assert `aborted`, not `error`.
- Typecheck: `tsc --noEmit` (see package `tsconfig.json`).

## 8. Open questions for you
1. Defaults OK? (`attemptsPerKey = 2`, `retryBudgetMs = 60_000`) — or prefer 1 retry / 30s?
2. Should `retryBudgetMs` also cap the **first** `acquire()` when a pool is *already* fully
   cooling from a prior request (currently it would wait up to the budget before failing)?
3. Want the two new fields surfaced in the TUI (5.4), or config-file-only to keep the menu lean?
