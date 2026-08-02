# AFL IR 设计草案

状态：讨论稿，尚未定案
日期：2026-08-02

## 1. 定位

AFL IR 是面向 Agent flow 的中间表示。它借用 basic block、指令、跳转和函数调用等形式，但不追求传统编译器 IR 的全部约束，也不试图成为一门包含完整类型系统和通用计算能力的 DSL。

本文中的文本形式用于表达 IR，而不是把 JSON/YAML 配置重新换一种外观。实现内部可以把同一组 node、block、instruction 和 dependency 编码成 AST、JSON 或二进制，但序列化载体不改变 flow 语义。

它主要描述：

- 哪些 Agent 参与工作；
- Agent 接收什么 prompt、memory 和 Frag；
- 工作之间有哪些数据依赖和 flow 依赖；
- 何时跳转、分发、同步或调用其他 flow；
- 常规路径无法覆盖时，何处允许 Agent 自主选择后续行为。

普通计算留给较宽松的 `oper`，复杂计算可以交给显式的 Python、TypeScript 或 shell 指令。这样可以让 IR 的粒度集中在 flow，而不是把每个布尔或字符串操作都拆成底层指令。

## 2. 文档边界

- [文本语法](core-ir-syntax.md)：规定代码长什么样；
- [执行语义](core-ir-semantics.md)：规定 dependency、调度和各类指令的含义；
- [Memory 规则](core-ir-memory.md)：规定 Agent 与 memory 的默认关系和复制行为；
- [示例](core-ir-examples.md)：展示完整 flow；
- [Parallel Voting 案例](afl-case-study-parallel-voting.md)：检验 list dispatch、batch dispatch 与结果汇合；
- [设计说明](core-ir-design-notes.md)：记录当前方案的推导、取舍和待验证问题。

语法、语义和设计分析分开维护，避免把示例写法误当成已经定案的语言规则。

## 3. 基本形态

大部分产生结果的指令采用统一形式：

```text
dst = instr arg0, arg1, ...
```

Agent 可以直接作为指令接收者：

```text
result = coder.do prompt
result = reviewer.seqdo prompt
```

不产生结果的配置指令和控制流终结指令可以省略 `dst`：

```text
coder.sysprompt @prompt.coder
jump next_block
ret result
```

普通关系与逻辑计算直接写成表达式：

```text
finish = oper accepted & tests_passed & !budget_exhausted
```

复杂计算或外部命令使用显式宿主指令：

```text
decision = python "script", review, policy
report = typescript "script", records
status = shell "command", artifact
```

## 4. Flow 结构

Basic block 用标签组织 flow：

```text
review:
    review_result = reviewer.seqdo review_prompt
    finish = oper review_result == "finish"
    jump finish, done, revise
```

可复用 flow 使用类似函数的 node：

```text
review_loop(task):
    entry:
        flow ...
        ret result
```

Node 可以通过 `call` 调用。循环由 basic block 之间的回跳形成，不需要单独定义 `while` 指令。

## 5. Dependency 与并行

AFL IR 不是把文本逐行翻译成单线程执行过程。一个 basic block 内，VM 根据数据、flow 和运行资源之间的依赖判断哪些指令已经可以开始。

例如四个 Agent 分别执行互不依赖的工作时，四条调用可以并行；如果后续指令读取它们的结果，则等所需结果产生后再运行。`dispatch` 用于创建不继承某个 Agent 上下文的 child flow，`fork` 用于复制已有 Agent 的 Memory 并立即启动一个新 Agent 分支，`sync` 用于等待和收集 dispatch 结果。

`dispatch` 有两种形式：`dispatch [flow_a(...), flow_b(...)]` 手工列出 child flow；`dispatch count, flow, task` 批量启动相同 flow。`new_agent = fork source_agent, new_agent.do task` 则把 `memory.copy`、`memory.apply` 和启动动作组合成一条上下文分支指令。Batch count 可以是常量，也可以由 Agent 输出后解析成整数。VM policy 可以限制同时运行数量，但不改变声明的逻辑 Worker 数量。

