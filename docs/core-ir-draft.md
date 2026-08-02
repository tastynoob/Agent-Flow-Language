# AFL Core IR 初步定义

状态：待检阅草案，不代表最终设计
日期：2026-08-02

## 1. 背景与定位

当前已经实现的 `FlowNode` 模型直接包含 `loop`、`forEach`、`parallel`、`retry`、`timeout`、`try` 和 `freedom` 等高层节点。它能够描述和执行工作流，但更接近 structured workflow AST 或配置模型，没有形成最小、正交、可自由组合的底层指令集合。

本草案将 AFL 分为两个语义层：

```text
Python / TypeScript / future AFL DSL
                 |
                 v
        AFL HIR (authoring-oriented)
                 |
              lowering
                 |
                 v
       AFL Core IR (instruction-oriented)
                 |
                 v
             AFL VM
```

- HIR 面向编写，可以保留 `while`、`retry`、`parallel map`、review loop 等高层结构；
- Core IR 面向验证和执行，只包含基本块、类型化寄存器、少量正交指令和 terminator；
- VM 只执行 Core IR，不直接解释 HIR；
- JSON、文本汇编或二进制只是 Core IR 的序列化形式，不决定其语义层级。

当前 `docs/ir-v0.1.md` 及其代码实现暂时重新定位为 HIR prototype。Core IR 在本草案通过检阅前不进入代码实现。

## 2. 设计目标

Core IR 应满足：

1. 最小性：复杂 flow 由少量 primitive 组合，而不是每种模式增加一种节点；
2. 正交性：控制流、数据流、Agent 工作、外部 effect 和并发彼此独立；
3. 显式性：输入、输出、跳转、任务 handle、memory snapshot 和错误路径均可见；
4. 可验证性：执行前可以检查寄存器、类型、控制流、capability 和资源生命周期；
5. 可执行性：Core IR 的每条指令都有确定的 VM 状态迁移；
6. 可扩展性：skill、MCP 和其他 runtime 能力经通用 `invoke` 接入，不需要加入 provider-specific 指令；
7. 动态性：支持验证后加载和调用 Agent 生成的新 flow；
8. 可暂停性：`userinput` 等指令可以安全挂起、持久化和恢复 VM frame。

Core IR 不以内建网页、文件、shell、数据库或某种 MCP transport 为目标。它可以显式调用这些 capability，但不实现 capability 本身。

## 3. 基础执行模型

一个 flow 由 basic block 组成。每个 block 包含：

- 零个或多个 block parameter；
- 零个或多个普通 instruction；
- 恰好一个 terminator。

普通 instruction 计算结果或产生 effect，然后继续执行下一条 instruction。只有 terminator 可以改变控制流。

```ts
type RegisterId = `%${string}`;
type BlockId = `^${string}`;
type SymbolRef = `@${string}`;

interface CoreModule {
  coreVersion: "0.1-draft";
  name: string;
  types: Record<string, TypeDefinition>;
  agents: Record<string, AgentInterface>;
  capabilities: Record<string, CapabilityInterface>;
  flows: Record<string, CoreFlow>;
  entry?: SymbolRef;
}

interface CoreFlow {
  parameters: Parameter[];
  returnType: AflType;
  errorType?: AflType;
  blocks: CoreBlock[];
  entry: BlockId;
  effects?: EffectDeclaration[];
}

interface CoreBlock {
  id: BlockId;
  parameters: RegisterDeclaration[];
  instructions: Instruction[];
  terminator: Terminator;
}

interface RegisterDeclaration {
  id: RegisterId;
  type: AflType;
}

type Parameter = RegisterDeclaration;

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface TypeDefinition {
  parameters?: string[];
  body: AflType;
}

interface FunctionSignature {
  parameters: AflType[];
  returns: AflType;
}

interface AgentInterface {
  input: AflType;
  output: AflType;
  session?: AflType;
  userResponse?: AflType;
  requiredCapabilities?: SymbolRef[];
}

interface CapabilityInterface {
  input: AflType;
  output: AflType;
  error: AflType;
}

interface EffectDeclaration {
  capability: SymbolRef;
  policy?: "required" | "optional";
}
```

