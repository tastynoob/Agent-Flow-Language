# AFL Structured Flow HIR Prototype v0.1

状态：已实现的高层语义实验，待 Core IR 检阅后重新定位
日期：2026-08-02

> 设计复核发现，本模型直接把 `loop`、`parallel`、`retry` 等高层结构作为节点，更适合作为 HIR，而不是最终 Canonical Core IR。新的指令式 Core IR 初步定义见 [Core IR 草案](core-ir-draft.md)。本文件保留用于记录已经实现和测试过的高层语义，不再作为底层 VM 指令规范。

## 1. 范围

AFL IR 只定义 Agent 工作流，不定义网页访问、文件读写、shell、数据库协议或 MCP tool 的具体行为。这些能力属于 Agent、skill、MCP server 或 runtime adapter。

IR 可以声明某个 Agent 需要哪些抽象 capability，并通过 `invoke` 请求 Agent operation，但不会出现 `fetch`、`browse`、`click`、`readFile` 等内建节点。部署方负责把逻辑 Agent ID 绑定到具体实现，并决定是否授予所声明的能力。

v0.1 必须能够表达：

- 顺序、条件、循环和 flow 调用；
- Agent 调用及结构化结果；
- 隔离并行、竞争和并行 map；
- retry、timeout、catch/finally、delay 和 cancellation；
- event emit/wait 与 checkpoint；
- `freedom` 生成的动态 continuation 或新 flow revision；
- 可验证的数据 schema、状态、trace 和运行预算。

## 2. 顶层结构

```ts
interface Program {
  irVersion: "0.1";
  name: string;
  entry: string;
  schemas?: Record<string, DataSchema>;
  agents?: Record<string, AgentDeclaration>;
  flows: Record<string, FlowDefinition>;
  metadata?: Record<string, JsonValue>;
}
```

`entry` 必须引用 `flows` 中的 flow。程序、flow、Agent、operation 和节点 ID 在各自作用域内必须唯一。

IR 是语言无关的数据模型。第一版使用 JSON 作为 `.aflir` 的序列化方式，JSON 不是 AFL 的运行语义，也不限制 flow 的动态性。

## 3. 数据 Schema

v0.1 使用一个小型、可移植的 schema union：

```ts
type DataSchema =
  | { type: "any" }
  | { type: "null" }
  | { type: "boolean" }
  | { type: "number"; integer?: boolean; minimum?: number; maximum?: number }
  | { type: "string"; minLength?: number; maxLength?: number; pattern?: string }
  | { type: "enum"; values: JsonPrimitive[] }
  | { type: "array"; items: DataSchema; minItems?: number; maxItems?: number }
  | {
      type: "object";
      properties: Record<string, DataSchema>;
      required?: string[];
      additionalProperties?: boolean;
    }
  | { type: "oneOf"; variants: DataSchema[] }
  | { type: "ref"; name: string };
```

命名 schema 位于 `Program.schemas`。引用必须能够解析，不允许循环引用导致 validator 无限递归。`any` 用于 adapter 边界和逐步迁移，不应成为所有 Agent output 的默认类型。

## 4. Agent 声明

```ts
interface AgentDeclaration {
  description?: string;
  capabilities?: string[];
  operations: Record<string, {
    input: DataSchema;
    output: DataSchema;
  }>;
}
```

Agent 声明只描述接口，不包含 URL、API key、模型名称或 tool 实现。`capabilities` 是供部署和 policy 检查的不可解释字符串，例如 `code.review` 或 `artifact.write`，不是 AFL 关键字。

runtime binding 根据 `(agentId, operation)` 接收 JSON input 并返回 JSON output。input 和 output 均按 operation schema 做运行时检查。

## 5. Flow 与变量

```ts
interface FlowDefinition {
  input: DataSchema;
  output: DataSchema;
  state?: Record<string, SlotDeclaration>;
  locals?: Record<string, SlotDeclaration>;
  body: FlowNode;
}

interface SlotDeclaration {
  schema: DataSchema;
  initial?: JsonValue;
}
```

