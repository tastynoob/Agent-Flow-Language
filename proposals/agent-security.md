# Agent 工具安全、人工请求队列与 Sandbox 实施记录

## 1. 状态与目标

本文记录 AFL Agent 执行安全的设计依据、实施顺序和后续范围。Policy chain、FIFO 人工请求队列、Pi 工具拦截、一次性提权执行、通用事务申请、bubblewrap ExecutionEnv 和 cc-safety-net adapter 已进入 v0 实现；当前可执行契约见 [`docs/guides/agent-security.md`](../docs/guides/agent-security.md)。本文仍包含未完成的宿主 UI、跨平台 sandbox 和资源治理计划，不能用后续目标替代当前实现限制。

本计划的实施顺序为：

1. 建立与 executor 无关的 pre-tool policy 接口和组合规则；
2. 建立适用于多 Agent 并发的统一人工请求队列；
3. 让 Pi 在实际工具副作用发生前调用统一授权接口；
4. 接入可选的 bubblewrap 执行 sandbox；
5. 接入可选的 cc-safety-net Shell 语义策略；
6. 完成端到端审计、故障处理和真实 Agent smoke。

核心目标如下：

- 工具权限属于 VM host、executor 和 sandbox 的执行策略，不进入 AFL IR；
- 所有受支持的 Agent 工具在副作用发生前经过一次明确、可组合的授权；
- hard deny、soft block、模型主动提权审批和 OS 强制隔离具有不同职责，不能互相冒充；
- 多 Agent 并发产生的主动提权和事务请求按稳定队列逐个呈现，处理结果不会串到其他 Agent 或工具调用；
- bubblewrap 和 cc-safety-net 可以分别启用或关闭，关闭状态必须通过 capability、trace 或启动提示如实暴露；
- 启用的安全组件初始化或分析失败时 fail closed，不能自动退回更宽松的执行模式；
- Agent 主工作区、只读工作区和 Memory 持久化继续沿用现有语义，不新增安全相关 AFL 指令。

本计划首先保护 Pi coding tools。AFL `capability` instruction、外部 Flow、Script adapter 和其他 executor 的安全接入可以复用同一设计，但不在第一阶段顺带宣称已经被保护。

## 2. 安全分层与威胁边界

安全执行分为三个互相收紧的层次：

```text
Agent tool call
  -> pre-tool policy       语义判断：allow / block / deny / abstain
  -> model fallback        block 后先尝试更安全的替代方案
  -> executor sandbox      对已允许操作实施 OS 级边界
  -> tool result

Agent elevation request
  -> matching block/error  只接受当前 do 内同名同参数候选
  -> pre-tool policy       block 成为审批原因，deny 仍不可覆盖
  -> approval queue        对模型主动请求进行单路人工决策
  -> sandbox or host       使用满足目标所需的最小 execution boundary

AFL control tool wrapper
  -> bypass ordinary pre-tool policy
  -> validate and authorize the inner Node / IR / action
  -> VM execution
```

最终权限遵循交集关系：

```text
effective permission
  = pre-tool policies
  AND human approval when required
  AND executor/backend policy
  AND selected execution-boundary enforcement
  AND existing AFL VM authorization
```

任意 `deny` 都终止调用。普通 policy `block` 不触发审批，而是返回模型选择替代方案；只有模型随后主动请求提权时，block 才成为人工审批原因。人工审批不能覆盖 `deny`、sandbox 初始化失败、只读挂载失败或 VM 对 Freedom/Capability 的拒绝。Freedom control wrapper 本身不作为普通工具进入 pre-tool policy；它执行的 Node、IR 和其他内部 action 仍由对应 validator、`VmPolicy` 或工具 policy 授权。

Policy `block` 或 sandbox execution error 可以成为提权候选：Agent 必须显式请求重试同名、同参数 action。前者经批准后仍在 sandbox 内执行；只有实际 sandbox error 才切换到 host executor。两种路径都会重新运行 policy 并无条件进入一次性 `tool-elevation` 审批，批准不改变 session 或后续工具的 execution boundary。

第一阶段主要处理以下风险：

