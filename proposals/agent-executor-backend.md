# Agent Executor Backend 提案

## 1. 状态与范围

本文讨论 AFL 的 Agent 执行器后端。内容尚未成为 parser、validator、VM 或 bindings API 的实现契约。

AFL 继续负责描述和调度 flow。`agent.do` 是 flow 发起 Agent 工作的执行入口；模型调用、工具循环和原生会话由可替换的 Agent Executor Backend 完成。Sandbox、工具审批等安全能力由 Backend 与 host 按 capability 共同提供，不要求每一种 Backend 具有相同实现。

本提案希望达到以下效果：

- 同一份 AFL flow 可以选择 Pi、Codex、Claude Code、普通 API adapter 或其他 Agent runtime；
- AFL 不需要复制每个 runtime 的 agent loop 和工具系统，也不假定所有 runtime 具有相同的安全能力；
- AFL Memory 保持可移植，同时允许后端利用原生 session 提高上下文连续性；
- AFL 可以观察和约束后端行为，但不绕过后端已有的安全边界；
- 后端能力不足时显式报告差异，不静默改变 `do`、Memory 或审批语义。

本提案不为 AFL IR 增加 provider、model、workspace 或 approval 指令。相关配置首先保留在 bindings 和 VM host 中。

首个实现以 [Pi](https://github.com/earendil-works/pi) 为目标。当前阶段优先让 AFL 获得完整、可用的 Agent loop、工具调用和会话能力；面向大规模部署的强制 sandbox、细粒度权限和完整审批系统在接口稳定后继续建设。能力缺失仍必须由 capability 如实表达，不能把未实现的安全边界包装成已支持。

当前实现已经把 Agent 工作统一为 `agent.do`。Parser、Core IR、validator、VM 和 adapter API 均不再保留其他 Agent 工作指令或 mode。

## 2. 分层

```text
AFL IR
  -> parser / validator / dependency scheduler
  -> AFL VM
  -> Agent Executor Backend
  -> Agent runtime
  -> Model provider
```

各层职责如下：

- AFL IR 描述 Agent 之间的数据依赖、控制流、并行、Memory 操作和 flow 组合；
- AFL VM 管理 Agent、Memory、TaskGroup 等 handle，并调度已经 ready 的指令；
- Agent Executor Backend 把一次 AFL Agent 工作映射为具体 runtime 的 session、turn、事件和审批；
- Agent runtime 管理模型与工具之间的内部循环；
- Model provider 只提供具体模型协议和推理能力。

Pi 是首个 Agent runtime 实现，但不是 AFL IR 的组成部分，也不是唯一后端。Pi 自身通过统一的模型接口连接不同 provider；后续的 Codex、Claude Code 或其他 Backend 继续复用同一套 AFL 执行契约。

## 3. `do` 的工作边界

### 3.1 完整工作周期

`agent.do` 向后端 session 提交一项工作，并等待这项工作到达终止状态。它表示一次完整的 Agent 工作激活，不表示一次模型请求、一次采样或一次 runtime turn。

一次 `do` 内部可以包含多次模型推理、命令执行、文件修改、MCP 调用、工具结果回传、审批和用户输入。只要后端仍能推进同一项工作，这些过程就属于同一次 `do`：

```text
running
  -> waiting_for_tool -> running
  -> waiting_for_approval -> running
  -> waiting_for_input -> running
  -> completed | blocked | budget_exhausted | cancelled | failed
```

工具调用本身不是 `do` 的停止点。Backend 应把工具结果交还 runtime 并继续执行。审批或用户输入也可以暂停当前工作；host 给出答复后，Backend 恢复同一次 `do`，而不是创建新的 IR 指令。

### 3.2 终止结果

Backend 的终止状态至少区分：

- `completed`：后端认为当前任务已经完成；
- `blocked`：后端无法继续，并给出原因；
- `budget_exhausted`：达到 turn、token、时间或费用上限；
- `cancelled`：AFL VM 或宿主取消工作。

`completed` 正常产生 role-free Frag。可由 host 处理的 `waiting_for_input` 和 `waiting_for_approval` 是运行中状态，不是返回给 flow 的终止结果。`blocked`、`budget_exhausted` 和 `cancelled` 由 VM 转换为可诊断的执行错误；transport 或 Backend 内部失败通过稳定的异常类型报告。

Backend 报告 `completed` 只表示 Agent 已经自行结束当前工作，不保证业务目标在外部意义上正确完成。Reviewer、条件分支和迭代 flow 仍负责检查结果并决定是否再次调用 `do`。

### 3.3 统一的工作语义

单步与连续执行的区别无法稳定映射到不同 runtime。一次看似单步的工作也可能需要工具调用、审批或多个模型 turn 才能产生结果，而这些内部步骤不适合作为 AFL flow 的边界。

本提案采用唯一的 `do` 语义，不提供旧指令兼容。需要观测单次模型请求或单个 runtime turn 时，可以通过 Backend 调试选项实现，不把该边界加入 Core IR。

## 4. Backend 接口

下面的 TypeScript 仅用于说明接口形状，名称和字段可以在实现时继续收敛：

```ts
export interface AgentExecutorCapabilities {
  readonly nativeSession: boolean;
  readonly checkpoint: boolean;
  readonly fork: boolean;
  readonly memoryExport: boolean;
  readonly memoryImportRoles: readonly string[];
  readonly structuredOutput: boolean;
  readonly interrupt: boolean;
  readonly toolCallInterception: boolean;
  readonly interactiveApproval: boolean;
  readonly sandboxEnforcement: boolean;
}

export interface BackendSessionRef {
  readonly backend: string;
  readonly id: string;
  readonly checkpoint?: string;
}

export interface AgentExecutionRequest {
  readonly runId: string;
  readonly node: string;
  readonly block: string;
  readonly agent: SymbolRef;
  readonly systemPrompt?: string;
  readonly memory: readonly Message[];
  readonly memoryRevision: number;
  readonly session?: BackendSessionRef;
  readonly sessionMemoryRevision?: number;
  readonly schema?: SymbolRef;
  readonly signal: AbortSignal;
}

export interface AgentExecutionResult {
  readonly output: string;
  readonly stopReason:
    | "completed"
    | "blocked"
    | "budget_exhausted"
    | "cancelled";
  readonly session?: BackendSessionRef;
  readonly messages?: readonly Message[];
  readonly usage?: Readonly<Record<string, number>>;
}

export interface AgentExecutorBackend {
  readonly capabilities: AgentExecutorCapabilities;

  execute(
    request: AgentExecutionRequest,
    host: AgentExecutionHost,
  ): Promise<AgentExecutionResult>;

  checkpoint?(
    session: BackendSessionRef,
    signal: AbortSignal,
  ): Promise<BackendSessionRef>;

  fork?(
    session: BackendSessionRef,
    signal: AbortSignal,
  ): Promise<BackendSessionRef>;

  exportMemory?(
    session: BackendSessionRef,
    signal: AbortSignal,
  ): Promise<readonly Message[]>;

  close?(
    session: BackendSessionRef,
    signal: AbortSignal,
  ): Promise<void>;
}
```

`AgentExecutorBackend.execute()` 自身就承诺推进一次完整的 Agent 工作激活，因此接口不再需要 `mode` 或 sequence capability。普通的无状态模型 adapter 可以根据 AFL Memory 发起一次请求，并在得到无需继续处理的模型输出后返回 `completed`；它不需要伪造多轮 session。

`BackendSessionRef` 是 VM 基础设施数据，不是 Frag，也不能由 AFL flow 读取、拼接或发送给另一个 flow。首版可以只在当前 VM run 中使用；持久化 VM run 时再为 backend 增加显式的编码与恢复契约。

普通 Chat Completions adapter 不需要伪造原生 session。它可以声明 `nativeSession: false`，每次根据 AFL Memory 构造请求。现有 `AgentAdapter.run()` 可以通过兼容包装器继续工作。

## 5. Event 与宿主交互

完整 Agent runtime 会在最终输出之前产生进度、工具和审批事件。Backend 不应把这些内容全部压缩进最终 Frag。不支持交互审批的 Backend 不会调用 `requestApproval`，并通过 capability 明确报告。

```ts
export type AgentExecutionEvent =
  | { readonly type: "message.delta"; readonly text: string }
  | { readonly type: "tool.started"; readonly id: string; readonly name: string }
  | { readonly type: "tool.completed"; readonly id: string; readonly ok: boolean }
  | { readonly type: "usage.updated"; readonly usage: Readonly<Record<string, number>> }
  | { readonly type: "warning"; readonly message: string };

export interface AgentExecutionHost {
  emit(event: AgentExecutionEvent): void | Promise<void>;
  requestApproval(request: AgentApprovalRequest): Promise<AgentApprovalDecision>;
  requestInput(request: AgentInputRequest): Promise<string>;
}
```

VM 可以先把事件转交 TraceSink；CLI 或其他 host 可以在此基础上提供流式输出、审批 UI 和用户输入。Backend 自己仍负责把宿主答复映射回原生 runtime 协议。

## 6. Memory 与原生 Session

### 6.1 三种状态

Agent 执行涉及三种相关但不同的状态：

- AFL Memory：由带 role 的字符串 Message 组成，是 flow 可复制和传递的可移植上下文；
- Backend Session：Pi session、Codex thread、Claude session 等原生 continuation state；
- Workspace State：文件、Git worktree、进程和其他外部副作用。

Backend Session 不能替代 AFL Memory。并非所有后端都能导出完整 session，模型未显式输出的内部推理也不属于 AFL Memory。Workspace State 同样不属于 Memory；复制或 fork 对话不会自动复制工作目录。

### 6.2 Revision 与同步

Memory handle 可以在实现内部增加单调递增的 revision。每次 `memory.append` 和 Agent 输出写入都推进 revision。Revision 由 VM 分配，Backend 不创建或推进 AFL Memory revision。

VM 为 Backend session 记录已经同步的 Memory revision：

1. 第一次执行时，Backend 根据 system prompt 和 AFL Memory 创建原生 session；
2. 后续执行时，VM 同时提供当前 revision 与该 session 已同步的 revision，Backend 只导入两者之间新增的 Message；
3. Backend 完成工作后，把模型可见的新增 Message 返回给 VM；
4. VM 先更新 AFL Memory，再把更新后的 revision 记录为 session 同步位置；
5. 无法导入某种 role 时，Backend 显式拒绝或要求配置转换规则，不自动改变 role。

Backend 可以保留比 AFL Memory 更丰富的原生工具事件和压缩状态，但这些状态只能通过兼容的原生 session 续接。

### 6.3 System Prompt 变化

System prompt 属于 Agent 配置，不是普通 Memory Message。后端 session 创建后再次修改 system prompt 时，基础行为建议为：

1. 使现有 session continuation 失效；
2. 使用新的 system prompt 和当前 AFL Memory 创建新 session；
3. 后端明确支持等价的动态更新时，才原地修改。

这样 Reviewer 在复制 Coder Memory 后设置自己的 system prompt 时，会创建独立 Reviewer session，不会污染 Coder session。

### 6.4 Copy、Apply 与 Fork

Memory 的语言可见内容仍是 Message 序列。实现可以附带一个不可由 flow 读取的原生 continuation checkpoint：

- `memory.copy` 复制 Message，并在 backend 支持时记录源 session 的稳定 checkpoint；
- `memory.apply` 绑定相同 executor 和兼容 Agent 配置时，可以从 checkpoint 建立新 session；
- Agent symbol、executor 或 system prompt 不兼容时，丢弃原生 continuation，只使用 Message 重建 session；
- `fork` 仍是 copy、apply 和立即执行的快捷形式，并优先使用后端原生 fork；
- 后端没有 checkpoint/fork 时，从复制后的 AFL Memory 创建独立 session。

Checkpoint 对应哪个 Memory revision 必须明确，避免 source Agent 在 copy 之后继续工作时把新增内容带入旧副本。

## 7. 安全、审批与阶段边界

AFL host policy 与 backend policy 使用收紧关系：

```text
effective permission = AFL host policy AND backend policy
```

- AFL policy 可以在 Agent 启动前拒绝整个执行；
- Backend 发起命令、文件、网络、MCP 或其他审批时，host 可以进一步拒绝；
- host 同意不代表 Backend 必须同意，Backend 仍可以根据 sandbox 或自身规则拒绝；
- adapter 不得为了避免交互而自动切换到更宽松的 sandbox 或 approval mode；
- backend 不支持某类隔离时，capability 和运行结果需要反映这一事实。

首版保留现有 `VmPolicy.authorizeAgent` 作为启动级策略。运行中的 action approval 只在 Backend 支持工具调用拦截时启用；审批事件至少应携带 backend、Agent、动作类别、人类可读原因和后端可安全公开的参数摘要。

Pi 不内置强制的文件、进程或网络权限系统，默认继承宿主进程权限。因此首个 Pi Backend 面向本地可信环境和开发试验，声明 `sandboxEnforcement: false`。这不阻挡 Agent loop、Memory、session 和 flow 调度先达到可用状态；在面向多人服务或大规模部署前，再增加容器、隔离 workspace 和更完整的权限策略。

## 8. 首个后端：Pi

### 8.1 选择 Pi

Pi 将模型适配、Agent loop 和 coding Agent 组织为可嵌入的 TypeScript package。AFL 与 Pi 可以在同一进程内交换结构化状态和事件，不必先维护一层外部进程协议。它提供的工具循环、消息状态、事件、取消、session 和 fork 能力，与本提案的 Backend 边界直接对应。

Pi 的统一模型接口也更符合 AFL 作为通用 flow IR 的定位：flow 不绑定某个模型 provider，bindings 决定具体模型和认证配置。

### 8.2 接入面

首版优先使用 `@earendil-works/pi-coding-agent` 的 SDK 接口，并复用 `@earendil-works/pi-agent-core` 和 `@earendil-works/pi-ai` 提供的底层能力，不包装交互式 CLI。建议映射如下：

| AFL / Backend 操作 | Pi SDK |
| --- | --- |
| 创建或恢复 session | `createAgentSession`、`AgentSession` 与 `SessionManager` |
| `do` | `AgentSession.prompt()`，等待完整 Agent loop 结束 |
| 读取和同步 Memory | Agent state messages 与 SessionManager entries |
| 进度和工具事件 | session / Agent event subscription |
| 取消 | `AgentSession.abort()` 或底层 Agent abort |
| checkpoint / fork | SessionManager 的会话树、branch / fork；不支持时复制消息状态 |
| 模型 provider | Pi model runtime 与 `pi-ai` |
| 工具调用拦截 | `beforeToolCall` 等 Agent hook，按需转交 host |

Pi SDK 文档没有提供与 `outputSchema` 等价的一等接口时，首版声明 `structuredOutput: false`。需要 schema 的 binding 应显式拒绝，或以后增加能够说明验证与重试语义的适配层，不能只解析最终文本后声称原生支持。

### 8.3 配置与可移植性边界

Pi coding-agent 还可以发现项目指令、skills、extensions 和默认工具。AFL Backend 应显式配置 ResourceLoader、system prompt、工具集合和 SessionManager，避免 flow 的实际语义被未声明的项目资源隐式改变。

首版 session 可以只存在于当前 VM run。Checkpoint 首先保证消息级 continuation，并与 AFL Memory revision 绑定；若使用 Pi 持久化会话树，文件位置和恢复策略仍属于 host 配置，不暴露给 AFL flow。

Pi 的 subagent、交互 UI 或工作流扩展不进入 AFL Backend。多 Agent 编排继续由 AFL IR 和 VM 负责，Pi 只执行一次 `do` 所代表的 Agent 工作。

### 8.4 后续 Codex Backend

Codex App Server 仍是有价值的后续 Backend。它原生提供 thread/turn 生命周期、结构化输出、sandbox 和运行中审批，可以用于验证 Backend 接口是否足以表达更严格的编码执行环境。Codex 的接入不应改变 `do`、Memory 或 fork 的通用语义，也不阻塞首个 Pi Backend 落地。

## 9. Workspace 与并行

Pi、Codex、Claude Code 等 coding Agent 会修改文件，因此 Agent Memory 隔离不足以保证并行安全：

- 两个独立 session 可以同时写入同一个工作目录；
- session fork 通常只复制对话，不复制文件系统；
- AFL `fork` 当前只承诺 Memory 隔离，不承诺 workspace 隔离。

初版 Pi Backend 可以在 binding 中固定 `cwd`，并明确同一 workspace 上的写操作风险。后续如需可靠的并行 coding flow，可以增加独立的 Workspace/Environment 基础设施，通过 Git worktree、临时目录、容器或远程环境提供隔离；这不要求改变 `do` 的基本语义。

## 10. 错误与兼容性

Backend 错误应转换为稳定的 AFL VM error code，同时保留不含密钥的 provider 摘要。至少区分：

- backend 不可用或协议版本不兼容；
- Agent symbol 没有 backend binding；
- 请求的 capability 不受支持；
- session 丢失、过期或无法恢复；
- Memory role 无法导入；
- 审批被拒绝；
- sandbox 或环境初始化失败；
- 模型 transport、限流和认证失败；
- 执行被取消或达到预算。

现有 stateless `AgentAdapter` 可以继续作为最小兼容接口。统一后的 `AgentRunRequest` 已不包含 mode；兼容层把完整 AFL Memory 传给 adapter，并将返回值规范化为 `completed`。兼容层不声明原生 session、fork、运行中审批或 Memory export 能力。

## 11. 首个实现范围

首个实现可以包含：

Agent 工作指令合并已经作为前置步骤完成，所有层只处理 `agent.do`。

- `AgentExecutorBackend`、capability、session ref、stop reason 和 host callback 类型；
- 现有 `AgentAdapter` 的兼容包装；
- Agent handle 上的 backend session，以及 Memory revision/checkpoint 元数据；
- `do`、`memory.copy`、`memory.apply` 和 `fork` 对 executor lifecycle 的调用；
- 基于 Pi SDK 的进程内 Backend，优先使用 `pi-coding-agent` 的 AgentSession 与 SessionManager；
- Pi session 创建/恢复、完整 `do` 周期、事件转发、Memory 同步、消息级 checkpoint/fork 和取消；
- 显式配置 system prompt、model、tools、ResourceLoader 和工作目录，不默认导入项目 extensions；
- 对 Pi 尚未提供的 structured output、强制 sandbox 和交互审批如实声明 capability；
- fake backend conformance tests，避免测试依赖真实模型或用户账户；
- 单独的 live smoke，用于验证真实 Pi runtime 和模型 provider，不作为默认测试前置条件。

持久化 VM run、Workspace handle、完整权限系统、Codex Backend 和其他 Agent runtime 可以在上述接口稳定后分别扩展。

## 12. 验收行为

实现进入 `docs/` 之前，至少验证以下行为：

- 同一 Agent 的连续执行复用同一 backend session；
- 不同 Agent 默认使用独立 session；
- `memory.copy` 在复制时冻结上下文，source 后续写入不进入既有副本；
- Reviewer 可以使用复制的 Coder Memory 和自己的 system prompt 创建 session；
- `fork` 产生互相隔离的 Memory 和 backend continuation；
- stateless adapter 仍可执行现有 flow；
- `do` 不会在中间工具调用、审批或可恢复输入点提前返回；
- Pi Backend 能完成包含多个模型与工具步骤的一次 `do`，并在真正终止前持续转发事件；
- AbortSignal、预算和错误转换保持有效，不支持的 schema 请求根据 capability 显式拒绝；
- 启用 action interception 时，AFL 拒绝的 action 不会被 backend 执行；
- Backend 自身具有安全策略时，其拒绝不会因 AFL host 同意而放行；
- Pi Backend 明确报告没有强制 sandbox，不把工具 hook 表述为系统级隔离；
- trace、日志和错误不包含 API key、认证 token 或原生 session secret。

## 13. 外部接口参考

- [Pi](https://github.com/earendil-works/pi)
- [Pi Agent Core](https://github.com/earendil-works/pi/tree/main/packages/agent)
- [Pi Coding Agent SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [Pi RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)
- [Codex App Server](https://developers.openai.com/codex/app-server/)
