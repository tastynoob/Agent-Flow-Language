---
name: author-afl-workflows
description: Create, generate from TypeScript, review, debug, and port AFL v0 workflows and their runtime bindings. Use when an agent needs to author Agent Flow Language IR, use the TypeScript AFL IR builder, choose or explain AFL instructions, reason about Agent, Memory, TaskGroup, workspace, concurrency, or Freedom semantics, implement portable host adapters or agent executors, validate binding contracts, or diagnose parser, validator, policy, persistence, and runtime failures across operating systems and model providers.
---

# Author AFL Workflows

使用本 Skill 编写、审查、调试或移植 AFL v0 工作流及其宿主绑定。把 AFL 语义与具体操作系统、模型供应商、Agent SDK 和进程启动方式分开：先写可移植的工作流，再由 binding 显式提供环境能力。

## 工作方法

1. 先确认目标、输入、输出、可用 symbol、binding 能力和安全边界。
2. 用普通 node、显式数据依赖和结构化控制流表达确定性部分。
3. 使用 TypeScript generator 时，通过 `AflIrBuilder` 的线性 `node/when/while/end` API 直接生成 AFL；不要在 generator 中建立 HIR。完整用法见 [TypeScript IR Generator](guides/typescript-generator.md)。
4. 只把确实需要模型判断的步骤交给 Agent；只在运行时确实需要动态决策时使用 Freedom。
5. 明确 Agent、Memory 和 TaskGroup 的所有权与生命周期，避免隐式共享状态。
6. 把外部系统访问放入 prompt、flow、capability、script 或 Agent executor binding，不假定宿主已经提供任何能力。
7. 先 parse 和 validate，再使用最小 mock bindings 做确定性测试，最后连接真实模型和外部系统。
8. 审查失败路径、取消传播、并发上限、workspace 隔离、schema 校验、持久化和 trace，再交付工作流。

## 保持跨平台

- 使用 AFL 文本语义和 binding 契约描述行为，不依赖某个 Agent 产品、模型 API 或 SDK。
- 在 AFL 中优先使用相对 workspace 路径；让宿主相对 `executionRoot` 解析并规范化路径。不要嵌入用户目录、盘符、shell 专用路径或临时目录位置。
- 把 workspace 描述符视为上下文和锁信息，不把它当作安全沙箱。只有声明 `sandboxEnforcement` 且实际执行隔离的 executor 才能提供沙箱保证。
- 优先用 `invoke` 或 external flow 表达可移植的外部能力。`python`、`typescript` 和 `shell` 只有在目标宿主提供一致的 `scripts` binding 时才可移植。
- 不假定命令解释器、换行符、字符编码、文件权限模型、符号链接或路径大小写规则一致。需要这些行为时，把差异封装在 binding 内。
- 让每个异步 binding 接受并及时响应取消信号；不要把凭据、完整私有 prompt 或敏感工具结果写入 trace 和错误信息。
- 将本文的 TypeScript 字段名视为 AFL 参考 VM 的接口映射。用其他语言实现宿主时，保留相同输入、输出、错误、取消和生命周期语义即可。

## 掌握语言骨架

使用以下结构定义 node：

```afl
node_name(arg_a, arg_b):
    # @description Describe the node contract.
    # @param arg_a Describe the first parameter.
    # @param arg_b Describe the second parameter.
    # @returns Describe the returned value.
    entry:
        result = prompt "Use the inputs", arg_a, arg_b
        ret result
```

遵守以下格式：

- 让 node、block 和局部名称以字母或下划线开头，后续只使用字母、数字或下划线。
- 使用 4 个空格缩进 block，使用 8 个空格缩进 instruction；禁止 tab。
- 使用 JSON 字符串转义规则；使用 `#` 写注释。
- 让每个 node 包含 `entry` block，让每个 block 以且仅以一个 terminator 结束。
- 只在 node header 后、首个 block 前使用 `@description`、`@param` 和 `@returns`。让每个 `@param` 对应真实参数。
- 使用至少包含两个段的 symbol，例如 `@prompt.review`、`@flow.lookup`。schema 使用 `@schema.*`，Freedom Agent allowlist 使用 `@agent.*`。
- 可以在不同 block 激活中复用局部名称，但不要在同一次 block 激活中重复定义。

