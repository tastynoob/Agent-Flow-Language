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
- 每个真正进入过 `agent.do` 的 Memory 使用一份可增量追加的 pretty JSON stream，同时保存 canonical Memory 和 executor-owned continuation；后者用于恢复工具调用、thinking、compaction 等原生记录，但不进入 AFL IR；
- `memory.copy` 和 `fork` 只建立惰性 base 引用，不因复制动作本身创建持久化文件；
- 不恢复 instruction pointer、TaskGroup 或正在运行的外部工具进程，因此这仍不是完整 VM snapshot。

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
- 当前进程内的 live checkpoint/session compatibility key 包含 Agent symbol、effective system prompt、model/binding identity 和带 access mode 的规范 Workspace roots；
- 持久化 continuation 由同名 executor 导入，并用目标 Agent 当前 binding 重建 harness。切换 executor 必须显式失败，不能只保留 canonical Message 后静默降级。

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

Memory handle 和 persistence slot 可以在 VM 内提前创建，但默认文件 store 只有在该 Memory 第一次真正进入 `agent.do` 时才物化文件。Agent declaration、`memory.apply`、`memory.copy`、`fork` 和首次使用前的 `memory.append` 都只更新内存状态，不单独触发文件创建；第一次 `agent.do` 会先物化此前积累的 canonical Message 或 base 引用，再写入本次调用。已经物化的 Memory 继续增量保存后续 `memory.append` 和 `agent.do` 消息。

`memory.copy` 和 `fork` 创建惰性 `{source slot, revision}` 引用，不复制源文件内容。副本从未被 Agent 使用，就不会留下文件；副本第一次进入 `agent.do` 时才创建自己的文件 header。若源 Memory 尚未物化，则它作为这次 Agent 上下文的传递依赖一并物化，保证 base 引用可以跨进程解析。

同一 `runId` 中，slot identity 表示同一个长期 Memory。Allocation 时若 slot 已存在，VM 恢复其 Message/revision，并忽略本次 empty/copy/fork initializer；`memory.copy` 和 `fork` 只在 slot 首次出现时从 source 初始化。这是 persistence 对 allocation 的明确语义，不做隐式 merge 或 rebase。Flow 需要新的逻辑副本时必须使用新的 `runId`，或让它出现在不同的结构 activation/slot。

同一 `runId` 再次启动相同 flow 时，VM 在 Memory handle 创建时按 slot 恢复 Message 和 revision。新的 `runId` 创建独立状态。`runId` 是 VM/CLI 参数，不进入 AFL IR。

`program.jsons` header 的 root module digest 必须与当前 root module 的 canonical IR 完全匹配，否则整个 run state 拒绝加载，不做按 slot 猜测的部分迁移。动态 generated flow 使用自己的 module digest 作为 slot segment，并由父 generated-flow call site 定位；生成源码变化时产生新 slot，旧 slot 继续保留。这不是完整 VM resume：执行仍从 entry 开始，不恢复 instruction pointer、条件分支、TaskGroup 或外部工具进程。如果控制路径变化，不再出现的 slot 不会被绑定到其他 Memory。

重复使用同一 `runId` 表示在已有 canonical Memory 上开始一次新的 flow execution。所有 `memory.append` 和 `agent.do` 都按本次执行正常追加，VM 不根据指令位置隐式去重。因此它适合“继续同一段对话”，不是失败指令的透明重放；包含一次性初始化 append 的 flow 应使用新 `runId`，或由 flow 自身决定是否再次追加。

### Role、Executor 与 Pi Session 边界

不同 provider 的原生消息协议确实可能使用不同 role label 和内容结构。AFL 持久化不能直接复制某个 provider 的 request payload，也不能假定一个 executor 的 session 可以交给另一个 executor。

当前接入的 Pi 0.82.1 在 `pi-ai` 层把模型协议归一化为三种 LLM Message：

```text
user
assistant
toolResult
```

