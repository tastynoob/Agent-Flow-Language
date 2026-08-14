# AFL IR 概览

## 1. 处理流程

当前实现按以下顺序处理 AFL：

```text
AFL source -> parseAfl -> assertValidModule -> AflVm -> VmBindings
```

Parser 把文本转换为 `AflModule`，validator 检查结构、名称、操作数类别、控制流和 TaskGroup 生命周期。VM 在每次运行时创建独立执行上下文，并通过 bindings 连接外部能力。

## 2. 结构

一个 module 包含若干 node。Node 具有参数和 basic block，并且必须包含 `entry` block。Basic block 包含普通指令和一个 terminator：

```text
main(task):
    entry:
        worker = agent @agent.worker
        result = worker.do task
        ret result
```

普通结果指令使用 `dst = instr ...`。Agent 工作使用 `dst = agent.do ...`。`jump`、`ret` 和 `fail` 结束 basic block。

Node 内的工作值在调用期间保存在同一个 frame 中。`call` 可以同步调用本地 node 或绑定的外部 flow。循环由 `jump` 回到既有 block 表达。

## 3. 值类别

VM 处理四类值：

| 类别 | 表示 | 用途 |
| --- | --- | --- |
| Frag | `{ kind: "frag", content: string }` | Agent、Prompt、Input 和 Flow 的业务文本 |
| Compute value | null、boolean、有限 number、string、list、record | `oper`、`compute`、script、条件和宿主数据 |
| Symbol | 以 `@` 开头的引用 | Agent、Prompt、Schema、Capability、Flow 等 binding key |
| Handle | Agent、Memory、TaskGroup | 当前 VM 运行中的状态资源 |

Frag 不携带 role。Frag 进入 Agent 或 Memory 时才确定 role。Handle 不能作为 Prompt、外部 Flow 或 Capability 的可移植参数。

## 4. 指令集合

当前 parser 和 VM 实现以下指令：

| 类别 | 指令 |
| --- | --- |
| Agent | `agent`、`agent.system_prompt`、`agent.do` |
| 数据与输入 | `prompt`、`input` |
| 计算 | `oper`、`compute` |
| Script | `python`、`typescript`、`shell` |
| Flow | `call`、`dispatch`、`repeat`、`sync`、`fork` |
| Capability | `invoke` |
| Memory | `memory.append`、`memory.copy`、`agent.with_memory` |
| 动态 Flow | `agent.route`、`agent.flow` |
| 控制流 | `jump`、`branch`、`match`、`ret`、`fail` |

完整操作数格式见[文本语法](syntax.md)，运行行为见[执行语义](semantics.md)。

Core IR opcode 与 AFL 表层操作保持一一对应。接收者语法会在 IR 中展开为显式字段，例如 `target.append` 对应 `memory.append`，`planner.route` 对应 `agent.route`；`jump`、`branch` 和 `match` 是三种独立 terminator，不共用兼容形状。

## 5. Dependency 调度

Basic block 内的指令不因文本相邻而自动串行。VM 从名称引用建立数据依赖，并为 Agent、Memory 和 TaskGroup handle 补充资源读写依赖。所有依赖完成的指令可以并发执行。

同一 Agent 的工作和同一 Memory 的写入按文本顺序执行。Agent 工作还使用层次化 Workspace lock：重叠的可写路径串行，互不重叠的主工作区可以并行，共享只读路径不会彼此阻塞。Basic block 的 terminator 等待该 block 的全部普通指令完成后执行。

需要显式 child flow 生命周期时使用：

- `dispatch [flow_a(...), flow_b(...)]` 启动一组显式调用；
- `repeat count, flow(args...)` 启动 `count` 个同构调用；
- `planner.route` 让 planner 从显式候选 Node 中构造动态 TaskGroup；
- `sync` 等待 TaskGroup 并收集结果；
- `fork` 复制 source Agent 的 Memory，创建 branch Agent，并立即执行一次 `do`。

## 6. Bindings

`VmBindings` 中的 adapter 均按需提供：

- `agents`
- `agentExecutor`
- `agentHost`
- `prompts`
- `input`
- `scripts`
- `capabilities`
- `flows`
- `formatters`
- `schemas`
- `policy`
- `trace`
- `memoryPersistence`

只有 flow 实际执行到对应能力时，VM 才要求该 binding 存在。纯计算 flow 可以使用空 bindings object。

Reference VM 提供 `defineBindings()` 作为组合入口。`agents: pi(...)` 会规范化为 `agentExecutor`，函数表式 `capabilities` 会规范化为 `CapabilityAdapter`，`scripts: "typescript"` 会启用显式可信的进程内 script executor。这些 helper 不改变 Core IR 或 adapter 边界，高级宿主仍可直接实现原始接口。

Freedom 不使用单独的 Move 或 Freedom binding。它要求 `agentExecutor` 支持 activation-scoped control tools；候选 Node、Agent 和参数范围直接来自当前 AFL 指令。

## 7. 文档边界

- [文本语法](syntax.md)列出 parser 接受的文本形式；
- [执行语义](semantics.md)描述 validator、scheduler 和 VM 行为；
- [Memory 语义](memory.md)描述 Agent、Message 和 Memory handle；
- [示例](../guides/examples.md)展示可解析的组合方式；
- [Parallel Voting](../guides/parallel-voting.md)展示两种 dispatch 形式。

当前实现不提供 package 声明语法、retry、race、all-settled、iterable map 或完整 VM snapshot 恢复。Canonical Memory 与可选的 executor continuation 可以跨进程落盘；continuation 只能由同名且支持其格式的 backend 恢复。Agent executor 的运行中事件可以进入 Trace 和可选 `agentHost`，但不是 AFL IR 值。