## 区分值与句柄

按以下类型推理：

- `Frag`：`{ kind: "frag", content: string }`。它是无 role 的文本片段；role 只在写入 Memory 时产生。
- compute value：`null`、布尔值、有限数字、字符串、list 或 record。List 写作 `[value, ...]`，record 写作 `[key: value, ...]`，空 record 写作 `[:]`；它们应可安全地跨进程序列化。
- symbol：形如 `@namespace.name` 的符号引用，由 binding 或 VM 解释。
- handle：Agent、Memory 或 TaskGroup 的运行时句柄。不要把它传给 prompt binding、capability、external flow 或 script，也不要把它当成可序列化数据。

使用 `.field`、`[index]` 或 `["key"]` 访问路径。仅对 Agent 使用 `.memory`，仅对 Frag 使用 `.content`；对 list 使用数字索引，对 record 使用字段或字符串 key。跨 node 或控制流合流使用值前，确保它在所有可达路径上都已定义。

## 理解调度与资源

不要把同一 block 内的文本顺序误认为执行顺序。VM 根据下列关系调度普通 instruction：

- 数据依赖：读取某个局部值的 instruction 等待其生产者。
- Agent 依赖：同一 Agent 的 `sysprompt`、`do` 和相关 Memory 操作按同一 block 内的文本顺序排序。
- Memory 依赖：同一 Memory 的状态操作按文本顺序排序；copy 读取前序操作已提交的状态。
- TaskGroup 依赖：`sync` 等待并消费对应 group。
- workspace 依赖：写 workspace 与相同或重叠 workspace 的读写访问互斥；只读 workspace 可并行读取。

让 terminator 等待当前 block 的普通 instruction 完成后再执行。需要确定的显式先后关系时，让后一步读取前一步结果，或把两步放入相邻 basic block。同一 Agent 或 Memory 的状态操作会按文本顺序执行；workspace 重叠只保证互斥，不要用锁竞争决定先后。

## 使用 Agent 指令

### `agent`

形式：`coder = agent @agent.coder`；`coder = agent @agent.coder, "work/coder"`；`coder = agent @agent.coder, ["work/coder", "shared/specs"]`；`coder = agent @agent.coder,, saved_memory`。

- 使用第一个 operand 选择 Agent symbol。
- 使用可选 workspace 字符串声明一个主读写目录；使用至少两个元素的 list 把第一个目录作为主读写 workspace，其余目录作为只读 workspace。
- 省略 workspace 时，让 VM 为该 Agent 分配独立临时 workspace。不要依赖临时目录的物理位置。
- 如需绑定既有 Memory，把它放在第三个 operand；省略第二个 operand 时保留两个逗号。
- 只绑定尚未被其他 Agent 拥有的 Memory。创建后通过 `coder.memory` 取得其 Memory handle。
- 让宿主拒绝主 workspace 与只读 workspace 的重叠、逃逸或不合法解析。不要把只读声明当作 executor 已经强制执行的证明。

### `agent.sysprompt`

形式：`coder.sysprompt "Act as a careful implementer."`；`coder.sysprompt @prompt.coder_system`；`coder.sysprompt prepared_fragment`。

- 在 `agent.do` 前设置独立的 system prompt。
- 传入字符串、Frag、compute value 或 prompt symbol；symbol 通过 `prompts` binding 渲染。
- 把它与 Memory 区分开：system prompt 不作为普通消息追加到 Memory。
- 修改 system prompt 后，让 executor 丢弃或重建不再兼容的原生会话。

### `agent.do`

形式：`answer = coder.do request`；`answer = coder.do @role.reviewer, request`；`answer = coder.do request, @schema.review`。

