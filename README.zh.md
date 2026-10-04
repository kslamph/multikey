# pi-multikey

一个 Pi provider 背后挂多个 API key：每个进行中的请求租用一把 key，
遇到 429/401/403 自动冷却并换下一把重试。

[English](./README.md)

## 包含内容

| 扩展 | 命令 / 快捷键 | 作用 |
|---|---|---|
| `index.ts` | `/multikey` | 管理 TUI：每把 key 的实时状态，增删改池 / key / 模型 / 端点 / 冷却时长，preset 同步，从磁盘重载 |
| `index.ts` | — | 每个池注册一个 Pi provider（例如 `bai`）；模型以 `<pool-id>/<model-id>` 使用，每个请求持有一把 key lease（在用数最少，其次最久未用） |
| `index.ts` | — | `session_start` 时提示注册失败的池、首次运行的配置结果，并询问是否同步 preset |

不注册快捷键、模型可调用工具或 CLI 参数。

## 安装

```bash
pi install npm:pi-multikey
pi install git:github.com/kslamph/multikey@v1.19.0
pi install ./path/to/checkout     # 本地目录，原地加载
```

不安装试用（仅本次调用生效，不写入 settings）：

```bash
pi -e npm:pi-multikey
```

Pi 包的基础知识：<https://pi.dev/docs>。

## 使用

从 preset 起步 —— endpoint、compat 和模型设定都已就位，只需粘贴 key：

```
/multikey → Add pool… → Preset: B.AI → 逐行粘贴 key（一行一个，留空结束）
```

模型随后以 `bai/<model-id>` 可用，例如 `bai/hy3`。内置 preset：

- **B.AI** —— 5 个模型（Hunyuan Hy3、MiMo V2.5、Qwen3.8 Flash、DeepSeek V4.1 Flash、GLM 5.3 Flash）。
- **OpenCode Zen** —— 7 个免费模型。扩展会发送该免费层要求的 OpenCode 客户端身份头。
- **Cline Free** —— 8 个模型，基于 Cline 账号。key 提示中可选 `Sign in with Cline (device flow)…` 或粘贴 access token。

其他任意 OpenAI 兼容端点：

```
/multikey → Add pool… → Custom… → provider id、Base URL、key
```

向导会探测 `GET <baseUrl>/models`（以及备用的 `<baseUrl>/v1/models`），
从 `Authorization: Bearer` 回退到 `x-api-key`，再用一个极小的 chat 请求校验 key，
最后让你从服务端列表中多选模型。整池仅在向导完成后保存。Cline 端点只用 Bearer 探测。

日常无需干预：429 会让该 key 冷却（默认 20s，尊重 `retry-after`），请求立刻换 key
重试且不产生重复输出；401/403 冷却 10 分钟；Cline 的每日免费额度会冷却到服务端给出的
重置时间。OAuth 形式的 Cline key 会在每次请求前刷新，遇到 401 再刷新一次，轮换后的
refresh token 会写回配置。只有所有 key 都耗尽才会把错误抛给 agent。并发 subagent 各自
持有 lease，把它们指向 `<pool-id>/<model-id>` 即会自动分摊到不同 key。改动即时生效，
无需重启。

## 配置

除添加池外零配置。状态文件为 `~/.pi/agent/multikey.json`（可用 `MULTIKEY_CONFIG`
覆盖，旧别名 `KEYPOOL_CONFIG`），首次运行自动创建。创建时会扫描
`~/.pi/agent/models.json`，把共用同一个 `baseUrl`（两个及以上）或指向 `api.b.ai`
的 provider 合并成池；key 里的 `$ENV` / `${ENV}` 会被解析，`!command` 会被跳过。
若什么都没发现则写入空配置。改名前的 `~/.pi/agent/keypool.json` 会迁移一次，
原文件保留为备份。

| 池字段 | 默认值 | 含义 |
|---|---|---|
| `id` | 必填 | Pi provider id；模型为 `<id>/<model-id>` |
| `baseUrl` | 必填 | 池的端点 |
| `api` | `openai-completions` | 流式 API 类型（任意已注册的 Pi api） |
| `auth` | `bearer` | `api-key` 发送 `x-api-key`；Cline 始终用 Bearer |
| `cooldownMs` | `20000` | 429 后的冷却 |
| `invalidKeyCooldownMs` | `600000` | 401/403 后的冷却 |
| `keys[]` | 必填 | `{ key, label?, enabled? }`，或 Cline 的 `credential` |
| `models[]` | 必填 | 模型定义（`id`、`api`、`baseUrl`、`contextWindow`、`maxTokens`、`input`、`thinkingLevelMap`、`compat`、`cost`） |
| `compat`、`headers` | — | provider 级默认值，合并进每个模型 / 每个请求都发送 |

未给出尺寸的模型规格默认取 `contextWindow` 128000、`maxTokens` 16384、
`input` `["text"]`、成本 0、`reasoning` true。模型的 `api` 与池不同时，会以
`<pool-id>.<api>` 再注册一个 provider，共享同一批 key 与冷却状态。

## 安全提示

扩展在 Pi 进程内以你的操作系统用户权限运行。

- API key 与 Cline 的 refresh/access token 明文保存在 `~/.pi/agent/multikey.json`。
  建议 `chmod 600 ~/.pi/agent/multikey.json`。
- 网络访问：你配置的端点；存在 Zen 池时的
  `https://opencode.ai/update/api/latest/cli`（用于解析其免费层校验的客户端版本）；
  Cline 登录期间的 `api.workos.com` 与 `api.cline.bot`。
- preset 与 Custom 向导会发送 `GET <baseUrl>/models`，并在已知模型 id 时发送一个极小的
  chat 请求来校验 key。
- Cline device flow 登录期间会调用系统打开器（`xdg-open`、`open` 或 `cmd /c start`）
  打开验证 URL。不执行其他 shell 命令。
- 无遥测。

## 更新 / 移除 / 启用禁用

```bash
pi update --extensions          # 更新全部已安装包
pi update npm:pi-multikey       # 更新单个包
pi list                         # 列出已安装包
pi remove npm:pi-multikey       # 从 settings 移除
pi config                       # 在 TUI 中启用/禁用包资源
```

## 兼容性

- Pi 1.0.2 —— 通过加载入口文件验证：`pi --offline -ne -e ./index.ts --list-models`。
- Node 24 —— `npm test` 在 24.20.0 上通过。
- 已验证 Linux。macOS 与 Windows：TODO: confirm。
- Peer 依赖（运行时由 Pi 提供，声明为 `*`）：
  `@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`。

## 开发

```bash
git clone https://github.com/kslamph/multikey
cd multikey
npm test                             # node --test *.test.ts（离线）
pi -e ./index.ts --offline --list-models
```

在仓库内运行 Pi 会原地加载工作副本；`pi -e ./index.ts` 只加载入口文件，仅本次调用。

## 许可

MIT —— 见 [LICENSE](./LICENSE)。

Cline 账号认证与 Cline 客户端头移植自 cline SDK；OpenCode Zen 身份头遵循 opencode 的
`model-request.ts`。Preset 模型规格来自各 provider 的 model card 与官方文档，thinking
档位经实测探测。