寄存器采用 single-assignment。循环中的变化值通过 block parameter 传递，不通过隐式全局变量覆盖：

```text
^loop(%artifact: Artifact):
    %review = call @review(%artifact)
    %accepted = is %review, accepted
    branch %accepted, ^done(%artifact), ^revise(%artifact, %review)

^revise(%old: Artifact, %review: Review):
    %revision = unwrap %review, revision_required
    %request = make RevisionRequest { artifact: %old, revision: %revision }
    %next = call @revise_artifact(%request)
    jump ^loop(%next)
```

## 4. 类型系统草案

### 4.1 值类型

```ts
type AflType =
  | { kind: "unit" }
  | { kind: "bool" }
  | { kind: "int"; bits?: 32 | 64 }
  | { kind: "float"; bits?: 32 | 64 }
  | { kind: "string" }
  | { kind: "bytes" }
  | { kind: "prompt"; role: "system" | "user" | "interaction" }
  | { kind: "named"; name: SymbolRef; arguments?: AflType[] }
  | { kind: "list"; element: AflType }
  | { kind: "tuple"; elements: AflType[] }
  | { kind: "record"; name?: string; fields: Record<string, AflType> }
  | { kind: "variant"; name?: string; cases: Record<string, AflType> }
  | { kind: "option"; value: AflType }
  | { kind: "result"; ok: AflType; error: AflType }
  | { kind: "handle"; handle: HandleType }
  | { kind: "flow"; parameters: AflType[]; returns: AflType };
```

`record` 表示结构化数据，`variant` 表示带 tag 的 union。Agent review 不应返回无含义的 bool，而应返回例如：

```text
type Review = variant {
    accepted: unit,
    revision_required: record { issues: list<Issue> },
    blocked: record { reason: string }
}
```

### 4.2 Handle 类型

```ts
type HandleType =
  | { kind: "agent"; interface: SymbolRef }
  | { kind: "agent_session"; interface: SymbolRef }
  | { kind: "memory"; value: AflType; mode: "snapshot" | "shared" }
  | { kind: "task"; result: AflType }
  | { kind: "capability"; interface: SymbolRef }
  | { kind: "dynamic_flow"; parameters: AflType[]; returns: AflType }
  | { kind: "input_request"; response: AflType };
```

handle 是 VM/runtime 资源引用，不是 provider URL 或 secret。portable IR 只记录其逻辑类型和 symbol，部署时由 runtime binding 解析。

初步约束：

- `task<T>` 是 affine resource，只能被一次 `sync` 或 `cancel` 消费；
- `agent` 配置不可变，可以安全传给多个分支；
- `agent_session` 是否允许跨分支共享仍待决定，默认不允许；
- `memory<snapshot>` 可复制，`memory<shared>` 需要显式声明并由 policy 授权；
- `dynamic_flow` 只能由 verifier 产生，不能由普通数据直接 cast。

### 4.3 指令结果

每条指令声明零个或一个类型化结果寄存器。需要返回多个值时使用 `record` 或 `tuple`，不额外引入多返回值语义：

```ts
interface ResultRegister {
  id: RegisterId;
  type: AflType;
}

interface InstructionBase {
  id?: string;
  result?: ResultRegister;
  metadata?: Record<string, JsonValue>;
}

type Operand =
  | { kind: "register"; register: RegisterId }
  | { kind: "immediate"; type: AflType; value: JsonValue }
  | { kind: "symbol"; symbol: SymbolRef };

type InstructionOpcode =
  | "const" | "make" | "get" | "variant" | "is" | "unwrap" | "op"
  | "agent" | "sysprompt" | "userprompt" | "do" | "seqdo"
  | "userinput" | "invoke"
  | "call" | "flow.verify" | "call_indirect"
  | "fork" | "sync" | "cancel"
  | "load" | "store" | "checkpoint";

interface Instruction extends InstructionBase {
  op: InstructionOpcode;
  operands: Operand[];
  attributes?: Record<string, JsonValue>;
}
```

上面是初步的 portable encoding 公共外形；每个 opcode 的 operand、result 和 attribute 约束由下方指令表及后续规范逐项定义，不能把任意 operand 数组视为合法指令。

