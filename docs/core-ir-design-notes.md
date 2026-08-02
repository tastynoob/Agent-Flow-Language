# AFL IR 设计说明

状态：记录当前推导，不属于规范
日期：2026-08-02

## 1. 已明确的方向

以下内容来自目前的需求讨论，是 Core IR 重写的基础：

- AFL IR 服务于 Agent flow，不是普通配置文件；
- 它接近 Verilog 式的连接和依赖描述，而不是只按源码行顺序执行；
- 大部分指令采用 `dst = instr arg0, arg1, ...`；
- Agent 指令允许 `coder.do`、`reviewer.seqdo` 这类形式；
- basic block 由指令和末尾跳转组成；
- node 类似可调用的 flow 函数；
- `oper` 直接接表达式，承担粗粒度逻辑计算；
- Python、TypeScript 和 shell 可以作为复杂计算或外部执行的 escape hatch；
- `seqdo` 是独立 primitive，不应退化成固定的 user/assistant 交替；
- Agent 默认绑定 memory，flow 可以 append Frag、copy memory，或把 memory apply 到新的 Agent；
- 普通业务结果统一为 role-free Frag，Frag 的可见内容是字符串；
- `prompt` 和 `input` 只产生 Frag，role 在使用 Frag 时决定；
- `freedom move` 与 `freedom flow` 是开放式 fallback 指令，不只是一个全局权限开关；
- Prompt 和公共 flow 应能通过 package/library 传播与复用。

## 2. 从具体例子向通用模型扩展

Coder/Reviewer 只是验证语义的第一个例子，IR 不应把角色、审核状态或缺陷列表写成内建概念。

当前草案因此采用：

- 任意 Agent symbol，而不是内建 `coder`、`reviewer` 类别；
- 任意字符串协议和可选外部 schema，而不是内建 `BugList`；
- node 参数与 `call`，使 review loop 可以替换 worker、reviewer、prompt 和 policy；
- `dispatch/sync`，使两角色循环能扩展到独立的多部门和多候选任务；
- `fork`，把 `memory.copy`、`memory.apply` 与首次工作组合为上下文继承操作；
- `invoke`，使网络、MCP、skill 等能力不必逐一升级为核心 opcode；
- `freedom.move/freedom.flow`，使固定图不能覆盖的任务仍有受控出口。

这种抽象不是要求所有 flow 都写成完全泛型。它只是避免用第一个案例的名词限制语言边界。

## 3. 当前草案补出的语义

需求给出了主要形态，但 runtime 仍需要一些可执行规则。当前文档暂时提出以下方案，后续可以根据示例调整。

### 3.1 Block 内按依赖调度

如果 block 内所有行严格串行，就无法自然表达“没有依赖即并行”；如果完全忽略源码顺序，同一个 Agent 的连续工作又会难以阅读。

当前折中是：

- 数据引用形成数据依赖；
- block 跳转形成 flow 依赖；
- 同一 Agent 的状态性指令按文本顺序使用其 memory；
- 不同 Agent 不因文本顺序自动串行。

这个规则需要用 coder 连续修订、多 Reviewer 并行以及同一 Agent 并行分身三个案例验证。

### 3.2 SSA-like 数据流不等于强制 SSA 语法

Flow 本身是半静态数据流。不可变 Frag 和 compute value 很适合按 SSA 思路建立 producer/consumer dependency；传统 SSA 的 block parameter、phi 和全局唯一名称也有利于 verifier 与 lowering。

但 AFL IR 首先是描述 Agent flow。当前文本草案允许后续 block activation 把同一可读名称绑定到新结果，例如 `code` 在 revise 后表示新版本；每次实际产生的值仍然不可变，并可由 runtime 分配独立版本。

是否把 block parameter 或严格 SSA 名称暴露给手写 IR，继续由循环、并行和可视化案例决定。内部表示可以先采用 SSA-like version，而不要求表面语法完全模仿编译器 IR。

### 3.3 Frag 是可进入 Memory 的最小业务数据

