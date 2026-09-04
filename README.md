# pi-multikey

[中文](./README.zh.md)

A pi extension that bundles multiple API keys into a single **key pool**, exposing only **one provider** to pi.

It solves three pain points:

1. **No more copying your provider config per key** — models (contextWindow / modalities / thinkingLevelMap / compat) are configured once; swapping or adding keys never touches the model definitions.
2. **Automatic 429 key rotation** — on a failed request it immediately retries with the next key, and the failed key goes into cooldown (honoring `retry-after`). No manual provider switching.
3. **Concurrent subagents share keys automatically** — every in-flight request holds a key lease, picked by "fewest in use + least recently used", so when the main agent spawns multiple subagents they naturally land on different keys.

## Installation

```bash
# Option 1: git (recommended, no npm account needed)
pi install git:github.com/kslamph/multikey@v1.2.0

# Option 2: npm
pi install npm:pi-multikey

# Option 3: local directory
pi install /path/to/multikey
```

## Quick start (B.AI preset)

```
/multikey → Add pool… → Preset: B.AI → paste keys one per line (blank line to finish)
```

After picking the preset, the endpoint, compat, and all 4 model definitions are wired up automatically. Models are available directly as `bai/<model-id>`, e.g. `bai/hy3`.

## Presets

Built-in presets decouple "model settings" from "keys". The data comes from b.ai model cards and DeepSeek / Tencent / Xiaomi official docs, with each thinking level probed empirically; unsupported levels are written as `null` so the UI hides them.

| Model | ctx / max-out | Modalities | Supported thinking levels |
|---|---|---|---|
| hy3 | 256K / 128K | text | off · low · high |
| mimo-v2.5 | 1M / 128K | text+image | off · high (official: low/medium/high behave identically) |
| qwen3.8-flash | 1M / 131K | text+image | off · low · medium · xhigh |
| glm-5.3-flash | 1M / 131K | text+image | low · high · max (always thinks, no off) |

> Why `null` must be explicit: pi's `getSupportedThinkingLevels` treats `mapped === null` as unsupported and hides that level, but **omitting** it is treated as supported and the level name is sent to the API verbatim; `xhigh` / `max` additionally require an explicit non-null value to be usable.

### OpenCode Zen (free tier)