Pi Agent Core 的 session 比这更丰富。除了 Message entry，它还保存 model、thinking level、active tools、compaction、branch summary、custom message、label 和当前 leaf 等树形状态；AgentMessage 还可以出现 `bashExecution`、`custom`、`branchSummary`、`compactionSummary` 等扩展 role。AFL 不直接复制 Pi 自带的 session 文件格式，而由 Pi executor codec 将恢复所需信息写入 AFL 的语义化 message records。

其中 `{"type":"session.tools","names":[...]}` 是 Pi `active_tools_change` 的投影，只表示当时激活的工具名称。工具实现、description 和 input schema 仍由 binding 或当前 Freedom activation 在运行时构造，不作为 Memory descriptor 快照重复保存。恢复 continuation 后，这些名称只保留为历史 session 状态；下一次 activation 实际可用的工具定义仍从当前 binding/VM 重建。这与当前不提供完整 VM snapshot 恢复的边界一致。

当前 AFL Pi backend 使用 `InMemorySessionRepo`，由 VM 把完整的 message records 追加到对应 Memory 文件，而不让 Pi 在各 Workspace 下另建 session 文件。AFL 与 Pi 的转换边界分成两层：

- AFL Memory 可以保存任意字符串 role；
- Pi backend Memory facet 的 `importRoles` 目前只有 `user` 和 `assistant`；
- Pi 执行要求最新未同步 Message 是 `user`；
- 导入 assistant 时，adapter 会根据当前 Pi model 补齐 api、provider、model、usage 和 timestamp；
- canonical Memory 只导入 `user`/`assistant` 边界消息；
- tool result、tool call、thinking、compaction 和其他 Pi session 内容由 executor codec 保存在结构化 message 中，不伪装成 AFL canonical role。

因此 v0 文件中的 `message` record 同时服务于人工回溯和 executor continuation 恢复。Canonical `user`/最终 `assistant` 仍投影为 AFL Memory；thinking、tool call、tool result 等内容只属于 executor continuation。Executor adapter 负责把这些结构映射为自己的 native session，VM 不把 `human`、`model`、`toolResult` 等 provider label直接改写成 AFL role，也不保存一份重复的 native session snapshot。

AFL 层的两个数据类型继续保持最小语义：

```text
Frag    = { content: string }
Message = { role: AFL role label, content: string }
Memory  = Message[]
```

`afl.message-role/v0` 保留 `user` 和 `assistant` 作为核心 role；`memory.append` 仍可以写入其他非空 role label，它们是 AFL extension role，不等于某个 provider 的原生 role，也不保证所有 executor 都能导入。平台无关指的是表示和语义不依附某个 backend，不代表每个 backend 都支持所有 extension role。

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

上面只列出 Memory facet。完整 continuation 通过 executor session lifecycle 的增量 message codec 与 `exportSession`/`importSession` 扩展点保存和恢复；record 必须可 JSON 序列化，并由 Memory header 中的 executor/format 标识。VM 只负责顺序追加、复制引用和按 executor 分发，不解析 executor-owned content block。

Pi、其他 Agent platform 或普通 model adapter 分别实现 Memory facet，AFL parser/IR/Memory handle 无需知道它们的 native role。Facet capability 是运行时能力，不写入 AFL Memory payload。

VM 与 executor 的公共边界始终只收发 canonical `Message[]`。在每次 `agent.do` 创建或续接 backend session 前，VM 使用完整 Memory 调用 `validateImport`，executor 再在 `execute` 内部转换 native message。Memory facet 校验失败只阻止该 Agent 执行，不删除已经持久化的 canonical Message，因为同一 Memory 仍可能交给另一个兼容 executor。

Backend 只返回最终 role-free output，VM 是唯一有权把它投影为 canonical assistant Message 的组件。Pi 在形成完整 assistant/tool message 后立即交给 persistence host；文件只写一次结构化消息，不在 `do` 结束时再次导出和复制完整 session。

