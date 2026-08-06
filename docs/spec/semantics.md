# AFL IR 执行语义

## 1. 范围

本文说明当前 validator、dependency scheduler 和 VM 对 node、basic block、Frag、role 与各类指令的处理方式。

## 2. Node 调用

调用一个 node 时，VM 创建一次独立的 node invocation：

1. 将实参与 node 参数绑定；
2. 创建本次调用的工作值环境；
3. 激活 `entry` basic block；
4. 按 dependency 调度 block 内指令；
5. 执行 block terminator；
6. 遇到 `ret`、`fail` 或未处理的 VM error 时结束调用。

Node 参数和已经完成的指令结果可以被后续 basic block 使用。Node invocation 结束后，其 frame 不再由 VM 保留。

## 3. Basic Block

同一 node invocation 通常只有一条由 `jump` 推进的主控制路径。一个 basic block 被激活时：

- 读取从前序 block 保留下来的工作值；
- 为本次 block 中的指令建立 dependency；
- 启动所有已经 ready 的指令；
- 等待 block 内指令全部完成；
- 执行最后的 terminator。

跳回之前的 block 会创建新的 block activation，因此可以表达循环。

Frag 和 compute value 在写入 frame 时按值保存。名称可以在后续 block activation 中重新绑定；同一个 block 内不允许重复定义名称。

一个 block activation 内不允许两条指令写同一个 `dst`。

## 4. Frag、Message 与 Memory

### 4.1 Frag

Frag 是普通业务数据的统一表示：

```text
Frag {
    content: string
}
```

Frag 的 VM 表示只包含 `kind` 和 `content`。

Frag 不带 role。同一个 Frag 可以被多个消费者读取，也可以用不同 role 加入不同 Memory。

### 4.2 Message

Frag 进入 Memory 时形成 Message：

```text
Message {
    role
    content: string
}
```

Role 属于 Frag 进入 Memory 的边，而不是 Frag 自身属性。基础 role 包括 `system`、`user`、`assistant` 和 `tool`；VM 可以通过 symbol 扩展其他 role。

### 4.3 Memory

Memory handle 保存有序 Message 序列：

```text
Memory {
    messages: Message[]
}
```

Memory handle 还记录 VM 内部 identity 和可选 owner，用于资源依赖与绑定检查。

## 5. 结果类别

指令结果分为三类：

- 数据结果：`do`、`prompt`、`input`、`invoke`、`call`、`sync` 等返回 Frag；
- 计算结果：`oper` 与 script executor 返回 bool、number、string 或宿主结构等本地 compute value；
- 资源结果：`agent`、`memory.copy`、`memory.apply`、`dispatch`、`fork` 返回 VM handle。

资源 handle 不会包装成 Frag，也不能作为 Agent message、Prompt 参数、Capability 参数或外部 Flow 参数发送。

JSON 是 Frag content 的一种可选编码，不是 Core IR 的内部数据模型。Flow 可以使用纯文本 sentinel、JSON、XML、Markdown 或自定义字符串协议。

## 6. Dependency

### 6.1 数据依赖

指令读取另一条指令的 `dst` 时形成数据依赖：

```text
review_result = reviewer.do review_prompt
finish = oper review_result == "finish"
```

`finish` 等待 `review_result`。一个不可变结果可以 fan-out 给多个消费者；消费者之间没有其他依赖时可以并行。

### 6.2 Flow 依赖

Basic block 的 terminator 建立 flow 依赖。目标 block 只在当前 block 完成并选中对应跳转后激活。

需要强制两个没有数据关系的动作先后执行时，可以把它们放入相邻 basic block。这样顺序由 flow 明确表达，而不是依赖不同 Agent 指令的文本位置。

### 6.3 Agent 与 Memory 依赖

Agent 调用和 `memory.append` 会读写绑定 Memory。同一 Agent 或同一 Memory 上的状态性指令形成资源依赖，依赖方向按它们在 block 中的文本顺序确定。

不同 Agent 使用不同 Memory 时，不会仅因为文本相邻而互相等待。需要让同类 Agent 并行工作时，可以创建多个 Agent instance，并按需要复制上下文。

### 6.4 Ready

一条指令在以下条件满足后 ready：

- 它读取的 Frag、compute value 或 handle 已经产生；
- 它依赖的前序 block 已完成；
- 它需要的 Agent、Memory 或 TaskGroup handle 已经产生。

所有 ready 指令都可以并行启动。VM 默认最多同时执行 32 个 Agent、Script 和 Capability adapter 调用；`VmPolicy.maxConcurrency` 可以修改该上限。

## 7. Agent 与 Prompt

### 7.1 `agent`

```text
coder = agent @agent.coder
reviewer = agent @agent.reviewer, review_memory
```

`agent` 创建 Agent instance。没有 Memory operand 时同时创建默认 working Memory；有 Memory operand 时绑定该 Memory。

### 7.2 `agent.sysprompt`

`agent.sysprompt` 设置或替换 Agent handle 上单独保存的 system prompt。后续 `AgentExecutionRequest` 通过 `systemPrompt` 字段携带该值；它不会作为普通 Message 写入 Memory。已经建立的原生 backend session 会失效，下一次 `do` 使用当前 Memory 和新 prompt 建立 session。