- Agent 通过 Bash 或文件工具访问声明 Workspace 之外的宿主文件；
- Agent 修改 `readonly_workspace`；
- Agent 在允许写入的主工作区中执行破坏性 Git 或文件命令；
- API key、SSH agent、云凭证、Docker socket、D-Bus 或 AFL Memory 被不必要地暴露给工具进程；
- 多个 Agent 同时等待审批时，UI 输出交错或审批答复绑定到错误请求；
- 已启用的策略、sandbox 或审批服务失败后静默放行。

第一阶段不承诺防御恶意内核、宿主 root、硬件侧信道或完整多租户隔离。bubblewrap 也不负责业务目标正确性、工作区内部数据恢复和 AFL 动态工作流授权。

## 3. Pre-tool Policy 契约

### 3.1 授权时机

Executor 必须在以下时点调用 host 授权：

1. 工具名称和输入 schema 已经验证；
2. command prefix、working directory、路径规范化等 executor 准备步骤已经完成；
3. 尚未启动子进程、读取或修改文件、发起网络请求或调用 host control；
4. 传入 policy 的 effective action 与随后执行的 action 完全一致。

如果授权后 executor 需要改变 command、cwd、目标路径或其他有安全意义的字段，原授权立即失效，必须对新 action 重新授权。只监听模型刚产生的原始 `tool_call` event 不足以满足这个契约，因为工具实现可能在 event 之后继续改写实际参数。

当前 Pi coding binding 会在 hook 前规范化 Bash cwd/environment 和文件 addressed path；第三方自定义工具若在自身 `execute` 内继续改写安全相关参数，仍必须提供相同的 normalizer/authorization 契约，不能仅凭 backend 已接 policy 就声称 effective action 完全覆盖。

### 3.2 请求与决策

下面的 TypeScript 摘录当前主要接口形状，省略与本节无关的辅助字段：

```ts
export type AgentToolExecutionBoundary =
  | "sandbox"
  | "host-control"
  | "host";

export interface AgentToolAction {
  readonly requestId: string;
  readonly runId: string;
  readonly node: string;
  readonly block: string;
  readonly agent: SymbolRef;
  readonly backend: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly executionBoundary: AgentToolExecutionBoundary;
  readonly workspace: AgentWorkspaceSet;
  readonly input: Readonly<Record<string, unknown>>;
  readonly effectiveInput: Readonly<Record<string, unknown>>;
  readonly display: AgentToolActionDisplay;
  readonly signal: AbortSignal;
}

export interface AgentToolActionDisplay {
  readonly title: string;
  readonly summary: string;
  readonly details?: Readonly<Record<string, string>>;
}

export type AgentToolPolicyDecision =
  | { readonly verdict: "allow"; readonly reason?: string }
  | { readonly verdict: "block"; readonly code: string; readonly reason: string }
  | { readonly verdict: "deny"; readonly code: string; readonly reason: string }
  | { readonly verdict: "abstain" };

export interface AgentPreToolPolicy {
  readonly name: string;
  evaluate(action: AgentToolAction):
    | AgentToolPolicyDecision
    | Promise<AgentToolPolicyDecision>;
}
```

`input` 保存 executor 收到的原始结构化参数，`effectiveInput` 保存实际即将执行的规范化参数。Policy 使用完整数据做判断，但审批 UI、trace 和错误默认只使用已经脱敏的 `display`，不能把 API key、认证 header 或完整环境变量直接写入日志。

Action 在进入 policy 前做不可变快照。Policy 只能给出决策，不能改写工具参数，也不能直接执行工具。Policy 名称由 policy chain 使用注册时的 `name` 附加，不能由返回结果伪造；同一 chain 内名称必须唯一。`requestId` 和 action digest 共同绑定一次授权，避免旧审批被复用到后续调用。

Action digest 对 backend、tool name、execution boundary、规范 Workspace identity 和完整 effective input 做 canonical serialization 后计算，不包含 display、时间戳或对象遍历顺序。Digest 只用于绑定当前待决请求，不能作为跨请求、跨 run 或跨进程复用的 capability token。

### 3.3 Policy 组合

Policy 按 bindings 中的稳定顺序求值，组合规则为：