Pi binding 额外提供 `thinkingReplay: "include" | "exclude"`。默认 `include`，让同一 Pi session 的历史 thinking 继续进入后续模型上下文；`exclude` 只在 provider request 前过滤 assistant 的 `thinking` content block，不删除持久化 entry，也不删除 tool call 上可能用于 provider 连续性的 `thoughtSignature`。因此同一份完整记录可以由不同 Agent binding 选择不同 replay 策略。

恢复规则采用保守策略：

- canonical Memory 总是可以独立加载，不因 executor 缺失而损坏；
- 每次执行 Agent 前，当前 executor 的 Memory facet 必须校验 `roleSchema` 和全部 canonical roles，不只在持久化恢复后校验；
- VM 不因 backend 不可用或校验失败而自动切换 executor；一个 Agent activation 选定 backend 后保持不变；
- 没有 continuation 时，host 可以通过显式 binding 把纯 AFL Memory 交给任一兼容 executor/model，并创建新 session；
- 存在 continuation 时必须由同名 executor 导入；不同 executor 不能静默丢弃原生记录并从 canonical Memory 降级重建；
- Memory facet 不支持某个 role 时显式失败，不能自动改名、删除或压平 Message；
- `memory.copy` 同时冻结 canonical Message 和 continuation 的 source revision，但持久化层只建立 base 引用；`memory.apply` 由目标 Agent 当前 executor 验证 canonical Memory，并由 continuation 所属 executor 使用目标 binding 重建独立 session；
- 跨 executor 迁移不需要改写 AFL Memory 文件，只需要目标 Memory facet 能完整导入其 role schema。

Pi 已经为不同 provider/model 提供统一 Message 层，所以纯 `user/assistant` AFL Memory 通常可以重新导入不同 Pi model，但每次仍由目标 binding 的 Memory facet 做能力校验并创建新 session。

完整 VM snapshot 恢复仍不在本计划范围内：instruction pointer、条件分支、TaskGroup、正在运行的外部工具进程和 Workspace 文件状态都不恢复。这里恢复的是文件中已经完整写入的 Agent conversation；最后一条记录若是尚无结果的 tool call，则作为 pending call 交给 executor 的恢复策略处理。Flow 仍从 entry 重新执行。持久化 continuation 与 executor 格式绑定；升级不兼容的 executor 格式或切换 executor 时显式报错。

### 统一 Memory 存储位置

默认状态位于：

```text
<executionRoot>/.afl/memory/afl-<YYYYMMDD-HHmmss>-<short-id>/program.jsons
<executionRoot>/.afl/memory/afl-<YYYYMMDD-HHmmss>-<short-id>/<memory-label>.jsons
```

`afl` 是固定目录 header，创建日期用于人工定位，`short-id` 只用于避免同一时刻冲突并辅助查找 `runId`，不把 workflow 或任务名称编码进目录。再次使用相同 `runId` 时定位并复用原目录，而不是用当前日期新建目录。

`program.jsons` 只记录 run 级 begin/end 和 module digest；它不是 VM snapshot。每个真正进入过 `agent.do` 的逻辑 Memory 使用一个可读名称的 JSON stream 文件，同名动态实例添加顺序编号，例如 `review-memory-01.jsons`。Agent 主工作区和只读工作区不参与持久化路径计算，因此编号 Workspace 不会各自产生一套分散的 Memory cache。

Binding 可以覆盖统一目录或替换存储实现：

```ts
interface MemoryPersistenceBinding {
  readonly directory?: string;
  readonly store?: MemoryStateStore;
}

interface MemoryStateStore {
  loadRun(runId: string, signal: AbortSignal): Promise<PersistedRunMemoryState | undefined>;
  saveRun(state: PersistedRunMemoryState, signal: AbortSignal, context?: MemorySaveContext): Promise<void>;
}
```

这里有三个彼此独立的扩展点：`MemoryStateStore` 决定统一 run state 保存到文件、内存或其他介质；`AgentMemoryContract` 声明 canonical Memory 的导入能力；executor 的 session codec 负责 continuation message 的序列化和恢复。默认文件 store 可以在内部提供增量追加接口，但不把文件 framing 强加给自定义 snapshot store。