可能失败的 effect instruction 返回显式 tagged outcome。`invoke` 等通用 effect 使用 `result<T, E>`；Agent 指令使用包含 `failed` case 的 `AgentStep/AgentExit`，不再额外嵌套一层 `result`。业务失败进入显式控制流，VM 自身损坏、非法 IR 等 verifier/runtime fault 不伪装成业务结果。

## 5. 初步指令集合

指令名为草案。这里优先确定语义边界，暂不固定最终拼写。

### 5.1 数据指令

| 指令 | 输入 | 输出 | 语义 |
| --- | --- | --- | --- |
| `const` | 类型与常量 | `T` | 创建不可变常量 |
| `make` | 多个寄存器 | record/list/tuple | 构造结构化值 |
| `get` | 结构化值、field/index | field type | 读取字段或元素 |
| `variant` | tag、payload | variant type | 构造 tagged union |
| `is` | variant、tag | bool | 检查 variant tag |
| `unwrap` | variant、tag | payload type | 在已验证 tag 下读取 payload |
| `op` | operands | typed result | 比较、布尔和基础数值运算 |

`move` 不是必需指令，因为寄存器引用本身即可传值。复杂数据处理将来可以通过纯 function 或标准 flow 提供，不应无限扩充 `op`。

### 5.2 Agent 与 prompt 指令

| 指令 | 输入 | 输出 | 初步语义 |
| --- | --- | --- | --- |
| `agent` | Agent symbol | `agent<I>` | 绑定逻辑 Agent interface |
| `sysprompt` | agent、prompt value | 新 `agent<I>` | 返回带 system prompt 的不可变 Agent handle |
| `userprompt` | template、typed arguments | prompt value | 构造自动化 user prompt，不产生外部交互 |
| `do` | agent/session、input | `AgentStep<O>` | 执行一次明确的 Agent 工作单元 |
| `seqdo` | agent/session、input、budget | `AgentExit<O>` | 允许 Agent 连续工作，直到完成、阻塞或预算耗尽 |

候选 Agent 状态类型：

```text
AgentStep<T, I, R> = variant {
    completed: T,
    continue: record { session: agent_session<I>, observation: option<T> },
    needs_input: record {
        session: agent_session<I>,
        request: input_request<R>
    },
    failed: AgentError
}

AgentExit<T, I, R> = variant {
    completed: T,
    needs_input: record {
        session: agent_session<I>,
        request: input_request<R>
    },
    budget_exhausted: record { session: agent_session<I> },
    failed: AgentError
}
```

这里的 `I` 是 Agent interface，`R` 是该 interface 允许的用户响应类型。为保持 assembly 示例可读，后文的 `AgentStep<Artifact>` 省略可由 Agent handle 推导出的 `I` 和 `R`。

`seqdo` 是否属于 Core primitive 仍待检阅。更严格的最小设计可以只保留 `do`，由 HIR 将 `seqdo` lowering 为 `do + branch + jump`。但对于 Codex、Claude Code 等不可拆分的长任务 adapter，`seqdo` 也可能需要成为明确的 runtime intrinsic。

### 5.3 用户输入与外部 capability

| 指令 | 输入 | 输出 | 语义 |
| --- | --- | --- | --- |
| `userinput` | prompt、response type | `result<T, InputError>` | 挂起 VM，等待用户输入后恢复 |
| `invoke` | capability symbol/handle、typed input | `result<O, InvokeError>` | 显式调用 skill、MCP 或其他外部能力 |

`invoke` 是通用 effect boundary。例如：

```text
%weather = invoke @weather.get, %location
```

Core IR 知道 `@weather.get` 的 input/output 类型和所需 capability，但不知道它是否通过 MCP、HTTP、本地 skill 或其他 transport 执行。AFL 不提供 `browse`、`click`、`fetch_url` 等 provider-specific opcode。

### 5.4 Flow 调用

| 指令 | 输入 | 输出 | 语义 |
| --- | --- | --- | --- |
| `call` | 静态 flow symbol、arguments | flow return type | 调用已链接的 flow |
| `flow.verify` | 未信任的 flow data、constraints | `result<dynamic_flow<Sig>, VerifyError>` | 验证动态生成的 Core IR |
| `call_indirect` | dynamic flow handle、arguments | flow return type | 调用已经验证的动态 flow |

