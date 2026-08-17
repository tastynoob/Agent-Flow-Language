# Agent 工具安全

AFL v0 的 Agent 工具执行边界由 AFL 与 TypeScript bindings 共同描述。Agent allocation 的 `tools` option 选择 VM 标准工具；bindings 配置实际 executor、安全策略和 sandbox。当前实现包含标准工具 profile、pre-tool policy、串行人工请求队列、Pi 内建提权工具、Pi 内建事务申请工具、可选的 bubblewrap execution environment，以及 cc-safety-net policy adapter。

`tools` 不是 sandbox，也不替代 pre-tool policy：它决定模型在本次 Agent activation 中能看到哪些标准工具。`readonly` 不暴露写入和 Shell 工具，`none` 不暴露文件或命令工具。只有 executor 对 Workspace 和只读挂载的实际强制执行才能提供安全边界。

标准工具 descriptor 不固定模型侧 tool schema，但要求 `authorization: "required"`。支持这些工具的 executor 必须声明 `toolAuthorization`，并在任何外部作用发生前调用 `AgentExecutionHost.authorizeTool`；否则 VM 拒绝运行显式选择了标准工具的 Agent。配置了 pre-tool policy 时，VM 同样拒绝不能提供该授权边界的 executor，避免安全配置静默失效。

Policy action 同时保存稳定的 AFL `capability` 和 executor 原生 `toolName`。例如 Pi 的 Shell action 是 `capability: "shell"`、`toolName: "bash"`。跨 executor 的通用 policy 应优先匹配 capability，并读取 executor 规范化后的 `effectiveInput`；需要后端特有规则时仍可匹配原生 toolName。模型看到的参数可以不同，但 executor 必须先把它转换成足够进行安全判断的 effective action。

Format Output、Freedom 和事务申请是 activation-scoped VM 控制工具，不是 executor 提供的文件或命令能力，因此不进入普通 pre-tool policy。它们只能调用各自的 `AgentExecutionHost` 入口：Format Output 只提交候选值，事务申请进入人工请求队列，Freedom 只执行当前 activation 允许的控制操作。Freedom 启动的子 Agent 工具仍逐次经过 `authorizeTool`；生成 IR 中的 script、capability 和外部 Flow 仍经过各自的 VM policy，不能借控制工具绕过原有安全边界。

这些能力只覆盖 `AgentExecutorBackend` 内的工具调用。AFL `script`、`capability`、外部 Flow adapter 和其他宿主扩展仍使用各自的 binding/`VmPolicy` 边界。

## Pre-tool policy

`AgentToolPolicyEngine` 在工具副作用发生前组合多个 policy。每个 policy 返回 `allow`、`block`、`deny` 或 `abstain`：

- `block` 拦截当前调用并把可提权的结构化错误返回模型，不触发人工审批；
- `deny` 是不能提权覆盖的硬拒绝；
- 没有 `block` 或 `deny` 时执行工具；
- `requireCoverage: true` 会拒绝没有任何 policy 负责的工具；
- policy 抛错或返回非法结果时 fail closed。

Pre-tool policy 不直接打开人工请求队列。模型收到 `block` 后应先尝试更安全的替代方案；只有模型主动调用提权工具时才会请求用户审批。

Pi 会在 schema 校验和 `prepareArguments` 完成后授权。`createPiCodingAgentBinding` 还会把 `read`、`edit`、`write` 的 path 规范化为实际 addressed path，并为 `bash` 补充实际 `cwd`、environment、继承模式和默认超时，随后才生成 immutable policy action。默认 `bashTimeoutSeconds` 为 300；binding 或 `pi()` profile 可以覆盖它，模型也可以为单次调用声明更短的 `timeout`，但不能通过省略字段获得无期限执行。

## 人工请求队列

`FifoAgentApprovalQueue` 对所有 Agent 共用一个 presenter，严格按 FIFO 一次呈现一个请求。请求的 `kind` 为：

- `tool-elevation`：Agent 主动请求执行一次已经被 policy `block` 或 sandbox execution error 拦住的 action；
- `transaction`：Agent 请求用户完成外部事务。

`AgentApprovalQueue` 是当前 API 名称；这里统一称为“人工请求队列”，因为 `transaction` 表示完成确认，不是权限审批。Pi 的 `interactiveApproval` capability 也只表示支持这些由模型主动发起的交互，不表示 pre-tool policy 会弹出审批。

队列支持容量限制、AbortSignal 取消和 shutdown。等待人工响应时 VM 会释放 external concurrency lease，但继续持有当前 Agent、Memory 和 Workspace lease；因此无关 Workspace 可以继续推进，冲突工作仍然等待。

Presenter 由宿主 UI 提供：

```js
import {
  FifoAgentApprovalQueue,
  createCCSafetyNetPolicy,
  createStdioAgentApprovalPresenter,
} from "@afl-lang/core";

const presenter = createStdioAgentApprovalPresenter();
const humanRequests = new FifoAgentApprovalQueue({
  maxPending: 64,
  presenter,
});

export const agentSecurity = {
  preTool: {
    policies: [createCCSafetyNetPolicy()],
  },
  approvalQueue: humanRequests,
};
```

进程退出时应调用 `humanRequests.close()` 和 `presenter.close()`。GUI/TUI host 可以实现自己的 `AgentApprovalPresenter`；它必须把 `request.queueId`、`sequence`、`kind`、`subject` 和 AbortSignal 绑定到同一个 UI 请求，并返回 `approved` 或 `denied`。

## 提权执行

启用 bubblewrap 的 `createPiCodingAgentBinding` 会额外提供 `afl_elevated_tool`，canonical 名为 `afl.elevation.execute`。它与 pre-tool 拦截、外部事务的职责不同：