把 record、enum 和 generic type 全部放入 Core IR，会让它迅速膨胀成完整 DSL。另一方面，只返回无身份的宿主对象，也不利于跨 Agent、跨 runtime 和 trace 传递。

当前草案把普通业务结果统一为 `Frag(string)`。它可以直接作为 prompt 参数、Agent 输入或 Memory message content。JSON 只是字符串协议之一；简单 review 可以直接使用 `finish` sentinel 和文本缺陷列表。

Agent call 仍可引用 `@schema.*` 约束 JSON 等格式，但 schema 不改变 Frag 的字符串本质。复杂解析留给 `oper` 的显式 function 或 script executor。

### 3.4 Role 属于使用边界

Agent 输出在来源 Memory 中具有 `assistant` role，但同一内容交给 Coder 时通常是 `user` role。把 role 固定在返回值上，会妨碍同一个结果 fan-out 给不同消费者。

因此 Frag 不带 role：

- `prompt` 和 `input` 返回 role-free Frag；
- `agent.do/seqdo` 输入默认使用 `user`，也可显式指定 role；
- `memory.append` 必须指定 role；
- `memory.copy` 保留已存在 Message 的 role，不重新赋 role。

### 3.5 Freedom 区分 move 与 flow

开放决策至少有两个不同尺度：从已暴露行为中选择下一步，以及现有行为不足时组合临时 flow。当前草案分别使用 `freedom.move` 和 `freedom.flow`，避免把二者压缩成一个含义模糊的返回值。

两者都直接返回被选行为的执行结果，而不是只返回一段自然语言计划。Move 的候选集合和临时 flow 都需要经过接口、能力、预算和 policy 检查。

长期 IR patch 或 self-modify 暂不与一次 fallback 混为同一语义；如果真实长期 Agent 案例需要，可以在临时 child flow 之上增加 revision 机制。

### 3.6 宿主脚本是显式非纯边界

复杂判断如果全部拆成 opcode，会让 Core IR 偏离 flow；完全禁止脚本，又会迫使每个 frontend 发明不可移植的隐藏扩展。

当前草案把 Python、TypeScript 和 shell 直接标在指令上，并要求输入显式列出。Runtime/package 可以根据场景允许、沙箱化或拒绝它们。这样 portable flow 与环境绑定 flow 可以共享主体语义，而不会假装两者具有相同部署条件。

## 4. 尚需案例验证的问题

以下内容尚不适合在第一轮直接定死：

- `do` 的最小工作边界由 AFL 统一规定，还是由 Agent adapter 声明；
- dispatch 已区分显式 flow list 与 `count, flow, task` batch；fork 采用 `new_agent = fork source_agent, new_agent.do task` 派生单个上下文分支；iterable map、race、all-settled、并发上限和 cancellation mode 是否进入首版；
- memory 除 append/copy/apply 外，何时需要 format、select、merge 或受控 shared store；
- move package 应采用什么统一接口，`freedom.flow` 应返回哪些可审计的生成信息；
- script instruction 的源码应内联、引用 package symbol，还是两种形式并存；
- 可选 schema 采用 JSON Schema、TypeBox、Zod-compatible 描述还是独立最小格式；
- flow package 如何导出 node、prompt、schema、Agent interface 和 capability；
- timeout、retry、event、checkpoint 等能力应由公共 flow 组合，还是提升为核心指令。

建议用 coder-reviewer、并行 research、三省六部、长期助手和 freedom fallback 逐项检验，而不是只靠抽象讨论增加语法。

## 5. 评审标准

后续检阅一项语法或指令时，可以优先问：

1. 它描述的是稳定的 flow 行为，还是普通宿主计算？
2. 去掉它后，常见 flow 是否明显难写或无法表达？
3. 它能否从两 Agent 案例扩展到任意数量、任意角色和嵌套 flow？
4. Runtime 是否能观察、验证和记录它，而不是只能相信自然语言？
5. 它是否迫使 Core IR 承担 package、schema 或 provider 本应负责的内容？

满足这些标准不代表设计永久固定，只表示它值得进入下一轮实现验证。
