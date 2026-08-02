# AFL IR 执行语义草案

状态：v0 讨论方案，等待案例检验
日期：2026-08-02

## 1. 范围

本文说明 node、basic block、dependency、Frag、role 和核心指令在当前草案中的含义。它用于对齐 frontend 与 VM，不定义 package、schema 描述语言或 provider API。

## 2. Node 调用

调用一个 node 时，VM 创建一次独立的 node invocation：

1. 将实参与 node 参数绑定；
2. 创建本次调用的工作值环境；
3. 激活 `entry` basic block；
4. 按 dependency 调度 block 内指令；
5. 执行 block terminator；
6. 遇到 `ret`、`fail` 或未处理的 VM error 时结束调用。

Node 参数和已经完成的指令结果可以被后续 basic block 使用。Node invocation 结束后，普通工作值随调用释放；需要长期保存的内容应进入 memory、artifact 或外部 store。

## 3. Basic Block

同一 node invocation 通常只有一条由 `jump` 推进的主控制路径。一个 basic block 被激活时：

- 读取从前序 block 保留下来的工作值；
- 为本次 block 中的指令建立 dependency；
- 启动所有已经 ready 的指令；
- 等待 block 内指令全部完成；
- 执行最后的 terminator。

跳回之前的 block 会创建新的 block activation，因此可以表达循环。

每次指令执行产生的 Frag 或 compute value 都是不可变结果。当前文本草案允许名称在后续 block activation 中绑定到新结果；VM、trace 或 lowering 可以给每次结果分配独立版本。这保留了 SSA-like 数据流属性，但暂不要求手写 IR 暴露 phi 或严格 SSA 名称。

一个 block activation 内不允许两条指令写同一个 `dst`。

## 4. Frag、Message 与 Memory

### 4.1 Frag

Frag 是普通业务数据的统一表示：

```text
Frag {
    content: string
}
```

Frag 的 IR 可见内容只有字符串。实现可以在 trace 或 object store 中记录 identity、producer 和 provenance，但这些 sidecar metadata 不改变 Frag 的字符串语义。

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

第一版把 Memory 的可观察语义视为有序 Message 序列：

```text
Memory {
    messages: Message[]
}
```

存储实现可以额外使用 artifact store、summary、索引或 provider session，只要对 AFL 暴露的 append、copy、apply 和 Agent 上下文行为保持一致。

## 5. 结果类别

指令结果分为三类：

- 数据结果：`do`、`seqdo`、`prompt`、`input`、`invoke`、`call`、`sync` 等返回 Frag；
- 计算结果：`oper` 与 script executor 返回 bool、number、string 或宿主结构等本地 compute value；
- 资源结果：`agent`、`memory.copy`、`memory.apply`、`dispatch`、`fork` 返回 VM handle。

资源 handle 不会为了满足统一字符串形式而包装成 Frag。它们只用于后续资源指令，不能直接作为 Agent message 发送。

JSON 是 Frag content 的一种可选编码，不是 Core IR 的内部数据模型。Flow 可以使用纯文本 sentinel、JSON、XML、Markdown 或自定义字符串协议。

## 6. Dependency

### 6.1 数据依赖

指令读取另一条指令的 `dst` 时形成数据依赖：

```text
review_result = reviewer.seqdo review_prompt
finish = oper review_result == "finish"
```

`finish` 等待 `review_result`。一个不可变结果可以 fan-out 给多个消费者；消费者之间没有其他依赖时可以并行。

### 6.2 Flow 依赖

Basic block 的 terminator 建立 flow 依赖。目标 block 只在当前 block 完成并选中对应跳转后激活。

需要强制两个没有数据关系的动作先后执行时，可以把它们放入相邻 basic block。这样顺序由 flow 明确表达，而不是依赖不同 Agent 指令的文本位置。

### 6.3 Agent 与 Memory 依赖

Agent 调用和 `memory.append` 会读写绑定 Memory。同一 Agent 或同一 Memory 上的状态性指令形成资源依赖。当前文本草案按它们在 block 中的顺序确定该资源依赖方向。

