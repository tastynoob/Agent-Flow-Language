# Agent Workspace 与 Memory 持久化实施计划

## Goal Description

本次改动为 Agent 声明增加列表式 Workspace 参数，并在 VM 内部增加统一的 Memory 持久化。Workspace 只描述 Agent 在哪里工作、可以读取哪些公共区域；Memory persistence 只属于 VM 基础设施。两者都不扩展成可由 flow 任意管理的通用资源系统。

核心边界如下：

- Workspace 不是独立指令、外部 symbol 或 flow-visible handle，而是 `agent` 的第二个 operand；
- 一个字符串表示只有主工作区；
- 一个列表表示 Workspace set，第一项是主工作区，其余项都是只读工作区；
- Workspace path 可以来自字符串字面量、TypeScript 结果或 node 参数；
- 并发子 Agent 通过带编号的主工作区显式隔离写入区域，并共享公共文档或代码区作为只读工作区；
- Memory 持久化没有新增指令，VM 自动加载和保存现有 Memory handle；
- AFL Memory 始终是 model/executor/Agent 平台无关的 canonical Message 序列，Frag 始终是 role-free content；
- VM 通过 executor-owned `AgentMemoryContract` 适配不同模型或 Agent executor，但 backend 类型和原生 role 不进入 AFL IR；
- `memory.append`、`memory.copy`、`memory.apply` 继续保留，因为它们描述 Agent 之间如何操作和传递记忆，而不是描述存储设施；
- 所有持久化记忆统一存放在 AFL execution root 下，不跟随各 Agent Workspace 分散保存；
- binding 只能改变 Memory 存储目录或替换存储实现，不改变 AFL IR；
- 首版只持久化 canonical Memory，不持久化或恢复 backend session、checkpoint 和完整 VM snapshot。

### Agent 语法

没有只读工作区时直接传入主工作区：

```afl
coder = agent @agent.coder, "main_workspace/"
```

需要只读工作区时使用列表。第一项是主工作区，后续项都是只读工作区：

```afl
coder = agent @agent.coder, ["workers/coder/", "docs/", "src/"]
```

Agent 完整形式为：

```text
agent <agent-symbol>
agent <agent-symbol>, <workspace-spec>
agent <agent-symbol>, , <memory-name>
agent <agent-symbol>, <workspace-spec>, <memory-name>
```

其中：

```text
workspace-spec = path-string
               | [main-path, readonly-path, ...]
               | expression-evaluating-to-one-of-the-above
```

第二个 operand 固定为 Workspace spec，第三个 operand 才是可选 Memory handle。Workspace 留空且提供 Memory 时，使用 execution root 作为默认主工作区：

```afl
reviewer = agent @agent.reviewer,, review_memory
reviewer = agent @agent.reviewer, "review_workspace/", review_memory
```

`agent @agent.reviewer,, review_memory` 中的空第二 operand 是语法的一部分，只允许出现在确实存在第三个 Memory operand 时。`agent @agent.reviewer,`、`agent @agent.reviewer,,` 等尾部空 operand 都是解析错误。

省略 Workspace spec 时，Agent 使用 execution root；省略 Memory 时，VM 创建 working Memory。为了保持语义确定，不保留“第二个 operand 根据运行时类型猜测是 Memory 还是 Workspace”的重载。

字符串是只有主工作区时的规范写法。列表至少包含两项；单元素列表应改写为字符串，空列表属于验证错误。列表第一项之后可以有多个只读目录。

### TypeScript 与 Dispatch

Workspace spec 是普通字符串或字符串列表，因此可以由现有 `typescript` 指令生成，也可以作为 node 参数传递：

```afl
worker(task, main_workspace):
    entry:
        agent = agent @agent.worker, [main_workspace, "docs/", "src/"]
        result = agent.do task
        ret result

main(task_a, task_b):
    entry:
        workspace_0 = typescript "return \"workers/\" + String(args[0]) + \"/\"", 0
        workspace_1 = typescript "return \"workers/\" + String(args[0]) + \"/\"", 1
        workers = dispatch [worker(task_a, workspace_0), worker(task_b, workspace_1)]
        results = sync workers
        ret results
```

两个 child Agent 分别写入 `workers/0/` 和 `workers/1/`，同时读取公共的 `docs/` 与 `src/`。

当前 `dispatch count, flow, task` 会向每个 child 传入同一个 task，不提供 worker index。首版带编号 Workspace 使用显式 `dispatch [...]`，或由外部 AFL generator 根据并发度生成 TypeScript path 与 dispatch call。是否让 batch dispatch 自动提供 index 属于单独的 dispatch 设计，不在本计划中顺带修改。

### Agent Workspace IR

不增加 `workspace`、`agent.workspace` 或 Workspace mutation 指令，也不增加 Workspace ValueKind。现有 `AgentInstruction` 扩展为：

```ts
interface AgentInstruction {
  readonly op: "agent";
  readonly dst: string;
  readonly agent: SymbolExpr;
  readonly workspace?: ValueExpr;
  readonly memory?: NameExpr;
  readonly span: SourceSpan;
}
```

Parser 接受一到三个 operand，保留中间空 operand，并按固定位置生成字段。空 Workspace operand 归一化为 `workspace: undefined`，第三个 operand 仍解析为 `memory`。Validator 与 VM 对 Workspace spec 执行以下检查：

- Workspace spec 最终必须是非空字符串，或至少包含两个非空字符串的 list；
- list 第一项是 primary，其余项按顺序成为 read-only roots；
- TypeScript 结果和 node 参数在运行时执行同样的 shape 检查；
- 主目录不能与只读目录相同，只读目录规范化后不能重复；
- 主目录与只读目录之间不能存在父子包含关系，避免同一路径树同时声明为 write 和 read-only；
- Workspace spec 不能是 Frag、record、number、boolean、SymbolRef、Memory handle 或嵌套 list。

