# Agent Executor Backend 提案

## 1. 状态与范围

本文讨论 AFL 的 Agent 执行器后端。内容尚未成为 parser、validator、VM 或 bindings API 的实现契约。

AFL 继续负责描述和调度 flow。`agent.do` 是 flow 发起 Agent 工作的执行入口；模型调用、工具循环、原生会话、sandbox 和工具审批由可替换的 Agent Executor Backend 完成。

本提案希望达到以下效果：

- 同一份 AFL flow 可以选择 Codex、Claude Code、普通 API adapter 或其他 Agent runtime；
- AFL 不需要复制每个 runtime 的 agent loop、工具系统和安全实现；
- AFL Memory 保持可移植，同时允许后端利用原生 session 提高上下文连续性；
- AFL 可以观察和约束后端行为，但不绕过后端已有的安全边界；
- 后端能力不足时显式报告差异，不静默改变 `do`、Memory 或审批语义。

本提案不为 AFL IR 增加 provider、model、workspace 或 approval 指令。相关配置首先保留在 bindings 和 VM host 中。

当前实现仍包含 `agent.seqdo`。本提案描述后续接口的收敛方向，不提前改变已经发布的 parser、validator、VM 和文档规范。

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

Codex 是一种 Agent runtime，而不是 AFL 的唯一模型 provider。Codex 后端可以继续选择 OpenAI、自定义 Responses provider、本地 provider 或后续增加的模型传输实现。

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

### 3.3 `seqdo` 迁移

当前 `do` 与 `seqdo` 的区别无法稳定映射到不同 runtime。一次看似单步的工作也可能需要工具调用、审批或多个模型 turn 才能产生结果，而这些内部步骤不适合作为 AFL flow 的边界。

本提案采用统一的 `do` 语义：后续实现移除独立的 `seqdo` 指令。若兼容已有 flow 有实际需要，parser 可以在有限迁移期把 `seqdo` 规范化为 `do`，但两者不再具有不同的运行语义。需要观测单次模型请求或单个 runtime turn 时，可以通过 Backend 调试选项实现，不把该边界加入 Core IR。

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
  readonly approvals: boolean;
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

完整 Agent runtime 会在最终输出之前产生进度、工具和审批事件。Backend 不应把这些内容全部压缩进最终 Frag。

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
- Backend Session：Codex thread、Claude session 等原生 continuation state；
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

## 7. 安全与审批

AFL host policy 与 backend policy 使用收紧关系：

```text
effective permission = AFL host policy AND backend policy
```

- AFL policy 可以在 Agent 启动前拒绝整个执行；
- Backend 发起命令、文件、网络、MCP 或其他审批时，host 可以进一步拒绝；
- host 同意不代表 Backend 必须同意，Backend 仍可以根据 sandbox 或自身规则拒绝；
- adapter 不得为了避免交互而自动切换到更宽松的 sandbox 或 approval mode；
- backend 不支持某类隔离时，capability 和运行结果需要反映这一事实。

首版可以保留现有 `VmPolicy.authorizeAgent` 作为启动级审批，再增加运行中的 action approval。审批事件至少应携带 backend、Agent、动作类别、人类可读原因和后端可安全公开的参数摘要。

## 8. Codex Backend

### 8.1 接入面

Codex App Server 比 `codex exec` 更适合作为长期 Backend 接口。它提供持久连接、thread/turn 生命周期、流式事件和运行中审批。建议的映射如下：

| AFL / Backend 操作 | Codex App Server |
| --- | --- |
| 创建 session | `thread/start` |
| 恢复 session | `thread/resume` |
| `do` | `turn/start`，按需由 Goal 或 continuation controller 续接，等待工作终止 |
| 读取 Memory | `thread/read` 或 turn/item 查询 |
| 注入 Message | `thread/inject_items` |
| checkpoint / fork | `thread/fork`，必要时指定最后一个 turn |
| 结构化输出 | `turn/start.outputSchema` |
| 取消 | `turn/interrupt` |
| 工具与权限审批 | App Server 的 server request / response |
| 进度 | thread、turn 和 item notification |

`codex exec --json` 可以用于独立 smoke 和协议观察，但每次启动进程、交互审批和多 session 并发不适合作为长期 VM transport。

Codex 内部使用一个还是多个 turn，不改变 AFL 层的一次 `do`。Backend 负责消费中间事件、处理工具与审批，并在当前工作真正终止后返回结果。

### 8.2 System Prompt

AFL `agent.sysprompt` 需要稳定的 per-Agent 配置。Codex 可以通过 instructions、Agent 配置或 collaboration mode 提供部分能力；若公开 App Server 字段不能表达等价行为，可以在 Codex fork 中补充一个明确的 per-thread developer instructions 字段。

这项修改应位于 App Server 请求和 thread 配置边界，不改写 Codex agent loop。

### 8.3 Model Provider