- 任意 `deny` 都是最终硬拒绝，不能成为提权候选；
- 没有 `deny` 且至少一个 policy 返回 `block` 时，拦截工具并把可提权错误返回模型，不进入人工请求队列；
- 没有 `deny` 或 `block` 时允许执行；
- `abstain` 表示该 policy 不负责这种工具，不等于该工具已经通过安全审查；
- `requireCoverage: true` 时，所有 policy 都 `abstain` 的工具调用按未覆盖拒绝；
- `requireCoverage: false` 时，未覆盖调用可以继续，但必须在 trace 中标记为 `uncovered`；
- 已启用的 enforcement policy 抛出异常或返回无效结果时，转换为稳定的 policy failure 并拒绝执行。

Policy 不提供“强制允许”语义。某个 policy 的 `allow` 不能覆盖另一个 policy、backend、sandbox 或 VM 的拒绝。

Policy chain 不能在遇到第一个 `block` 或 `allow` 时立即结束，必须继续检查后续 policy 是否给出 `deny`。`deny` 已经是不可覆盖的最终结果，因此可以安全地结束剩余求值。

### 3.4 Host 授权入口

`AgentExecutionHost` 已收敛为普通工具授权、一次性提权与通用事务请求入口：

```ts
export type AgentToolAuthorization =
  | { readonly status: "allowed"; readonly requestId: string }
  | {
      readonly status: "denied";
      readonly requestId: string;
      readonly code: string;
      readonly reason: string;
      readonly elevatable?: boolean;
    };

export interface AgentExecutionHost {
  authorizeTool(action: AgentToolAction): Promise<AgentToolAuthorization>;
  requestElevation(request: AgentElevationRequest): Promise<AgentToolAuthorization>;
  requestTransaction(request: AgentTransactionRequest): Promise<AgentTransactionResult>;
  // Existing event, continuation, input and control-tool methods remain.
}
```

Backend 只接收最终的 `allowed` 或 `denied`，不直接操作 presenter。普通 `authorizeTool()` 永远不会打开人工请求队列；soft block 表现为带 `elevatable: true` 的 `denied`，由 Backend 返回模型并记录提权候选。只有 `requestElevation()` 和 `requestTransaction()` 可以产生人工请求。

## 4. 多 Agent 人工请求队列

### 4.1 所有权与并发语义

人工请求队列由 VM host/CLI 所有，不属于单个 Agent、session 或 executor。CLI 默认创建一个进程级队列，因此同一进程内不同 run 和不同 Agent 的请求不会同时占用终端。当前 API 沿用 `AgentApprovalQueue` 命名，但队列同时承载提权审批与非审批性质的事务确认。

队列使用单调 sequence 和 FIFO 顺序：

```text
queued -> presenting -> approved | denied
   |          |
   +------> cancelled
```

- 任一时刻最多有一个 `presenting` 请求；
- 每个 `enqueue()` 返回独立 Promise，只有发起该请求的 Agent 等待该 Promise；
- 其他不需要人工交互的 Agent 和工具调用继续运行；
- 其他需要人工交互的 Agent 进入队列等待，不并发读取 stdin；
- 请求不合并、不去重，两个相同命令仍是两个独立授权；
- v0 不提供“全部允许”“本次 run 永久允许”等扩大授权范围的快捷操作。

严格 FIFO 会产生人为的 head-of-line blocking，但它符合 v0 的目标：保证请求上下文清晰和答复映射正确。未来 GUI 可以在不改变授权契约的前提下提供选择、分组或多 reviewer 分片。

### 4.2 队列接口

```ts
export interface AgentApprovalRequestDraft {
  readonly kind: "tool-elevation" | "transaction";
  readonly subject: {
    readonly runId: string;
    readonly node: string;
    readonly block: string;
    readonly agent: string;
    readonly backend: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly executionBoundary: AgentToolExecutionBoundary;
    readonly workspace: string;
    readonly display: AgentToolActionDisplay;
  };
  readonly reasons: readonly {
    readonly policy: string;
    readonly reason: string;
  }[];
  readonly actionDigest: string;
}

export interface AgentApprovalRequest extends AgentApprovalRequestDraft {
  readonly queueId: string;
  readonly sequence: number;
  readonly requestedAt: string;
}

export type AgentApprovalDecision = "approved" | "denied";

export interface AgentApprovalPresenter {
  present(
    request: AgentApprovalRequest,
    signal: AbortSignal,
  ): Promise<AgentApprovalDecision>;
}

export interface AgentApprovalQueue {
  enqueue(
    request: AgentApprovalRequestDraft,
    signal: AbortSignal,
    observer?: (event: AgentApprovalQueueEvent) => void | Promise<void>,
  ): Promise<AgentApprovalDecision>;
  close(): Promise<void>;
}
```

