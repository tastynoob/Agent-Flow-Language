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
| Compute value | null、boolean、有限 number、string、list、record | `oper`、script、条件和宿主数据 |
| Symbol | 以 `@` 开头的引用 | Agent、Prompt、Schema、Capability、Flow 等 binding key |
| Handle | Agent、Memory、TaskGroup | 当前 VM 运行中的状态资源 |

Frag 不携带 role。Frag 进入 Agent 或 Memory 时才确定 role。Handle 不能作为 Prompt、外部 Flow 或 Capability 的可移植参数。

## 4. 指令集合

当前 parser 和 VM 实现以下指令：

| 类别 | 指令 |
| --- | --- |
| Agent | `agent`、`agent.sysprompt`、`agent.do` |
| 数据与输入 | `prompt`、`input`、`oper` |
| Script | `python`、`typescript`、`shell` |
| Flow | `call`、两种 `dispatch`、`sync`、`fork` |
| Capability | `invoke` |
| Memory | `memory.append`、`memory.copy`、`memory.apply` |
| 动态 Flow | `freedom.move`、`freedom.flow` |
| 控制流 | `jump`、`ret`、`fail` |

完整操作数格式见[文本语法](syntax.md)，运行行为见[执行语义](semantics.md)。

## 5. Dependency 调度

Basic block 内的指令不因文本相邻而自动串行。VM 从名称引用建立数据依赖，并为 Agent、Memory 和 TaskGroup handle 补充资源读写依赖。所有依赖完成的指令可以并发执行。

同一 Agent 的工作和同一 Memory 的写入按文本顺序执行。使用不同 Memory 且没有数据依赖的 Agent 工作可以并发执行。Basic block 的 terminator 等待该 block 的全部普通指令完成后执行。

需要显式 child flow 生命周期时使用：

- `dispatch [flow_a(...), flow_b(...)]` 启动一组显式调用；
- `dispatch count, flow, task` 启动 `count` 个同构调用；
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
- `moves`
- `freedom`
- `policy`
- `trace`

只有 flow 实际执行到对应能力时，VM 才要求该 binding 存在。纯计算 flow 可以使用空 bindings object。

## 7. 文档边界

- [文本语法](syntax.md)列出 parser 接受的文本形式；
- [执行语义](semantics.md)描述 validator、scheduler 和 VM 行为；
- [Memory 语义](memory.md)描述 Agent、Message 和 Memory handle；
- [示例](../guides/examples.md)展示可解析的组合方式；
- [Parallel Voting](../guides/parallel-voting.md)展示两种 dispatch 形式。

当前实现不提供 package 声明语法、持久化 Memory、retry、race、all-settled 或 iterable map。Agent executor 的运行中事件可以进入 Trace 和可选 `agentHost`，但不是 AFL IR 值。