Agent instruction 的依赖引用包含 Workspace expression。由 TypeScript 生成路径时，Agent 创建必须等待对应 script instruction 完成；dispatch child 收到 path 参数后再创建 Agent。

Workspace path 不作为 Agent 创建后的可读字段暴露给 AFL，也不能由 `oper`、Prompt 或 Capability 从 Agent handle 中取出。

### 路径解析与运行时模型

`VmRunOptions.executionRoot` 明确 AFL 执行根目录，CLI 默认使用启动 AFL 时的 `process.cwd()`。

Workspace path 的解析规则如下：

- 相对路径以 execution root 解析；
- 绝对路径保持绝对语义；
- 主工作区不存在时由 VM 递归创建；
- 只读工作区必须已经存在且是目录，VM 不替 Agent 创建公共资料区；
- VM 在目录存在后通过 `realpath` 得到规范绝对路径，并以它作为首版 resource identity；
- 当前阶段不限制 `..` 或 execution root 之外的绝对路径，因为 Workspace 尚不是 sandbox 边界。

Agent handle 内部保存解析后的配置：

```ts
interface AgentWorkspaceSet {
  readonly primary: WorkspaceDescriptor;
  readonly readOnly: readonly WorkspaceDescriptor[];
  readonly origin: "default" | "explicit";
}

interface WorkspaceDescriptor {
  readonly root: string;
  readonly resourceId: string;
}
```

不再增加 `WorkspaceAdapter` 或 `@workspace.*` binding。Workspace 的路径值由 AFL expression 直接产生，VM 只负责相对于 execution root 解析和验证。

`AgentExecutionRequest` 和兼容 `AgentRunRequest` 增加 `workspace: AgentWorkspaceSet`。Executor capabilities 增加 `workspaceContext` 和 `readOnlyWorkspaceContext`：

- 没有文件工具的 stateless adapter 可以忽略 VM 自动提供的默认 Workspace；
- flow 显式传入 Workspace，而 backend 不支持对应上下文时必须报 capability error；
- backend 不能静默丢弃显式只读 Workspace，也不能宣称它已经形成权限隔离。

`origin` 由 Agent declaration 决定，而不是通过规范化后路径是否等于 execution root 猜测。`fork` 和 `memory.apply` 继承它，使 VM 在派生 Agent 上仍能区分“自动提供的默认 cwd”和“flow 显式要求的 Workspace”。

Pi backend 不再在 `createPiCodingAgentBinding()` 时固定全局 `cwd`。模型、system prompt 和稳定的 Agent 配置仍由 Pi Agent binding 提供；Workspace 相关的 env、tools、tool context 和 resources 由工厂按 session 创建：

```ts
interface PiWorkspaceExecutionContext {
  readonly tools?: readonly AgentHarnessTool<any>[];
  readonly toolContext?: AgentHarnessToolContextSource<any>;
  readonly resources?: AgentHarnessResources;
  readonly contextPrompt?: string;
}

interface PiAgentBinding {
  readonly model: Model<Api> | PiModelRef;
  readonly systemPrompt?: string;
  readonly createExecutionContext?: (
    workspace: AgentWorkspaceSet,
  ) => PiWorkspaceExecutionContext | Promise<PiWorkspaceExecutionContext>;
}
```

上面只列出 Workspace 相关形状；现有 thinking level、stream options、active tools 等稳定配置继续保留。

内置 coding binding 的工厂以 primary root 创建 `NodeExecutionEnv` 和 read/bash/edit/write tools；主工作区成为 Pi 的 `cwd`，read-only roots 通过 backend context prompt 和必要的 tool context 作为可读取的绝对路径呈现。`contextPrompt` 是 executor 注入的运行环境上下文，不是 AFL `agent.sysprompt` 指令，也不改变 flow-visible system prompt。

静态且不依赖 Workspace 的自定义工具可以复用；捕获 cwd、env 或文件根目录的工具必须由 `createExecutionContext` 每次重新创建。Pi session record 保存规范 Workspace set 和本次创建的 context，fork/checkpoint 只能在该 Workspace compatibility key 相同的情况下复用。

首版的“只读”是 flow、调度和 Agent 上下文语义，不是操作系统安全边界。Pi Bash 仍继承宿主进程权限，AFL 暂不承诺阻止 Agent 写入只读目录。

### Workspace 并发语义

每次 `agent.do` 的资源访问为：

```text
primary workspace   -> write
read-only workspace -> read
```

VM 在调用 backend 前通过专用的 hierarchical Workspace lock manager 获取路径锁：

- 不同主工作区的子 Agent 可以并行执行；
- 只共享只读工作区的 Agent 可以并行执行；
- main/main 和 main/read-only 的路径相同或存在祖先关系时按依赖顺序串行；
- 未显式配置 Workspace 的 Agent 共享 execution root，因此其 `do` 默认按潜在写操作串行。

两个 Workspace access 在“路径相同或一方是另一方祖先”且至少一个 access 是 write 时冲突；read/read 即使路径重叠仍可并行。祖先关系使用规范绝对路径的 path segment 判断，不能使用字符串前缀，例如 `/repo/a` 不是 `/repo/ab` 的祖先。`workers/0/` 和 `workers/1/` 是互不重叠的 sibling，因此仍可并行；`workers/` 和 `workers/0/` 必须串行。首版不提供跨进程 Workspace lock。

`agent.do` 固定先获取 Agent/Memory handle lock，再获取 Workspace path locks，并按相反顺序释放；其他路径不能在持有 Workspace lock 时反向请求 Agent/Memory lock，避免两个 lock manager 形成环形等待。

Agent 派生规则如下：

- `fork` 继承 source Agent 的主工作区和只读工作区，不克隆目录；
- `memory.apply` 使用 source Agent 的 symbol、system prompt 和 Workspace 配置；
- `memory.copy` 只复制 Memory，不携带 Workspace；
- Agent 创建后 Workspace 配置不可由 AFL mutation；
- checkpoint/session compatibility key 包含 Agent symbol、effective system prompt、model/binding identity 和带 access mode 的规范 Workspace roots。