终端 presenter 至少显示：queue sequence、run、Agent、node/block、tool、execution boundary、主工作区、触发审批的 policy 原因和脱敏后的 effective action 摘要。`AgentApprovalRequest` 不携带原始 `input` 或 `effectiveInput`；完整 action 只由 host 保存在对应的待决 Promise 中。审批输入只作用于当前 `queueId + actionDigest`。

### 4.3 取消、故障与容量

- Agent 或 run 的 `AbortSignal` 触发时，queued 请求直接移除，presenting 请求取消 UI，并向等待方返回 cancelled；
- 队列关闭、host 退出或 presenter 异常时，所有尚未决策的请求 fail closed；
- 没有配置交互 presenter 时，主动提权和事务请求返回 unavailable，不能默认批准；
- 队列配置 `maxPending`，超过容量的新请求立即拒绝，避免失控 Agent 无限占用内存；
- presenter 返回后再次校验 request identity 和 action digest；过期、重复或不匹配答复不能放行工具；
- 进程崩溃时 pending request 不做 snapshot 恢复。由于提权工具尚未执行、事务也未确认完成，重新运行时由 Agent 重新发起请求；
- approval queue 自身不获取或管理 VM 内部锁。等待审批的 `agent.do` 继续持有它已经取得的 Agent、Memory 和 Workspace lease，因此冲突工作仍然等待；无关 Workspace 上的 Agent 可以继续推进。

### 4.4 通用事务申请

人工队列同时接受 `kind: "transaction"`。Pi 内建 `afl.transaction.request`（模型侧名称 `afl_transaction_request`），让普通 Agent 在缺少编译器、凭据外的用户动作或其他前置条件时提交 title、具体请求、阻塞原因和可选恢复条件。

事务申请不是权限提升，也不自动执行安装命令。Presenter 的 `approved` 对事务表示“用户标记已完成”，工具结果会要求 Agent 再验证恢复条件；`denied` 或 queue unavailable 作为结构化结果返回模型。事务和提权审批共享同一 FIFO，避免多 Agent 产生两套会互相抢占终端的交互系统。

### 4.5 一次性提权执行

人工队列接受 `kind: "tool-elevation"`。Pi bubblewrap coding binding 内建 `afl.elevation.execute`（模型侧名称 `afl_elevated_tool`），只重试当前 `agent.do` 中同名、同参数的已有候选。候选有两种来源：

- pre-tool policy 的 soft block：调用尚未执行，批准后仍使用原 sandbox execution context；
- sandbox execution error：调用已经在 sandbox 中失败，批准后才使用 host execution context。

模型必须先收到 block 或实际失败结果，并自行判断替代方案代价过高，再显式提交原始参数和提权理由。Host 按最终 execution boundary 重新规范化 cwd/path 等 effective input，并重新运行完整 policy chain；任意 hard deny 立即结束，soft block 作为审批原因展示，其他结果也必须进入人工队列。批准只绑定当前 `queueId + actionDigest`，不产生 session 级权限、可复用 token 或动态 sandbox profile；成功执行后对应候选被消费。

提权状态通过 `elevation.state` 记录 `queued`、`presenting`、`approved`、`denied`、`cancelled` 或 `unavailable`；事务使用独立的 `transaction.state`。Trace 记录稳定 ID、位置和队列序号，审批 display 使用脱敏后的 action，不另外复制原始工具参数。

## 5. 可选安全组件与配置语义

安全组件通过 TypeScript bindings/host 配置，不增加 AFL source 指令。概念配置如下：

```ts
const security = {
  preTool: false | {
    requireCoverage: boolean;
    policies: readonly AgentPreToolPolicy[];
  },
  approvalQueue: false | {
    maxPending: number;
    presenter: AgentApprovalPresenter;
  },
  sandbox: false | {
    backend: "bubblewrap";
    network: "none" | "host";
  },
};
```

实际 API 可以让 cc-safety-net 作为 `policies` 中的实例，让 bubblewrap 作为 Pi execution context 的 sandbox backend；上面的单一对象只说明用户可独立启停三类能力，不要求它们必须由同一个类实现。v0 不提供被动触发人工审批的 policy decision 或 `InteractiveApprovalPolicy`。