- `input`：调用期间只读；
- `state`：flow 的可变业务状态，进入 checkpoint；
- `local`：flow invocation 内的临时值；
- 外部长时 memory：作为显式 handle 或普通数据通过 input/Agent operation 传递，不由 AFL 假定具体存储实现。

v0.1 的赋值目标是完整 slot，不支持隐式嵌套路径原地修改。需要更新 record 时构造新 record 并重新赋值，使 trace 和并发行为保持清晰。

## 6. 表达式

表达式没有副作用：

```ts
type Expr =
  | { kind: "literal"; value: JsonValue }
  | {
      kind: "ref";
      scope: "input" | "state" | "local";
      name?: string;
      path?: Array<string | number>;
    }
  | { kind: "object"; entries: Record<string, Expr> }
  | { kind: "array"; items: Expr[] }
  | { kind: "unary"; op: "not" | "negate" | "isNull"; value: Expr }
  | {
      kind: "binary";
      op:
        | "eq" | "neq" | "lt" | "lte" | "gt" | "gte"
        | "and" | "or" | "add" | "subtract" | "multiply" | "divide"
        | "concat" | "coalesce" | "in";
      left: Expr;
      right: Expr;
    };
```

`input` ref 在未指定 `name` 时引用完整 flow input。`state` 和 `local` 必须指定已声明的 slot。`path` 按顺序读取 object key 或 array index，读取不存在的路径是运行错误。

`and`、`or` 和 `coalesce` 短路求值。比较不会做字符串与数字之间的隐式转换。

## 7. 节点集合

每个节点都有在当前 flow 内唯一且稳定的 `id`，用于 diagnostics、trace、checkpoint 和动态约束检查。

### 7.1 基本控制流

- `noop`：无操作；
- `sequence`：按顺序执行子节点，遇到 `return` 或失败立即停止；
- `assign`：计算表达式并替换一个 state/local slot；
- `branch`：按声明顺序选择第一个为真的 case，否则执行 optional default；
- `loop`：条件为真时执行 body，并受必需的 `maxIterations` 限制；
- `return`：结束当前 flow 或隔离分支并产生结构化值；
- `fail`：以结构化 error 终止当前路径。

### 7.2 调用

- `invoke`：调用声明过的 Agent operation，可将结果写入 slot；
- `callFlow`：以计算后的 input 调用另一个 flow，可将结果写入 slot。

`invoke` 不等于 tool call。Agent 是否以及如何使用 skill、MCP、网页或文件能力不属于 AFL IR。

### 7.3 并发

- `parallel`：运行命名分支，mode 为 `all`、`allSettled` 或 `race`；
- `forEach`：对数组运行隔离 body，支持 `maxConcurrency`，结果保持输入顺序。

每个并发分支获得父 frame 的 state/local 深拷贝。分支赋值不隐式合并回父 frame，分支必须用 `return` 导出结果，由父节点写入一个明确 slot。这样避免 last-writer-wins 和调度顺序导致的不确定状态。

结果形状：

- `parallel/all`：`Record<branchId, value>`；
- `parallel/allSettled`：每个 branch 为 `{status, value}` 或 `{status, error}`；
- `parallel/race`：第一个成功分支产生 `{branch, value}` 并取消未结束分支；全部失败时整体失败；
- `forEach`：与输入数组同序的 result array。

### 7.4 可靠性

- `retry`：失败后按固定或指数 backoff 重试，`maxAttempts` 包含第一次执行；
- `timeout`：超过 `timeoutMs` 后取消 body 并产生 `TIMEOUT` error；
- `try`：执行 body、optional catch 和 optional finally；
- `delay`：可取消的定时等待；
- `checkpoint`：请求 checkpoint adapter 持久化当前 flow state 和 trace cursor。