规则如下：

- `memoryPersistence` 未配置时使用 execution root 下的默认目录；
- `directory` 相对路径以 execution root 解析；
- `directory` 与 `store` 二选一，同时配置属于 binding error；
- 自定义 store 仍接收完整逻辑 run state；默认文件 store 使用 pretty JSON stream 增量追加；
- 每条完整 record append 后都 flush/sync，本身就是可恢复状态，不需要额外 commit；
- parse、validate 和构造 VM 时不创建 `.afl`，第一次实际保存时再创建目录。

VM 在 run 开始时为 `(store namespace, runId)` 注册一个活跃的顶层 run context，并在 run 的 `finally` 中注销。默认文件 store 的 namespace 是规范化 Memory 目录；自定义 store 使用 store instance identity。同一进程不能同时启动第二个同 namespace、同 `runId` 的顶层 run，否则两套 run-level persistence queue 会竞争整份 state。这个限制不影响同一 run 内的并发 Agent，它们共享同一个 context 和 queue。跨进程的同 `runId` 并发执行仍不属于首版能力。

实验阶段的文件格式始终使用 `version: 0`，格式尚未稳定前不把方案调整称为版本迭代。文件不是 JSONL，也不是一个需要整体重写的 JSON array，而是一串由空白分隔的顶层 JSON object。每个 object 使用两空格缩进，对象之间留一个空行；`.jsons` 表示 AFL pretty JSON stream。

`program.jsons` 的正常示例为：

```json
{
  "type": "program.begin",
  "version": 0,
  "run_id": "review-42",
  "module": "sha256:canonical-ir-digest",
  "started_at": "2026-08-07T15:42:18+08:00"
}

{
  "type": "program.end",
  "status": "ok",
  "finished_at": "2026-08-07T15:48:31+08:00"
}
```

Memory 文件也是有上下文的顺序流。Schema 使用顶层 `type` 区分 record，不再使用 `{"message":{"assistant":...}}` 或 `{"do":{"begin":...}}` 等无必要嵌套。一次 `agent.do` 由 `do.begin` 打开，后续连续 records 天然属于它，正常结束或可控错误时可以写入 `do.end`：

```json
{
  "type": "memory",
  "version": 0,
  "name": "coder",
  "key": "main/coder",
  "agent": "@agent.coder",
  "executor": "pi"
}

{
  "type": "do.begin",
  "location": "main:draft",
  "started_at": "2026-08-07T15:42:19+08:00"
}

{
  "type": "user",
  "text": [
    "实现 qsort。",
    "只允许修改 qsort.c，并使用 gcc 验证。"
  ]
}

{
  "type": "assistant",
  "content": [
    {
      "type": "thinking",
      "text": [
        "先检查函数签名。",
        "然后实现分区和递归逻辑。"
      ]
    },
    {
      "type": "tool.call",
      "id": "call-1",
      "name": "source_file",
      "arguments": {
        "path": "qsort.c"
      }
    }
  ]
}

{
  "type": "tool.result",
  "id": "call-1",
  "name": "source_file",
  "status": "ok",
  "text": "当前文件内容……"
}

{
  "type": "assistant",
  "text": [
    "qsort 已实现。",
    "gcc 验证通过。"
  ]
}

{
  "type": "do.end",
  "status": "ok",
  "finished_at": "2026-08-07T15:43:06+08:00"
}
```

一次 `do` 表示一次完整的 `agent.do`，内部可以包含任意数量的模型轮次、thinking、tool call 和 tool result。除 Memory header 外，executor、Agent、format 等稳定信息不在后续 records 上重复；时间只记录在 `do.begin` 和可选的 `do.end`。恢复所必需的 tool call id、thinking signature 等信息保留在对应语义结构中，可重新生成的 session id、逐消息时间戳和统计信息不保存。