### VM 内部 Memory 持久化

不增加 `memory @memory.*`、`memory.save`、`memory.load` 或 persistence option 指令。VM 为每个现有 Memory handle 分配内部 persistence slot，并在 Memory mutation 时自动保存。

持久化覆盖：

- `agent` 隐式创建的 working Memory；
- Agent 第三个 operand 显式绑定的已有 Memory；
- `memory.copy` 创建的独立 Memory；
- `fork` 为 branch 创建的 Memory；
- `memory.append` 和 `agent.do` 对上述 Memory 产生的后续修改。

Persistence slot 不依赖运行时 handle counter。VM 对每个已经通过验证的 module 做 canonical serialization，排除 source span、文件路径和其他展示信息，再计算 `moduleDigest`。每个新 Memory allocation 根据结构化 activation lineage 生成稳定 slot：

```text
module:<moduleDigest>
  / entry:<entry-name>
  / activation:<call-site and dispatch-index path>
  / block:<block-name>@<visit-ordinal>
  / instruction:<index>:<op>:<destination>
  / allocation:<working|copy|fork>
```

Root entry、local call site、generated flow call site、dispatch task index 和父 activation 都进入不可变 activation path。Dispatch index 在线程启动前按输入顺序确定，避免 Promise 完成顺序改变 Memory identity。每个 node activation 为每个 block 单独维护 visit ordinal，用于区分 loop 中同一 allocation instruction 的多次动态执行。

只有实际创建新 Memory 的位置分配 slot：隐式 Agent working Memory、`memory.copy` 和 `fork` branch。第三个 operand、`memory.apply`、node 参数或本地 flow call 传递已有 Memory handle 时沿用原 slot，不重新分配。VM 为每个 run 维护 `claimedSlots`；不同 live Memory handle claim 同一 slot 属于稳定错误，不能加载同一份 Message 后各自覆盖。

新建的空 working Memory 可以只注册 slot，延迟到第一次 Message append 再写文件，因为“slot 不存在”和“从未写入的空 Memory”在下一次执行中等价。`memory.copy` 创建时已经包含 canonical Message，属于一次 durable allocation；copy instruction 必须在新 slot 保存成功后才完成，即使之后没有任何 append。`fork` branch 的首次 `agent.do` 输入提交同时保存其复制内容和新输入。

同一 `runId` 中，slot identity 表示同一个长期 Memory。Allocation 时若 slot 已存在，VM 恢复其 Message/revision，并忽略本次 empty/copy/fork initializer；`memory.copy` 和 `fork` 只在 slot 首次出现时从 source 初始化。这是 persistence 对 allocation 的明确语义，不做隐式 merge 或 rebase。Flow 需要新的逻辑副本时必须使用新的 `runId`，或让它出现在不同的结构 activation/slot。

同一 `runId` 再次启动相同 flow 时，VM 在 Memory handle 创建时按 slot 恢复 Message 和 revision。新的 `runId` 创建独立状态。`runId` 是 VM/CLI 参数，不进入 AFL IR。

状态文件的 `rootModuleDigest` 必须与当前 root module 的 canonical IR 完全匹配，否则整个 run state 拒绝加载，不做按 slot 猜测的部分迁移。动态 generated flow 使用自己的 module digest 作为 slot segment，并由父 generated-flow call site 定位；生成源码变化时产生新 slot，旧 slot 继续保留。这不是完整 VM resume：执行仍从 entry 开始，不恢复 instruction pointer、条件分支、TaskGroup 或未完成外部调用。如果控制路径变化，不再出现的 slot 不会被绑定到其他 Memory。

重复使用同一 `runId` 表示在已有 canonical Memory 上开始一次新的 flow execution。所有 `memory.append` 和 `agent.do` 都按本次执行正常追加，VM 不根据指令位置隐式去重。因此它适合“继续同一段对话”，不是失败指令的透明重放；包含一次性初始化 append 的 flow 应使用新 `runId`，或由 flow 自身决定是否再次追加。

### Role、Executor 与 Pi Session 边界

不同 provider 的原生消息协议确实可能使用不同 role label 和内容结构。AFL 持久化不能直接复制某个 provider 的 request payload，也不能假定一个 executor 的 session 可以交给另一个 executor。

当前接入的 Pi 0.82.1 在 `pi-ai` 层把模型协议归一化为三种 LLM Message：

```text
user
assistant
toolResult
```

Pi Agent Core 的 session 比这更丰富。除了 Message entry，它还保存 model、thinking level、active tools、compaction、branch summary、custom message、label 和当前 leaf 等树形状态；AgentMessage 还可以出现 `bashExecution`、`custom`、`branchSummary`、`compactionSummary` 等扩展 role。Pi 自带的持久化实现使用 version 3 JSONL session，header 包含 session id、cwd 和 metadata，后续每行是一个带 parent id 的 session entry。

当前 AFL Pi backend 尚未使用该 JSONL repo，而是使用 `InMemorySessionRepo`。AFL 与 Pi 的现有转换边界也比 Pi 原生 session 更窄：

- AFL Memory 可以保存任意字符串 role；
- Pi backend Memory facet 的 `importRoles` 目前只有 `user` 和 `assistant`；
- Pi 执行要求最新未同步 Message 是 `user`；
- 导入 assistant 时，adapter 会根据当前 Pi model 补齐 api、provider、model、usage 和 timestamp；
- tool result、tool call、thinking、compaction 和其他 Pi session entry 当前不会导出到 AFL Memory。

因此 v1 持久化文件保存的是可检查的 AFL canonical Memory，不是 Pi 原生 session。Role 继续使用 AFL label，并由 `roleSchema` 标记序列化与核心语义版本；executor adapter 负责把 canonical role 映射为自己的 native role。VM 不把 `human`、`model`、`toolResult` 等 executor/provider label 直接改写成 AFL role。