Endpoint `https://opencode.ai/zen/v1`; keys from [opencode.ai/auth](https://opencode.ai/auth) → workspace Keys. Context / max-output are the **Zen free-tier serving limits** (opencode.ai/docs/zen); the raw models are bigger — MiMo V2.5 = 1M ctx. `muse-spark-1.3-contributor-free` uses the OpenAI **Responses** API endpoint; the other five use chat completions.

Requests to this endpoint impersonate the official OpenCode client, on both probes and live requests, whenever a pool's baseUrl is `https://opencode.ai/zen/v1`:

| Header | Value | Lifetime |
|---|---|---|
| `x-opencode-client` | `tui` | constant |
| `User-Agent` | `opencode/0.1.50 ai-sdk/openai-compatible/3.0.41` | constant |
| `x-opencode-session` | `ses_` + 12 hex + 14 base62 | one per pi conversation; regenerated on `/new`, resume and fork |
| `x-opencode-request` | v4 UUID | one per machine, persisted as `deviceId` in `multikey.json` |

The session id reproduces OpenCode's own `Identifier.create()`: the first 12 hex chars encode `timestamp_ms * 0x1000 + counter` bitwise-NOTed (descending), so newer conversations sort first, and the counter resets whenever the millisecond changes.

| Model | ctx / max-out | Modalities | Supported thinking levels |
|---|---|---|---|
| big-pickle | 200K / 32K | text | always-on (no thinkingLevelMap, like pi's catalog) |
| mimo-v2.5-free | 200K / 32K | text+image | always-on (no thinkingLevelMap) |
| ling-3.0-flash-fin-free | 262K / 32K | text | always-on (no thinkingLevelMap) |
| nemotron-3-ultra-free | 1M / 128K | text | always-on (no thinkingLevelMap) |
| nemotron-3.5-lightning-free | 262K / 262K | text | always-on (no thinkingLevelMap) |
| muse-spark-1.3-contributor-free | 1M / 131K | text+image | always-on (no reasoning_options; Responses API) |

> All six models are free (zero per-token cost) for a limited time while OpenCode collects feedback; data may be used to improve the models (Nemotron free endpoints are NVIDIA trials; Muse Spark Contributor models grant Meta training permission — don't send confidential data).
>
> Removed from the preset over time as the free list changed: `deepseek-v4-flash-free` (now **paid** on Zen), `hy3-free` (no longer offered free), and `muse-spark-1.2-contributor-free` (legacy 1.3 predecessor).

### Cline Free (free tier)

Endpoint `https://api.cline.bot/api/v1` (OpenAI-compatible chat completions). Cline periodically offers free models on its usage-billing API — no static API key exists; access is tied to a **Cline account** via OAuth. The preset therefore collects a credential instead of keys:

- **Sign in with Cline (device flow)** — a WorkOS device code is shown; approve it in the browser at the given URL. The refresh token is stored in `multikey.json` and access tokens are minted/rotated automatically before each request and again on 401. This is the recommended path: pasted tokens rot, device-flow tokens don't.
- **Paste a Cline access token** — from `~/.cline/data/secrets.json` (or the Cline CLI's storage). Works until the token expires, then must be replaced manually.

Requests to this endpoint send the same client-identity headers the official Cline CLI sends, on probes and live requests alike:

| Header | Value |
|---|---|
| `HTTP-Referer` / `X-Title` | `https://cline.bot` / `Cline` |
| `X-CLIENT-TYPE` / `X-CLIENT-VERSION` | `cline-cli` / CLI version |
| `User-Agent` | `Cline/<version>` |
| `X-PLATFORM` / `X-PLATFORM-VERSION` | `cli` / CLI version |
| `X-CORE-VERSION` | SDK core version |
| `X-IS-MULTIROOT` | `false` |
| `X-Task-ID` | v4 UUID, one per pi conversation (regenerated on `/new`, resume, fork) |

Quota semantics differ from every other pool: Cline enforces a **daily, per-account, per-model** limit answered with `429 "Daily free limit reached on model X. Try again in 23h 59m"`. multikey classifies this as its own outcome — the key cools down until the server-reported reset time (shown as `cooldown 24h (daily limit)` in the status view) instead of the 20s 429 rotation, which would be meaningless here.

| Model | ctx / max-out | Notes |
|---|---|---|
| deepseek/deepseek-v4-flash | 1M / 131K | thinking levels not yet probed |
| meituan/longcat-2.0 | 1M / 131K | thinking levels not yet probed |
| poolside/laguna-s-2.1:free | 128K / 16K | limits unpublished; safe defaults |
| z-ai/glm-5.2:free | 200K / 131K | thinking levels not yet probed |

> The free lineup **rotates**: retired ids answer `"model not found"`. New models appear via `GET /models` (public) — or accept the one-time preset-sync prompt when this preset ships an updated list. Context/output numbers are best-effort (server-enforced); tune them per model in `multikey.json`.
>
> **Single-account by design.** A Cline account is meant to be used from the official IDE extension / CLI, not third-party API clients, and multi-account rotation to dodge the daily quota would violate Cline's terms. The integration exists to use *your own* account's free quota from pi; the client headers identify requests as coming from a Cline-style client. Use it accordingly.

To add a preset: append one entry to the `PRESETS` array in `presets.ts`.

### Preset sync

Pools created from a preset are tracked: `poolFromPreset` stamps a `_preset` marker (preset id + a fingerprint of the model list) into `multikey.json`.

- When a shipped preset changes (models added/removed, spec tweaks), pi asks **once** at session start: "Built-in presets changed for pool(s) … — review and align now?"
- **Align** replaces the pool's model list with the preset's; keys, endpoint, and settings are kept. **Keep my models** — or Esc, or even a crash mid-prompt — mutes that version: the offered fingerprint is persisted *before* the dialog shows, so the same version never re-prompts.
- When the preset changes **again** (new fingerprint), you're asked once more. Each version gets exactly one ask.
- Hand-tuned models never trigger the automatic prompt (the preset hasn't changed since your last sync); they stay reachable via `/multikey → Check preset updates…`, which is always available regardless of muting.
- Legacy pools (created before tracking existed) are matched by `baseUrl` and adopted into tracking the same way.
- The fingerprint covers the preset's **models only** — compat/API/description changes don't trigger prompts.

## Configuration

`~/.pi/agent/multikey.json`. On first run it auto-discovers mergeable pools from `~/.pi/agent/models.json` (≥2 providers sharing a baseUrl = you copying the provider per key), and also picks up providers pointing at `api.b.ai`; if nothing is found it generates an empty config.

```jsonc
{
  "pools": [
    {
      "id": "bai",                          // provider id in pi → bai/hy3
      "name": "B.AI (Key Pool)",
      "baseUrl": "https://api.b.ai/v1",
      "api": "openai-completions",
      "auth": "bearer",                     // optional: "bearer" (default) or "api-key" (x-api-key header)
      "compat": { ... },                    // provider-level defaults, merged into every model
      "cooldownMs": 20000,                  // 429 cooldown
      "invalidKeyCooldownMs": 600000,       // 401/403 cooldown
      "keys": [
        { "key": "sk-...", "label": "key-1", "enabled": true },
        { "key": "sk-...", "label": "key-2", "enabled": true },
        { "key": "<access token>", "label": "cline-account", "enabled": true,
          "credential": { "kind": "cline-oauth", "refreshToken": "...", "accessToken": "...", "expiresAt": 1735689600000 } }
      ],
      "models": [ "…preset or hand-configured model definitions…" ]
    }
  ]
}
```

To add nvidia / other providers later: `/multikey` → `Add pool…` (Custom), or edit the JSON directly and `Reload config from disk`.

### Adding a custom pool (no questions about API types)

The custom wizard only asks for the essentials — **provider id, base URL, key(s)**. It then probes the endpoint:

1. It fetches `<baseUrl>/models` (and `<baseUrl>/v1/models` as a fallback) with `Authorization: Bearer`; on 401/403 it retries with `x-api-key`.
2. `/models` is public on some gateways, so it also sends a tiny 1-token chat request to verify the key. If both header styles are rejected there but a dummy key passes, the endpoint simply doesn't check keys (open endpoint) and the pool is saved with the default Bearer auth.
3. You multi-select the models to add straight from the server's list. Context window / input modes / max output found in the model metadata are adopted; everything else gets safe defaults (128k context, text input, 16k max output, zero cost).
4. Optionally tune the common params (context size, input modes, max output) per model — or skip and edit them later via the Models menu. Anything advanced (thinking maps, compat, cost) you edit in `multikey.json` and hit *Reload config from disk*.

The detected header style is stored as `"auth": "api-key"` only when the endpoint proved to want `x-api-key`; the default is Bearer. The pool is saved **only after** this completes, so a cancelled wizard never leaves a half-configured provider behind.

## Management UI

```
/multikey
├─ Status                     live status: in-flight / cooldown / 429 count per key
├─ Manage pools…              pools with an unknown api type are marked ⚠ broken; incomplete pools (incomplete)
│  ├─ Keys…                   add keys one per line; delete / edit / disable
│  ├─ Models…                 fetch from /models (multi-select) or add manually; edit contextWindow,
│  │                         maxTokens, modalities, reasoning, thinkingLevelMap, compat, cost
│  ├─ Endpoint & settings…   baseUrl, api type, auth style, cooldown durations, headers
│  └─ Delete pool
├─ Add pool…
│  ├─ Preset: B.AI           all model settings preloaded; paste keys (verified by a probe) and you're done
│  ├─ Preset: OpenCode Zen   free-tier models preloaded (8 models); paste keys and you're done
│  └─ Custom…                id + base URL + keys, then auto-probe, model multi-select, safe defaults
└─ Reload config from disk
```

Changes take effect immediately (the provider is re-registered) — no restart needed.

## Pointing subagents at the pool

Set `agentOverrides` in `settings.json` to the pool provider:

```json
"subagents": {
  "agentOverrides": {
    "oracle":   { "model": "bai/glm-5.3-flash" },
    "scout":    { "model": "bai/hy3" },
    "worker":   { "model": "bai/mimo-v2.5" }
  }
}
```

`defaultProvider: "bai"` works the same way.

## How it works

- The extension registers a provider via `pi.registerProvider()` with a custom `streamSimple`.
- Each request leases one key from the pool (`options.apiKey` overrides), and once the HTTP response headers arrive:
  - 429 → that key is cooled down (default 20s, honoring `retry-after`) and the request immediately retries with the next key (no duplicated output);
  - Cline daily free limit (429 + `"free limit reached on model"` in the body) → that key cools down until the server-reported reset time (hours, not seconds) and the request retries with the next key;
  - 401/403 → that key gets a long cooldown (default 10 minutes) and the request retries with the next key; for OAuth-backed keys (Cline), a 401 first forces one token refresh + same-key retry before any cooldown;
  - other errors → handed back to pi's own retry mechanism.
- OAuth-backed keys (Cline accounts) resolve a fresh access token from their stored refresh token before every request (single-flight per account, so concurrent subagents share one refresh), and every rotation of the refresh token is persisted back to `multikey.json`.
- Only when every key is exhausted does it surface the 429 upward, letting pi's own backoff retry as a safety net (by then the earliest cooldown has usually expired).

## Security note

Keys are stored in plaintext at `~/.pi/agent/multikey.json`; recommended:

```bash
chmod 600 ~/.pi/agent/multikey.json
```