启停遵循以下规则：

- 组件为 `false` 时不参与授权，但不能使其他组件失效；
- bubblewrap 显式启用但二进制、user namespace 或挂载能力不可用时，Agent 启动失败；
- cc-safety-net 显式启用但配置、规则或 analyzer 失败时，本次 Shell 调用拒绝；
- approval queue 关闭时，主动提权和事务请求返回 unavailable；
- sandbox 关闭时 executor 必须声明 `sandboxEnforcement: false`；
- 不允许“尝试 bubblewrap，失败后自动使用 NodeExecutionEnv”一类隐式降级；
- host 应在 run 开始时输出当前生效安全能力，避免用户只根据配置文件名称猜测保护状态。

后续可以提供 `development`、`reviewed`、`isolated` 等便捷 profile，但 profile 只展开为上述显式组件，不能引入隐藏权限。

## 6. Bubblewrap Sandbox

### 6.1 Pi 接入位置

Pi 的 `read`、`bash`、`edit` 和 `write` 工具都通过 `ExecutionEnv` 完成文件和进程操作。第一版保留 AFL VM、Pi AgentHarness、模型调用和 Memory persistence 在宿主进程中，并把实际工具执行放入长生命周期 sandbox worker：

```text
AFL VM / Pi AgentHarness / model transport
                  |
                  | structured ExecutionEnv RPC
                  v
          bubblewrap tool worker
          - filesystem operations
          - shell child processes
```

Pi coding binding 使用 `BubblewrapExecutionEnv` 代替直接访问宿主的 `NodeExecutionEnv`。Worker 在一个 Agent session/Workspace execution context 内复用；session 关闭、取消或 host 退出时终止。模型 API key 和 provider 网络连接留在宿主侧，不进入 worker。

ExecutionEnv RPC 只暴露固定、带 schema 的文件和进程方法，不提供新增 bind mount、访问宿主路径或执行 host callback 的通用转发。Sandbox mount table 在 worker 启动后保持不可变；所有 RPC 返回值都需要大小限制和错误规范化。

不能只给 Bash 子进程增加 bubblewrap。否则 `read`、`edit`、`write` 或绕过 shell 的自定义工具仍会直接访问宿主文件系统，executor 不能声明完整 workspace sandbox。

### 6.2 文件系统视图

基础挂载模型为：

- 空 mount namespace 作为 root；
- Agent primary workspace 读写挂载到稳定的 `/workspace`；
- read-only workspaces 按声明顺序只读挂载到 `/readonly/0`、`/readonly/1` 等路径；
- 必要的 `/usr`、`/bin`、runtime libraries 和最小系统配置只读挂载；
- `/tmp` 与 sandbox HOME 使用独立 tmpfs；
- 使用独立 `/proc` 和最小 `/dev`；
- 不挂载宿主 HOME、SSH agent、Docker socket、D-Bus、云凭证目录和 AFL Memory store；
- primary 是 execution root 时，默认遮蔽 `/workspace/.afl`，只允许 bindings 显式重新暴露必要的非敏感子路径；
- mount source 使用 VM 已经 `realpath` 规范化的 Workspace descriptor；所有 bwrap 参数以 argv 数组构造，不经过 shell 拼接。

Agent prompt 中呈现 sandbox 内路径，而不是宿主绝对路径。这样持久化 Memory 和工具记录使用稳定的 `/workspace`、`/readonly/N`，也减少宿主目录结构泄露。

### 6.3 Namespace 与进程生命周期

基础 profile 至少使用独立 mount、PID、IPC、UTS 和 network namespace，以及 `--new-session`、`--die-with-parent`、清理环境变量和默认 capability drop。允许时禁止 worker 再创建嵌套 user namespace。

网络默认 `none`。因为模型 transport 位于宿主侧，普通 coding loop 不需要 worker 网络。确实需要下载依赖的 binding 可以显式选择 `host`，但这表示该 worker 拥有宿主网络可达性；域名级 allowlist、代理和流量审计是后续能力，不能把 `host` 表述为受限网络。

