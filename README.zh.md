# pi-keypool

一个 pi 扩展：把多个 API key 组成一个"密钥池"，对外只暴露**一个 provider**。

解决三个痛点：

1. **不用为每个 key 复制一份 provider 配置** —— 模型（contextWindow / 模态 / thinkingLevelMap / compat）只配置一次，换 key、加 key 都不动模型定义。
2. **429 自动换 key** —— 请求失败立刻用下一个 key 重试，失败的 key 进入冷却（尊重 `retry-after`），无需手工切换 provider。
3. **并发 subagent 自动分摊 key** —— 每个进行中的请求持有一个 key lease，选择策略是"在用数最少 + 最久未用"，所以主 agent 同时开多个 subagent 时，它们天然落在不同的 key 上。

## 安装

```bash
# 方式一：git（推荐，无需 npm 账号）
pi install git:github.com/<user>/pi-keypool@v1.0.0

# 方式二：npm
pi install npm:pi-keypool

# 方式三：本地目录
pi install /path/to/keypool
```

## 快速开始（B.AI preset）

```
/keypool → Add pool… → Preset: B.AI → 逐行粘贴 key（一行一个，留空结束）
```

选 preset 后 endpoint、compat、6 个模型的全部设定自动就位，模型通过
`bai/<model-id>` 直接可用，例如 `bai/deepseek-v4-flash`。

## Presets

内置 preset 把"模型设定"与"密钥"解耦。数据来自 b.ai model cards、
DeepSeek / Tencent / 小米官方文档，并对每个 thinking 档位做过实测探测；
不支持的档位写为 `null`，UI 不显示。

| 模型 | ctx / max-out | 模态 | 生效 thinking 档位 |
|---|---|---|---|
| deepseek-v4-flash | 1M / 384K | text | off · low · high · max |
| deepseek-v4-flash-vision-exp | 1M / 384K | text+image | off · low · high · max |
| hy3 | 256K / 128K | text | off · low · high |
| mimo-v2.5 | 1M / 128K | text+image | off · high（官方：low/medium/high 行为相同） |
| qwen3.8-flash | 1M / 131K | text+image | off · low · medium · xhigh |
| glm-5.3-flash | 1M / 131K | text+image | low · high · max（始终思考，无 off） |

> 为什么必须显式写 `null`：pi 的 `getSupportedThinkingLevels` 把 `mapped === null`
> 视为不支持并隐藏该档，但**省略**会被当作支持并把档名原样发给 API；
> `xhigh` / `max` 还要求显式给出非 null 值才可用。

新增 preset：在 `presets.ts` 的 `PRESETS` 数组里加一项即可。

## 配置

`~/.pi/agent/keypool.json`。首次运行时会从 `~/.pi/agent/models.json` 自动发现
可合并的池（同一 baseUrl 出现 ≥2 个 provider = 你在按 key 复制 provider），
也会收录指向 `api.b.ai` 的 provider；什么都没发现则生成空配置。

```jsonc
{
  "pools": [
    {
      "id": "bai",                          // pi 里的 provider id → bai/deepseek-v4-flash
      "name": "B.AI (Key Pool)",
      "baseUrl": "https://api.b.ai/v1",
      "api": "openai-completions",
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

以后要加 nvidia / opencode 等：`/keypool` → `Add pool…`（Custom），或直接编辑
JSON 后 `Reload config from disk`。

## 管理界面

```
/keypool
├─ Status                    实时状态：每把 key 的 in-flight / 冷却 / 429 计数
├─ Manage pools…
│  ├─ Keys…                  一行一个添加 key；删 / 改 / 禁用
│  ├─ Models…                增删模型，编辑 contextWindow、maxTokens、模态、
│  │                         reasoning、thinkingLevelMap、compat、cost
│  ├─ Endpoint & settings…   baseUrl、api 类型、冷却时长、headers
│  └─ Delete pool
├─ Add pool…
│  ├─ Preset: B.AI           预置全部模型设定，逐个粘贴 key 即可用
│  └─ Custom…                自己填 endpoint、api 类型、模型
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

key 明文保存在 `~/.pi/agent/keypool.json`，建议：

```bash
chmod 600 ~/.pi/agent/keypool.json
```