记忆文本使用统一的 `Text` 表示：单行直接保存字符串，多行按换行拆成字符串数组，读取时用 `\n` 连接。末尾空字符串保留原文结尾换行：

```text
Text = string | string[]
```

纯文本 user/assistant 直接使用顶层 `text: Text`；assistant 同时包含 thinking、text 和 tool call 时使用按原顺序排列的 `content` block 数组。Tool arguments 仍使用普通 JSON value，不为展示目的改写其数据结构。`memory.append` 在 Memory 已物化后使用简洁的独立记录：

```json
{
  "type": "append",
  "role": "user",
  "text": "评审指出需要补充重复元素测试。"
}
```

`memory.copy` 和 `fork` 本身不创建文件。副本第一次被 Agent 使用时，Memory header 保存冻结的 source file/revision 引用，不复制源历史：

```json
{
  "type": "memory",
  "version": 0,
  "name": "review_memory",
  "key": "main/review[1]",
  "agent": "@agent.reviewer",
  "executor": "pi",
  "base": {
    "file": "coder.jsons",
    "revision": 2
  }
}
```

Loader 递归解析 base；循环、缺失文件或不存在的 revision 属于损坏状态。Revision 根据完整 canonical records 推导，不依赖 `do.end`。

`do.end` 只是便于人工回溯的可选 tail metadata，不是 commit marker。JSON stream reader 顺序解析顶层 object，并记录最后一个完整 object 的结束字节位置。恢复遵循以下规则：

- 每个已经完整写入的 memory、append、user、assistant 和 tool record 都独立有效；
- 文件在一个打开的 `do` 中结束，表示进程直接崩溃，该区段状态记为 interrupted；
- 没有 `do.end` 时仍恢复其中所有完整的 user、assistant、thinking、tool call 和 tool result；
- EOF 处不完整的最后一个 object 截断到上一个完整 object 的结束位置，不能简单按换行截断；之前的完整 records 不受影响，文件中部的损坏 JSON 仍然显式报错；
- 最后一条完整记录若是没有 tool result 的 tool call，则作为 pending call 交给 executor 恢复策略，VM 不虚构结果；
- 恢复后追加新的 `do.begin` 会隐式关闭此前未收尾的区段，不需要补写 tail；
- `do.end` 若存在，可以保存 `status: "ok" | "error"`、结束时间，以及浅层的 `error_code`/`error_message`，但不决定消息是否可恢复。

VM 使用 run-level persistence queue 串行化文件写入。每个 record 通过 `JSON.stringify(record, null, 2)` 生成，末尾追加两个换行作为可读分隔，然后在返回前完成 append + sync；parser 依赖 JSON object 边界而不是空行。Queue 第一次失败后进入 terminal failed 状态，拒绝后续 mutation 并使整个 run 失败。

持久化文件不包含：

- 仅当前进程有效的 `BackendSessionRef` 和 runtime handle；
- Memory owner 和运行时 handle id；
- Workspace path 或工作区文件；
- VM instruction pointer、TaskGroup、外部工具进程和完整 VM snapshot。

恢复 Memory 后，owner 重新建立。若 slot 有 continuation，VM 要求对应 executor 导入并创建新的 live session；若没有，则由 canonical Message 创建新 session。当前进程内的 checkpoint/fork 优化保持不变。

Memory durability 与 Agent 外部副作用使用以下写入顺序：

1. Memory 第一次进入 `agent.do` 时创建文件并写入 header；已有 canonical Message 或 base 引用先完成物化。
2. VM 写入 `do.begin` 和 canonical user message，并等待 sync 成功；保存失败时不调用 backend。
3. Backend 每形成一条完整的 assistant/tool message 就立即追加并 sync；thinking、tool call 和 tool result 因此在同一次 `do` 内可恢复。
4. VM 校验最终 output 和 schema，把最终 assistant 投影为 canonical Message；正常结束时可以写 `do.end`，但完成指令不依赖 tail 才能识别此前消息。
5. 可控错误可以写 error tail；进程崩溃时不补写任何内容，恢复以最后一个完整 JSON object 为准。
6. 任何保存失败都使 persistence queue 和整个 run 进入失败状态，不能在 failed queue 后继续追加较新的消息。