- 把一次 `do` 视为完整的 Agent activation，而不是单个模型请求。executor 可以在内部执行多轮推理和工具调用。
- 省略 role 时使用 `user`；也可使用标准 role 或 `@role.*` 自定义 role。
- VM 先把输入作为指定 role 的消息追加到 Agent Memory，再调用 executor。
- 只有 `stopReason = completed` 的执行结果可作为正常输出；其他停止原因应作为失败处理。
- 使用 schema 时把请求传给 executor，并始终提供 `schemas` binding。executor 可以原生约束输出，也可以只生成候选内容；VM 在接受输出前调用 schema validator，成功后才把 assistant 消息追加到 Memory。
- 返回 role-free Frag。后续 role 由下一次 `do` 或 `memory.append` 明确指定。

## 构造输入与数据

### `prompt`

形式：`request = prompt "Review this change", diff, criteria`；`request = prompt @prompt.review, diff, criteria`。

- 让字符串、Frag 或 compute source 成为基础文本；把后续参数格式化后以两个换行分隔。
- 让 symbol source 调用 `prompts.render`，并把后续 Frag、compute 或 symbol 作为参数原样交给 binding。
- 不传 Agent、Memory 或 TaskGroup handle。
- 返回 Frag。

### `input`

形式：`choice = input "Select a release channel"`；`config = input @prompt.release_config, @schema.release_config`。

- 先按 prompt source 规则生成提示文本，再调用 `input.read`。
- 让 adapter 返回字符串；VM 将其包装为 Frag。
- 指定 schema 时调用 `schemas.validate`；validator 只接受或拒绝内容，不负责转换内容。
- 在无人值守宿主中，提供非交互 input adapter，或在验证阶段拒绝包含 `input` 的工作流。

### `oper`

形式：`ready = oper attempts < 3 & approved`；`label = oper "build-" + build_id`；`item = oper payload.items[0]`。

- 使用 `!`、一元 `-`、`&`、`|`、`==`、`!=`、比较运算、`+`、`-`、`*`、`/`、路径和括号。
- 只对布尔值使用 `&` 和 `|`，并依赖其短路语义。
- 只对数字做算术；`+` 也可连接两个字符串。拒绝除零和非有限数字。
- 不把 Frag 内容隐式解析为 JSON。需要结构化数据时，通过 schema、binding 或明确的 script/capability 生成 compute value。
- 返回 compute value。

### `python`、`typescript`、`shell`

形式：`parsed = python "parse_record.py", raw.content`；`checked = typescript "validate.mjs", parsed`；`status = shell "check-status", checked`。

- 使用字符串字面量指定 script source；把后续参数求值为 compute value 后传给 `scripts.execute`。
- 不假定 source 是文件名、内联代码还是命令。由 binding 定义解释方式，并在所有目标平台保持一致。
- 让 binding 返回合法 compute value；拒绝句柄、Frag、NaN、Infinity 或宿主对象。
- 不授予脚本隐式的文件、网络、环境变量或 shell 权限。由宿主按策略显式提供。
- 对跨平台工作流，优先用 `invoke` 或 external flow 替代依赖特定解释器或 shell 语法的脚本。

## 组合 Flow 与并发

### `call`

形式：`result = call local_node, input_value`；`result = call @flow.lookup, query`。

- 调用本模块 node 时匹配精确参数数量。局部调用可以传递 VM 内部值，包括由被调 node 合法使用的 handle。
- 调用 symbol flow 时使用 `flows.invoke`，只传 Frag、compute 或 symbol。
- 等待调用完成。让可复用 child node 返回 Frag 或 compute；external flow 也应返回 Frag 或 compute。
- 不把 Agent、Memory 或 TaskGroup handle 跨 external flow 边界。

### `dispatch` 列表形式

形式：`jobs = dispatch [score_a(item), score_b(item), @flow.remote_score(item)]`。

- 并发启动显式列出的调用，并立即返回 TaskGroup handle。
- 结果顺序按声明顺序确定，不按完成顺序确定。
- 任一 child 失败时取消其余 child，并让后续 `sync` 传播失败。

### `dispatch` 批量形式

形式：`jobs = dispatch task_count, process_item, task`。