- pre-tool `block` 拦截工具并让模型先选择替代方案，不触发审批；
- `tool-elevation` 由模型主动发起。被 policy `block` 的 action 经批准后仍在原 bubblewrap 中执行；只有实际产生 sandbox execution error 的 action 才改由 host executor 重试；
- `transaction` 表示环境中存在 Agent 无法自行完成的条件，需要用户主动操作。它不执行命令，也不改变权限。

模型调用 `afl_elevated_tool` 时提交 `tool`、该工具原始 `arguments` 和 `reason`。Pi 只接受当前 `agent.do` 内同名、同参数且已经产生 policy `block` 或 sandbox execution error 的 action；hard deny 不构成提权凭据。目标 action 按最终 execution boundary 重新规范化并再次经过完整 pre-tool policy。`block` 在提权路径中成为审批原因，`deny` 仍立即终止；即使所有 policy 都返回 `allow`，提权也必须进入 `tool-elevation` 队列。

批准绑定到本次 action digest，不产生可复用权限或“本 session 已提权”状态。默认 coding binding 可以提权重试 `read`、`bash`、`edit` 和 `write`。Host retry 的 cwd 为 Agent 的实际 primary Workspace，且不再受 bubblewrap mount/network 边界保护；被 policy `block` 的重试则继续受原 sandbox 约束。Presenter 必须展示并审批完整的脱敏后 effective action。

## 通用事务申请

Pi session 始终提供 `afl_transaction_request`，canonical 名为 `afl.transaction.request`。Agent 可以提交：

- `title`：简短标题；
- `request`：需要用户完成的具体动作；
- `reason`：当前为何无法继续；
- `resume_when`：恢复后由 Agent 验证的可观察条件，可省略。

该工具只负责排队、暂停和返回结果，不安装软件、不授予权限，也不修改 sandbox。用户标记完成后，工具明确要求 Agent 自行验证 `resume_when`。用户拒绝或队列不可用时，模型收到结构化 `denied`/`unavailable` 结果并决定如何收敛任务。事务和提权共用同一 FIFO presenter，因此并发 Agent 不会产生互相覆盖的终端询问。

## Bubblewrap

`createPiCodingAgentBinding` 可以显式启用 Linux bubblewrap：

```js
import {
  PiAgentExecutorBackend,
  createPiCodingAgentBinding,
} from "@afl-lang/core";

const binding = createPiCodingAgentBinding({
  model: { provider: "deepseek", id: "deepseek-chat" },
  bashTimeoutSeconds: 300,
  sandbox: {
    backend: "bubblewrap",
    network: "none",
  },
});

export default {
  agentExecutor: new PiAgentExecutorBackend({ defaultBinding: binding }),
  agentSecurity,
};
```

Sandbox 内的稳定视图为：

- primary Workspace 读写挂载到 `/workspace`；
- read-only Workspace 依次挂载到 `/readonly/0`、`/readonly/1`；
- HOME 为独立的 `/home/afl`，`/tmp` 为 tmpfs；
- `/workspace/.afl` 被 tmpfs 遮蔽，不暴露 canonical Memory；
- `read`、`bash`、`edit` 和 `write` 共用同一个长生命周期 `ExecutionEnv` worker；
- `bash` 未显式给出更短超时时，使用 binding 的默认命令超时；
- network 默认为 `none`，只有显式 `network: "host"` 才共享宿主网络 namespace。

显式启用后，缺少 Linux、bubblewrap、user namespace 或 mount 能力会产生 `AGENT_SANDBOX_*` 错误，不会回退到 `NodeExecutionEnv`。当 backend 的所有已配置 binding 都声明并实际创建 sandbox context 时，`sandboxEnforcement` 才为 `true`。

当前 bubblewrap profile 不提供 seccomp syscall allowlist、cgroup/rlimit 资源配额、磁盘配额或域名级网络控制。`network: "host"` 表示完整宿主网络可达性，不是受限网络。

## cc-safety-net

`createCCSafetyNetPolicy()` 处理 AFL `shell` capability，并兼容默认原生名为 `bash` 的 Shell action，其他工具返回 `abstain`。它复用固定依赖 `cc-safety-net@1.0.6` 的公开插件入口，安全命令返回 `allow`，破坏性 Git/文件命令、nested shell 和 interpreter 语义返回 `block`，让模型先寻找替代方案。格式错误的 Shell effective input 和 analyzer failure 仍按 hard `deny` 处理。

当前 adapter 在宿主进程中分析 `effectiveInput.command`，并以 Agent primary Workspace 的宿主路径初始化上游插件。它不观察 bubblewrap 内的 mount namespace 或 `/workspace` 路径映射，因此不能替代 sandbox 的文件系统边界。

Strict、paranoid 和 worktree mode 使用 cc-safety-net 的 `CC_SAFETY_NET_*` 环境变量，并应在创建 policy 前由宿主固定。未知 capability 的自定义工具仍可用 `toolNames` 指定具有同一 canonical `command` security view 的原生名称。当前适配不会自动打开审批，也不会写 AFL 自己的第二份命令审计日志。

cc-safety-net 保护工作区内部仍然危险但 sandbox 允许的操作；bubblewrap 负责阻止跨 Workspace 访问。两者不能互相替代。

## 可观测性

`agent.started` trace 会记录当前是否启用 pre-tool policy、人工请求队列、executor tool authorization 和 backend-wide sandbox enforcement。工具 trace 使用 `tool.requested`、`tool.policy`、`elevation.state`/`transaction.state`、`tool.started` 和 `tool.completed`，不会把“已请求”误记为“已开始产生副作用”。审批 display 和 policy reason 经过统一脱敏；完整工具消息是否进入 Memory 仍由 executor continuation 契约决定。