### 7.3 `prompt`

Prompt source 是 symbol 时，VM 调用 Prompt binding 的 `render`。Source 是 literal、Frag 或 compute value 时，VM 将 source 与格式化后的参数用两个换行符连接。两种形式都返回 Frag。

`prompt` 返回的 Frag 没有 role。它被传给 `agent.do` 或 `memory.append` 时才形成带 role 的 Message。

### 7.4 `input`

`input` 将 prompt Frag、可选 schema、run id 和当前位置交给 Input binding。Binding 返回字符串后，VM 执行可选 schema 校验，并将字符串包装成 role-free Frag。

### 7.5 `do`

`agent.do` 表示一次完整的 Agent 工作激活，而不是一次模型请求或单个 runtime turn。其基本过程为：

1. 将输入 Frag 以显式 role 加入 Agent Memory；省略 role 时使用 `user`；
2. 调用一次 `AgentExecutorBackend.execute`；backend 负责在返回前完成内部需要的模型 turn 和工具步骤；
3. 将模型可见输出以 `assistant` role 加入该 Agent Memory；
4. 返回包含同一输出字符串、但不带 role 的 Frag。

Role-free 返回值可以被另一个 Agent 作为 `user` message 接收，也可以用其他 role 显式 append。

Backend 可以在 `messages` 中返回中间 Message。VM 依次追加这些 Message，再以 `assistant` role 追加 `output`，指令返回包装 `output` 的 Frag。旧 `AgentAdapter` 由无状态兼容 backend 包装，仍会收到完整 Memory。

支持原生 session 的 backend 可以返回 session ref。VM 记录该 session 已同步的 Memory revision，并把运行中的文本、工具和 usage 事件转交 Trace 与可选 `agentHost`。这些事件不是 Message，也不会自动写入 Memory。

### 7.6 输出格式约束

Agent 调用可以带 schema symbol：

```text
report = reviewer.do prompt, @schema.Report
```

存在 schema operand 时，VM 要求 Schema binding 存在，并用它校验 Agent 输出字符串。校验后的 `report` 仍是 Frag，不会自动变成 Core IR record。

简单 flow 不必使用 JSON。例如 Reviewer 可以约定：没有缺陷时精确输出 `finish`，否则输出文本缺陷列表：

```text
review_result = reviewer.do review_prompt
finish = oper review_result == "finish"
```

比较按 Frag 的原始字符串执行，不自动 trim、忽略大小写或解析自然语言。需要其他规则时使用 script binding 显式转换。

## 8. `oper` 与 Script Executor

### 8.1 `oper`

`oper` 处理 flow 中常见的逻辑、关系、算术和字符串计算。Frag 作为 string operand 使用时读取其 `content`：

```text
finish = oper review_result == "finish"
```

`oper` 返回本地 compute value，通常用于 `jump` 或后续计算。它不把输入或结果自动加入任何 Memory，也不隐式解析 JSON。

### 8.2 `python`、`typescript`、`shell`

Script executor 把显式 operand 交给对应 VM binding。Frag 以 content string 传入，脚本结果作为 compute value 返回。

Script 不能隐式读取 node 中的其他工作值。需要把脚本结果传给 Agent 时，先通过 `prompt` 或其他 formatter 生成 Frag。

## 9. Memory 指令

### 9.1 `memory.append`

```text
memory.append target_memory, role, frag
```

`memory.append` 在目标 Memory 尾部加入 `{role, frag.content}`。Role 是必需 operand，因为 Frag 本身没有 role。

### 9.2 `memory.copy`

```text
copied = memory.copy source_memory
```

`memory.copy` 创建独立 Memory，并按原顺序复制 source 中的 Message。每条 Message 保留原 role；copy 之后双方更新互不自动传播。

当 backend 支持 checkpoint 时，VM 还会复制一份 flow 不可读取的 continuation checkpoint，并绑定复制时的 Memory revision。该元数据只用于兼容的 `memory.apply` 或 `fork`，不改变 Message 序列。

`memory.copy` 不接收新 role，因为它复制的是已经带 role 的 Message，而不是把一个 role-free Frag 加入 Memory。

### 9.3 `memory.apply`

```text
new_agent = memory.apply source_agent, memory
```

`memory.apply` 使用 source Agent 的 symbol 与 system prompt 创建新的 Agent handle，并把给定 Memory 作为其 working Memory。它不修改 source Agent，也不再次复制 Memory。Memory 已有 owner 时，VM 报告 `MEMORY_ALREADY_BOUND`；调用方需要独立副本时先执行 `memory.copy`。

Memory checkpoint 的 backend、Agent symbol 和 system prompt 都兼容时，首次执行优先从 checkpoint fork 原生 session；否则 backend 只根据可移植 Message 重建 session。

## 10. 控制流

### 10.1 `jump`

```text
jump target
jump condition, true_target, false_target
```

无条件形式激活目标 block。条件形式读取 boolean compute value，只激活一个目标。

### 10.2 `ret`

