# Freedom 内建工具与动态工作流设计

## 1. 状态与目标

本文记录 AFL Freedom v0 的设计与实现契约。Parser、validator、VM 和 Pi Agent executor 已按本文的核心路径实现；末尾测试清单仍用于后续扩充覆盖面。

Freedom 的目标是允许 Agent 在 AFL 明确描述的边界内自行推进 workflow。它是必要的动态控制指令，不是特殊 Agent 类型、Agent binding 的永久能力，也不等于让模型任意调用宿主工具。VM 会按 Freedom 指令种类，在单次 activation 内临时向 writer Agent 暴露一组标准化的 AFL 控制工具：

- `freedom.route` 允许查询当前 AFL 环境，并调用已有 Node；
- `freedom.flow` 额外允许校验和执行 Agent 编写的 AFL IR；
- 普通 `agent.do` 默认不获得这些工具；
- 工具调用仍受当前 run 的候选范围、参数范围、policy、预算、并发和取消约束。

这里的 writer Agent 是执行当前 Freedom 指令、决定 Node 调用或编写 IR 的普通 Agent。Freedom 控制工具是 AFL VM control plane，不是 `@mcp.*` capability、Pi coding tool 或外部 Move binding。Freedom activation 结束后，工具和参数引用立即失效；同一 Agent 随后的普通 `agent.do` 不保留这些权限。

## 2. 设计边界

### 2.1 Freedom 是必要的 activation 边界

以下要求必须同时满足：

- 普通 `agent.do` 不具有 AFL 工作流控制权限；
- Node、Agent 和受控参数范围显式写在当前 AFL 中；
- 权限只在一次 Agent activation 内有效，不能永久写入 Agent handle；
- parser、validator 和 analyzer 能识别、校验并分析潜在动态依赖。

因此 AFL 需要 `freedom.route` 和 `freedom.flow` 这样的专用 IR 指令。把范围放入 binding 会造成跨文件管理，并让 binding 与具体 AFL module 强绑定；把权限永久附着到 Agent 会使后续普通 `do` 意外保留控制能力；先配置再执行则会引入可泄漏的中间状态和额外生命周期规则。

Freedom 指令是一个原子的 Agent activation：指令显式给出 writer、prompt、constraint、候选符号和受控参数；VM 在 activation 开始时构造临时工具环境，在结束时完整撤销。指令自身不替 Agent 选择 Node 或编写 IR，实际决策由 writer 在 Agent loop 中通过标准控制工具完成。

### 2.2 Freedom 工具不进入 AFL 文本语法

内建工具只存在于 Freedom Agent 的执行上下文中。AFL source 继续使用 `freedom.route` 和 `freedom.flow` 指令，不增加下面这种普通 flow 写法：

```text
invoke @afl.ir.execute, ...
```

这样可以保证普通 flow 不能绕过 Freedom 边界使用控制工具，也避免把 VM 内部对象包装成外部 capability。

### 2.3 工具协议与 Agent executor 无关

`afl.*` 工具的名称、输入、输出和错误语义由 AFL 标准化。Pi backend 可以把它们映射成 `AgentHarnessTool`，Codex、Claude Code 或其他 executor 可以映射到自己的 function/tool 协议，但不能改变工具语义。

工具只是 Agent 与 VM 交互的传输协议：

- Node 仍由 AFL VM 执行；
- IR 仍由 AFL parser、validator 和 VM 处理；
- executor 不自行解释 Node、绑定参数或运行 AFL；
- backend 不支持动态控制工具时必须报告 capability error，不能退化为自然语言猜测。

### 2.4 Binding 不定义 flow scope

Agent binding 只负责模型、provider、thinking、普通 harness 工具、原生 session 和其他 executor 配置。Binding 不列出当前 Freedom 可调用的 Node，不捕获 AFL 局部参数，也不决定 generated IR 可引用哪些 Agent。

Freedom 的有效范围来自三部分的交集：

```text
Freedom 指令显式范围
  ∩ writer origin 的符号可见性
  ∩ VM policy 和当前 run 预算
```

