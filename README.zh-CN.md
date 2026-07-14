# opencode-smart-approval

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[OpenCode](https://github.com/sst/opencode) 的 Shell 命令智能审批插件。通过 [Tirith](https://github.com/sheeki03/tirith)、Tree-sitter Shell 分析、确定性规则和带只读工具的 LLM 审查，在不降低安全性的前提下减少审批成本。

OpenCode 不提供命令沙盒。本插件把个人信任决策留给显式用户规则，只提供极小的通用内置快速路径，并在上下文 LLM 审查前交由 Tirith 判断风险。

## 工作原理

每条 shell 命令（`bash`、`shell`、`exec_command` 等）经过以下管线：

```
配置自我保护 → 用户规则 → 内置规则 → Tirith → LLM
```

| 阶段 | 行为 |
|------|------|
| **配置自我保护** | 在常规审批前，拒绝 Shell 写入以及 OpenCode `Write`/`Edit`/`apply_patch` 对当前全局或项目策略文件的编辑。默认开启，可配置关闭。 |
| **用户规则** | 优先级最高。完整 allow 或 deny 立即终止，不执行任何后续阶段。Tree-sitter 提取静态可执行段，管道一侧不能替另一侧授权。 |
| **内置规则** | 只为常见低风险命令提供少量 allow/deny 快速路径，不维护平台专属风险目录。 |
| **Tirith** | 确定性规则未决时扫描完整、未拆分的原始命令。block 为最终结果；allow/warn 继续交给 LLM，warn 会作为证据附带。 |
| **LLM 审查** | 最终上下文判断，使用完整命令、扫描结果、只读文件工具和对话上下文。失败封闭。 |

用户规则阶段中，同一命令段先取最高整数 `priority`，同优先级按 **deny > review > allow** 决策；不同命令段也按同样顺序聚合。管道或列表只有每个静态可执行段都被允许时才短路。任一段命中用户 deny 会拒绝整条命令；部分 allow、未匹配或显式 review 会继续进入 Tirith 和 LLM。

## 前置条件：bash 权限放行

OpenCode 必须允许 bash 工具，命令才能到达本插件。在 `~/.config/opencode/opencode.json` 中：

```json
{
  "permission": { "bash": "allow" },
  "plugin": ["opencode-smart-approval"]
}
```

插件通过 `tool.execute.before` 钩子拦截——只有在 OpenCode 本来会执行命令时才触发。如果 bash 设为 `deny` 或 `ask`，插件没有机会审查。

## 安装

```sh
npm install -g opencode-smart-approval
```

## 配置

插件将全局配置作为可信策略边界：

1. **全局** — `~/.config/opencode/command-approval.jsonc`（或 `$XDG_CONFIG_HOME/opencode/`）。首次运行时如不存在则自动生成默认配置。
2. **本地** — 项目目录下的 `./command-approval.jsonc`。项目文件可能不可信，因此默认忽略。只有全局文件显式设置 `"allow_local_config": true` 时，它才会替代全局配置。

创建全局配置（支持 JSONC 注释）：

```jsonc
{
  "version": 2,
  "allow_local_config": false,
  "self_protection": { "enabled": true },
  "review": {
    "base_url": "https://api.openai.com/v1",
    "api_key": "sk-...",
    "model": "gpt-4o-mini",
    "timeout_ms": 45000,
    "max_script_bytes": 20000,
    "max_tool_calls": 3,
    "max_retries": 3,
    "context_messages": 20
    // "prompt": "..."  // 覆盖默认审查策略
  },
  "tirith": {
    "enabled": true,
    "timeout_ms": 5000,
    "fail_open": false
  },
  "rules": {
    "deny": [],
    "review": [
      { "match": "^deploy(?:\\s|$).*", "scope": "segment", "priority": 50 }
    ],
    "allow": [
      {
        "match": "^my-read-only-tool(?:\\s|$).*",
        "scope": "segment",
        "priority": 100,
        "reason": "可信的个人检查工具"
      }
    ]
  }
}
```

文件不存在时插件首次运行自动生成默认配置。`review` 端点独立配置——插件不读取 OpenCode 自身的模型/认证配置。

### 选项

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `version` | `2` | 用于生成策略迁移的配置格式标记；只接受版本 1 和 2。 |
| `allow_local_config` | `false` | 允许项目本地配置完整替代全局策略。只从可信全局文件读取。 |
| `self_protection.enabled` | `true` | 拒绝 Shell 和 OpenCode 文件工具编辑当前审批配置。动态 Shell 输出路径因无法证明目标安全而失败封闭；可在可信策略中设为 `false` 关闭。 |
| `review.base_url` | — | OpenAI 兼容端点 URL。**必填。** |
| `review.api_key` | — | API 密钥。**必填。** |
| `review.model` | — | 模型名。**必填。** |
| `review.timeout_ms` | `45000` | LLM 审查超时（5000–300000）。 |
| `review.max_script_bytes` | `20000` | 发送给审查器的脚本最大字节数。 |
| `review.max_tool_calls` | `3` | 每次审查的只读工具调用上限（0–10，0 禁用工具）。 |
| `review.max_retries` | `3` | 每次请求的 LLM API 传输重试上限（0–10 整数）。正值还允许在结构化输出畸形后重新发起一次请求；0 同时禁用两类重试。 |
| `review.context_messages` | `20` | 注入为对话上下文的近期会话消息数（0–100，0 禁用）。 |
| `review.prompt` | 内置 | 覆盖审查策略文本。详见 [LLM 审查](#llm-审查)。 |
| `tirith.enabled` | `true` | 启用 Tirith 扫描。 |
| `tirith.path` | 自动 | 本地二进制路径。跳过自动下载。 |
| `tirith.timeout_ms` | `5000` | 每条命令的扫描超时。 |
| `tirith.fail_open` | `false` | `true` = 扫描失败时放行。 |
| `rules.deny` | `[]` | 用户拒绝规则，在内置规则、Tirith 和 LLM 前终止。 |
| `rules.block` | `[]` | `rules.deny` 的旧版兼容别名。 |
| `rules.review` | `[]` | 需要扫描器和最终 LLM 判断的用户规则。 |
| `rules.allow` | `[]` | 用户放行规则；完整匹配会跳过内置规则、Tirith 和 LLM。 |

## 规则

规则可以是正则字符串，也可以是带 `match`、可选 `reason`、`scope` 和 `priority` 的对象。旧字符串和旧对象继续按 `scope: "command"`、`priority: 0` 兼容；新的管道友好规则应使用 `scope: "segment"`。

加载无版本或 version 1 配置时，插件只忽略 v2 之前自动写入的六条精确紧凑字符串 **allow** 模式，避免过时的宽泛包脚本、构建和测试授权在升级后继续生效。自定义对象和修改过的模式都会保留。如果确实需要其中某条旧 allow，请设置 `version: 2`，并将其改写为带明确 `scope: "segment"` 和有意设置的 `priority` 的规则。

未知的未来配置版本会直接拒绝加载，不会按旧版本语义猜测解释。

```jsonc
"deny": [
  // 旧简洁写法：整条命令、优先级 0
  "^(?:printenv|set)(?:\\s|$).*",

  // 显式写法
  { "match": "^dangerous-tool(?:\\s|$).*", "scope": "segment", "priority": 100 }
],
"review": [
  { "match": "^deploy(?:\\s|$).*", "scope": "segment", "priority": 50 }
],
"allow": [
  { "match": "^my-reader(?:\\s|$).*", "scope": "segment", "priority": 100 }
]
```

**各类型适用场景：**

- **deny** — 绝不允许执行的命令。立即拒绝，不产生扫描器或 LLM 成本；`block` 保留为兼容别名。
- **review** — 需要上下文判断的命令，会继续经过 Tirith 和 LLM。
- **allow** — 按模式显式信任的命令；完整匹配会跳过所有后续阶段。

`scope: "segment"` 匹配解析后的精确可执行段，因此 `my-reader | grep value` 只有在两段都放行时才能整体放行。整命令作用域的 allow 仅在命令只有一个静态可执行节点时生效；整命令 block/review 仍可升级复合命令。

分段规则匹配前会规范化静态可执行文件的引号、转义及拼接写法。引号内容保持为字面数据；管道和列表会拆成可执行段；静态嵌套 Shell 会递归分析。重定向、命令替换、后台执行、不支持的控制结构、畸形输入和资源上限超限都会阻止内置 allow 短路。解析器、运行时或资产初始化失败会直接失败封闭阻断。

用户规则对完整静态命令保持最高优先级。对于管道和列表，只有每个可执行兄弟段都被用户显式允许时才会跳过后续阶段。

## LLM 审查

审查器接收：命令、工作目录、工具参数、匹配规则、Tirith 发现、脚本证据、近期对话上下文。返回结构化裁决（`outcome`、`risk_level`、`user_authorization`、`categories`、`reasons`）。

启用重试时，畸形或不符合 schema 的结构化输出会触发一次全新格式修正请求；第二次仍无效，或禁用重试时首次就无效，都会失败封闭。

### 只读工具

审查器有两个工具用于在决策前验证本地状态：

- **`read_file`** — 读取文件内容。规范化目标必须在 cwd 或系统临时目录内，且不能是敏感路径。
- **`list_files`** — 列出目录内容。同样的路径限制。

路径会沿现有父目录和符号链接规范化，再检查是否位于规范化后的 cwd、`tmpdir()`、`/tmp` 或 `/private/tmp` 内。越界路径、敏感凭证/配置路径会向 LLM 返回错误；脚本证据使用同一边界。工具调用次数受 `max_tool_calls` 限制。

### 对话上下文

插件通过 OpenCode SDK client（`session.messages`）获取当前会话的近期消息，提取文本和工具调用摘要，注入为对话上下文。这为审查器提供了用户意图和授权信息——对齐 [Codex](https://github.com/openai/codex) guardian 模型。设 `review.context_messages` 为 0 可禁用。

### 自定义 prompt

默认审查策略涵盖证据处理、用户授权评分、风险分级、调查指南、裁决策略。通过 `review.prompt` 可覆盖——提供完整策略文本，插件替换内置策略。JSON 数据（命令、规则、对话上下文等）始终附加在自定义策略之后。

### 拒绝反馈

审查器拒绝时，`reasons` 通过 `CommandApprovalError` 传回 OpenCode——AI agent 看到拒绝原因，可以选择更安全的替代方案或向用户请求明确授权。

## 内置规则

内置规则刻意保持精简且与平台无关：

- **Allow：** 基本 Shell 胶水命令（`echo`、`printf`、`true`、`false`、`test`）、基本位置/目录查看（`ls`、`pwd`、`basename`、`dirname`）和 `command -v`。
- **Deny：** 当前为空。风险分类交给 Tirith，不在正则目录中重复实现。

内置 allow 不覆盖输出重定向，复合命令仍要求每个可执行段都匹配。`git push`、包发布、项目构建、解释器、文件写入及平台专属开发工具默认保持未匹配，并进入 Tirith 和 LLM；用户可为可信命令添加显式规则。

## Tirith

[Tirith](https://github.com/sheeki03/tirith) 是用 Rust 编写的终端安全扫描器，负责捕获精简内置规则不应重复覆盖的风险：西里尔字母同形字 URL、ANSI 转义注入、base64 解码执行链、通过 `curl` 上传的凭证外泄、管道脚本中的混淆载荷和不可见 Unicode 隐写。

### 自动下载

未设置 `tirith.path` 时，插件首次使用自动下载适合当前平台的最新发布版本，校验上游 SHA-256，并连同发布版本、压缩包摘要、二进制摘要和新鲜度元数据缓存到用户缓存目录。复用缓存时先校验本地二进制，并在 24 小时后刷新上游发布与 checksum；发现新版本或摘要变化时原子安装。HTTP 响应体、重定向次数、总耗时、压缩包大小、条目边界、解压后大小和二进制大小均有上限。平台不支持或发布资产缺失时，与扫描器执行失败一样按 `tirith.fail_open` 决策。

| 平台 | 支持 |
|------|------|
| macOS arm64 / x64 | ✅ |
| Linux glibc arm64 / x64 | ✅ |
| Linux musl arm64 | ✅ |
| Windows x64 | ✅ |

## 隐私

- 审查器可见：命令、工作目录、工具参数、匹配规则、Tirith 发现、引用的脚本内容、近期会话对话上下文。
- 只读工具和脚本证据会先规范化，再限制在 cwd 与系统临时目录内；敏感路径和符号链接逃逸会被拒绝。
- 插件不创建 OpenCode 会话，不调用 `opencode run`。

## 开发

```sh
cd opencode-smart-approval
bun install
bun run typecheck
bun test
```

## 参考项目

- [OpenCode](https://github.com/sst/opencode) — 本插件扩展的开源编码 Agent。提供 `tool.execute.before` 钩子和 `permission` 模型，使命令拦截无需修改核心代码即可实现。
- [OpenGuardrails Instrumentation for OpenCode](https://github.com/openguardrails/openguardrails-instrumentation-opencode) — 采用 OGR 协议的同类 guardrails 插件。同样使用 `tool.execute.before` 插桩模式，支持文本/正则规则和可选 LLM judge；本项目采用了不同路线，集成了 Tirith 并构建了分阶段的解析与策略管线。
- [OpenAI Codex CLI](https://github.com/openai/codex) — OpenAI 的终端编码 Agent。其沙箱自动审批模型启发了本插件的失败封闭默认值、只读工具设计，以及基于对话上下文的证据驱动审批。
- [Dyad](https://github.com/dyad-sh/dyad) — 本地开源 AI 应用构建器。其权限钩子和策略配置模式影响了本插件的 JSONC 配置设计以及确定性规则与上下文审查的分离。
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) — Nous Research 的自我改进 AI Agent。其内置 Tirith 集成（自动安装、checksum 校验、断路器 fail-open 逻辑）直接启发了本插件的 Tirith 自动下载和失败封闭行为。
- [Tirith](https://github.com/sheeki03/tirith) — 在用户规则和内置规则未决后运行的终端安全扫描器，在命令执行前拦截同形字 URL、管道注入、ANSI 注入、混淆载荷、凭证外泄和恶意 AI 技能文件。

## 许可

MIT
