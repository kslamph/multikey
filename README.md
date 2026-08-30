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

After picking the preset, the endpoint, compat, and all 6 model definitions are wired up automatically. Models are available directly as `bai/<model-id>`, e.g. `bai/deepseek-v4-flash`.

## Presets

Built-in presets decouple "model settings" from "keys". The data comes from b.ai model cards and DeepSeek / Tencent / Xiaomi official docs, with each thinking level probed empirically; unsupported levels are written as `null` so the UI hides them.

| Model | ctx / max-out | Modalities | Supported thinking levels |
|---|---|---|---|
| deepseek-v4-flash | 1M / 384K | text | off · low · high · max |
| deepseek-v4-flash-vision-exp | 1M / 384K | text+image | off · low · high · max |
| hy3 | 256K / 128K | text | off · low · high |
| mimo-v2.5 | 1M / 128K | text+image | off · high (official: low/medium/high behave identically) |
| qwen3.8-flash | 1M / 131K | text+image | off · low · medium · xhigh |
| glm-5.3-flash | 1M / 131K | text+image | low · high · max (always thinks, no off) |

> Why `null` must be explicit: pi's `getSupportedThinkingLevels` treats `mapped === null` as unsupported and hides that level, but **omitting** it is treated as supported and the level name is sent to the API verbatim; `xhigh` / `max` additionally require an explicit non-null value to be usable.

### OpenCode Zen (free tier)

Endpoint `https://opencode.ai/zen/v1`; keys from [opencode.ai/auth](https://opencode.ai/auth) → workspace Keys. Context / max-output are the **Zen free-tier serving limits** (consistent across models.dev `opencode` provider + pi's built-in opencode catalog); the raw models are bigger — MiMo V2.5 = 1M ctx, Hy3 = 262K ctx. `muse-spark-1.2-contributor-free` uses the OpenAI **Responses** API endpoint; the other seven use chat completions.

| Model | ctx / max-out | Modalities | Supported thinking levels |
|---|---|---|---|
| big-pickle | 200K / 32K | text | always-on (no thinkingLevelMap, like pi's catalog) |
| deepseek-v4-flash-free | 200K / 128K | text | off · low · high · max (mirrors b.ai's deepseek-v4-flash) |
| mimo-v2.5-free | 200K / 32K | text+image | always-on (no thinkingLevelMap) |
| hy3-free | 190K / 64K | text | low · medium · high (no off) |
| ling-3.0-flash-fin-free | 256K / 32K | text | always-on (no thinkingLevelMap) |
| nemotron-3-ultra-free | 1M / 128K | text | always-on (no thinkingLevelMap) |
| nemotron-3.5-lightning-free | 256K / 256K | text | always-on (no thinkingLevelMap) |
| muse-spark-1.2-contributor-free | 1M / 128K | text+image | minimal · low · medium · high · xhigh (no off, Responses API) |

> All eight models are free (zero per-token cost) for a limited time while OpenCode collects feedback; data may be used to improve the models (Nemotron free endpoints are NVIDIA trials — don't send confidential data).

To add a preset: append one entry to the `PRESETS` array in `presets.ts`.

## Configuration

`~/.pi/agent/multikey.json`. On first run it auto-discovers mergeable pools from `~/.pi/agent/models.json` (≥2 providers sharing a baseUrl = you copying the provider per key), and also picks up providers pointing at `api.b.ai`; if nothing is found it generates an empty config.

```jsonc
{
  "pools": [
    {
      "id": "bai",                          // provider id in pi → bai/deepseek-v4-flash
      "name": "B.AI (Key Pool)",
      "baseUrl": "https://api.b.ai/v1",
      "api": "openai-completions",
      "auth": "bearer",                     // optional: "bearer" (default) or "api-key" (x-api-key header)
      "compat": { ... },                    // provider-level defaults, merged into every model
      "cooldownMs": 20000,                  // 429 cooldown
      "invalidKeyCooldownMs": 600000,       // 401/403 cooldown
      "keys": [
        { "key": "sk-...", "label": "key-1", "enabled": true },
        { "key": "sk-...", "label": "key-2", "enabled": true }
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
  - 401/403 → that key gets a long cooldown (default 10 minutes) and the request retries with the next key;
  - other errors → handed back to pi's own retry mechanism.
- Only when every key is exhausted does it surface the 429 upward, letting pi's own backoff retry as a safety net (by then the earliest cooldown has usually expired).

## Releasing to npm

A GitHub Action (`.github/workflows/release.yml`) auto-publishes to npm on tag push.

1. Bump the version in `package.json` (and commit).
2. Tag the commit — the tag must match the version, e.g. `v1.0.1`:

   ```bash
   git tag v1.0.1
   git push origin v1.0.1
   ```

3. The workflow verifies tag/version match, dry-runs `npm pack`, then publishes with
   [npm provenance](https://docs.npmjs.com/generating-provenance-statements).

Setup (once):

- Add an npm **automation** token with `publish` scope as the `NPM_TOKEN` secret
  in the repo's GitHub **Settings → Secrets and variables → Actions**.
  (An automation token, not your login token, so 2FA never blocks the action.)
- The repo and package must be **public** for provenance to work.
- Pre-release tags like `v1.0.1-beta.1` publish to the `next` dist-tag instead of `latest`.

## Security note

Keys are stored in plaintext at `~/.pi/agent/multikey.json`; recommended:

```bash
chmod 600 ~/.pi/agent/multikey.json
```