Binding 可以提供 Agent 的公开描述和 executor capability，但不能扩大指令范围。存在 default Agent binding 也不表示 Freedom 可以枚举或创建任意 Agent。

### 2.5 保留 namespace

标准控制工具使用保留的 `afl.*` namespace。Agent binding 不允许注册同名普通工具，也不能覆盖其 description 或 schema。

初始工具集为：

```text
afl.environment.get
afl.ir.validate
afl.ir.execute
afl.node.execute
```

## 3. 工具暴露矩阵

| 执行入口 | `environment.get` | `node.execute` | `ir.validate` | `ir.execute` |
| --- | --- | --- | --- | --- |
| 普通 `agent.do` | 否 | 否 | 否 | 否 |
| `freedom.route` | 是 | 是 | 否 | 否 |
| `freedom.flow` | 是 | 是 | 是 | 是 |

工具列表由 VM 在每次 Freedom activation 开始时生成，并带有本次 activation 的作用域。即使同一个 Agent session 先后执行 Route 和 Flow，也不能沿用上一次 activation 的工具集合、候选 Node 或参数引用。

## 4. `afl.environment.get`

### 4.1 目标

`afl.environment.get` 返回 writer 当前可见的 AFL 环境，使 Agent 不必依靠 prompt 猜测可用 Agent、Node、参数和控制能力。

建议请求形状为：

```ts
interface AflEnvironmentGetInput {
  readonly include?: readonly (
    | "agents"
    | "nodes"
    | "parameters"
    | "constraints"
    | "tools"
  )[];
}
```

省略 `include` 时返回当前 Freedom 所需的完整环境，但不得返回 API key、原生 session id、绝对秘密路径或 binding 私有配置。

`environment.get` 只描述本次 activation 的可见对象和约束，不返回 AFL 语法。v0 的真实测试把必要的最小语法直接写在 Freedom user prompt 中；后续将 AFL 打包为 skill，为 Agent 提供完整语言知识。无论知识从 prompt 还是 skill 获得，都不能替代 VM 的 parse、validate 和 authorize。

### 4.2 Node 信息

每个可见 Node 至少包含：

```ts
interface AflVisibleNode {
  readonly name: string;
  readonly parameters: readonly {
    readonly name: string;
    readonly description?: string;
  }[];
  readonly description?: string;
  readonly returns?: string;
  readonly callable: boolean;
}
```

`freedom.route` 和 `freedom.flow` 都只返回各自指令显式候选列表中的 Node，并进一步与 writer origin 可见性和 policy 求交集。Node body 不进入环境结果，binding 也不能追加候选 Node。

### 4.3 Agent 信息

`freedom.flow` 显式传入 generated IR 可以引用的 Agent symbol；`freedom.route` 默认不暴露 Agent catalog。`afl.environment.get` 只能返回本次指令列出的 Agent，并可通过只读描述接口补充：

- 明确注册的 Agent symbol；
- Agent description 和公开 capability；
- 可公开的模型选择范围；
- Workspace、structured output、tool loop 等 executor capability。

Agent description 和 executor capability 由 binding 提供，但它们只是已授权 symbol 的说明信息。未显式传入的 Agent 即使能被 default binding 解析，也不能出现在环境中或被 generated IR 使用。Binding description 不能包含 provider secret 或宿主闭包状态。

### 4.4 显式参数

Freedom instruction 传入的显式参数使用稳定名称暴露；首版采用具名 record，不使用难以阅读和维护的 ordinal 列表。环境结果为每项参数分配 activation-scoped reference，例如：

```json
{
  "name": "task",
  "ref": "param:task",
  "kind": "frag",
  "preview": "Implement and review ..."
}
```

`ref` 只能交回本次 activation 的 AFL 工具。它不是可进入普通 AFL value、Memory 或外部 flow 的全局 handle。

## 5. Node 文档接口

候选 Node 需要向 Agent 提供稳定的职责和参数说明。建议在 Node header 后使用机器可读的文档注释：