不同 Agent 使用不同 Memory 时，不会仅因为文本相邻而互相等待。需要让同类 Agent 并行工作时，可以创建多个 Agent instance，并按需要复制上下文。

### 6.4 Ready

一条指令在以下条件满足后 ready：

- 它读取的 Frag、compute value 或 handle 已经产生；
- 它依赖的前序 block 已完成；
- 它需要的 Agent、Memory 或 capability 当前可用；
- VM policy 允许启动。

所有 ready 指令都可以并行启动。并发上限、rate limit 和预算可以推迟启动，但不会新增业务 dependency。

## 7. Agent 与 Prompt

### 7.1 `agent`

```text
coder = agent @agent.coder
reviewer = agent @agent.reviewer, review_memory
```

`agent` 创建 Agent instance。没有 Memory operand 时同时创建默认 working Memory；有 Memory operand 时绑定该 Memory。

### 7.2 `agent.sysprompt`

`agent.sysprompt` 设置或替换 Agent 的 system prompt。它隐含 `system` role，并影响该 Agent 后续工作。Provider 是否把 system prompt 单独保存为配置，不改变 AFL 中的 role 语义。

### 7.3 `prompt`

`prompt` 把 prompt source 和参数格式化为一个 Frag。Prompt package 决定模板替换、分隔和参数编码；literal 实现可以直接拼接字符串。

`prompt` 返回的 Frag 没有 role。只有它被传给 `agent.do/seqdo`、`agent.sysprompt` 或 `memory.append` 时，才获得 user、system、tool 或其他 role。

### 7.4 `input`

`input` 暂停当前指令并等待外部输入。输入被包装成 role-free Frag 后产生 `dst`。输入来源是人、事件还是其他 adapter，不决定它后续进入 Memory 时的 role。

### 7.5 `do`

`agent.do` 表示一次 Agent 工作单元。其基本过程为：

1. 将输入 Frag 以显式 role 加入 Agent Memory；省略 role 时使用 `user`；
2. 执行一次由 Agent adapter 定义的工作单元；
3. 将模型可见输出以 `assistant` role 加入该 Agent Memory；
4. 返回包含同一输出字符串、但不带 role 的 Frag。

Role-free 返回值可以被另一个 Agent 作为 `user` message 接收，也可以用其他 role 显式 append。

### 7.6 `seqdo`

`agent.seqdo` 与 `do` 使用相同的输入和最终输出规则，但允许同一个 Agent 连续完成多步工作，直到报告完成、需要外部输入、失败或触发 VM 限制。

内部可以产生多条 assistant、tool 和 observation Message。AFL 指令只返回最后约定的业务输出 Frag；完整过程保留在 Agent Memory 和 trace 中。

### 7.7 输出格式约束

Agent 调用可以带 schema symbol：

```text
report = reviewer.seqdo prompt, @schema.Report
```

VM 可以要求模型输出 JSON 并校验 schema，但校验后的 `report` 仍是包装 JSON 文本的 Frag，不会自动变成 Core IR record。

简单 flow 不必使用 JSON。例如 Reviewer 可以约定：没有缺陷时精确输出 `finish`，否则输出文本缺陷列表：

```text
review_result = reviewer.seqdo review_prompt
finish = oper review_result == "finish"
```

比较按 Frag 的原始字符串执行，不自动 trim、忽略大小写或解析自然语言。需要其他规则时应由 prompt、`oper` function 或 script 明确表达。

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

`memory.copy` 不接收新 role，因为它复制的是已经带 role 的 Message，而不是把一个 role-free Frag 加入 Memory。

### 9.3 `memory.apply`

```text
new_agent = memory.apply source_agent, memory
```

`memory.apply` 使用 source Agent 的 binding 与配置创建一个新的 Agent handle，并把给定 Memory 作为其 working Memory。它不修改 source Agent，也不再次复制 Memory。第一版要求 Memory 尚未绑定其他 Agent；否则 validator 拒绝该操作，避免隐式产生 shared mutable Memory。调用方需要独立副本时先显式执行 `memory.copy`。

## 10. 控制流

### 10.1 `jump`

```text
jump target
jump condition, true_target, false_target
```

无条件形式激活目标 block。条件形式读取 boolean compute value，只激活一个目标。