bubblewrap 不提供完整的 CPU、内存、进程数和磁盘资源治理。Timeout、rlimit、cgroup 和 tmpfs size 需要由 host 分别设置。Seccomp 需要预编译的过滤器；在过滤器落地前不能只因为使用了 bubblewrap 就声称存在 syscall allowlist。

### 6.4 工具覆盖声明

每个 Pi tool 需要声明执行边界：

- 内置 coding tools 使用 `sandbox`，所有副作用经 `BubblewrapExecutionEnv`；
- Freedom 的 `afl.*` 工具使用 `host-control`，由 VM 现有 scope、constraint、validator 和 `VmPolicy` 授权；
- 自定义 host tool 使用 `host`，必须有显式 policy 覆盖，不能因同一 Agent 的其他工具在 sandbox 中就被视为安全；
- 要求完整 sandbox 的 profile 遇到未声明边界或绕过 ExecutionEnv 的 effectful tool 时直接拒绝 session 创建。

只有所有声明为 sandbox 内执行的工具确实共享受控 ExecutionEnv，且 sandbox 初始化成功时，Pi backend 才能报告 `sandboxEnforcement: true`。这一 capability 只表示声明 Workspace 边界得到强制执行，不表示 host-control、网络、资源上限或业务行为已经全部安全。

## 7. cc-safety-net Policy

cc-safety-net 作为一个 `AgentPreToolPolicy` 接入，不作为 Pi extension 自动加载，也不成为 AFL 的通用权限系统。

适配规则为：

- 只处理 effective Shell action，其他工具返回 `abstain`；
- analyzer 使用 `effectiveInput` 中的最终 command，并以对应 primary Workspace 的宿主路径初始化上游插件，而不是分析未经 prepare 的模型原始文本；
- 安全命令返回 `allow`；
- 命中破坏性规则返回带稳定 code 和解释的 `block`，让模型先尝试更安全的替代方案；
- malformed supported input、规则加载失败或 analyzer 异常 fail closed；
- cc-safety-net 本身不进入人工审批队列；模型只有在替代方案代价过高时才能用同名同参数 action 主动申请一次性提权；
- AFL trace 复用 analyzer 的解释和脱敏结果，不重复保存一份未经处理的命令日志。

当前 cc-safety-net adapter 在宿主进程中运行，并把 primary Workspace 的宿主路径作为上游插件目录。它能审查最终 Shell command 和宿主工作区中的 Git 状态，但不观察 bubblewrap 内的 `/workspace` 路径视图、mount namespace 或 symlink 解析结果，因此它是命令语义策略，不是 namespace-aware 文件系统策略。需要更强一致性时，可以在 sandbox worker 中增加只分析不执行的 RPC，或等待上游提供可显式传入 cwd/path mapping 的 typed analyzer API；不能通过暴露整个宿主 HOME 来加载规则或 cache。

当前固定使用 `cc-safety-net@1.0.6`。该版本仍未把 analyzer 直接作为顶层 API 导出，但公开的 plugin entry 已封装同一分析路径；AFL adapter 通过该公开 hook 接口接入，不加载 Pi CLI extension，也不逐次启动 CLI 子进程。Strict/paranoid/worktree mode 暂时沿用上游 `CC_SAFETY_NET_*` 环境变量。若上游提供稳定 analyzer API，应改用直接 typed API，并移除这层 plugin 兼容边界。

cc-safety-net 只能保护授权工作区内部的 Shell 行为。bubblewrap 仍负责阻止越过 Workspace 边界；文件工具、host tools、AFL control tools 和网络分别由其他 policy 或执行边界处理。

## 8. 与现有 AFL 语义的关系

本计划不增加 `sandbox`、`approval`、`policy` 或 `workspace` mutation 指令。AFL source 继续只描述 Agent flow：

- Agent declaration 的 primary/read-only Workspace 作为 sandbox mount 输入；
- VM WorkspaceLocks 继续协调当前进程内重叠 Workspace，并不被 bubblewrap 替代；
- Memory persistence 继续由 VM 在 execution root 的 `.afl` 下统一管理，默认不暴露给 sandbox worker；
- `VmPolicy.authorizeAgent` 继续处理 Agent activation；
- `authorizeCapability`、Freedom node/IR authorization 继续处理 VM 级操作；
- pre-tool policy 只处理 Agent runtime 即将执行的工具 action，不能授予新的 Node、IR、Capability 或 binding；
- Freedom planner 调用 `afl.node.execute` 或 `afl.ir.execute` 时，即使 pre-tool policy 允许，VM 仍必须重新 parse、validate、检查 constraint 和授权；
- 外部 Script、Capability 和 Flow adapter 在专门接入 sandbox/policy 之前，不属于 `sandboxEnforcement` 的覆盖范围。