可复用的“flow 集”在 Core 层表现为 module/package 中导出的多个类型化 flow symbol。版本、依赖和导入属于 linker/package 层，不进入 `call` 的运行时语义。

### 5.5 并发指令

| 指令 | 输入 | 输出 | 语义 |
| --- | --- | --- | --- |
| `fork` | flow symbol/handle、arguments | `task<T>` | 在独立 child frame 中启动 flow |
| `sync` | task handles、mode | 结构化结果 | 等待 `all`、`all_settled` 或 `race` |
| `cancel` | task handle、reason | unit | 请求取消 task 并消费 handle |

第一版 `fork` 只启动 flow，不直接跳入当前 flow 的任意 instruction address。这样 child 有明确签名、frame 和返回类型，也便于 package 化。

fork 不隐式共享可写 memory：

```text
%snapshot = call @memory.snapshot(%memory)
%a = fork @research(%snapshot, "security")
%b = fork @research(%snapshot, "performance")
%results = sync all [%a, %b]
%next_memory = call @memory.merge(%snapshot, %results)
```

- 普通不可变值按值传递；
- snapshot handle 可以安全复制；
- shared memory 必须以 `memory<T, shared>` 显式传入；
- `sync all` 的结果顺序由输入 task 顺序决定，不由完成先后决定；
- `sync race` 选出第一个成功结果并取消其他 task；
- 三种 `sync` mode 都消费传入的全部 task handle；
- 分支状态不会隐式执行 last-writer-wins merge。

同类型 task 的初步结果类型为：`all` 返回 `list<T>`，`all_settled` 返回 `list<result<T, TaskError>>`，`race` 返回 `result<record { index: int, value: T }, AggregateTaskError>`。异构 task 是否允许同一次 `sync`，留待 tuple typing 方案确定。

### 5.6 状态指令

候选指令：

| 指令 | 输入 | 输出 | 语义 |
| --- | --- | --- | --- |
| `load` | memory handle、key/path | typed value | 从显式 memory 读取 |
| `store` | memory handle、key/path、value | 新 memory handle 或 unit | 更新 memory |
| `checkpoint` | serializable frame values | checkpoint handle | 请求 runtime 保存恢复点 |

尚未决定 `store` 应返回新的不可变 memory version，还是允许对显式 shared handle 产生 effect。默认倾向：业务数据优先使用 SSA value 或 snapshot memory；shared mutation 是需要 effect/policy 声明的例外。

## 6. Terminator 集合

Terminator 不产生隐式 fallthrough：

```ts
type Terminator =
  | {
      op: "jump";
      target: BlockId;
      arguments: RegisterId[];
    }
  | {
      op: "branch";
      condition: RegisterId;
      then: { target: BlockId; arguments: RegisterId[] };
      else: { target: BlockId; arguments: RegisterId[] };
    }
  | { op: "return"; value: RegisterId }
  | { op: "fail"; error: RegisterId };
```

`return` 的值必须匹配 `CoreFlow.returnType`。只有声明了 `errorType` 的 flow 才能使用 `fail`，且错误寄存器必须匹配该类型；`call` 遇到 callee fail 时究竟返回 `result` 还是走独立 error edge，仍属于第 12 节的待检阅问题。

用户设想中的“条件 jump”在本草案中拆为：

- `jump`：无条件跳转；
- `branch`：根据 bool 选择两个目标。

这种拆分便于 verifier 确保每个 block 的 successor、参数和类型明确。多分支 `switch` 可以先 lowering 为多个 block/branch，是否加入 Core primitive 待真实案例验证。

## 7. 完整示例