- 把 `task_count` 求值为非负整数，使用同一个 task 参数启动指定数量的调用。
- 把总任务数与并发 worker 上限分开：operand 决定总调用数，`maxDispatchWorkers` 限制同时执行数。
- 遵守宿主的 `maxDispatchWorkers` 和 `maxDispatchTasks`。参考 VM 默认分别为 16 和 10,000。

### `sync`

形式：`combined = sync jobs`；`combined = sync jobs, @formatter.rank_results`。

- 每个 TaskGroup 在所有退出路径上恰好 `sync` 一次；不要遗漏、重复消费或在消费前重定义其名称。
- 等待全部 child，并按声明顺序收集 Frag。
- 省略 formatter 时，返回内容为 child Frag content 构成的 JSON array 文本。
- 指定 formatter 时调用 `formatters.format`，传入 `Frag[]`，并把返回字符串包装为 Frag。

### `fork`

形式：`branch = fork source, branch.do "Explore an alternative"`。

- 让左侧目标名与 `.do` receiver 相同。
- 复制 source Agent 的 Memory 和可用 continuation checkpoint，创建具有相同 symbol、system prompt 和 workspace 的新 Agent，然后立即执行其首次 `do`。
- 当前文本 parser 的快捷形式只接受默认 `user` role 和一个 input。需要自定义 role 或 schema 时，先使用 `memory.copy` 与 `memory.apply` 创建分支，再单独执行普通 `agent.do`。
- 把首次输出保留在 branch Memory 中；该 instruction 返回的是新 Agent handle，不是输出 Frag。
- 把 branch Memory 视为独立快照；后续修改不会回流到 source。
- 即使 Memory 独立，共享或重叠 workspace 仍会形成资源锁和潜在外部副作用。

### `invoke`

形式：`ticket = invoke @capability.issue.create, title, body`。

- 使用 `capabilities.invoke` 调用窄而明确的宿主能力。
- 只传 Frag、compute 或 symbol；返回值必须是字符串或 Frag，并统一为 Frag。
- 在调用 adapter 前执行 `authorizeCapability`，并按 capability symbol 与参数作出授权决策。运行位置等上下文通过宿主闭包或 trace 关联，不要假定 request 含有未声明字段。
- 用 capability 封装文件、网络、数据库、凭据和平台 API，避免把这些能力隐式塞进通用脚本。

## 管理 Memory

### `memory.append`

形式：`memory.append coder.memory, user, request`；`memory.append memory_copy, @role.note, note`。

- 向目标 Memory 追加一条带 role 的 Frag。
- 使用标准 role 或 `@role.*`；让 executor 的 Memory contract 验证可导入的 role schema。
- 把追加视为有副作用的写操作；启用持久化时，确保它以追加方式提交。

### `memory.copy`

形式：`snapshot = memory.copy coder.memory`。

- 创建独立 Memory 快照，保留消息 role 和可用 continuation checkpoint。
- 不让后续 source 更新传播到 copy，也不让 copy 更新回写 source。
- 允许参考 VM 使用持久化 base reference 延迟物化，但不要让 binding 暴露共享可变状态。

### `memory.apply`

形式：`reviewer = memory.apply coder, snapshot`。

- 创建新 Agent，沿用 source 的 symbol、system prompt 和 workspace，并取得给定 Memory 的所有权。
- 只使用未被其他 Agent 拥有的 Memory；该操作不再复制 Memory。
- 当 executor 支持兼容的 session import 或 fork 时恢复 continuation；否则从规范消息重建上下文。

## 使用 Freedom

只在路由数量、调用目标或子流程结构必须由 Agent 在运行时决定时使用 Freedom。优先把候选范围和参数显式列入 allowlist。两种 Freedom 都继续使用 planner/writer 现有的 Memory 与 session，把 prompt 作为 `user` 消息追加，并只在当前 activation 临时注入控制工具。

### `freedom.route`

形式：`routes = freedom.route planner, request, [min_routes: 1, max_routes: 3], [inspect, test, summarize], [payload: input_value, policy: policy_record]`。

