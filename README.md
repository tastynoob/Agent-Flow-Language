# Agent Flow Language

AFL 是一种面向 Agent 工作流的描述语言，当前实现提供文本 IR、parser、semantic validator、dependency scheduler 和 TypeScript VM。

文本 AFL 通过显式 VM bindings 连接 Agent、Prompt、Input、Script、Capability、外部 Flow、Formatter、Schema 和 Trace 实现。Freedom 是 VM 向 Agent executor 临时注入的工作流控制能力，不使用单独的 Freedom binding。当前格式为 v0，API 与文本格式可能继续调整。

AFL提供一种最小IR实现，并不提供高级描述，可以使用python、typescript等语言作为AFL IR generator前端，以提供更加便捷的表达方式

## 架构

```text
AFL IR source -> parser -> validator -> dependency scheduler -> AFL VM -> bindings
```

## 一个代表性工作流

下面的 flow 让 Coder 完成任务，再把 Coder 的完整 Memory 复制给 Reviewer。Reviewer 返回 `finish` 时结束；否则缺陷列表会交回 Coder，随后再次审核：

```text
main(task):
    entry:
        coder = agent @agent.coder
        coder.sysprompt "Implement the requested change and return the current complete result."
        code = coder.do task
        jump review

    review:
        review_memory = memory.copy coder.memory
        reviewer = agent @agent.reviewer,, review_memory
        reviewer.sysprompt "Begin with VERDICT: FINISH when correct or VERDICT: REVISE when defects remain."
        review_result = reviewer.do "Review the latest implementation."
        finish = typescript "const lines = String(args[0]).replaceAll('*', '').replaceAll('_', '').toLowerCase().split(String.fromCharCode(10)).map(line => line.trim()); return lines.some(line => ['finish', 'approved', 'pass'].some(verdict => line === verdict || line.startsWith('verdict: ' + verdict) || line.startsWith('status: ' + verdict)))", review_result
        jump finish, done, revise

    revise:
        fix_prompt = prompt "Fix every listed defect", review_result
        code = coder.do fix_prompt
        jump review

    done:
        ret code
```

```text
task -> Coder -> copy Memory -> Reviewer -> finish -> result
          ^                         |
          +------ defect list ------+
```

这里的 Agent 调用、Memory 复制、结果依赖、条件跳转和循环都是 VM 执行的 flow 语义，不是宿主代码中的隐藏编排。Reviewer prompt 提供明确的 verdict 协议，Script binding 再对大小写、Markdown 包裹和常见的 `Status: APPROVED` 变体做宽松解析，避免直接依赖模型输出的字面相等。相同 primitive 还能通过 `dispatch/sync` 表达并行 Worker，通过 `fork` 创建继承上下文的 Agent 分支，并在预定义路径不足时使用受验证的 `freedom` fallback。完整文件见 [`examples/coder-reviewer.afl`](examples/coder-reviewer.afl)，并行案例见 [`docs/guides/parallel-voting.md`](docs/guides/parallel-voting.md)。

## AFL VM

安装 npm 包后，VM 的最短调用只需要 bindings module 与 AFL IR：

```bash
afl-vm ./bindings.mjs ./flow.afl
```

VM 默认调用 `main()`。参数化入口可以显式传入参数，其他选项按需增加：

```bash
afl-vm ./bindings.mjs ./flow.afl --entry main --args '["task"]'
afl-vm ./bindings.mjs ./flow.afl --trace trace.json
```

Bindings module 默认导出 `VmBindings`，也可以使用名为 `bindings` 的导出。它既可以是文件路径，也可以是已安装的 package specifier。VM 按指令实际使用情况检查 binding；纯计算 flow 可以传入只包含 `export default {}` 的空 bindings module。

仓库内开发时可以直接运行：

```bash
npm install
npm run build
./bin/afl-vm.mjs test/fixtures/noop-bindings.mjs test/fixtures/minimal.afl
```

当前版本要求 Node.js 22.19.0 或更高版本。

### Pi Agent Executor

`VmBindings.agentExecutor` 可以接入带原生 agent loop 和 session 的执行器。Pi backend 直接使用 `@earendil-works/pi-agent-core` 的 `AgentHarness`，模型和认证由 `@earendil-works/pi-ai` 管理：

```js
import {
  PiAgentExecutorBackend,
  createPiCodingAgentBinding,
} from "@afl-lang/core";

const binding = createPiCodingAgentBinding({
  model: { provider: process.env.AFL_PI_PROVIDER, id: process.env.AFL_PI_MODEL },
});

export default {
  agentExecutor: new PiAgentExecutorBackend({ defaultBinding: binding }),
};
```

完整 bindings 文件见 [`examples/pi-bindings.mjs`](examples/pi-bindings.mjs)。`defaultBinding` 可供所有 Agent symbol 使用；需要为 Coder、Reviewer 等选择不同模型或工具时，改用 `agents` map，以 `@agent.*` symbol 为 key。