人工请求结果和安全 trace 不成为 flow-visible Frag 或 Memory。Agent 可以从被拒绝的工具结果获知本次操作未执行和安全原因，但不能读取人工请求队列、修改 policy 或枚举其他 Agent 的待处理请求。

## 9. 错误与可观测性

实现时需要稳定区分：

- `AGENT_TOOL_POLICY_DENIED`：policy 正常给出硬拒绝；
- policy 自定义稳定 code：soft block，返回模型且可成为当前 `do` 的提权候选；
- `AGENT_TOOL_POLICY_FAILED`：已启用 policy 自身失败，按 fail closed 拒绝；
- `AGENT_TOOL_POLICY_UNCOVERED`：严格 coverage 下没有 policy 负责该 action；
- `AGENT_APPROVAL_UNAVAILABLE`：需要审批但没有 presenter；
- `AGENT_APPROVAL_QUEUE_FULL`：超过 pending 上限；
- `AGENT_APPROVAL_CANCELLED`：run、Agent 或 host 取消请求；
- `AGENT_ELEVATION_DENIED`：人类拒绝一次性宿主执行；
- `AGENT_ELEVATION_UNAVAILABLE`：提权需要审批但没有可用队列；
- `AGENT_SANDBOX_UNAVAILABLE`：平台或 bubblewrap 能力不存在；
- `AGENT_SANDBOX_INIT_FAILED`：namespace、mount 或 worker 初始化失败；
- `AGENT_SANDBOX_TERMINATED`：worker 在工具执行期间异常终止。

Tool lifecycle event 增加 policy 和 sandbox 相关状态，但不把 policy 检查伪装成工具已经开始执行。建议顺序为：

```text
tool.requested
tool.policy
elevation.state / transaction.state         # only after an active model request
tool.started                             # side effect may begin here
tool.completed
```

错误、trace、审批 UI 和安全决策记录使用统一脱敏 helper。原始 action 只在 policy 求值和实际 executor 内存中短暂存在，安全层不另外复制到审计文件。Executor continuation 是否保存完整 tool message 继续遵循 Memory persistence 契约；安全 trace 不能为了方便调试再保存一份未经脱敏的副本。

## 10. 实施阶段

### Phase 1: Policy Contract（已实现）

- 增加 `AgentToolAction`、policy decision、policy chain 和最终 authorization 类型；
- 已把旧 Pi `approval: "never" | "always"` 与 `requestApproval()` 收敛到 `authorizeTool()`；
- 提供 fake policies，验证 allow/block/deny/abstain、组合优先级、coverage 和异常 fail closed；
- 为 action 建立不可变快照、stable request ID、digest 和统一脱敏 display；
- 保持现有 VM-level authorization，不把 Agent tool policy 扩大成通用 AFL Policy DSL。

### Phase 2: Human Request Queue（核心队列已实现）

- 实现单 presenter FIFO queue、容量限制、取消和 shutdown；
- 提供最小 stdio presenter，并允许宿主 UI 实现 presenter 以显示完整 Agent/flow 定位和队列序号；
- 非交互 host 对主动提权和事务请求 fail closed；
- 增加并发单元测试，确认乱序 enqueue、取消和 presenter failure 不会串答复；
- 增加 trace events 和脱敏测试；
- 统一承载 `tool-elevation` 和 `transaction`，两类主动请求保持不同 presenter 文案和 trace 状态。

### Phase 3: Pi Exact Interception（内建 coding tools 已实现）

- 包装 Pi tools，使 policy 观察最终 effective action；
- 确保工具只有在 authorization `allowed` 后才进入 execute；
- 对 command prepare、cwd、文件 path 和自定义 tool execution boundary 建立测试；
- `afl.*` control wrapper 不走普通工具 policy，其内部 Node、IR 和 action 保留 VM 或工具层的对应授权；
- 后端取消时同步取消 queued human request 和尚未开始的 tool。

### Phase 4: Bubblewrap（Linux v0 已实现）