```text
module @review_example

flow @review_loop(%task: Task) -> Artifact throws FlowError {
^entry:
    %coder0 = agent @coder
    %coder_system = const system_prompt "You are a coding agent."
    %coder = sysprompt %coder0, %coder_system
    %reviewer0 = agent @reviewer
    %reviewer_system = const system_prompt "Review the artifact as JSON."
    %reviewer = sysprompt %reviewer0, %reviewer_system

    %work_args = make { task: %task }
    %work_prompt = userprompt "Implement: {task}", %work_args
    %initial_step = do %coder, %work_prompt
    %initial_completed = is %initial_step, completed
    branch %initial_completed, ^initial_ready(%initial_step), ^artifact_step_incomplete(%initial_step)

^initial_ready(%step: AgentStep<Artifact>):
    %artifact = unwrap %step, completed
    jump ^review(%artifact)

^review(%artifact: Artifact):
    %review_args = make { artifact: %artifact }
    %review_prompt = userprompt "Review: {artifact}", %review_args
    %review_step = do %reviewer, %review_prompt
    %review_completed = is %review_step, completed
    branch %review_completed, ^review_ready(%artifact, %review_step), ^review_step_incomplete(%review_step)

^review_ready(%artifact: Artifact, %step: AgentStep<Review>):
    %report = unwrap %step, completed
    %accepted = is %report, accepted
    branch %accepted, ^done(%artifact), ^review_rejected(%artifact, %report)

^review_rejected(%artifact: Artifact, %report: Review):
    %revision_required = is %report, revision_required
    branch %revision_required, ^revise(%artifact, %report), ^review_not_revision(%report)

^review_not_revision(%report: Review):
    %is_blocked = is %report, blocked
    branch %is_blocked, ^blocked(%report), ^invalid_review(%report)

^revise(%artifact: Artifact, %report: Review):
    %revision = unwrap %report, revision_required
    %revision_args = make { revision: %revision }
    %prompt = userprompt "Revise using: {revision}", %revision_args
    %next_step = do %coder, %prompt
    %next_completed = is %next_step, completed
    branch %next_completed, ^revision_ready(%next_step), ^artifact_step_incomplete(%next_step)

^revision_ready(%step: AgentStep<Artifact>):
    %next = unwrap %step, completed
    jump ^review(%next)

^artifact_step_incomplete(%outcome: AgentStep<Artifact>):
    %error = make AgentOutcomeError { outcome: %outcome }
    fail %error

^review_step_incomplete(%outcome: AgentStep<Review>):
    %error = make AgentOutcomeError { outcome: %outcome }
    fail %error

^blocked(%report: Review):
    %detail = unwrap %report, blocked
    %error = make ReviewBlockedError { detail: %detail }
    fail %error

^invalid_review(%report: Review):
    %error = make InvalidReviewError { report: %report }
    fail %error

^done(%artifact: Artifact):
    return %artifact
}
```

这段文本只是可读的 assembly notation。最终 JSON 或其他 portable encoding 可以把同样的 block、instruction、operand 和 terminator 编码为结构化数据，但不得改变语义。

## 8. 高层结构的 Lowering

Core IR 不需要为每种 flow pattern 定义 opcode：

| HIR construct | Core lowering |
| --- | --- |
| `sequence` | 同一 block 中连续 instruction |
| `if/match` | `branch` 和多个 block |
| `while/loop` | block parameter、`branch`、回边 `jump` |
| `forEach` | iterator/index value、loop blocks，可选 `fork` |
| `parallel` | 多个 `fork` 加一个 `sync` |
| `retry` | attempt block、result branch、counter 和 jump |
| `timeout` | 工作 task、timer capability task、`sync race`、`cancel` |
| `try/catch` | `result` variant、`is/unwrap` 和 branch |
| `freedom` | planner `do`、`flow.verify`、`call_indirect` |
| review loop | `do`、Review variant、branch 和 jump |

如果某个 HIR construct 无法完整 lowering 为 Core IR，说明 Core primitive 或 HIR 语义仍不完整。runtime adapter 不得用未声明的宿主 orchestration 补足缺失语义。

## 9. VM 状态草案

一个运行中的 VM 至少维护：

```text
RunState {
    run_id
    current_flow
    current_block
    instruction_pointer
    register_file
    call_stack
    task_table
    resource_handles
    effect_log
    budgets
}
```

`userinput`、外部 event 或 checkpoint 挂起时，可持久化上述可序列化状态。Agent session、shared memory 和外部 task 等 handle 需要 adapter 提供 resume token，或者明确声明为不可恢复资源。