AFL 层的两个数据类型继续保持最小语义：

```text
Frag    = { content: string }
Message = { role: AFL role label, content: string }
Memory  = Message[]
```

`afl.message-role/v1` 保留 `user` 和 `assistant` 作为核心 role；`memory.append` 仍可以写入其他非空 role label，它们是 AFL extension role，不等于某个 provider 的原生 role，也不保证所有 executor 都能导入。平台无关指的是表示和语义不依附某个 backend，不代表每个 backend 都支持所有 extension role。

Frag 本身永远没有 role。只有 Frag 被 `agent.do` 或 `memory.append` 放进 Memory 时，flow 才为它赋予 AFL role；Agent 输出写入自身 Memory 时使用 canonical assistant role，但返回给 flow 的结果仍是 role-free Frag。`Message` 和 role schema 常量移动到独立的 core Memory module，不能继续由 `adapters.ts` 拥有。

VM 在 Memory 与具体 executor/model 之间保留 executor-owned Memory facet。它声明导入能力并执行校验，不改变 AFL Memory 的公开表示；native message 转换仍是 executor `execute` 的私有实现：

```ts
interface AgentMemoryCapabilities {
  readonly roleSchemas: readonly string[];
  readonly importRoles: readonly string[];
}

interface AgentMemoryContract {
  readonly capabilities: AgentMemoryCapabilities;

  validateImport(
    agent: SymbolRef,
    roleSchema: string,
    messages: readonly Message[],
  ): void | Promise<void>;
}

interface AgentExecutorBackend {
  readonly memory: AgentMemoryContract;
}
```

上面只列出本计划新增的 Memory facet，现有 `name`、其他 capabilities、`execute` 和当前进程内的 session lifecycle 仍保留。现有顶层 `memoryImportRoles` 移入该 facet；首版删除未被 Pi 使用的 `memoryExport`/`exportMemory`，等确实需要从 native session 重建 canonical Memory 时再单独设计。

Pi、其他 Agent platform 或普通 model adapter 分别实现 Memory facet，AFL parser/IR/Memory handle 无需知道它们的 native role。Facet capability 是运行时能力，不写入 AFL Memory payload。

VM 与 executor 的公共边界始终只收发 canonical `Message[]`。在每次 `agent.do` 创建或续接 backend session 前，VM 使用完整 Memory 调用 `validateImport`，executor 再在 `execute` 内部转换 native message。Memory facet 校验失败只阻止该 Agent 执行，不删除已经持久化的 canonical Message，因为同一 Memory 仍可能交给另一个兼容 executor。

首版从 `AgentExecutionResult` 和兼容 `AgentRunResult` 删除可选 `messages`。Backend 只返回最终 role-free output，VM 是唯一有权把它追加为 canonical assistant Message 的组件。Pi 的 tool、thinking、compaction 等 backend-only entry 继续留在当前进程的 native session 中，不建立目前没有实际消费者的第二套 Memory delta 协议。

恢复规则采用保守策略：

- canonical Memory 总是可以独立加载，不因 executor 缺失而损坏；
- 每次执行 Agent 前，当前 executor 的 Memory facet 必须校验 `roleSchema` 和全部 canonical roles，不只在持久化恢复后校验；
- VM 不因 backend 不可用或校验失败而自动切换 executor；一个 Agent activation 选定 backend 后保持不变；
- host 可以通过显式 binding 把纯 AFL Memory 交给另一个兼容 executor/model，但必须创建新 session，不能复用旧 backend checkpoint；
- Memory facet 不支持某个 role 时显式失败，不能自动改名、删除或压平 Message；
- `memory.copy` 只复制 canonical Message；`memory.apply` 由目标 Agent 当前 executor 的 Memory facet 重新验证；
- 跨 executor 迁移不需要改写 AFL Memory 文件，只需要目标 Memory facet 能完整导入其 role schema。

Pi 已经为不同 provider/model 提供统一 Message 层，所以纯 `user/assistant` AFL Memory 通常可以重新导入不同 Pi model，但每次仍由目标 binding 的 Memory facet 做能力校验并创建新 session。

Snapshot 恢复明确不在本计划范围内。`BackendSessionRef`、Pi session tree 和 checkpoint 只用于当前 VM 进程内的性能与 fork 优化，VM 退出后不恢复。未来如果需要 snapshot，将在独立提案中定义 backend-owned 格式和严格兼容性，不扩展本次 Memory 文件。

### 统一 Memory 存储位置

默认状态文件位于：

```text
<executionRoot>/.afl/memory/<encoded-run-id>.json
```

所有 Agent 的 Memory 都进入这一份 run state。Agent 主工作区和只读工作区不参与持久化路径计算，因此编号 Workspace 不会各自产生一套分散的 Memory cache。

Binding 可以覆盖统一目录或替换存储实现：

```ts
interface MemoryPersistenceBinding {
  readonly directory?: string;
  readonly store?: MemoryStateStore;
}

interface MemoryStateStore {
  loadRun(runId: string, signal: AbortSignal): Promise<PersistedRunMemoryState | undefined>;
  saveRun(state: PersistedRunMemoryState, signal: AbortSignal): Promise<void>;
}
```

这里有两个彼此独立的 backend 扩展点：`MemoryStateStore` 决定 canonical Memory 保存到文件、内存或其他介质；`AgentMemoryContract` 声明并校验具体模型或 Agent executor 的导入能力。前者不理解模型 role，后者不决定持久化位置。

规则如下：

- `memoryPersistence` 未配置时使用 execution root 下的默认目录；
- `directory` 相对路径以 execution root 解析；
- `directory` 与 `store` 二选一，同时配置属于 binding error；
- 自定义 store 仍保存统一 run state，不把存储职责交给单个 Agent；
- `saveRun` 成功返回表示整份 run state 已原子提交；自定义 store 不能暴露部分更新；
- parse、validate 和构造 VM 时不创建 `.afl`，第一次实际保存时再创建目录。