`createPiCodingAgentBinding` 显式启用 Pi core 的 `read`、`bash`、`edit` 和 `write` 工具，并为每个 Agent activation 按 AFL Workspace 创建执行上下文。默认使用宿主 `NodeExecutionEnv`；设置 `sandbox: { backend: "bubblewrap" }` 后，四个 coding tools 会共用强制 Workspace mount 边界，primary 映射为 `/workspace`，read-only Workspace 映射为 `/readonly/<index>`，AFL Memory 不暴露给工具进程。默认不加载 pi-coding-agent 的 CLI、extensions 或交互 UI。

Agent 工具可以通过与 executor 无关的 pre-tool policy 做 `allow/block/deny/abstain` 决策；`block` 只把错误返回模型，不触发人工请求。`FifoAgentApprovalQueue` 会把模型主动发起的一次性提权和通用事务申请串行呈现。Pi sandbox binding 内建 `afl_elevated_tool`，只允许把当前 `do` 中被 `block` 或在 sandbox 内实际执行失败的同名同参数 action，经强制审批后重试一次：前者仍在 sandbox 内执行，后者才使用 host executor。`afl_transaction_request` 用于暂停并等待用户完成外部动作，不授予权限。`createCCSafetyNetPolicy()` 可对 Bash 做破坏性命令语义审查。完整配置、边界与当前限制见 [`docs/guides/agent-security.md`](docs/guides/agent-security.md)。这些组件默认关闭或不提供 presenter，显式启用失败时不会降级放行。

Agent 省略 Workspace 时，VM 不再让所有 Agent 共享执行根目录，而是按稳定 allocation identity 分配 `.afl/tmpworkspace/<run-id>/<allocation>/`。`freedom.route` 和 `freedom.flow` 执行 child Node/IR 时禁止 child Agent 与 planner/writer 产生 Workspace 写/读冲突；双方共享同一个只读目录仍然允许。静态可见的冲突由 validator 警告，实际执行前由 VM 强制拒绝。

AFL canonical Memory 默认保存在执行根目录的 `.afl/memory/afl-<date>-<id>/`。`program.jsons` 记录 run header；每个真正进入过 `agent.do` 的 Memory 使用一份两空格缩进、对象间空行分隔的 `.jsons` pretty JSON stream。同一 `runId` 再次执行时会恢复对应 slot。Pi backend 在一次 `do` 内按完整语义消息流式追加 thinking、工具调用与工具结果；每个完整 JSON object 都可恢复，不依赖 `do.end`。`memory.copy` 使用 source file/revision 引用，不重复写入整段历史。这仍是 executor continuation，不是 VM snapshot。Pi backend 暂不支持带 schema 的 `do`。

受限工具的 coder-reviewer 示例见 [`examples/coder-reviewer-qsort-bindings.mjs`](examples/coder-reviewer-qsort-bindings.mjs)。它只允许 Agent 读写 `qsort.c`，并通过固定的 GCC 命令编译和运行自测。建议从独立工作目录运行：

```bash
mkdir -p /tmp/afl-qsort-demo
cd /tmp/afl-qsort-demo
DEEPSEEK_API_KEY=... /path/to/Agent-Flow-Language/bin/afl-vm.mjs \
  /path/to/Agent-Flow-Language/examples/coder-reviewer-qsort-bindings.mjs \
  /path/to/Agent-Flow-Language/examples/coder-reviewer.afl \
  --args-file /path/to/Agent-Flow-Language/examples/coder-reviewer-qsort.args.json \
  --run-id qsort-demo
```

`afl` 命令负责静态验证；旧 `afl run` 形式暂时保留兼容：

```bash
afl validate examples/coder-reviewer.afl
```

## 打包

`package.json` 将 `afl-vm` 声明为 npm executable，并打包 `bin/`、编译后的 `dist/src/`、规范文档与 README。生成并安装本地包后即可脱离源码目录调用：

```bash
npm pack
npm install -g ./afl-lang-core-0.1.0.tgz
afl-vm ./bindings.mjs ./flow.afl
```

## DeepSeek Smoke

DeepSeek bindings 只从环境变量读取密钥。Smoke flow 本身是无参 `main()`，因此命令也只保留 bindings 与 IR 两项：

```bash
DEEPSEEK_API_KEY=... npm run smoke:deepseek
```

`DEEPSEEK_MODEL` 可以覆盖默认的 `deepseek-v4-flash`，`DEEPSEEK_BASE_URL` 可以覆盖默认 API 地址。密钥不会进入 AFL source、fixture 或 trace。

Pi backend 的 live smoke 会验证真实模型调用、一次工具循环和同一 Agent 的 session 续接：

```bash
DEEPSEEK_API_KEY=... npm run smoke:pi
```

## 文档

[实现文档](docs/README.md)描述当前 parser、validator、VM 与 CLI 已支持的行为。尚未进入实现契约的长期目标和设计讨论保存在仓库的 `proposals/` 目录，不随 npm package 发布。

## License

本仓库中的代码、文档和示例均采用 [Apache License 2.0](LICENSE) 许可。