`ret value` 返回 frame 中的对应值；无操作数的 `ret` 返回空 Frag。`call` 和 `dispatch` 会把 child 的 compute value 格式化为 Frag，并拒绝 child 返回的 handle。

### 10.3 `fail`

`fail value` 以 `FLOW_FAILED` 结束当前 node invocation。Frag 使用 `content` 作为错误消息，compute value 使用其格式化文本，handle 使用固定错误消息。

## 11. Flow 组合

### 11.1 `call`

`call` 创建 child node/flow invocation 并等待返回。业务调用结果规范化为 role-free Frag。

### 11.2 `dispatch`

`dispatch` 同时创建多个 child flow invocation 并返回 TaskGroup handle。Child 使用独立工作值环境；Memory 是否传入由 flow operand 明确表达。

List 形式显式列出 flow call：

```text
dispatch [flow_a(...), flow_b(...), ...]
```

VM 为每个 list item 创建一次 child invocation。不同 item 可以调用不同 flow，也可以传入不同 task。

Batch 形式批量启动同一个 flow：

```text
dispatch count, flow, task
```

`count` 必须求值为非负整数 compute value。Agent 输出是 Frag，需要先由 script binding 转换为 number。VM 创建 `count` 次 `flow(task)`；每个 child 拥有独立 node invocation，并接收 task 值的副本。

VM 默认允许一次 dispatch 创建最多 10,000 个 task，并最多同时运行 16 个 worker。`VmPolicy.maxDispatchTasks` 和 `maxDispatchWorkers` 可以修改这两个限制，但不会改变声明的 `count`。

这两种形式都不遍历运行时 task list。当前 VM 没有 iterable map 指令。

### 11.3 `fork`

`fork` 从 source Agent 派生一个带上下文的并行分支，并立即在新 Agent 上启动一次工作：

```text
new_agent = fork source_agent, new_agent.do prompt
```

左侧 `dst` 在该条指令的第二个 operand 中是合法的 branch Agent 绑定，在其他 operand 或定义前的普通指令中仍不可引用。`fork` 执行以下概念操作：

```text
new_memory = memory.copy source_agent.memory
new_agent = memory.apply source_agent, new_memory
new_agent.do prompt
```

Branch Agent 沿用 source Agent 的 binding 和配置，并绑定独立复制的 Memory。Source Agent 和 branch Agent 在 fork 后的消息写入互不传播。

`fork` 返回 branch Agent handle。启动动作的输出已经以 `assistant` role 写入 branch Memory，但这条快捷形式不额外返回 Frag。后续对 branch Agent 的 `do`、`sysprompt` 或 Memory 写入，与启动动作形成同一 Agent 的资源依赖。

多条互不依赖的 `fork` 指令可以并行启动分支。需要 list 或 batch child flow、独立结果集合和 `sync` 时使用 `dispatch`。Trace 记录 `fork.started`、内部 Agent 事件和 `fork.completed`。

### 11.4 `sync`

`sync` 等待 TaskGroup，并按 list 声明顺序或 batch ordinal 收集 child Frag。省略 formatter 时，VM 把各 Frag 的 content 编码为 JSON string array。指定 formatter 时，VM 调用 Formatter binding。任一 child 失败会取消同组其他 child，`sync` 抛出该失败；同一个 TaskGroup 只能 sync 一次。

Validator 要求每个 dispatch 产生的 TaskGroup 在 node 退出前恰好 sync 一次。VM 也会拒绝未消费或重复消费的 TaskGroup。

Basic block 中互不依赖的普通 Agent 指令本身已经可以并行；`dispatch` 表达独立 child flow 的生命周期，`fork` 表达从 source Agent 复制上下文并立即工作的分支关系。

## 12. `invoke`

`invoke` 调用已绑定的 skill、MCP method 或 capability。Binding 负责把外部输出格式化成 role-free Frag。

Agent 在 `do` 内部自行使用 tool，与 flow 显式执行 `invoke` 是两种语义：前者由 Agent 决策，后者由 AFL flow 决策。

## 13. `freedom`

`freedom.move` 从显式候选 move 中选择并执行一步；`freedom.flow` 选择已有 flow 或生成临时 child flow。两者的业务结果都返回 role-free Frag。

VM 把 planner Agent 的 system prompt 和 Memory messages 交给 Freedom binding，不会为该指令另外调用 Agent binding。Freedom binding 返回的 plan 必须符合所用指令的 mode。`freedom.move` 还要求 move 位于显式候选列表中。可选 `approveFreedom` policy 返回 `false` 时拒绝执行；通过后，VM 调用 Move、External Flow binding，或解析并验证 generated flow。

## 14. 失败与挂起

指令可以完成、等待 adapter 或失败：

- `input` 可以等待外部输入；
- `do` 等待 Agent binding；
- `sync` 可以等待 child flow；
- VM error、格式校验失败、权限拒绝和显式 `fail` 会使当前路径失败。

`AflVm.run` 接受 `AbortSignal`，取消信号会传递给 adapter 和 child flow。VM 还使用 `maxSteps` 防止无限执行；默认值为 100,000。当前 IR 没有 timeout、retry、catch 或 compensation 指令。