VM 在 run 开始时为 `(store namespace, runId)` 注册一个活跃的顶层 run context，并在 run 的 `finally` 中注销。默认文件 store 的 namespace 是规范化 Memory 目录；自定义 store 使用 store instance identity。同一进程不能同时启动第二个同 namespace、同 `runId` 的顶层 run，否则两套 run-level persistence queue 会竞争整份 state。这个限制不影响同一 run 内的并发 Agent，它们共享同一个 context 和 queue。跨进程的同 `runId` 并发执行仍不属于首版能力。

默认文件格式是带版本的单 run JSON envelope：

```json
{
  "version": 1,
  "format": "afl.memory-run",
  "roleSchema": "afl.message-role/v1",
  "runId": "review-42",
  "rootModuleDigest": "sha256:canonical-ir-digest",
  "memories": {
    "module:sha256:canonical-ir-digest/entry:main/activation:root/block:entry@0/instruction:0:agent:coder/allocation:working": {
      "revision": 3,
      "messages": [
        { "role": "user", "content": "..." },
        { "role": "assistant", "content": "..." }
      ]
    }
  }
}
```

VM load 时保留文件中的全部 slots，包括本次控制路径尚未 claim 的 slots；后续 save 以这份完整状态为基础，只替换已经 mutation 的 slot，避免条件分支暂时未经过时丢失旧 Memory。Memory GC 不在首版范围。

VM 使用 run-level persistence queue 串行保存不同 Memory 的最新完整 state，避免两个 Agent 同时完成时互相覆盖。内置文件存储使用同目录 temporary file、flush/close 和 atomic rename，并清理失败的 temporary file；指令在对应状态保存成功后才算完成。Queue 第一次保存失败后进入 failed 状态，拒绝所有后续 mutation 并使整个 run 失败。损坏 JSON、未知 version、非法 Message 或 revision 必须报告稳定错误，不能静默清空。

Version 1 只有 append mutation，因此每个 slot 必须满足 `revision === messages.length`。不一致的数据拒绝加载；未来若增加 edit/delete，再通过新的文件 version 修改 revision 规则。

Version 1 文件只包含 AFL canonical Memory 及其格式、run、root module digest、role schema、slot 和 revision 信息，不保存 executor、model、provider 或其他 backend metadata。Memory facet capability 在运行时从当前 executor 获取，不属于 Memory 数据。

持久化文件不包含：

- `BackendSessionRef`、Pi session 或 `MemoryCheckpoint`；
- Memory owner 和运行时 handle id；
- Workspace path 或工作区文件；
- VM instruction pointer、TaskGroup、进程和未完成工具调用。

恢复 Memory 后，backend session 和 owner 重新建立。Pi 首次执行时根据恢复的 AFL Message 创建新 session；当前进程内的 checkpoint/fork 优化保持不变。

Memory durability 与 Agent 外部副作用使用以下提交顺序：

1. `agent.do` 先把输入 Message 追加到 canonical Memory 并等待保存成功；保存失败时不调用 backend。
2. Memory facet 校验完整 Memory，backend 执行模型与工具循环。
3. VM 校验最终 output 和 schema，把它追加为唯一的 canonical assistant Message。
4. VM 等待输出后的完整 run state 保存成功，再把返回的 native session/checkpoint 标记为可继续使用并完成指令。
5. 第 2 步以后任何校验或保存失败都使整个 run 失败；VM 丢弃 Agent 上的 session/checkpoint，并尽力调用 backend `close`，不能继续使用已经推进但未与 durable Memory 对齐的 session。

模型调用、工具执行和 Workspace 文件修改无法与 Memory 文件形成同一事务。VM 不自动重试失败的 `agent.do`，也不承诺 exactly-once；输出保存失败时，文件副作用可能已经发生，而 durable Memory 只包含先前已提交的输入。调用方重新运行前需要接受这种 at-least-once 边界或自行检查 Workspace。

首版不提供跨进程同时写同一 `runId`、状态删除、过期、压缩、GC、native session persistence 或完整 snapshot，也不把 Pi version 3 JSONL session 嵌入 v1 AFL Memory 文件。

## Acceptance Criteria

- AC-1: Agent Workspace 使用确定的位置参数语法。
  - Positive Tests (expected to PASS):
    - Parser 接受 `agent @agent.ai, "main/"`、`agent @agent.ai, ["main/", "docs/", "src/"]`、`agent @agent.ai,, memory` 和显式 Workspace 加第三个 Memory operand。
    - 省略 Workspace 时 Agent 使用 execution root，省略 Memory 时创建 working Memory。
    - `AgentInstruction` 只新增 `workspace?: ValueExpr`，不产生 Workspace instruction/handle。
  - Negative Tests (expected to FAIL):
    - Parser 把第二个 operand 继续解释为 Memory，或根据运行时类型重载其含义。
    - Parser 接受没有第三个 Memory 的尾部空 operand，或把空 Workspace 保存为普通字符串。
    - Parser 接受 `workspace @...`、`agent.workspace` 或 Workspace clause/named argument。

- AC-2: Workspace spec shape 严格遵循字符串/列表约定。
  - Positive Tests (expected to PASS):
    - 字符串解析为只有 primary 的 Workspace set。
    - 列表第一项解析为 primary，其余多项按顺序解析为 read-only roots。
    - TypeScript 结果和 node 参数可以提供同样的 string/list shape。
  - Negative Tests (expected to FAIL):
    - 空字符串、空列表、单元素列表、嵌套列表或非字符串 list item。
    - Frag、record、number、boolean、SymbolRef 或 Memory handle 被当作 Workspace path。

- AC-3: 路径相对 execution root 解析并正确准备。
  - Positive Tests (expected to PASS):
    - 相对 primary path 解析到 execution root 下并在缺失时自动创建。
    - 已存在的相对/绝对 read-only path 被规范化为 descriptor。
    - 默认 Agent primary 是规范化的 execution root。
  - Negative Tests (expected to FAIL):
    - read-only path 不存在、不是目录、与 primary 相同/父子重叠，或规范化后重复。
    - Agent Workspace 影响 Memory persistence directory。