```afl
hubu(task, model):
    # @description 处理数据、资源、核算、报表和成本分析
    # @param task 部门任务和共享上下文
    # @param model 执行任务时使用的模型名称
    # @returns 部门执行报告
    entry:
        ...
```

普通 `#` 注释仍只服务于源码阅读。`@description`、`@param` 和 `@returns` 由 parser 保存到 Node IR：

```ts
interface NodeDocumentation {
  readonly description?: string;
  readonly parameters: Readonly<Record<string, string>>;
  readonly returns?: string;
}
```

Node 签名仍是参数名称和数量的语义来源。未知的 `@param` 名称产生 diagnostic；缺少文档在 v0 不阻止执行。Documentation 进入 module digest，因为修改公开职责会改变 Freedom Agent 看到的环境。

## 6. `afl.node.execute`

### 6.1 语义

`afl.node.execute` 调用一个当前 Freedom activation 允许的既有 Node。Agent不能通过该工具提交、拼接或修改 IR，也不能把 Node 名称替换成外部 capability 或 flow symbol。

建议请求形状为：

```ts
interface AflNodeExecuteInput {
  readonly node: string;
  readonly args: readonly AflControlArgument[];
}

type AflControlArgument =
  | { readonly ref: string }
  | { readonly string: string };
```

`ref` 只能引用：

- 当前 Freedom instruction 的显式参数；
- 当前 activation 中先前 AFL 控制工具产生、仍然有效的结果引用。

`string` 允许 Agent产生任意字符串，例如任务说明、角色名称或模型名称。AFL 不把字符串自动转换为 Symbol、Agent 或其他 handle。Node 若接受模型名称，必须在自己的接口或 binding 中显式解析该字符串。

首版不允许 Agent构造 number、boolean、list、record、Frag、Symbol 或 VM handle。后续若真实 workflow 需要其他安全字面量，应逐项增加。

### 6.2 校验和执行

VM 在调用前检查：

- Node 位于当前工具的 allowlist；
- 参数数量与 Node 签名一致；
- 每个 ref 属于当前 activation 且未失效；
- 当前 activation 的路由数量没有超出 constraint，运行资源没有超出 VM policy；
- policy 批准该调用。

调用使用 writer origin 的本地 Node resolution 和当前 run context。Node 结果返回给 Agent，同时由 VM分配 result ref，使非字符串结果可以受控地传给后续 Node 调用。

同一个 assistant tool-use turn 中出现多个互不引用的 `afl.node.execute` 调用时，AFL executor contract 应允许 VM按 executor capability 与全局调度策略并行执行，并按 tool call id 返回结果。并行度不是 flow constraint；跨 turn 的调用天然可以根据前一轮结果继续路由。

因此 `freedom.route` 可以同时覆盖：

- 一次选择多个部门并行执行；
- 查看部门结果后再调用补充 Node；
- 根据任务复杂度向 Node 传入不同模型字符串；
- 在约束耗尽或 Agent给出最终回答时结束。

## 7. `afl.ir.validate`

### 7.1 语义

`afl.ir.validate` 对 Agent提供的一段 AFL source 执行无副作用校验。它不运行 instruction、不创建 Agent、Memory 或 Workspace，也不调用任何 binding。

建议输入为：

```ts
interface AflIrValidateInput {
  readonly source: string;
  readonly entry: string;
  readonly args?: readonly AflControlArgument[];
}
```

校验必须使用与 `afl.ir.execute` 相同的 writer origin 和 symbol visibility，包括：

- 文本 parser；
- module validator；
- entry 是否存在及参数数量；
- 对 writer origin Node 的引用能否解析；
- Node 引用是否属于 Freedom 指令显式候选列表；
- Agent symbol 是否属于 Freedom 指令显式 Agent 列表；
- 其他外部 symbol 在首版是否被拒绝；未来增加显式 symbol scope 后，是否同时属于该 scope 并被 policy 允许；
- generated source 大小、Node 数量、静态 dispatch 数量和禁止 opcode；
- Freedom activation 的预算与 capability 限制。

返回值至少包含：