- 要求 planner executor 支持 `dynamicControlTools`。
- 只暴露 `afl.environment.get` 和 `afl.route.add`。planner 可读取受控参数，并登记 allowlist 中的 local node 调用。
- 让登记的 route 在 planner activation 成功结束后才启动；返回 TaskGroup，并随后使用 `sync` 消费。
- 不把 planner 的最终文本当作 route 结果；它只保留在 planner Memory 和 trace 中。
- 用 `min_routes` 和 `max_routes` 约束数量；`max_routes` 必须为正、不得小于 `min_routes`，并受宿主上限约束。

### `freedom.flow`

形式：`result = freedom.flow writer, request, [min_routes: 1, max_routes: 4], [inspect, test, summarize], [@agent.coder, @agent.reviewer], [payload: input_value]`。

- 只暴露 `afl.environment.get`、`afl.node.execute`、`afl.ir.validate` 和 `afl.ir.execute`。
- 让 `node.execute` 立即执行 allowlist 中的 node；允许后续工具调用引用先前结果。
- 让 `ir.validate` 先验证生成 IR，并返回可审计 digest；让 `ir.execute` 只执行已验证且未改变的 IR。
- 限制生成 IR 的 node、Agent symbol、字节数、调用次数和 activation depth。拒绝输入、script、external flow、capability、递归 Freedom、未授权 Agent 和捕获外层 frame 的生成 IR。
- 至少成功执行一次 node 或生成 IR 后，才接受 writer 的最终 Frag；否则返回空 Frag。

Freedom 的参数 record 只放 Frag 或 compute value，不放 handle 或 symbol。工具参数使用受控引用，例如 `{ref: "param:payload"}`，或显式字符串 `{string: "literal"}`。参考 VM 的默认上限为 64 次 control tool、32 条 route、16 次 IR validation、8 次 IR execution、65,536 生成字节、64 个生成 node、8 层 activation 和 300,000 ms。

## 使用 Terminator

### `jump`

形式：`jump next`；`jump approved, accepted, rejected`。

- 无条件跳转到指定 block，或使用布尔 compute value 选择两个 block。
- 不把 Frag、数字或字符串当作隐式 truthy 值。
- 在控制流合流后，只使用所有前驱都定义的值。

### `ret`

形式：`ret result`；`ret`。

- 返回给调用方；无 operand 时返回空 Frag。
- 返回前确保当前 node 创建的每个 TaskGroup 都已同步消费。
- 对可能作为 child flow 调用的 node，返回 Frag 或 compute。不要依赖 handle 跨调用边界传播。

### `fail`

形式：`fail error_message`。

- 显式终止当前 node，并让调用、dispatch 或顶层 run 传播失败。
- 对 Frag 使用 content；对 compute 使用稳定格式。不要在错误中泄露敏感数据。

## 实现 Binding

把所有 binding 视为可选能力，但在执行到对应 instruction 时必须存在。让缺失能力产生明确错误，不要静默模拟成功。

参考 VM 接受一个 `VmBindings` 对象：

```text
VmBindings
  agents?             minimal/stateless Agent adapter
  agentExecutor?      full Agent executor backend; takes precedence over agents
  agentHost?          host event and interactive-input hooks
  agentSecurity?      pre-tool policy and approval queue
  prompts?            prompt symbol renderer
  input?              workflow input provider
  scripts?            python/typescript/shell executor
  capabilities?       explicit capability invoker
  flows?              external flow invoker
  formatters?         TaskGroup result formatter
  schemas?            content schema validator
  policy?             concurrency, Freedom, and authorization policy
  trace?              ordered trace sink
  memoryPersistence?  durable Memory storage
```

对于参考 CLI binding module，导出 default object 或名为 `bindings` 的 object。其他宿主直接把等价对象传给 VM，不需要采用 JavaScript 模块形式。

让宿主按 symbol 解析实现；AFL v0 本身没有 package 或 provider 声明语法。

### 通用值边界

- Prompt argument：Frag、compute 或 symbol。
- Script argument/result：仅 compute。
- Capability argument：Frag、compute 或 symbol；result 为 string 或 Frag。
- External flow argument：Frag、compute 或 symbol；可执行 flow 的 result 使用 Frag 或 compute。
- Formatter input：按声明顺序排列的 `Frag[]`；result 为 string。
- Schema input：schema symbol 和待验证 string；成功时无返回值，失败时抛出结构化错误。
- 任何 adapter 都不得返回 Agent、Memory、TaskGroup、函数、循环对象或宿主专用不可序列化值。