模型调用、工具执行和 Workspace 文件修改无法与 Memory 文件形成同一事务。VM 不自动重试失败的 `agent.do`，也不承诺 exactly-once；崩溃时已经执行的工具副作用可能只留下 tool call 而没有 tool result。调用方或 executor 恢复 pending call 前需要接受这种 at-least-once 边界或自行检查 Workspace。

当前版本不提供跨进程同时写同一 `runId`、状态删除、过期、GC 或完整 VM snapshot。已经完成的 compaction message 会进入对应 Memory JSON stream，但 AFL VM 不主动触发或解释 compaction。

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
    - Memory 只有在第一次真正进入 `agent.do` 时才物化文件；未被 Agent 使用的 working/copy/fork Memory 不留下文件。
    - `memory.copy`/`fork` 只建立 source revision 引用，首次使用前不复制或保存历史内容。
    - Memory 物化时保存此前的 `memory.append`，物化后的 append 和 `agent.do` message 自动增量写入。
    - 现有 `memory.append/copy/apply` 不增加 persistence operand。
    - 每次 Agent 执行前，executor Memory facet 校验完整 canonical Memory；executor continuation 与 canonical Message 分层保存。
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
    - 没有 continuation 时，Host 显式选择兼容相同 role schema 的 executor/model，可以从 canonical Memory 创建全新 session。
    - 有 continuation 时，同名 executor 跨进程恢复完整 native transcript，并用目标 Agent 当前 binding 重建 harness。
  - Negative Tests (expected to FAIL):
    - 动态 handle counter或 Agent 完成顺序改变 persistence slot。
    - 不匹配的 module digest/run state 被绑定到当前 flow。
    - 两个不同 live Memory handle claim 同一 slot。
    - VM 把重新执行误认为 instruction resume，或按指令位置静默去重 append/do。
    - 已存在的 copy/fork slot 与本次 source 自动 merge/rebase，或被 source 静默覆盖。
    - Memory facet 不支持某个 canonical role 时仍创建 session，或自动改写、删除 Message。
    - VM 因当前 backend 不可用或校验失败而自动切换 executor。
    - 新 executor 复用或静默丢弃另一个 executor 的 continuation。

- AC-10: Memory 始终保存在 execution root 的统一位置。
  - Positive Tests (expected to PASS):
    - 默认状态文件位于 `<executionRoot>/.afl/memory/afl-<date>-<short-id>/`，包含 `program.jsons` 和实际使用过的 Memory JSON streams。
    - 目录名包含创建日期但不包含具体 workflow/任务名称；相同 runId 恢复原目录。
    - 编号 primary Workspace 不会各自产生 Memory cache。
    - Binding directory override 和自定义 store 能替换默认位置/介质。
  - Negative Tests (expected to FAIL):
    - Memory 被写入 Agent primary 或任一 read-only Workspace。
    - 同时配置 `directory` 和 `store`，或相对 override 不以 execution root 解析。

