# opencode-smart-approval

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[OpenCode](https://github.com/sst/opencode) 的 Shell 命令自动审批插件。通过正则规则、[Tirith](https://github.com/sheeki03/tirith) 安全扫描、LLM Agent 审查三层防护，对 Shell 命令执行进行自动审批。

## 工作原理

每条 shell 命令（`bash`、`shell`、`exec_command` 等）经过四级管线：

```
命令 → ① Tirith 扫描 → ② 用户规则 → ③ 内置规则 → ④ LLM 审查 → 裁决
```

| 阶段 | 优先级 | 行为 |
|------|--------|------|
| **Tirith** | 第一 | 内容级威胁扫描（同形字 URL、管道注入、混淆载荷、凭证外泄、ANSI 注入）。可阻断或升级至 LLM 审查。 |
| **用户规则** | 第二 | 来自 `command-approval.jsonc` 的 `block` / `review` / `allow` 正则规则。对匹配命令覆盖内置规则。 |
| **内置规则** | 第三 | 随插件内置。无用户规则匹配时生效。 |
| **LLM 审查** | 第四 | 通过 Vercel AI SDK 调用 OpenAI 兼容端点。前三级未决时触发。具备只读文件工具和对话上下文。失败封闭。 |

规则匹配优先级：**block > review > allow**。`block` 规则命中后立即停止匹配。`review` 规则强制 LLM 审查，即使后续 `allow` 规则也会匹配。Tirith `warn` 强制 LLM 审查，即使 `allow` 规则已匹配。

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

配置分两层加载：

1. **全局** — `~/.config/opencode/command-approval.jsonc`（或 `$XDG_CONFIG_HOME/opencode/`）。首次运行时如不存在则自动生成默认配置。
2. **本地** — 项目目录下的 `./command-approval.jsonc`。如果存在，**完全替代**全局配置（不合并）。

创建全局配置（支持 JSONC 注释）：

```jsonc
{
  "review": {
    "base_url": "https://api.openai.com/v1",
    "api_key": "sk-...",
    "model": "gpt-4o-mini",
    "timeout_ms": 45000,
    "max_script_bytes": 20000,
    "max_tool_calls": 3,
    "context_messages": 20
    // "prompt": "..."  // 覆盖默认审查策略
  },
  "tirith": {
    "enabled": true,
    "timeout_ms": 5000,
    "fail_open": false
  },
  "rules": {
    "block": [
      { "match": "git\\b.*--no-verify\\b", "reason": "绕过 git hook" }
    ],
    "review": [
      "git\\s+push\\b(?!.*(?:--force|-f\\s|:)).*"
    ],
    "allow": [
      "^(?:pwd|ls|rg)(?:\\s|$).*"
    ]
  }
}
```

文件不存在时插件首次运行自动生成默认配置。`review` 端点独立配置——插件不读取 OpenCode 自身的模型/认证配置。项目目录下的 `./command-approval.jsonc` 如果存在，完全替代全局配置。

### 选项

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `review.base_url` | — | OpenAI 兼容端点 URL。**必填。** |
| `review.api_key` | — | API 密钥。**必填。** |
| `review.model` | — | 模型名。**必填。** |
| `review.timeout_ms` | `45000` | LLM 审查超时（5000–300000）。 |
| `review.max_script_bytes` | `20000` | 发送给审查器的脚本最大字节数。 |
| `review.max_tool_calls` | `3` | 每次审查的只读工具调用上限（0–10，0 禁用工具）。 |
| `review.context_messages` | `20` | 注入为对话上下文的近期会话消息数（0–100，0 禁用）。 |
| `review.prompt` | 内置 | 覆盖审查策略文本。详见 [LLM 审查](#llm-审查)。 |
| `tirith.enabled` | `true` | 启用 Tirith 扫描。 |
| `tirith.path` | 自动 | 本地二进制路径。跳过自动下载。 |
| `tirith.timeout_ms` | `5000` | 每条命令的扫描超时。 |
| `tirith.fail_open` | `false` | `true` = 扫描失败时放行。 |
| `rules.block` | 内置 | 匹配后立即阻断。 |
| `rules.review` | 内置 | 匹配后强制 LLM 审查。 |
| `rules.allow` | 内置 | 匹配后跳过 LLM 审查。 |

## 规则

规则为正则字符串（简洁写法）或 `{ "match": "...", "reason": "..." }` 对象。`reason` 字段在 `block` 规则触发时作为工具错误消息传回 OpenCode——AI agent 看到拒绝原因后可以选择更安全的替代方案。

```jsonc
"block": [
  // 简洁写法 — 纯正则字符串
  "^(?:printenv|set)(?:\\s|$).*",

  // 带 reason 写法 — 拒绝时向 AI agent 显示原因
  { "match": "git\\b.*--no-verify\\b", "reason": "绕过 git hook 和安全检查" }
],
"review": [
  // 匹配后强制 LLM 审查，即使 allow 规则也匹配
  "(?:^|[;&|]\\s*)(?:npm|pnpm|yarn)\\s+publish\\b.*"
],
"allow": [
  "^(?:pwd|ls|rg)(?:\\s|$).*"
]
```

**各类型适用场景：**

- **block** — 绝不允许执行的命令。立即拒绝，无 LLM 成本。
- **review** — 需要上下文判断的命令（如 `git push`、`npm publish`）。强制 LLM 审查，附带完整对话上下文和只读工具。
- **allow** — 按模式安全的命令。跳过 LLM 审查（除非 Tirith 警告）。

## LLM 审查

审查器接收：命令、工作目录、工具参数、匹配规则、Tirith 发现、脚本证据、近期对话上下文。返回结构化裁决（`outcome`、`risk_level`、`user_authorization`、`categories`、`reasons`）。

### 只读工具

审查器有两个工具用于在决策前验证本地状态：

- **`read_file`** — 读取文件内容。路径必须在 cwd 或系统 tmp 下。
- **`list_files`** — 列出目录内容。同样的路径限制。

路径经 `resolve()` 解析后检查是否以 `resolve(cwd)` 或 `resolve(tmpdir())` 开头。超出范围的路径返回错误信息给 LLM。工具调用次数受 `max_tool_calls` 限制。

### 对话上下文

插件通过 OpenCode SDK client（`session.messages`）获取当前会话的近期消息，提取文本和工具调用摘要，注入为对话上下文。这为审查器提供了用户意图和授权信息——对齐 [Codex](https://github.com/openai/codex) guardian 模型。设 `review.context_messages` 为 0 可禁用。

### 自定义 prompt

默认审查策略涵盖证据处理、用户授权评分、风险分级、调查指南、裁决策略。通过 `review.prompt` 可覆盖——提供完整策略文本，插件替换内置策略。JSON 数据（命令、规则、对话上下文等）始终附加在自定义策略之后。

### 拒绝反馈

审查器拒绝时，`reasons` 通过 `CommandApprovalError` 传回 OpenCode——AI agent 看到拒绝原因，可以选择更安全的替代方案或向用户请求明确授权。

## 内置规则

**阻断** — 凭证文件、环境密钥、钥匙串读取、`sudo`、提权、环境变量导出、破坏性 `rm -rf`、磁盘/设备操作、git hook 绕过、强推、嵌套代理调用。

**审查** — `git push`（非强推）、`npm/pnpm/yarn publish`、`docker/podman push`。

**放行** — 只读命令（`ls`、`pwd`、`rg`、`cat` 等）、版本/帮助参数、只读 git 操作、测试/构建/校验、安全 macOS 工具、基础文件操作（`mkdir`、`touch`、`cp`）。

内置规则在无用户规则匹配时生效。用户规则对匹配命令优先。

## Tirith

[Tirith](https://github.com/sheeki03/tirith) 是用 Rust 编写的终端安全扫描器。它捕捉正则无法覆盖的威胁：西里尔字母同形字 URL、ANSI 转义注入、base64 解码执行链、通过 `curl` 上传的凭证外泄、管道脚本中的混淆载荷、不可见 Unicode 隐写。对干净输入的开销在亚毫秒级。

### 自动下载

未设置 `tirith.path` 时，插件首次使用自动下载适合当前平台的最新发布版本，校验 SHA-256 并缓存：

| 平台 | 支持 |
|------|------|
| macOS arm64 / x64 | ✅ |
| Linux glibc arm64 / x64 | ✅ |
| Linux musl arm64 | ✅ |
| Windows x64 | ✅ |

## 隐私

- 审查器可见：命令、工作目录、工具参数、匹配规则、Tirith 发现、引用的脚本内容、近期会话对话上下文。
- 只读工具范围限于 cwd 和系统 tmp——无法访问其他路径。
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
- [OpenGuardrails Instrumentation for OpenCode](https://github.com/openguardrails/openguardrails-instrumentation-opencode) — 采用 OGR 协议的同类 guardrails 插件。同样使用 `tool.execute.before` 插桩模式，支持文本/正则规则和可选 LLM judge；本项目采用了不同路线，集成了 Tirith 并构建了专用四级管线。
- [OpenAI Codex CLI](https://github.com/openai/codex) — OpenAI 的终端编码 Agent。其沙箱自动审批模型启发了本插件的失败封闭默认值、只读工具设计，以及基于对话上下文的证据驱动审批。
- [Dyad](https://github.com/dyad-sh/dyad) — 本地开源 AI 应用构建器。其权限钩子和策略配置模式影响了本插件的 JSONC 配置设计以及确定性规则与上下文审查的分离。
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) — Nous Research 的自我改进 AI Agent。其内置 Tirith 集成（自动安装、checksum 校验、断路器 fail-open 逻辑）直接启发了本插件的 Tirith 自动下载和失败封闭行为。
- [Tirith](https://github.com/sheeki03/tirith) — 本管线第一级使用的终端安全扫描器。在命令执行前拦截同形字 URL、管道注入、ANSI 注入、混淆载荷、凭证外泄和恶意 AI 技能文件。

## 许可

MIT