```ts
interface AflIrValidationResult {
  readonly valid: boolean;
  readonly digest?: string;
  readonly diagnostics: readonly {
    readonly code: string;
    readonly message: string;
    readonly line?: number;
    readonly column?: number;
  }[];
}
```

`valid: true` 只表示该 source 在当前环境中可执行，不代表已经授权执行。Validation result 不成为永久 capability，环境或 policy 变化后不能继续使用。

## 8. `afl.ir.execute`

### 8.1 核心定义

`afl.ir.execute` 的严格语义是：

> 将给定 IR 作为临时 child activation，等效插入到 writer Agent 的 origin environment 中并执行。

这里的“等效插入”描述 name resolution、binding、Workspace 根和运行上下文的复用，不表示修改源文件、持久化 patch 原 module，或真的把文本插进某个 basic block。

### 8.2 Writer origin

VM 在创建 Agent handle 时记录不可由 AFL 读取的 `WriterOrigin`：

```ts
interface WriterOrigin {
  readonly module: AflModule;
  readonly moduleDigest: string;
  readonly activationPath: string;
  readonly node: string;
  readonly block: string;
  readonly instruction: number;
}
```

通过 `fork` 或 `memory.apply` 创建的新 Agent 使用派生 Agent 实际创建位置作为自己的 origin，不沿用 source Agent 的 origin。Agent handle 被传入其他本地 Node 后，Freedom IR仍锚定该 Agent 的 origin，而不是当前调用者的位置。

### 8.3 顶层 binding 复用

临时 IR 与 writer 所在 run 复用同一个：

- `VmBindings`，包括 Agent executor、Prompt、Capability、External Flow、Schema 和 Formatter；
- `VmPolicy`、全局并发限制和 max steps budget；
- run id、execution root、Workspace lock manager 和 external semaphore；
- Memory persistence、TraceSink 和取消信号；
- writer origin module 的本地 Node interface 和 imported flow visibility。

因此 writer 在根 AFL 中启动时，临时 IR使用根 AFL 的 binding；writer 在本地 child Node 或 generated child module 中启动时，临时 IR仍使用同一个顶层 binding，但本地 Node resolution 锚定 writer origin module。复用 binding 只表示使用相同实现解析已授权 symbol，不表示 generated IR 自动获得顶层 binding 中的全部 Agent、Capability 或 External Flow。

### 8.4 Module overlay

Agent提交的 source 作为临时 module fragment 解析。执行时构造只读 overlay：

- fragment 内声明的 Node 可以互相调用；
- fragment 可以调用 Freedom 指令显式列出、writer origin 可见且 policy 允许的本地 Node；
- fragment Node 名称不能覆盖 writer origin module 的同名 Node；
- origin module 和 fragment 都不被修改；
- 临时 activation path 是 writer origin activation path 的唯一 child；
- fragment 使用自己的 module digest，以便 Trace 和新建 Memory slot 区分不同生成代码。

“等效插入”不隐式捕获 writer 创建位置的局部变量。IR只能通过 entry 参数引用 Freedom instruction 显式提供的参数和此前工具结果。这样生成代码不会依赖已经退出或不可重放的 frame。

### 8.5 执行协议

建议输入与 validate 保持一致：

```ts
interface AflIrExecuteInput {
  readonly source: string;
  readonly entry: string;
  readonly args?: readonly AflControlArgument[];
  readonly expectedDigest?: string;
}
```

执行前必须重新 parse、validate 和 authorize。`expectedDigest` 存在时要求与当前 canonical digest 一致，用于防止 Agent在 validate 和 execute 之间意外修改 source；它不能跳过重新校验。

执行成功后，Node 返回值作为 tool result 交给 writer Agent，并获得 activation-scoped result ref。失败返回稳定 diagnostic 和 error code，使 Agent可以修改 IR 后重新验证。失败不能吞掉已经发生的 Workspace 或外部副作用；AFL 当前没有事务回滚语义。

## 9. Freedom 指令语义

### 9.1 `freedom.route`

建议表面形式为：

```afl
result = freedom.route planner, prompt, constraint, [node0, node1, node2], {task: task, spec: spec}
```