- AC-11: Run state 的并发、错误和能力边界确定。
  - Positive Tests (expected to PASS):
    - Persistence queue 保存包含所有并发 Memory 更新的最新 state。
    - 实验格式始终使用 `version: 0`，不因尚未稳定的设计调整递增版本。
    - 每个 Memory 文件按浅层 `type` records、`do.begin`、连续 messages 和可选 `do.end` 组织，不重复 transaction id、时间戳、executor 或 cursor。
    - Pi thinking/tool call/tool result 在形成完整 message 后立即追加并成为可恢复状态，不等待 `do.end`。
    - 没有 tail 的打开 do 被识别为进程崩溃，最后一个完整 JSON object 之前的消息全部恢复；截断的 EOF object 被丢弃。
    - `memory.copy`/`fork` 使用 base file/revision 引用，目标文件不重复源 Message 或 session tree。
    - 单行记忆文本保存为 string，多行保存为 string array，并能无损保留末尾换行。
    - 同一 store namespace/runId 的第二个活跃顶层 run 被拒绝；同一 run 内的并发 Agent 正常共享 persistence queue。
    - Agent input 保存成功后才调用 backend，每条完整 executor message append + sync 后立即可恢复。
    - 文档明确重新运行从 entry 开始，不是完整 VM resume。
    - build、unit tests、VM acceptance tests、package smoke 和 Pi mock smoke 全部通过。
  - Negative Tests (expected to FAIL):
    - 较旧 state 覆盖较新 revision，或保存失败后 instruction 仍成功。
    - 保存队列失败后继续写入较新的 message，或自动重试 Agent。
    - Live session ref、Workspace、TaskGroup、instruction pointer 或损坏数据被当作可恢复 continuation。

- AC-12: Pi role mapping 与 canonical Memory 边界明确。
  - Positive Tests (expected to PASS):
    - Pi Memory facet 只接受 capability 声明的 AFL roles，并把 canonical `user/assistant` 映射为 Pi AgentMessage。
    - Pi 的 tool call、tool result、thinking、compaction 和 leaf 保存在 continuation，不污染 canonical Message。
    - Pi binding 可以选择是否 replay 历史 thinking，过滤不会修改持久化 transcript，也不会删除当前工具循环的 thinking。
    - Agent 输出返回的 Frag 不携带 assistant role，只有写入 Memory 的 Message 携带 canonical role。
    - 切换 Pi model 或 Agent binding 时由目标 Memory facet 校验 role，并由 Pi continuation 创建新 session。
    - `Message` 与 role schema 定义位于 core Memory module，不依赖 adapter 或 Pi 类型。
  - Negative Tests (expected to FAIL):
    - Pi 的 `toolResult`、custom、compaction 或 session tree entry 被压成普通 AFL role 后写入 canonical Message。
    - Backend 通过 native session entry 或额外 messages 绕过 VM 修改 canonical Memory。
    - VM 解析或改写 executor payload 内的 provider/model/native role。
    - `thinkingReplay: "exclude"` 删除持久化 thinking，或过滤同一工具循环刚产生的 thinking。

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
- `version: 0` 的 pretty program/Memory JSON streams、保存队列、错误诊断、文档和回归测试。

缺少任一项时，不应把功能标记为完成。

### Allowed Choices

- Can use: 现有 ValueExpr、TypeScript ScriptAdapter、ResourceLocks 和 Node.js 标准库；
- Can use: 带日期的 run 目录、`program.jsons`、per-Memory append-only pretty JSON stream、可选 do tail、测试用 in-memory store；
- Can change: 实验性 Agent/Pi API，不保留旧的第二 operand Memory 语法或 Pi 固定 `cwd` API；
- Cannot add: Workspace symbol/binding、Workspace instruction/handle、named clause 或通用 Agent options record；
- Cannot add: `memory.save/load`、persistence option 指令、flow-visible slot 或宿主缓存路径；
- Cannot change: batch dispatch 的参数或 index 语义；
- Can switch: 没有 continuation 时，host 通过显式 binding 把纯 canonical Memory 交给兼容的 executor/model Memory facet，并创建全新 backend session；
- Cannot turn into: 通用 named arguments、资源生命周期管理或文件系统编程接口；
- Cannot claim: read-only Workspace 是 sandbox 权限边界；
- Can persist: 已完整写入的 backend conversation records，作为统一 run state 中 flow 不可见的 executor continuation；
- Cannot persist: live session ref、Workspace state、instruction pointer、正在运行的外部工具进程或完整 VM snapshot；
- Cannot add: Workspace clone、跨进程 locks、Memory GC、完整 VM snapshot 或远端数据库实现。

## Dependencies and Sequence

### Milestones