VM 是协作式调度器：普通 instruction 执行至完成；`fork` 创建 child frame；effect instruction 可以返回 pending/suspended；`sync` 和 `userinput` 可以挂起当前 frame。任何无限循环仍受 run step、时间和成本 budget 限制。

## 10. Verifier 最低要求

执行前至少验证：

1. flow、block、instruction result 和 symbol 唯一；
2. 每个 block 恰好有一个 terminator；
3. 每个寄存器在使用前已定义且支配使用点；
4. block argument 数量与类型匹配 block parameter；
5. `branch` condition 是 bool；
6. `return/fail` 分别匹配 flow 的 `returnType/errorType`；
7. `call/fork` 参数与 flow signature 匹配；
8. `invoke` capability 已声明且 input/output 类型匹配；
9. `do/seqdo` 的 Agent interface 与输入输出匹配；
10. `sync/cancel` 正确消费 task handle；
11. `flow.verify` 的约束、预算、允许 capability 和签名有效；
12. 可挂起位置的 live register 可以 checkpoint，或显式声明不可恢复；
13. Core IR 中不存在未注册 opcode 和 host-language callback。

后续可以加入 unreachable block、无退出循环、未消费 task、潜在 deadlock 和 effect policy 等检查，但这些不阻塞最小 VM 起步。

## 11. 与现有实现的关系

当前代码不立即删除，暂按以下方式理解：

- 现有 `AflProgram/FlowNode`：structured HIR prototype；
- 现有 TypeScript/Python builder：HIR frontend prototype；
- 现有 validator：可复用 schema、symbol 和 capability 检查思路；
- 现有 runtime：语义实验品，后续不作为 Core VM 架构基础；
- 现有 adapter、trace、错误规范：多数可以在 Core VM 中复用；
- portable package 的最终执行载荷：应是通过 verifier 的 Core IR，而不是当前 HIR。

在 Core IR 定稿前，不继续向现有 `FlowNode` union 增加新的高层节点，以免进一步固化错误抽象。

## 12. 待检阅问题

以下问题需要在实现前明确：

1. `seqdo` 是 Core primitive，还是只存在于 HIR 并 lowering 为 `do` loop？
2. `do` 的最小工作单元是一次模型 turn、一次 Agent runtime invocation，还是由 Agent interface 声明？
3. `sysprompt/userprompt` 应保留为显式 opcode，还是作为不可变 prompt/agent value 的构造指令？
4. Core 是否允许 shared mutable memory，还是第一版只允许 snapshot 和 SSA value？
5. `sync` 的 `all/all_settled/race` 都作为 Core mode，还是由更少 primitive 组合？
6. task handle 是否严格 linear，是否允许多个 observer 等待同一个 task？
7. `invoke` 是否覆盖所有外部 effect，还是只覆盖 skill/MCP，其他 effect 另设 opcode？
8. `userinput` 返回普通 `T` 还是显式 `result<T, InputError>`？
9. flow error 使用返回的 `result`、独立 error edge，还是两者并存？无论选择哪一种，`fail` 都必须匹配 flow 声明的 `errorType`。
10. `flow.verify/call_indirect` 是否足以表达 freedom self-modify，何时需要持久 package revision？
11. 类型采用 structural record 为主，还是 package 内 nominal type 为主？
12. 第一版是否直接定义文本 assembly，还是先只定义抽象数据模型和 verifier？

这些选择会直接影响 VM、lowering 和 package ABI。本草案只提供可讨论的初步边界，不把它们提前视为已确认结论。

## 13. 检阅后的实现顺序

草案通过检阅后再执行：

1. 固定 Core type grammar、opcode 表和 terminator；
2. 实现 Core IR verifier；
3. 用手写 Core IR 跑通 review loop、fork/sync 和 userinput suspension；
4. 实现最小 VM；
5. 实现当前 HIR 到 Core IR 的 lowering；
6. 调整 TypeScript/Python frontend，使其生成 HIR 并编译为 Core IR；
7. 用 conformance tests 替换当前直接解释 HIR 的 runtime contract。
