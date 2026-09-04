# pi-multikey

一个 pi 扩展：把多个 API key 组成一个"密钥池"，对外只暴露**一个 provider**。

解决三个痛点：

1. **不用为每个 key 复制一份 provider 配置** —— 模型（contextWindow / 模态 / thinkingLevelMap / compat）只配置一次，换 key、加 key 都不动模型定义。
2. **429 自动换 key** —— 请求失败立刻用下一个 key 重试，失败的 key 进入冷却（尊重 `retry-after`），无需手工切换 provider。
3. **并发 subagent 自动分摊 key** —— 每个进行中的请求持有一个 key lease，选择策略是"在用数最少 + 最久未用"，所以主 agent 同时开多个 subagent 时，它们天然落在不同的 key 上。

## 安装

```bash
# 方式一：git（推荐，无需 npm 账号）
pi install git:github.com/kslamph/multikey@v1.2.0

# 方式二：npm（scoped 包，发布时始终带 --access public）
pi install npm:pi-multikey

# 方式三：本地目录
pi install /path/to/multikey
```

## 快速开始（B.AI preset）

```
/multikey → Add pool… → Preset: B.AI → 逐行粘贴 key（一行一个，留空结束）
```

选 preset 后 endpoint、compat、4 个模型的全部设定自动就位，模型通过
`bai/<model-id>` 直接可用，例如 `bai/hy3`。

## Presets

内置 preset 把"模型设定"与"密钥"解耦。数据来自 b.ai model cards、
DeepSeek / Tencent / 小米官方文档，并对每个 thinking 档位做过实测探测；
不支持的档位写为 `null`，UI 不显示。

| 模型 | ctx / max-out | 模态 | 生效 thinking 档位 |
|---|---|---|---|
| hy3 | 256K / 128K | text | off · low · high |
| mimo-v2.5 | 1M / 128K | text+image | off · high（官方：low/medium/high 行为相同） |
| qwen3.8-flash | 1M / 131K | text+image | off · low · medium · xhigh |
| glm-5.3-flash | 1M / 131K | text+image | low · high · max（始终思考，无 off） |

> 为什么必须显式写 `null`：pi 的 `getSupportedThinkingLevels` 把 `mapped === null`
> 视为不支持并隐藏该档，但**省略**会被当作支持并把档名原样发给 API；
> `xhigh` / `max` 还要求显式给出非 null 值才可用。

### OpenCode Zen（免费层）