- 定义 executor sandbox backend 和 Pi `BubblewrapExecutionEnv`；
- 实现基于 stdio 或等价窄 IPC 的长生命周期 tool worker；
- 实现 mount profile、空 HOME/tmp、环境变量 allowlist、namespace 和生命周期管理；
- 启动时进行真实 capability probe，显式启用后任何失败都不降级；
- 初始仅支持 Linux，其他平台报告稳定 unavailable；
- 在完整工具覆盖后把 Pi `sandboxEnforcement` 设为 true。

### Phase 5: cc-safety-net（固定版本 adapter 已实现）

- 确定 upstream API 或固定 fork/vendor 边界；
- 实现只处理 Shell action 的 policy adapter；
- strict/paranoid/worktree 当前由上游环境变量固定，后续再改为无全局状态的 binding 配置；
- 对 nested shell、Git、path、malformed input、配置失败和脱敏建立回归测试；
- 保留 analyzer 来源、版本和许可说明。

### Phase 6: End-to-end Verification（进行中）

- 使用 fake model 稳定覆盖安全分支；
- 已使用 DeepSeek live smoke 验证真实 Pi tool loop、两次 sandbox 失败后的主动提权以及完整 Memory 记录；
- 运行多 Agent coder/reviewer flow，制造多个并发审批请求并验证队列顺序；
- 在 bubblewrap 中完成读写、GCC 编译和测试，确认工具链仍可用；
- 检查持久化 Memory、trace 和终端输出没有 API key 或未脱敏 action；
- 更新 README、bindings 示例和 capability 说明后再把行为迁入正式 docs。

## 11. 验收行为

实现完成至少满足：

- policy `deny` 后对应工具没有产生任何副作用；
- 多个 policy 中 deny 始终胜过 block/allow；普通 block 不进入队列；
- policy 异常、无 presenter、queue overflow 和 sandbox init failure 都不会放行；
- 三个以上并发 Agent 的审批 UI 始终一次展示一个请求，答复只唤醒对应 Agent；
- queued 和 presenting 请求都能被 AbortSignal 取消，旧答复不能应用到新 tool call；
- 等待审批的 Agent 不阻塞无需审批且 Workspace 不冲突的其他 Agent；
- primary workspace 可以创建、修改和编译文件；
- read-only workspace 可读取但不能由 Bash、edit 或 write 修改；
- sandbox 内不能读取宿主 HOME、AFL Memory、API key 或未挂载路径；
- sandbox worker 默认无法访问网络，Pi 模型请求仍正常工作；
- worker/host 退出后子进程被清理，不留下脱离管理的命令；
- `rm -rf /workspace` 一类命令不能越过 sandbox，在主工作区内部由 cc-safety-net soft block 并先返回模型选择替代方案；
- 安全 Shell 命令可以正常执行，cc-safety-net 的 nested wrapper 和 Git/path 分析生效；
- 自定义 host tool 在严格 profile 下没有 policy coverage 时拒绝；
- Freedom control wrapper 不依赖普通 tool policy，并且不能绕过 VM constraint、validator 或 authorization；
- 独立关闭 bubblewrap 或 cc-safety-net 时其 capability/trace 准确反映缺失保护，其他组件仍正常工作。

## 12. 延后范围

以下内容不在本次实施中：

- pending human request 的 snapshot、跨进程恢复和分布式请求 broker；
- 自动合并相似请求、批量批准、永久授权或 Agent 自我批准；
- macOS Seatbelt、Windows AppContainer/Job Object 等其他 sandbox backend；
- 域名级网络 allowlist、透明代理和网络内容审查；
- 完整 seccomp profile、cgroup 资源配额和多租户容器编排；
- 将安全 policy 设计成 AFL 指令或通用语言；
- 用 bubblewrap 替代 WorkspaceLocks、Memory persistence 或 VM 动态工作流授权；
- 对第三方自定义工具自动推断副作用和执行边界。

## 13. 外部参考

- [bubblewrap](https://github.com/containers/bubblewrap)
- [bubblewrap manual](https://github.com/containers/bubblewrap/blob/main/bwrap.xml)
- [cc-safety-net](https://github.com/kenryu42/cc-safety-net)
- [Pi Agent Core](https://github.com/earendil-works/pi/tree/main/packages/agent)