- AC-4: TypeScript 生成的编号 Workspace 可以驱动 dispatch 并发。
  - Positive Tests (expected to PASS):
    - TypeScript 分别生成 `workers/0/`、`workers/1/` 并作为 child node 参数传入 Agent。
    - 两个 Agent 获得不同 primary，同时共享 `docs/` 和 `src/` read-only roots。
    - Agent 创建依赖于生成 Workspace path 的 script instruction。
  - Negative Tests (expected to FAIL):
    - 不同 child 因共享同一个生成结果而意外获得相同 primary。
    - 本改动静默改变 batch dispatch 参数数量或虚构 worker index。

- AC-5: Workspace 配置完整传递给 Agent executor 和 Pi。
  - Positive Tests (expected to PASS):
    - Mock backend 能观察规范化的 primary/read-only descriptors。
    - Pi execution context factory 在不同 primary 上创建不同 `NodeExecutionEnv`、tools 和 tool context，相对工具路径以各自主目录解析。
    - Default/explicit Workspace origin 能传递到派生 Agent，静态 stateless adapter 只可忽略 default Workspace。
    - 相同 Workspace compatibility key 的 Pi session 可以在当前 run 内续接。
  - Negative Tests (expected to FAIL):
    - Backend 不支持显式 Workspace context 时静默忽略参数。
    - 捕获旧 cwd 的 Pi tool/context 被复用于另一个 primary。
    - Workspace compatibility key 不同的 Agent 错误复用 checkpoint/session。

- AC-6: Workspace path 控制 Agent 并发资源。
  - Positive Tests (expected to PASS):
    - 不同 primary 的子 Agent 可以同时进入 backend。
    - 只共享 read-only roots 的 Agent 可以并行。
    - main/main 和 main/read-only 指向相同或父子重叠路径时按顺序执行。
    - sibling primary `workers/0/` 和 `workers/1/` 可以并行。
  - Negative Tests (expected to FAIL):
    - 相同 primary 出现并发 writer。
    - `/repo/workers/` writer 与 `/repo/workers/0/` writer/read-only 同时进入 backend。
    - 默认共享 execution root 的多个写 Agent 绕过 Workspace lock。

- AC-7: Agent 派生保持 Workspace 语义。
  - Positive Tests (expected to PASS):
    - `fork` 和 `memory.apply` 继承 source Agent Workspace set 及 default/explicit origin。
    - `memory.copy` 仍只复制 Message/checkpoint，不产生 Workspace 数据。
    - 派生 Agent 的 `do` 使用继承后的 Workspace locks。
  - Negative Tests (expected to FAIL):
    - `fork` 隐式克隆目录或为 branch 生成编号 Workspace。
    - Workspace 不兼容时错误复用原生 continuation。

- AC-8: Memory persistence 完全是 VM 内部行为。
  - Positive Tests (expected to PASS):
    - 隐式 Agent Memory、显式绑定 Memory、copy Memory 和 fork Memory 都自动注册 persistence slot。
    - `memory.copy` 即使没有后续 append，也在指令完成前保存复制后的 Message。
    - `memory.append` 和 `agent.do` mutation 自动更新统一 run state。
    - 现有 `memory.append/copy/apply` 不增加 persistence operand。
    - 每次 Agent 执行前，executor Memory facet 校验完整 canonical Memory，持久化 payload 不随 executor 改变。
    - Agent executor 只返回 role-free output，VM 只追加一次 canonical assistant Message。
    - Agent 输入和返回给 flow 的 Frag 始终是 role-free content，只有写入 Memory 时才形成带 canonical role 的 Message。
  - Negative Tests (expected to FAIL):
    - Parser 接受 `memory @memory.*`、`memory.save/load` 或 cache path 指令。
    - Flow 可以读取 persistence slot、存储路径或 envelope。

- AC-9: 同一 runId 可以稳定恢复集中管理的 Memory。
  - Positive Tests (expected to PASS):
    - 相同 runId 和 activation lineage 恢复 Message 顺序及 revision。
    - Dispatch task index 和 fork lineage 不受并发完成顺序影响。
    - 新 runId 从独立空状态开始。
    - 当前 module digest、entry/call/dispatch/block visit/instruction/allocation kind 共同形成稳定 slot，envelope 校验 root module digest。
    - 未被本次控制路径 claim 的旧 slot 在保存后仍然保留。
    - 已存在的 copy/fork slot 恢复长期 Memory，只有首次 allocation 才从 source 初始化。
    - 同一 runId 的新 execution 从 entry 开始，并在恢复的 Memory 后正常追加新 Message。
    - Canonical Memory 在执行前由当前 backend facet 校验 role schema 和全部 roles。
    - Host 显式选择兼容相同 role schema 的 executor/model 时，可以从 canonical Memory 创建全新 session。
  - Negative Tests (expected to FAIL):
    - 动态 handle counter或 Agent 完成顺序改变 persistence slot。
    - 不匹配的 module digest/run state 被绑定到当前 flow。
    - 两个不同 live Memory handle claim 同一 slot。
    - VM 把重新执行误认为 instruction resume，或按指令位置静默去重 append/do。
    - 已存在的 copy/fork slot 与本次 source 自动 merge/rebase，或被 source 静默覆盖。
    - Memory facet 不支持某个 canonical role 时仍创建 session，或自动改写、删除 Message。
    - VM 因当前 backend 不可用或校验失败而自动切换 executor。
    - 新 executor 复用另一个 executor 的 checkpoint/session。