端点 `https://opencode.ai/zen/v1`；密钥从 [opencode.ai/auth](https://opencode.ai/auth) → workspace Keys 获取。
上下文/最大输出为 **Zen 免费层限制**（opencode.ai/docs/zen）；原始模型更大——MiMo V2.5 = 1M ctx。
`muse-spark-1.3-contributor-free` 使用 OpenAI **Responses** API；其余五个使用 chat completions。

只要 pool 的 baseUrl 是 `https://opencode.ai/zen/v1`，探测和真实请求都会伪装成官方 OpenCode 客户端：

| 请求头 | 值 | 生命周期 |
|---|---|---|
| `x-opencode-client` | `tui` | 常量 |
| `User-Agent` | `opencode/0.1.50 ai-sdk/openai-compatible/3.0.41` | 常量 |
| `x-opencode-session` | `ses_` + 12 位十六进制 + 14 位 base62 | 每个 pi 会话一个；`/new`、resume、fork 时重新生成 |
| `x-opencode-request` | v4 UUID | 每台机器一个，作为 `deviceId` 持久化在 `multikey.json` |

session id 复现了 OpenCode 自己的 `Identifier.create()`：前 12 位十六进制编码 `timestamp_ms * 0x1000 + counter` 后按位取反（降序），因此新会话排序在前；计数器仅在毫秒变化时重置。

| 模型 | ctx / max-out | 模态 | 生效 thinking 档位 |
|---|---|---|---|
| big-pickle | 200K / 32K | text | 始终思考（无 thinkingLevelMap，与 pi 内置目录一致） |
| mimo-v2.5-free | 200K / 32K | text+image | 始终思考（无 thinkingLevelMap） |
| ling-3.0-flash-fin-free | 262K / 32K | text | 始终思考（无 thinkingLevelMap） |
| nemotron-3-ultra-free | 1M / 128K | text | 始终思考（无 thinkingLevelMap） |
| nemotron-3.5-lightning-free | 262K / 262K | text | 始终思考（无 thinkingLevelMap） |
| muse-spark-1.3-contributor-free | 1M / 131K | text+image | 始终思考（无 reasoning_options；Responses API） |

> 以上六个模型在 OpenCode 收集反馈期间均免费（零 token 费用）；数据可能用于改进模型（Nemotron 免费端点为 NVIDIA 试用；Muse Spark Contributor 模型授权 Meta 用于训练——请勿提交机密数据）。
>
> 免费列表变化后已从 preset 移除：`deepseek-v4-flash-free`（在 Zen 上已转为**付费**）、`hy3-free`（不再提供免费层）、`muse-spark-1.2-contributor-free`（1.3 的前身遗留变体）。

新增 preset：在 `presets.ts` 的 `PRESETS` 数组里加一项即可。

### Preset 同步

从 preset 创建的池会被追踪：`poolFromPreset` 会在 `multikey.json` 里写入 `_preset` 标记（preset id + 模型列表的指纹）。

- 内置 preset 变化（模型增删、参数调整）后，pi 会在会话启动时**只询问一次**：“内置 preset 已变化……是否立即对齐？”
- **Align** 用 preset 的模型列表替换池的模型；密钥、endpoint、其他设置保留。**Keep my models**——以及 Esc、甚至提示中途崩溃——都会静音该版本：提供的指纹在弹窗**之前**就已持久化，同一版本绝不会重复询问。
- preset **再次**变化（新指纹）时会再询问一次。每个版本恰好一次。
- 手动调过参数的池不会触发自动询问（自上次同步后 preset 没变）；它们始终可以通过 `/multikey → Check preset updates…` 检查，该入口不受静音影响。
- 旧版本创建的池（早于追踪功能）按 `baseUrl` 匹配并以同样方式纳入追踪。
- 指纹只覆盖 preset 的**模型列表**——compat/API/描述变化不会触发询问。

## 配置

`~/.pi/agent/multikey.json`。首次运行时会从 `~/.pi/agent/models.json` 自动发现
可合并的池（同一 baseUrl 出现 ≥2 个 provider = 你在按 key 复制 provider），
也会收录指向 `api.b.ai` 的 provider；什么都没发现则生成空配置。

```jsonc
{
  "pools": [
    {
      "id": "bai",                          // pi 里的 provider id → bai/hy3
      "name": "B.AI (Key Pool)",
      "baseUrl": "https://api.b.ai/v1",
      "api": "openai-completions",
      "auth": "bearer",                       // 可选："bearer"（默认）或 "api-key"（x-api-key 头）
      "compat": { ... },                    // provider 级默认，合并进每个模型
      "cooldownMs": 20000,                  // 429 冷却
      "invalidKeyCooldownMs": 600000,       // 401/403 冷却
      "keys": [
        { "key": "sk-...", "label": "key-1", "enabled": true },
        { "key": "sk-...", "label": "key-2", "enabled": true }
      ],
      "models": [ "…preset 或手动配置的模型定义…" ]
    }
  ]
}
```

以后要加 nvidia 等其他 provider：`/multikey` → `Add pool…`（Custom），或直接编辑
JSON 后 `Reload config from disk`。

### 添加自定义池（不再询问 API 类型）

自定义向导只问最基本的三项：**provider id、Base URL、key**。随后自动探测端点：

1. 用 `Authorization: Bearer` 请求 `<baseUrl>/models`（会自动尝试 `<baseUrl>/v1/models`），若返回 401/403 再换 `x-api-key` 重试。
2. 有些网关的 `/models` 是公开的，因此还会发一个 1 token 的迷你 chat 请求验证 key。若两种头都被拒但假 key 能通过，说明是免鉴权的开放端点，按默认 Bearer 保存。
3. 直接从服务端返回的模型列表中**多选**要添加的模型。元数据里的上下文长度 / 输入模态 / 最大输出会被采用，其余一律安全默认值（128k 上下文、text 输入、16k 最大输出、成本 0）。
4. 可选：逐模型微调常用参数（上下文、输入模态、最大输出），或跳过以后在 Models 菜单里改。高级字段（thinking 映射、compat、cost）直接编辑 `multikey.json` 后 `Reload config from disk`。

探测出的认证头风格只在端点确实要求 `x-api-key` 时才会存为 `"auth": "api-key"`，默认 Bearer。整池**最后一次性写入**，中途取消不会留下半成品 provider。

## 管理界面

```
/multikey
├─ Status                    实时状态：每把 key 的 in-flight / 冷却 / 429 计数
├─ Manage pools…             api 类型非法的池会标 ⚠ broken；未完成的池标 (incomplete)
│  ├─ Keys…                  一行一个添加 key；删 / 改 / 禁用
│  ├─ Models…                从 /models 拉取多选添加，或手动添加；编辑 contextWindow、
│  │                         maxTokens、模态、reasoning、thinkingLevelMap、compat、cost
│  ├─ Endpoint & settings…   baseUrl、api 类型、认证风格、冷却时长、headers
│  └─ Delete pool
├─ Add pool…
│  ├─ Preset: B.AI           预置全部模型设定，粘贴 key（自动校验）即可用
│  ├─ Preset: OpenCode Zen   免费层模型预置（8 个模型），粘贴 key 即可用
│  └─ Custom…                只填 id + Base URL + key，随后自动探测、多选模型、安全默认值
└─ Reload config from disk
```

改动即时生效（重新注册 provider），无需重启。

## 让 subagent 用上池

`settings.json` 的 agentOverrides 改成池 provider：

```json
"subagents": {
  "agentOverrides": {
    "oracle":   { "model": "bai/glm-5.3-flash" },
    "scout":    { "model": "bai/hy3" },
    "worker":   { "model": "bai/mimo-v2.5" }
  }
}
```

`defaultProvider: "bai"` 同理。

## 工作原理

- 扩展通过 `pi.registerProvider()` 注册 provider，并提供自定义 `streamSimple`。
- 每次请求从池中取一把 key（`options.apiKey` 覆盖），收到 HTTP 响应头后：
  - 429 → 该 key 冷却（默认 20s，尊重 `retry-after`），立即换 key 重试（不产生任何重复输出）；
  - 401/403 → 该 key 长冷却（默认 10 分钟），换 key 重试；
  - 其他错误 → 原样交给 pi 的重试机制。
- 所有 key 都耗尽时才向上抛 429，由 pi 自身的 backoff 重试兜底（此时最早的冷却多半已结束）。

## 安全提示

key 明文保存在 `~/.pi/agent/multikey.json`，建议：

```bash
chmod 600 ~/.pi/agent/multikey.json
```