1. Milestone 1: 固化 Agent operand 与 persistence contract
   - 为 string/list/empty Workspace、第三个 Memory operand、非法 shape 和旧语法编写失败测试。
   - 定义 `AgentWorkspaceSet`、core `Message`/role schema、`MemoryStateStore`、executor Memory facet 和 v0 envelope。
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
   - 实现统一 run state load、active-run guard、mutation save、failed-state persistence queue 和 durable file store。
   - 保存 canonical Memory，并在每次 Agent 执行前校验 role schema 和 import roles。
   - 接入 implicit/bound Memory、append、copy、apply、fork 和 VM-owned assistant Message 更新。
   - 验证同 runId 恢复/继续追加、并发完成顺序、slot collision、损坏文件和各提交阶段的 store failure。

5. Milestone 5: 文档和端到端验证
   - CLI 传递 execution root，binding 示例只覆盖 Memory directory，不配置 Workspace path。
   - 更新 syntax、IR、Memory、semantics、executor proposal、Pi role/session 边界和并发示例。
   - 将 `.afl/` 加入 `.gitignore`，测试使用临时 execution root 或 in-memory store。
   - 运行 build、全量测试、package smoke 和 Pi mock smoke，检查 Memory 未写入编号 Workspace。

6. Milestone 6: 完整 executor continuation
   - 为 executor 增加 JSON-safe session export/import，并在 slot 中保存 backend、format、payload 和同步 revision。
   - Pi 导出和恢复完整 session tree，包括 tool call、tool result、thinking、compaction 和 leaf。
   - `memory.copy`/`memory.apply` 复制并重建 continuation；跨 executor 使用显式失败。
   - Pi binding 提供历史 thinking replay 策略，并验证过滤不修改持久化 transcript。

7. Milestone 7: per-Memory pretty JSON stream
   - 默认文件 store 改为带日期的 run 目录、`program.jsons` 和每个已使用 Memory 一份 `.jsons`，保持自定义 snapshot store 可用。
   - executor host 接收完整的结构化 message；Pi 在 message 形成后立即同步写入 thinking/tool call/tool result。
   - 使用 Memory header、`do.begin`、连续 messages 和可选 `do.end` 形成可读上下文；每条完整 record 独立可恢复。
   - EOF 截断 object 被丢弃；没有 tail 的调用标记为 interrupted，但其完整 messages 继续恢复。
   - copy/fork 在第一次被 Agent 使用时物化，并用 source file/revision base 消除完整前缀复制。

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
- AFL canonical Message 只写 canonical role。Provider/model role label 的差异留在 executor continuation 内，不在文件加载阶段启发式改名。
- v0 Memory 文件中的 canonical Message 保持可移植；continuation 通过 header 中的 executor/format 明确绑定 backend，VM 不解析 executor-owned content block。
- 没有 continuation 的纯 Memory 可以切换兼容 executor；存在 continuation 时只能由同名 executor 导入。二者都不等于完整 VM snapshot 恢复。
- Activation lineage 在并发任务启动前由结构位置和 task index 分配，不能使用 Promise 完成顺序或全局 handle counter。
- 同一 run 的 program 与各 Memory JSON stream 写入由一个 persistence queue 串行化；不同 Memory 不再反复重写完整 state image。
- Agent input 在调用 backend 前写入 Memory 并持久化；backend 失败或进程崩溃时保留全部完整 messages，恢复不依赖 `do.end`。
- 默认 FileMemoryStore 在第一个 Memory 真正进入 `agent.do` 前不创建 Memory 文件。Run id 和 Memory label 必须编码为安全文件名，不能产生 path traversal；目录名只使用固定 header、日期和短标识。
- 同一进程内禁止相同 store namespace/runId 的两个顶层 run 同时活跃；同一 run 内的并发 Agent 共享一条 queue。跨进程同 runId 并发执行当前不保证正确。
- `proposals/agent-executor-backend.md` 中 Workspace 暂不进入 IR 的旧描述需要更新为：Workspace 是 Agent declaration operand，provider/model 仍由 binding 决定，Memory persistence 仍由 VM 管理。