- AC-10: Memory 始终保存在 execution root 的统一位置。
  - Positive Tests (expected to PASS):
    - 默认状态文件位于 `<executionRoot>/.afl/memory/`。
    - 编号 primary Workspace 不会各自产生 Memory cache。
    - Binding directory override 和自定义 store 能替换默认位置/介质。
  - Negative Tests (expected to FAIL):
    - Memory 被写入 Agent primary 或任一 read-only Workspace。
    - 同时配置 `directory` 和 `store`，或相对 override 不以 execution root 解析。

- AC-11: Run state 的并发、错误和能力边界确定。
  - Positive Tests (expected to PASS):
    - Persistence queue 保存包含所有并发 Memory 更新的最新 state。
    - Version 1 JSON 只保存 canonical `memories`、`roleSchema`、`rootModuleDigest` 和运行定位字段，并使用 atomic rename 完成 round trip。
    - Version 1 每个 slot 满足 `revision === messages.length`。
    - Version 1 JSON 中不存在 executor、provider、model 或 backend session metadata。
    - 同一 store namespace/runId 的第二个活跃顶层 run 被拒绝；同一 run 内的并发 Agent 正常共享 persistence queue。
    - Agent input 保存成功后才调用 backend，output 保存成功后才提交 native session continuation。
    - 文档明确重新运行从 entry 开始，不是完整 VM resume。
    - build、unit tests、VM acceptance tests、package smoke 和 Pi mock smoke 全部通过。
  - Negative Tests (expected to FAIL):
    - 较旧 state 覆盖较新 revision，或保存失败后 instruction 仍成功。
    - 输出保存或 post-execution validation 失败后继续复用已经推进的 native session，或自动重试 Agent。
    - Session、checkpoint、Workspace、TaskGroup、instruction pointer 或损坏数据被当作可恢复 Memory。

- AC-12: Pi role mapping 与 canonical Memory 边界明确。
  - Positive Tests (expected to PASS):
    - Pi Memory facet 只接受 capability 声明的 AFL roles，并把 canonical `user/assistant` 映射为 Pi AgentMessage。
    - 同一 canonical Memory 经 Pi 与 mock executor 保存后得到相同的 version 1 Memory payload，不出现 executor-specific section。
    - Agent 输出返回的 Frag 不携带 assistant role，只有写入 Memory 的 Message 携带 canonical role。
    - 切换 Pi model 前由目标 Memory facet 校验 role 可导入性，并创建新 session。
    - `Message` 与 role schema 定义位于 core Memory module，不依赖 adapter 或 Pi 类型。
  - Negative Tests (expected to FAIL):
    - Pi 的 `toolResult`、custom、compaction 或 session tree entry 被压成普通 AFL role 后写入 v1 Memory。
    - Backend 通过 native session entry 或额外 messages 绕过 VM 修改 canonical Memory。
    - Executor、provider 或 model metadata 出现在 version 1 AFL Memory 文件的任何位置。
    - VM 尝试从 version 1 Memory 文件恢复 Pi session、checkpoint 或其他 native state。

## Path Boundaries

### Upper Bound (Maximum Scope)

本计划允许修改：

- `src/ir.ts`、`src/parser.ts`、`src/validation.ts`、`src/dependencies.ts`：修改 Agent operand、Workspace expression 引用和验证，不新增 Workspace/Memory persistence 指令；
- `src/vm-values.ts`、`src/evaluator.ts`、`src/vm.ts`：解析 Workspace set、创建主目录、Workspace locks、Memory slot 和 persistence lifecycle；
- `src/concurrency.ts`：增加按规范路径祖先关系判定冲突的 Workspace lock manager；
- `src/memory.ts`：允许新增 canonical `Message`、role schema、run state 和 persistence 公共类型；
- `src/adapters.ts`、`src/agent-executor.ts`：Workspace descriptor、executor request/result 和 `AgentMemoryContract`；
- `src/pi-agent-executor.ts`：根据每个 Agent 的 Workspace request 创建执行环境；
- `src/memory-store.ts`：允许新增统一 run state 的默认文件实现；
- `src/index.ts`：导出新增 runtime/binding 公共类型；
- `bin/afl.mjs`、`bin/vm-command.mjs`：传递 execution root，并保持 `--run-id` 可重用；
- `.gitignore`：忽略默认 `.afl/` 运行状态；
- 相关测试、`docs/spec/*`、`docs/guides/*`、examples 和 proposals。

### Lower Bound (Minimum Scope)

首个可交付版本至少完成：

- Agent 第二个 Workspace operand、空 Workspace placeholder、列表约定和第三个 Memory operand；
- execution root 路径解析、primary 创建和 read-only 验证；
- TypeScript/node 参数到 Agent Workspace 的依赖与运行时传递；
- executor/Pi Workspace context factory 和基于规范路径祖先关系的 read/write locks；
- VM 内部 Memory slot、统一 run state load/save 和同 runId 恢复；
- Canonical role schema、model/executor-independent Memory payload、executor Memory facet 运行时兼容性检查；
- canonical module digest、稳定 activation lineage、进程内 active-run guard 和 persistence failure contract；
- 默认 `<executionRoot>/.afl/memory` 与 binding override；
- versioned JSON、atomic write、保存队列、错误诊断、文档和回归测试。

缺少任一项时，不应把功能标记为完成。

### Allowed Choices

- Can use: 现有 ValueExpr、TypeScript ScriptAdapter、ResourceLocks 和 Node.js 标准库；
- Can use: 单 run versioned JSON、同目录 temporary file + atomic rename、测试用 in-memory store；
- Can change: 实验性 Agent/Pi API，不保留旧的第二 operand Memory 语法或 Pi 固定 `cwd` API；
- Cannot add: Workspace symbol/binding、Workspace instruction/handle、named clause 或通用 Agent options record；
- Cannot add: `memory.save/load`、persistence option 指令、flow-visible slot 或宿主缓存路径；
- Cannot change: batch dispatch 的参数或 index 语义；
- Can switch: host 通过显式 binding 把纯 canonical Memory 交给兼容的 executor/model Memory facet，并创建全新 backend session；
- Cannot turn into: 通用 named arguments、资源生命周期管理或文件系统编程接口；
- Cannot claim: read-only Workspace 是 sandbox 权限边界；
- Cannot persist: backend session/checkpoint、Workspace state 或完整 VM snapshot；
- Cannot add: Workspace clone、跨进程 locks、Memory GC、native session/snapshot persistence 或远端数据库实现。