文本顺序、同一 Agent 的连续调用、memory 读写与显式 dependency 之间如何配合，见执行语义草案。这里的目标是同时容纳数据流并行和易读的 Agent 工作过程，而不是预设所有指令都串行或都并行。

## 6. 核心能力

当前草案围绕以下能力组织：

| 类别 | 指令或形式 | 用途 |
| --- | --- | --- |
| Agent | `agent`、`agent.sysprompt` | 创建 Agent，设置 system prompt |
| 工作 | `agent.do`、`agent.seqdo` | 单次工作与连续多步工作 |
| Frag | `prompt`、`input` | 构造 prompt Frag，等待外部输入 Frag |
| 数据 | `oper`、`python`、`typescript`、`shell` | 粗粒度计算和宿主扩展 |
| 控制 | `jump`、`ret`、`fail` | block 跳转和 node 退出 |
| 组合 | `call`、`dispatch`、`fork`、`sync` | flow 调用、独立派发、Agent 上下文分支和汇合 |
| 能力 | `invoke` | 显式调用 skill、MCP 或其他 capability |
| Memory | `memory.append`、`memory.copy`、`memory.apply` | 写入 role message，复制 Memory，把 Memory 应用到新 Agent |
| 动态行为 | `freedom.move`、`freedom.flow` | 选择允许的 move，或生成临时 flow |

这是一组初始核心，不表示未来只能有这些指令。新增指令应优先代表稳定、通用的 flow 行为，而不是把宿主语言已有的细粒度计算逐项搬入 IR。

## 7. Frag 与外部符号

普通业务数据统一表示为不带 role 的字符串 wrapper，暂称 `Frag`：

```text
Frag = wrapper<string>
```

`do`、`seqdo`、`prompt`、`input`、`invoke` 和 `call` 等数据指令返回 Frag。JSON 可以作为 Frag content 的格式，但 Core IR 不把 JSON object 作为独立数据系统；flow 也可以约定纯文本或其他字符串协议。

`oper` 和 script executor 返回本地 compute value。`agent`、`memory.copy`、`memory.apply`、`dispatch`、`fork` 等资源指令返回 handle，不把运行资源伪装成字符串。

Agent 输出仍可附带 schema symbol，用于要求和校验 JSON 等格式；校验后返回值仍是 Frag。Prompt、schema、format、Agent、flow、skill 和 MCP 接口通过 `@...` symbol 引用。

## 8. Memory

创建 Agent 时默认创建并绑定 working memory。`agent.do` 和 `agent.seqdo` 自动使用这份 memory，不需要每次显式传入。

Reviewer 可以从 Coder 的 memory 复制上下文后工作，也可以使用自己的空 memory 做无上下文 review。复制后的 memory 与来源分离，Reviewer 后续写入不会自动修改 Coder memory。`memory.apply` 可以沿用 source Agent 的 binding 与配置，把指定 Memory 绑定到一个新的 Agent handle。

Frag 自身不带 role。它进入 Memory 时必须指定 role：

```text
memory.append coder.memory, user, review_result
```

把 Frag 直接传给 `agent.do/seqdo` 时，role 默认是 `user`。Agent 输出在来源 Memory 中使用 `assistant` role，但返回给 flow 的 Frag 仍然不带 role。`memory.copy` 复制已经带 role 的完整消息，因此保留原 role，不需要新的 role operand。

## 9. Freedom

`freedom` 作为正式指令族保留。它适合出现在已知分支的 fallback、候选 flow 全部失败后的恢复路径，或者显式开放的规划节点。

- `freedom.move` 从 flow 暴露的候选 move 中选择并执行一步；
- `freedom.flow` 选择已有 flow，或生成一个有作用域的临时 child flow。

两种结果都要经过 VM 的接口、能力和 policy 检查。是否进一步支持修改当前 node 或创建长期 revision，仍需要结合真实案例继续收敛。

## 10. 工具链

```text
Python / TypeScript generator / future AFL DSL
                         |
                         v
                      AFL IR
                         |
              validator / TypeScript VM
                         |
             Agent / Memory / Capability adapter
```

当前文本草案尚未绑定 parser、validator 或 VM 的内部数据结构。实现应以收敛后的语法和语义为输入，而不是从历史代码接口反推语言设计。