五个 operand 分别是 planner Agent、业务 prompt、机器约束、Node allowlist 和显式参数环境。

VM把业务 prompt 作为普通 user message 追加到 planner 的既有 Memory，并在这次 activation 中只启用：

```text
afl.environment.get
afl.node.execute
```

Planner 可以查询 Node 文档、调用一个或多个 Node、观察结果后继续调用，最后以普通 assistant final response 结束。成功执行过 Node 时，`freedom.route` 返回该 final response 的 role-free Frag；Node tool call、结果、thinking 和 final response 都进入 planner 的原生 continuation，并按现有 Memory 规则持久化。

Route 不接收、解析或执行 Agent编写的 AFL source。Agent即使在 final response 中输出 AFL，也只会被当作普通文本。

### 9.2 `freedom.flow`

建议表面形式显式传入 writer、prompt、constraint、Node allowlist、Agent allowlist 和参数环境：

```afl
result = freedom.flow writer, prompt, constraint, [node0, node1], [@agent.fast, @agent.strong], {task: task, spec: spec}
```

六个 operand 分别是 writer Agent、业务 prompt、机器约束、Node allowlist、Agent allowlist 和显式参数环境。

Node 和 Agent 列表先经过 writer origin visibility 与 policy 收紧。Binding 只负责解析列表中已经授权的 Agent，不参与扩张列表。若 generated IR 未来需要直接引用 Capability 或 External Flow，也必须通过 AFL 指令新增显式 symbol scope，不能从 binding 自动枚举。

VM向 Flow writer 注入全部四个工具：

```text
afl.environment.get
afl.node.execute
afl.ir.validate
afl.ir.execute
```

Writer 可以先查询环境，直接调用已有 Node，也可以编写 IR、反复校验并执行。规划、工具调用、IR diagnostics 和执行结果都发生在同一 writer Agent session 中。

Flow writer 成功执行过 Node 或 IR 后，其 final response 作为指令结果。IR执行结果已经作为 tool result 回到 writer；是否调用更多 Node、再次执行 IR或总结结果由 writer 在 constraint 内决定。

两种 Freedom activation 都必须区分“模型给出了答案”和“workflow 确实执行过”。VM先按已发起 route 检查 `min_routes`，不足时报告 `FREEDOM_ROUTE_MIN_NOT_REACHED`；通过检查后若没有任何 Node 或 IR 成功完成，则忽略模型对未执行工作的文本声明并返回空 Frag。`environment.get`、`ir.validate` 和失败的执行尝试都不满足成功执行条件。空 Frag 保持了 Freedom 指令稳定的结果类型；空 TaskGroup 会错误引入 `sync` 和 child flow 生命周期，因此不作为兜底值。

## 10. Constraint 与 Policy

Constraint 是 VM 强制执行的结构化 flow 语义，不是自然语言 prompt。v0 只包含：

```text
min_routes              activation 至少发起的路由数
max_routes              activation 至多启动的路由数
```

一次 `afl.node.execute` 算作一次 route。`freedom.flow` 的 generated IR 每次从临时 Node 调用显式候选 Node 也算作一次 route，因此不能通过 IR 绕过约束；临时 IR 内部局部 Node 之间的调用不计数，重复调用同一候选分别计数。VM在启动 route 前检查 `max_routes`，writer 给出 final response 后检查 `min_routes`。

控制工具总调用数、IR 校验/执行次数、generated IR 大小、activation 深度和 timeout 属于 `VmPolicy.freedomLimits`。并行度由 `VmPolicy.maxConcurrency`、dispatch policy 和 executor capability 决定。它们描述 VM 如何执行 flow，不作为 AFL source 中的业务约束。Policy 的 `maxRoutes` 为 source `max_routes` 提供全局上界。

Policy 至少能够分别批准：

- Freedom activation 开始；
- 单次 Node 调用；
- 一段已规范化 IR 的执行；
- 临时 IR引用的 Agent、Capability、External Flow 和 Script；
- 递归 Freedom activation。