## Dependencies and Sequence

### Milestones

1. Milestone 1: 固化 Agent operand 与 persistence contract
   - 为 string/list/empty Workspace、第三个 Memory operand、非法 shape 和旧语法编写失败测试。
   - 定义 `AgentWorkspaceSet`、core `Message`/role schema、`MemoryStateStore`、executor Memory facet 和 version 1 envelope。
   - 定义 `VmRunOptions.executionRoot`、canonical module digest、activation lineage/slot 和同 runId active-run guard 规则。

2. Milestone 2: 实现 Workspace operand
   - 扩展 Agent parser/IR/validator，不引入新的 resource instruction 或 ValueKind。
   - 求值 string/list Workspace，解析路径并创建缺失 primary。
   - 更新 dependency builder，使 Agent 等待 TypeScript 或 node 参数 producer。
   - 为 `agent.do` 增加基于路径祖先关系的 primary/write 和 read-only/read locks。

3. Milestone 3: 接通 Pi Workspace
   - 移除 Pi Agent binding 的全局固定 `cwd` 假设。
   - 通过 execution context factory 按 Agent Workspace 创建 `NodeExecutionEnv`、tools、tool context、harness 和 session。
   - 把 Workspace origin、规范 roots/access modes 和 binding identity 纳入 session/checkpoint compatibility key。
   - 验证 dispatch.list、fork、memory.apply 和 stateless adapter 行为。

4. Milestone 4: 实现 VM 内部 Memory persistence
   - 为 node/call/dispatch/fork/loop activation 建立确定性 lineage 和 Memory slots。
   - 实现统一 run state load、active-run guard、mutation save、failed-state persistence queue 和 atomic file store。
   - 只保存 canonical Memory，并在每次 Agent 执行前校验 role schema 和 import roles。
   - 接入 implicit/bound Memory、append、copy、apply、fork 和 VM-owned assistant Message 更新。
   - 验证同 runId 恢复/继续追加、并发完成顺序、slot collision、损坏文件和各提交阶段的 store failure。

5. Milestone 5: 文档和端到端验证
   - CLI 传递 execution root，binding 示例只覆盖 Memory directory，不配置 Workspace path。
   - 更新 syntax、IR、Memory、semantics、executor proposal、Pi role/session 边界和并发示例。
   - 将 `.afl/` 加入 `.gitignore`，测试使用临时 execution root 或 in-memory store。
   - 运行 build、全量测试、package smoke 和 Pi mock smoke，检查 Memory 未写入编号 Workspace。

实现顺序为：Agent operand/持久化契约 -> Workspace VM -> Pi -> Memory persistence -> 文档和全量验证。Workspace request 需要先稳定，Pi 才能按 Agent 创建正确环境；activation lineage 需要先稳定，Memory store 才能可靠恢复。

## Implementation Notes

- AFL 只描述 Agent 的工作区域关系，不描述目录删除、挂载、权限或 worktree 生命周期。
- Workspace 使用一个位置 operand 和一种 string/list 约定，不再引入 symbol resolver、专用 clause 或通用 config record。
- 第二个 operand 的含义固定。显式 Memory 必须移到第三个 operand，避免 parser/VM 按运行时类型猜测语义。
- 空第二 operand 只表示默认 execution root，必须与第三个 Memory operand 一起出现；Parser 不能过滤 top-level empty item。
- Workspace list 的第一项表示 primary，后续至少一项表示 read-only；只有 primary 时直接使用字符串形式。保持顺序有助于将公共文档、代码区稳定地呈现给 executor。
- 默认共享 execution root 会保守串行化潜在写 Agent；需要并发文件修改时，TypeScript 或外部 AFL generator 为 child 生成不同的编号路径。
- VM 可以创建 primary 目录，但不创建 read-only 公共目录；公共文档和代码区应由 host 预先准备。
- Workspace dependency 和 session compatibility key 使用规范绝对路径与 access mode，不能使用未解析字符串。
- `fork` 共享 Workspace set 但复制 Memory；这不意味着复制 worktree。
- Memory slot 是 VM bookkeeping，不加入 `VmValue`、Frag 或 AFL 指令表。
- AFL Memory 文件只写 canonical role。Provider/model role label 的差异由 executor 私有转换处理，不在文件加载阶段启发式改名。
- Version 1 Memory 不记录 executor 或 model；可移植性由目标 executor Memory facet 对 `roleSchema` 和全部 roles 的支持决定。
- 纯 Memory 切换 executor/model 时总是创建新 session；本计划不实现 native session 或 snapshot 恢复。
- Activation lineage 在并发任务启动前由结构位置和 task index 分配，不能使用 Promise 完成顺序或全局 handle counter。
- 整个 run state 写入由一个 persistence queue 串行化；每次保存使用包含未 claim slots 在内的最新完整 state image。
- Agent input 在调用 backend 前写入 Memory 并持久化；backend 失败时保留已经提交的输入，但当前 native session continuation 作废，整个 run 失败且不自动重试。
- 默认 FileMemoryStore 在第一次 mutation 前不创建目录。Run id 必须编码为安全文件名，不能产生 path traversal。
- 同一进程内禁止相同 store namespace/runId 的两个顶层 run 同时活跃；同一 run 内的并发 Agent 共享一条 queue。跨进程同 runId 并发执行首版不保证正确，atomic rename 只保证单个文件不会半写。
- `proposals/agent-executor-backend.md` 中 Workspace 暂不进入 IR 的旧描述需要更新为：Workspace 是 Agent declaration operand，provider/model 仍由 binding 决定，Memory persistence 仍由 VM 管理。