### 简单 Adapter 契约

| Binding | 请求字段 | 返回值 | 关键要求 |
| --- | --- | --- | --- |
| `prompts.render` | `prompt`, `args`, `signal` | string | 只解析 symbol prompt；保持参数顺序；响应取消 |
| `input.read` | `runId`, `node`, `block`, `prompt`, `schema?`, `signal` | string | 允许交互或自动输入；不要自行跳过 VM schema 校验 |
| `scripts.execute` | `language`, `source`, `args`, `signal` | compute | 隔离执行环境；验证输出可序列化且数字有限 |
| `capabilities.invoke` | `capability`, `args`, `signal` | string 或 Frag | 只实现明确 symbol；把副作用纳入授权和审计 |
| `flows.invoke` | `flow`, `args`, `signal` | Frag 或 compute | 不接受 handle；传播取消；稳定地报告远端失败 |
| `formatters.format` | `formatter`, `values`, `signal` | string | 不改变输入次序；对空列表定义稳定行为 |
| `schemas.validate` | `schema`, `content`, `signal` | void | 只验证，不转换；失败时给出安全、可定位的错误 |

### Memory Contract

让最小 Agent adapter 和完整 executor 都声明 `memory.capabilities.roleSchemas` 与 `memory.capabilities.importRoles`，并实现 `validateImport(agent, roleSchema, messages)`。支持 AFL 规范消息时包含 `afl.message-role/v0`；遇到不支持的 schema 或 role 时明确拒绝，不要改写、丢弃或合并消息。

### 最小 Agent Adapter

仅在不需要原生 session、checkpoint、fork、Freedom control tool、交互审批或 executor 沙箱声明时使用 `agents.run`：

```text
request = {
  runId, node, block,
  agent, systemPrompt?, workspace,
  messages, schema?, signal
}
result = { output: string }
```

- 声明 `workspaceCapabilities.workspaceContext` 和 `readOnlyWorkspaceContext`，表示 adapter 是否真正接收相应上下文。
- 提供 Memory contract，声明支持的 role schema 与 import role，并在 `validateImport` 中拒绝不兼容消息。
- 把 `agents` 看作 stateless compatibility layer。参考 VM 会把它包装成 executor；该包装不声明 native session、checkpoint、fork、structured output、Freedom control tools、interactive approval 或 sandbox enforcement。

### 完整 Agent Executor

需要长会话、可靠 fork、Freedom、工具审批或沙箱证明时实现 `agentExecutor`。声明稳定的 `name`、可选 `sessionFormat`、Memory contract 和以下 capability booleans：

| Capability | 含义 |
| --- | --- |
| `nativeSession` | 能保存并恢复供应商或 SDK 的原生会话状态 |
| `checkpoint` | 能在 activation 边界创建 continuation checkpoint |
| `fork` | 能从兼容 checkpoint 分叉独立 session |
| `workspaceContext` | 能向 Agent 提供主读写 workspace 上下文 |
| `readOnlyWorkspaceContext` | 能区分并提供只读 workspace 上下文 |
| `structuredOutput` | 能接收并遵守结构化输出请求；VM 仍使用 `schemas` 复核 |
| `interrupt` | 能在取消信号后中断进行中的执行 |
| `dynamicControlTools` | 能在 activation 中调用 VM 提供的 Freedom control tools |
| `interactiveApproval` | 能发起显式 elevation 或 transaction 审批 |
| `sandboxEnforcement` | executor 自身确实强制执行工作区、进程、网络或工具隔离 |

让 `execute(request, host)` 接收：

```text
request = {
  runId, node, block,
  agent, systemPrompt?,
  memory, memoryRevision,
  workspace,
  session?, sessionMemoryRevision?,
  schema?, control?, signal
}
result = {
  output: string,
  stopReason: completed | blocked | budget_exhausted | cancelled,
  session?, usage?
}
```

