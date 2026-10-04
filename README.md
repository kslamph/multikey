# pi-multikey

One Pi provider backed by many API keys: every in-flight request leases a key,
and 429/401/403 rotates to the next one with a cooldown.

[中文](./README.zh.md)

## What's included

| Extension | Command / shortcut | What it does |
|---|---|---|
| `index.ts` | `/multikey` | Management TUI: live per-key status, add/edit/delete pools, keys, models, endpoints and cooldowns, preset sync, reload from disk |
| `index.ts` | — | Registers one Pi provider per pool (for example `bai`); models are used as `<pool-id>/<model-id>` and each request holds a key lease (fewest in-flight, then least recently used) |
| `index.ts` | — | On `session_start`, reports pools that failed to register and the first-run config result, and offers preset updates |

No keybindings, model-callable tools, or CLI flags are registered.

## Install

```bash
pi install npm:pi-multikey
pi install git:github.com/kslamph/multikey@v1.19.0
pi install ./path/to/checkout   # local checkout, loaded in place
```

Try it without installing (loads for one invocation, adds nothing to settings):

```bash
pi -e npm:pi-multikey
```

Pi package basics: <https://pi.dev/docs>.

## Usage

Start from a preset — endpoint, compat and model specs are preconfigured, you
only paste keys:

```
/multikey → Add pool… → Preset: B.AI → paste keys, one per line (blank to finish)
```

Models are then available as `bai/<model-id>`, e.g. `bai/hy3`. Built-in presets:

- **B.AI** — 5 models (Hunyuan Hy3, MiMo V2.5, Qwen3.8 Flash, DeepSeek V4.1 Flash, GLM 5.3 Flash).
- **OpenCode Zen** — 7 free models. The extension sends the OpenCode client identity headers the free tier requires.
- **Cline Free** — 8 models on a Cline account. The key prompt offers `Sign in with Cline (device flow)…` or a pasted access token.

Any other OpenAI-compatible endpoint:

```
/multikey → Add pool… → Custom… → provider id, base URL, keys
```

The wizard probes `GET <baseUrl>/models` (and `<baseUrl>/v1/models`), falls back
from `Authorization: Bearer` to `x-api-key`, verifies the key with a small chat
request, then lets you multi-select models from the server's list. The pool
is saved only after the wizard completes. Cline endpoints are probed Bearer-only.

Day to day you do nothing: a 429 cools that key (default 20s, `retry-after`
honored) and the request retries on the next key with no duplicate output; a
401/403 cools it for 10 minutes; Cline's daily free limit cools until the
server-reported reset. OAuth-backed Cline keys refresh before each request and
again on 401, and the rotated refresh token is written back to config. Only when
every key is exhausted is the error surfaced. Concurrent subagents each hold
their own lease, so point them at `<pool-id>/<model-id>` and they spread across
keys automatically. Changes apply immediately; no restart.

## Configuration

Zero config beyond adding a pool. State lives in `~/.pi/agent/multikey.json`
(override with `MULTIKEY_CONFIG`, legacy alias `KEYPOOL_CONFIG`) and is created
on first run. Creation scans `~/.pi/agent/models.json` and merges providers that
share one `baseUrl` (two or more) or point at `api.b.ai`; `$ENV` / `${ENV}` key
references are resolved, `!command` values are skipped. If nothing matches, an
empty config is written. A pre-rename `~/.pi/agent/keypool.json` is migrated
once and kept as a backup.

| Pool field | Default | Meaning |
|---|---|---|
| `id` | required | Pi provider id; models become `<id>/<model-id>` |
| `baseUrl` | required | Endpoint for the pool |
| `api` | `openai-completions` | Streaming API type (any registered Pi api) |
| `auth` | `bearer` | `api-key` sends `x-api-key`; Cline always uses Bearer |
| `cooldownMs` | `20000` | Cooldown after a 429 |
| `invalidKeyCooldownMs` | `600000` | Cooldown after a 401/403 |
| `keys[]` | required | `{ key, label?, enabled? }`, or a Cline `credential` |
| `models[]` | required | Model definitions (`id`, `api`, `baseUrl`, `contextWindow`, `maxTokens`, `input`, `thinkingLevelMap`, `compat`, `cost`) |
| `compat`, `headers` | — | Provider-level defaults merged into every model / sent on every request |

A model spec that omits sizing gets `contextWindow` 128000, `maxTokens` 16384,
`input` `["text"]`, zero cost, `reasoning` true. Models whose `api` differs from
the pool's are registered under a second provider id, `<pool-id>.<api>`, sharing
the same keys and cooldowns.

## Security

The extension runs in-process with your OS user's permissions.

- API keys and Cline refresh/access tokens are stored in plaintext in
  `~/.pi/agent/multikey.json`. Run `chmod 600 ~/.pi/agent/multikey.json`.
- Network access: the endpoints you configure; `https://opencode.ai/update/api/latest/cli`
  when a Zen pool exists (to resolve the client version its free tier gates on);
  `api.workos.com` and `api.cline.bot` during Cline sign-in.
- The custom and preset wizards send `GET <baseUrl>/models` and, when a model
  id is known, a small chat request to verify a key.
- During Cline device-flow sign-in it spawns your OS opener (`xdg-open`, `open`,
  or `cmd /c start`) for the verification URL. No other shells are invoked.
- No telemetry.

## Update / remove / enable-disable

```bash
pi update --extensions          # update every installed package
pi update npm:pi-multikey       # update one package
pi list                         # list installed packages
pi remove npm:pi-multikey       # remove from settings
pi config                       # enable/disable package resources in a TUI
```

## Compatibility

- Pi 1.0.2 — verified by loading the entry file: `pi --offline -ne -e ./index.ts --list-models`.
- Node 24 — `npm test` passes on 24.20.0.
- Linux verified. macOS and Windows: TODO: confirm.
- Peer dependencies (provided by Pi at runtime, declared as `*`):
  `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`.

## Development

```bash
git clone https://github.com/kslamph/multikey
cd multikey
npm test                             # node --test *.test.ts (offline)
pi -e ./index.ts --offline --list-models
```

Running Pi from inside the repo loads the working copy in place; `pi -e ./index.ts`
loads only the entry file for one invocation.

## License

MIT — see [LICENSE](./LICENSE).

Cline account auth and the Cline client header set are ported from the cline SDK;
OpenCode Zen identity headers follow opencode's `model-request.ts`. Preset model
specs come from provider model cards and docs, with thinking levels probed live.