Codex 已经支持自定义 model provider、Ollama、LM Studio 和 Amazon Bedrock。当前自定义 provider 的 wire protocol 以 Responses API 为边界，因此“Codex Backend”和“OpenAI GPT Backend”不是同一个概念，但非 GPT 模型可能仍需要协议适配。

模型接入按以下层次处理：

1. 模型服务兼容 Codex 需要的 Responses API 时，只配置 provider；
2. 模型只提供 Chat Completions 或 Anthropic Messages API 时，先使用独立 Responses protocol bridge；
3. bridge 无法保持必要语义时，再为 Codex 模型传输层增加新的 `wire_api`；
4. Agent loop、Memory、工具、安全和 App Server 协议尽量不随 provider 改动。

Responses bridge 需要处理流式 event、tool call ID、结构化输出、并行工具调用、usage、重试和错误分类。Reasoning continuation、prompt caching 或 provider 特有签名不能可靠转换时，应通过 capability 降级或禁用，不伪造等价支持。

### 8.4 Codex 修改边界

首个 Codex fork 如需修改，优先限制在以下位置：

- per-thread developer instructions；
- 新的 model wire transport；
- AFL 需要但 App Server 尚未公开的 session/checkpoint 字段；
- 协议兼容测试和 AFL service name 标识。

不建议为了 AFL 重写 Codex 的工具实现、sandbox、审批判定、session storage 或 agent loop。这样可以减少跟进上游 Codex 更新时的长期差异。

## 9. Workspace 与并行

Codex、Claude Code 等 coding Agent 会修改文件，因此 Agent Memory 隔离不足以保证并行安全：

- 两个独立 session 可以同时写入同一个工作目录；
- `thread/fork` 或 `forkSession` 通常只复制对话，不复制文件系统；
- AFL `fork` 当前只承诺 Memory 隔离，不承诺 workspace 隔离。

初版 Codex Backend 可以在 binding 中固定 `cwd` 和 sandbox policy，并明确同一 workspace 上的写操作风险。后续如需可靠的并行 coding flow，可以增加独立的 Workspace/Environment 基础设施，通过 Git worktree、临时目录、容器或远程环境提供隔离；这不要求改变 `do` 的基本语义。

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

现有 stateless `AgentAdapter` 可以继续作为最小兼容接口。兼容层把完整 AFL Memory 传给旧 adapter，并将返回值规范化为 `completed`；旧接口中的 mode 只作为 adapter 迁移细节，不进入新的 Backend 契约。兼容层不声明原生 session、fork、运行中审批或 Memory export 能力。

## 11. 首个实现范围

首个实现可以包含：

- `AgentExecutorBackend`、capability、session ref、stop reason 和 host callback 类型；
- 现有 `AgentAdapter` 的兼容包装；
- Agent handle 上的 backend session，以及 Memory revision/checkpoint 元数据；
- parser、IR、validator 和 VM 中独立 `seqdo` 语义的移除，必要时提供有限的兼容规范化；
- `do`、`memory.copy`、`memory.apply` 和 `fork` 对 executor lifecycle 的调用；
- Codex App Server transport；
- thread 创建/恢复、完整 `do` 周期、Memory 同步、fork、schema、取消和审批映射；
- fake backend conformance tests，避免测试依赖真实模型或用户账户；
- 单独的 live smoke，用于验证真实 Codex runtime，不作为默认测试前置条件。

非 GPT protocol bridge、持久化 VM run、Workspace handle 和其他 Agent runtime 可以在上述接口稳定后分别扩展。

## 12. 验收行为

实现进入 `docs/` 之前，至少验证以下行为：

- 同一 Agent 的连续执行复用同一 backend session；
- 不同 Agent 默认使用独立 session；
- `memory.copy` 在复制时冻结上下文，source 后续写入不进入既有副本；
- Reviewer 可以使用复制的 Coder Memory 和自己的 system prompt 创建 session；
- `fork` 产生互相隔离的 Memory 和 backend continuation；
- stateless adapter 仍可执行现有 flow；
- `do` 不会在中间工具调用、审批或可恢复输入点提前返回；
- 旧 `seqdo` flow 在迁移策略启用时与 `do` 具有一致结果；
- schema 约束、AbortSignal、预算和错误转换保持有效；
- AFL 拒绝的 action 不会被 backend 执行；
- backend 拒绝的 action 不会因 AFL host 同意而放行；
- trace、日志和错误不包含 API key、认证 token 或原生 session secret。

## 13. 外部接口参考

- [Codex App Server](https://developers.openai.com/codex/app-server/)
- [Codex SDK](https://developers.openai.com/codex/sdk/)
- [Codex 非交互模式](https://developers.openai.com/codex/noninteractive/)
- [Codex 高级配置](https://developers.openai.com/codex/config-advanced/)
- [Codex 配置参考](https://developers.openai.com/codex/config-reference/)