- 使用 `{ backend, id, checkpoint? }` 表示 session ref；导入导出状态使用 `{ backend, format, payload }`，不要把供应商对象直接暴露给 VM。
- 在执行前验证 canonical Memory import；不要悄悄删除未知 role。
- 只在正常完成时返回 `completed`。把策略阻止、预算耗尽和取消分别返回对应 stop reason。
- 让 `sessionMemoryRevision` 精确说明原生 session 已吸收的 canonical Memory revision，防止重复导入消息。
- 如支持 continuation，实现适用的 `checkpoint`、`fork`、`exportSession`、`importSession` 和 `close`；检查 executor name、session format、Agent symbol、system prompt 和 revision 兼容性。
- 向 `host.emit` 发送规范化 Agent event；向 `host.persistContinuation` 发送完整语义增量，不要发送无法重放的 token 碎片。
- 仅在 `control` 存在时调用 `host.executeControlTool`，并只使用 VM 提供的 tool 名称和 schema。

使用完整的 executor host 表面：

```text
emit(event) -> void
persistContinuation(delta) -> void
authorizeTool(action) -> allowed | denied
requestElevation(request) -> allowed | denied
requestTransaction(request) -> completed | denied | unavailable
requestInput(request) -> string
executeControlTool(request) -> {content: string, details?: compute}
```

在 executor 执行任何工具前调用 `authorizeTool`。只有策略返回可提权的拒绝时才调用 `requestElevation`；需要宿主确认外部事务完成时调用 `requestTransaction`；需要用户或上层系统补充信息时调用 `requestInput`。Agent event 只使用 `message.delta`、`tool.requested/policy/started/updated/completed`、`transaction.state`、`elevation.state`、`usage.updated` 或 `warning`。

按以下生命周期实现 Agent activation：追加输入消息，验证 canonical Memory，恢复兼容 session，执行 Agent 授权，持久化 attempt 起点，运行 executor，处理取消或非完成 stop reason，验证 schema，追加 assistant 输出，更新 continuation，再提交完成状态。任何中途错误都不得伪造成功输出。

### Agent Host 与安全

- 使用 `agentHost.emit` 接收宿主可展示的事件；使用 `agentHost.requestInput` 处理 executor 的交互请求。没有 handler 时明确拒绝，不要无限等待。
- 使用 `agentSecurity.preTool` 在工具执行前评估 action。action 包含 run/node/block、Agent、backend、tool call、执行边界、workspace、原始与实际 input、展示信息和 signal；让每个具名 policy 返回 `allow`、`block`、`deny` 或 `abstain`。`deny` 优先，policy 错误应失败关闭。
- 启用 `requireCoverage` 时，拒绝所有没有 policy 明确覆盖的工具 action。
- 把 `block` 当作可由 Agent 显式请求 elevation 的软阻止，不把它自动等同于批准。只有 `interactiveApproval` executor 和启用的 approval queue 才能完成 elevation 或 transaction。
- 让 approval queue 实现 `enqueue(draft, signal, observer?) -> approved | denied` 和 `close()`，按宿主交互模型串行化请求，并在 run 取消时清理未决请求。将 `preTool: false` 或 `approvalQueue: false` 视为显式关闭。

### VM Policy

配置并验证以下限制：

- `maxConcurrency`：Agent execution/session、script 和 capability 的外部执行许可上限；参考 VM 默认 32，必须为正。
- `maxDispatchWorkers`：批量 dispatch 的 worker 上限；默认 16，必须为正。
- `maxDispatchTasks`：单次批量 dispatch 的 task 上限；默认 10,000，可为 0。
- `freedomLimits`：限制 control call、route、IR validation、IR execution、生成字节、生成 node、activation depth 和时长。
- `authorizeAgent(request)`：在 Agent activation 前授权 symbol、workspace、prompt/schema 等上下文。
- `authorizeCapability(request)`：在 capability adapter 前授权 symbol 和参数。
- `authorizeFreedom(request)`：授权 Freedom instruction 本身。
- `authorizeFreedomNode(request)`：授权 Freedom 选择的 node 及实参。
- `authorizeFreedomIr(request)`：授权生成 IR source、entry 和 digest。