`environment.get` 只报告 policy 允许公开的环境，不应该先泄露再在执行阶段拒绝。

## 11. Executor 与 VM Host 接口

### 11.1 Backend capability

Agent executor 增加显式 capability，例如：

```ts
interface AgentExecutorCapabilities {
  readonly dynamicControlTools: boolean;
}
```

Pi 首个实现把 AFL descriptor 映射成 activation-scoped `AgentHarnessTool`。普通 binding 的 `read`、`bash`、`edit`、`write` 等工具仍由 binding 决定，但 Pi 在 Freedom activation 内只激活 AFL 控制工具，结束后再恢复原 active tool 集，避免 writer 在 VM 重入时并发修改自己的 Workspace。Binding 只需要声明 backend 是否支持动态工具注入，不保存 Freedom 的 Node、Agent 或参数范围。

Freedom 不创建第二套 Agent 上下文，也不注入隐藏 system prompt。它继续使用同一个 Agent handle、Memory 和 Pi session，并把指令的业务 prompt 作为普通 user message 追加进去；activation 的差异只有临时 active tools。provider 若不接受 canonical 工具名，executor 可以用兼容别名，并在工具描述中标出 canonical 名称，而不额外修改 Agent prompt。

### 11.2 标准描述和 host callback

VM为每次 Freedom activation构造工具 descriptor，executor只负责向模型呈现并把调用转交 host：

```ts
interface AflControlToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ComputeValue;
}

interface AgentControlToolRequest {
  readonly id: string;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

interface AgentExecutionHost {
  executeControlTool(request: AgentControlToolRequest): Promise<AgentControlToolResult>;
}
```

Executor 不能缓存 descriptor 到下一次普通 `agent.do`。Tool call 和 tool result 仍通过 backend session codec 持久化，恢复后也不能重新执行历史 tool call。

## 12. VM 重入与锁

控制工具会在 writer Agent executor 尚未结束时重新进入 VM。当前 VM 在整个 `agent.do` 期间持有 Agent、Memory、Workspace lock，并占用一个 external semaphore permit；直接在 tool handler 中执行 Node 或 IR会产生两类死锁：

- child Node 使用与 writer 重叠的 Workspace，而 writer 正等待 tool result；
- `maxConcurrency=1` 时 writer 占用唯一 external permit，child Agent 无法开始。

实现必须引入 control-tool suspension boundary：

1. writer Agent 和 Memory 保持独占 ownership，保证 session 与 Memory 不被其他指令并发修改；
2. executor 在等待 VM control tool result 时，不再占用 model/external execution permit；
3. writer Workspace lock 在整个 activation 内保持持有；child Agent 主工作区与 writer 重叠时，在等待 lock 前立即拒绝；
4. 未显式指定 Workspace 的 Agent 获得 `.afl/tmpworkspace/<run-id>/` 下的独立稳定目录；
5. child activation 使用自己的资源锁，不能直接获得 writer Agent/Memory handle；
6. 取消 Freedom 时同时取消正在执行的控制工具和 writer executor；
7. Pi 在 Freedom activation 内不激活普通 coding tool，避免控制工具与 writer 自身文件操作竞争。

这需要 backend 与 host 明确报告“模型正在等待 AFL control tool”，不能通过扩大 semaphore 数量掩盖死锁。

## 13. 三省六部迁移目标

每个部门应成为带文档接口的本地 Node。部门 Node 内部可以创建 Agent、配置 Workspace、调用 capability 或组合其他 flow；这些实现不暴露为外部 Move。

主路由形态为：

```afl
reports = freedom.route shangshu, route_prompt, route_constraint, [hubu, libu, bingbu, xingbu, gongbu, libu_hr], {plan: execution_plan, assignments: assignments}
```

尚书通过 `afl.environment.get` 查看六个部门的职责，通过一个或多个 `afl.node.execute` 调用相关部门。未选择的部门不会启动 Agent。同一 tool-use turn 中的多个部门调用由 VM按全局调度策略并行执行，结果回到尚书后可以继续补充路由或形成最终报告。