### 10.2 `ret`

`ret` 结束当前 node invocation。业务 flow 通常返回 Frag；内部 helper 是否允许返回 compute value，由其接口决定。

### 10.3 `fail`

`fail` 以错误结束当前 node invocation。错误可以使用 Frag 或 VM error value 表示。Retry、catch 和 compensation 暂可由 basic block、子 flow 和 VM policy 组合。

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

`count` 可以是硬编码非负整数，也可以是 Agent 输出经 `oper` 或 script executor 解析得到的整数。VM 创建 `count` 次 `flow(task)`。每个 child 接收同一个 task Frag，但获得独立 node invocation、Agent 和 Memory。

VM policy 可以限制同时运行的 child 数量，使部分逻辑 Worker 排队，但不得静默改变 `count`。`count` 不是绕过预算、rate limit 或部署上限的权限参数。

这两种形式都不表示 iterable map。运行时 task list 的逐项分发如果成为核心需求，应另行定义，不能通过猜测 `task` 内容隐式实现。

### 11.3 `fork`

`fork` 从 source Agent 派生一个带上下文的并行分支，并立即在新 Agent 上启动一次工作：

```text
new_agent = fork source_agent, new_agent.do prompt
new_agent = fork source_agent, new_agent.seqdo task
```

左侧 `dst` 在该条指令的第二个 operand 中是合法的 branch Agent 绑定，在其他 operand 或定义前的普通指令中仍不可引用。`fork` 执行以下概念操作：

```text
new_memory = memory.copy source_agent.memory
new_agent = memory.apply source_agent, new_memory
new_agent.do prompt
```

Branch Agent 沿用 source Agent 的 binding 和配置，并绑定独立复制的 Memory。Source Agent 和 branch Agent 在 fork 后的消息写入互不传播。

`fork` 返回 branch Agent handle。启动动作的输出已经以 `assistant` role 写入 branch Memory，但这条快捷形式不额外返回 Frag。后续对 branch Agent 的 `do`、`seqdo`、`sysprompt` 或 Memory 写入，与启动动作形成同一 Agent 的资源依赖。

多条互不依赖的 `fork` 指令可以并行启动任意数量的分支。需要 list 或 batch child flow、独立结果集合和 `sync` 时使用 `dispatch`。`fork` 是 `memory.copy`、`memory.apply` 与启动动作的组合快捷方式，这些步骤在 trace 中仍应可见。

### 11.4 `sync`

`sync` 等待 TaskGroup，并按 dispatch item 的声明顺序或 batch ordinal 收集 child Frag。可选 formatter 把结果集合编码成一个 Frag；省略时使用 task group interface 的默认 formatter。Formatter 可以输出 JSON 字符串或 package 声明的其他文本格式。

Basic block 中互不依赖的普通 Agent 指令本身已经可以并行；`dispatch` 表达独立 child flow 的生命周期，`fork` 表达从 source Agent 复制上下文并立即工作的分支关系。

## 12. `invoke`

`invoke` 调用已绑定的 skill、MCP method 或 capability。Binding 负责把外部输出格式化成 role-free Frag。

Agent 在 `do/seqdo` 内部自行使用 tool，与 flow 显式执行 `invoke` 是两种语义：前者由 Agent 决策，后者由 AFL flow 决策。

## 13. `freedom`

`freedom.move` 从显式候选 move 中选择并执行一步；`freedom.flow` 选择已有 flow 或生成临时 child flow。两者的业务结果都返回 role-free Frag。

候选行为在执行前接受 symbol、capability、预算和 policy 检查。一次 freedom fallback 不自动等价于永久改写当前程序；长期 revision 可以在后续案例中继续设计。

## 14. 失败与挂起

指令可以完成、等待外部事件或失败：

- `input` 可以等待外部输入；
- `seqdo` 可以等待 Agent 所需的外部输入；
- `sync` 可以等待 child flow；
- VM error、格式校验失败、权限拒绝和显式 `fail` 会使当前路径失败。

Timeout、重试、取消和恢复策略暂由 VM policy 或可复用 flow 表达。是否提升为核心指令，需要用长任务和长期 Agent 案例验证。