让授权 hook 返回布尔值或异步布尔值；显式 `false` 表示拒绝。不要依赖 adapter 在授权前自行产生副作用。

### Trace

实现 `trace.emit(event)` 时保留单调递增 sequence、timestamp、runId、event type 和可用的 node、block、instruction、details、error。接受 `run.started`、`run.completed`、`run.failed`、`node.started`、`node.completed`、`node.failed`、`block.started`、`block.completed`、`instruction.started`、`instruction.completed`、`instruction.failed`、`agent.started`、`agent.completed`、`agent.failed`、`agent.event`、`dispatch.started`、`dispatch.completed`、`fork.started`、`fork.completed`、`freedom.started`、`freedom.tool` 和 `freedom.completed`。让 sink 处理背压或快速落盘，但不要改变 VM 行为；对敏感字段做最小化或脱敏。

### Memory 持久化

使用 `memoryPersistence.directory` 选择宿主目录，或通过 `memoryPersistence.store` 实现自定义 store。参考 VM 默认使用相对 execution root 的 `.afl/memory`，但其他平台可以使用等价的安全位置。

让 store 实现：

```text
loadRun(runId, signal) -> state | undefined
saveRun(state, signal, context?) -> void

optional streaming hooks:
beginMemoryDo(...)
appendMemoryContinuation(...)
endMemoryDo(...)
```

- 保存格式版本、role schema、runId、root module digest，以及每个 Memory 的 module digest、消息、revision、continuation 和可选 base reference。
- 保持 revision 单调和消息追加语义；原子提交可见状态，并在取消或崩溃后拒绝半条消息。
- 用相同 runId 和 root module digest 从 `entry` 重放已持久化 Memory；不要声称恢复 VM 栈、局部变量、TaskGroup 或 instruction pointer。
- 限制同一 store namespace 内同一顶层 runId 的并发执行，避免两个写者破坏 append-only 历史。

## 验证工作流

按以下顺序检查：

1. 解析源文件，修复缩进、字符串、symbol 和 instruction 形状错误。
2. 运行静态验证，修复未定义值、错误 arity、非法路径、不可达或缺失 block、TaskGroup 所有权和 Freedom allowlist 问题。
3. 使用 mock bindings 覆盖每个 external symbol，并断言请求字段、参数顺序、返回类型和取消行为。
4. 测试同一 block 内的真实并发和依赖顺序，不用源代码行序作为断言。
5. 测试 child failure、schema failure、policy denial、adapter exception、timeout 和 cancellation 的传播。
6. 测试 Memory copy/apply/fork 的独立性，以及同 runId 的持久化重放。
7. 在每个目标平台运行相同的行为测试；把路径、shell、权限或 SDK 差异留在 binding 测试中。

使用参考 CLI 时，可运行：

```text
afl validate workflow.afl
afl visualize workflow.afl --output workflow.graph.html
afl-vm bindings-module workflow.afl
```

把命令中的路径写成目标 shell 能传递的普通参数；不要把某个平台的引号、环境变量展开或路径分隔符复制到工作流语义中。

## 审查清单

- 确认 README 风格说明与实际 AFL v0 语义一致，避免描述尚未实现的语法。
- 确认每条数据和资源依赖都显式成立，所有 block 都有 terminator。
- 确认每个 TaskGroup 在所有退出路径上恰好同步一次。
- 确认跨 binding 边界只传可移植值，所有返回值都经过类型和 schema 校验。
- 确认 workspace 路径可规范化、互不越界，并由 executor 实际执行所声明的隔离。
- 确认 Freedom 候选、Agent、参数和预算都受 allowlist 与 policy 限制。
- 确认取消信号贯穿 Agent、input、script、flow、capability、formatter、schema 和持久化实现。
- 确认 trace 与错误不泄露凭据、私有 prompt、完整工具载荷或敏感文件内容。
- 确认测试不依赖特定模型措辞、操作系统时序或并发完成顺序。