## 14. 实施顺序

1. 为 Node 增加 documentation 解析、IR 字段、digest 和 diagnostics；
2. 定义四个 AFL 控制工具的 descriptor、输入、输出、错误码和 reserved namespace；
3. 为 Agent handle 增加 writer origin，并定义 module overlay 和显式参数 reference；
4. 扩展 Agent executor/host，使 Pi支持 activation-scoped AFL控制工具；
5. 实现 control-tool suspension boundary，解决 Workspace lock 和 external semaphore 重入；
6. 实现 `environment.get` 和由 Freedom 指令构造的 Node/Agent interface view；
7. 实现 `node.execute` 的 allowlist、参数引用、并行 tool call 和 result reference；
8. 实现 scope-aware `ir.validate` 和始终重新校验的 `ir.execute`；
9. 将 `freedom.route` 和 `freedom.flow` 重写为带显式范围的原子 Agent activation，移除旧 Move/generated-plan 执行路径；
10. 迁移三省六部样例并更新 syntax、IR、semantics 和 examples 文档；
11. 使用 mock executor 和 Pi真实模型分别验证控制语义与 Agent可用性。

## 15. 测试要求

至少覆盖：

- 普通 `agent.do` 看不到任何 `afl.*` 工具；
- Route 只看到 environment/node，Flow 看到全部四个工具；
- 同一 Agent 执行 Freedom 后再次进入普通 `agent.do` 时，控制工具和参数引用已经撤销；
- binding 不能覆盖 reserved tool name；
- default Agent binding 不能扩大 Freedom 指令显式 Agent 列表；
- environment 只返回当前 activation 可见的 Agent、Node、参数和工具；
- analyzer 能从 Route/Flow 的显式 allowlist 记录每个候选 Node 的潜在动态依赖边；
- Node documentation 被正确保存并进入 digest；
- `node.execute` 拒绝未知 Node、越界 ref、错误 arity、对象构造和超预算调用；
- `min_routes` 与 `max_routes` 同时覆盖直接 Node 工具调用和 generated IR 对候选 Node 的调用；
- 同一 turn 的多个 Node 调用按 VM 全局调度策略执行，结果按 tool call id 对应；
- `ir.validate` 无副作用，并返回稳定 diagnostics 和 digest；
- `ir.execute` 始终重新校验，digest 不一致时拒绝；
- 临时 IR能调用 writer origin module 的 Node并复用顶层 binding；
- 临时 IR不能覆盖 origin Node，也不能隐式读取 writer frame 局部变量；
- root、local child、generated child 和 forked writer 的 origin resolution 正确；
- `maxConcurrency=1` 和重叠 Workspace 场景不会因控制工具重入死锁；
- Node/IR失败能返回给 writer继续决策，取消会传播到所有 child activation；
- control tool call、result、thinking 和 final response 完整流式持久化；
- 恢复 Memory不会重复执行历史控制工具；
- 三省六部能够一次并行调用多个部门，并根据结果继续路由。

## 16. 后续设计问题

- 是否为 `afl.node.execute` 增加显式 batch 形状，而不只依赖 executor 同 turn 并发；
- Flow 何时增加显式 Capability/External Flow scope；v0 只能通过候选 Node 间接使用；
- 临时 module overlay 的本地 Node resolution 是否需要显式 namespace；
- generated IR 何时允许递归 Freedom；v0 直接拒绝；
- writer Agent被传入其他 Node后，origin 固定在创建位置的规则是否需要表面可视化；
- Node 参数说明何时扩展为可机器检查的 interface schema；
- 是否增加可选的直接返回协议，让调用方取得最后一次 Node/IR结果而不是 writer 总结；v0 的零执行兜底仍固定为空 Frag。

这些问题不改变核心方向：`freedom.route` 和 `freedom.flow` 是必要的、activation-scoped AFL 指令；候选 Node、Agent 和受控参数由当前 AFL 显式给出，binding 不定义 flow scope；Route 使用环境查询和既有 Node调用，Flow在此基础上增加 IR校验与 writer-origin IR执行。