每次 retry attempt 使用进入节点前的 frame snapshot。失败 attempt 的 state/local 变更不提交；已经发生的外部 Agent 副作用不能由 AFL 自动回滚，需要业务 flow 显式设计幂等 operation 或 compensation。

### 7.5 事件

- `emit`：通过 event adapter 发布命名事件和 JSON payload；
- `awaitEvent`：等待命名事件，可设置 timeout，并将 payload 写入 slot。

事件 transport、持久化和跨进程投递语义由 adapter 提供。reference runtime 保证 abort 和 timeout 传播。

### 7.6 Freedom

`freedom` 指定 planner Agent operation、上下文表达式和动态约束。planner 返回：

```ts
type FreedomPlan =
  | { kind: "continuation"; body: FlowNode }
  | { kind: "revision"; flow: FlowDefinition; input: JsonValue };
```

runtime 在执行前必须：

1. 解析为结构化 IR，拒绝夹杂自然语言的结果；
2. 执行普通 IR validator；
3. 检查 `maxNodes`、`maxDepth`、allowed node kinds、Agent 和 flow；
4. 检查 capability、预算与部署 policy；
5. 记录完整 plan hash、来源和验证结果。

continuation 在当前 frame 中作为有作用域的动态子节点运行。revision 是新的临时 flow definition，使用独立 frame 执行，并记录 `revision.created`；它不会无记录地原地覆盖当前 Program。

## 8. 错误与退出

runtime error 至少包含：

```ts
interface FlowError {
  code: string;
  message: string;
  nodeId?: string;
  details?: JsonValue;
}
```

控制流返回不使用异常实现对外协议。Agent reviewer 应返回 `accepted`、`revision_required`、`blocked` 等业务 enum；transport failure、schema failure 和 timeout 才进入 runtime error 路径。

`try` 的 catch 可以把序列化后的 `FlowError` 绑定到 local slot。不可序列化的宿主异常必须先规范化。

## 9. 执行与取消

每次 run 创建根 `AbortController`。timeout、race loser 和外部取消创建或触发子 signal。所有 Agent、event、delay 和 checkpoint adapter 都必须接收 `AbortSignal`。

节点完成状态只有：

- normal：继续执行；
- return：结束当前 flow/隔离分支；
- failed：进入 retry/catch 或终止；
- cancelled：由 signal 传播，不被普通 retry 自动重试。

## 10. Trace

reference runtime 至少产生以下事件：

- `run.started/completed/failed`；
- `flow.started/completed/failed`；
- `node.started/completed/failed`；
- `agent.started/completed/failed`；
- `event.emitted/received`；
- `checkpoint.created`；
- `freedom.plan.created/accepted/rejected`；
- `revision.created`。

trace 包含 monotonic sequence、timestamp、run ID、flow ID、node ID 和 JSON details。不得默认记录 secret；adapter 可在写入 trace 前执行 redaction。

## 11. Validator 分层

v0.1 validator 分为：

1. structural：union shape、必填字段、数值范围；
2. linkage：schema ref、entry、flow、Agent operation、slot 和节点 ID；
3. expression：ref 可见性和 operator arity；
4. policy：capability、动态约束和部署限制；
5. runtime schema：run input、Agent output、event payload assignment 和 flow output。

第一版不承诺完整的数据流类型推导或模型检查，但 validator 的问题必须带稳定 code 与 JSON path，便于后续 compiler frontend 和 IDE 复用。

## 12. v0.1 明确不做

- 不内建网页、文件、shell、数据库或 MCP tool 节点；
- 不保存 provider URL、API key 或模型凭据；
- 不允许 runtime 执行 frontend 的任意 Python/JavaScript；
- 不定义跨进程分布式事务；
- 不自动回滚外部 Agent 副作用；
- 不保证真实模型输出可确定重放；
- 不支持未经验证的 flow 原地 self-modify。

这些边界保留 AFL 作为工作流语言的职责，并让 skill、MCP、Agent runtime 和部署 policy 独立演进。
