# TypeScript AFL IR Generator

TypeScript generator 用线性 builder API 直接生成 AFL IR 文本。它只维护生成 basic block 所需的临时状态，不定义 HIR，也不建立另一套 instruction 数据模型。`build()` 会把最终文本交给现有 parser 和 validator。

## 基本用法

```ts
import { AflIrBuilder } from "@afl-lang/core";

const bdr = new AflIrBuilder({ sourceName: "workflow.generated.afl" });
const main = bdr.node("main", ["task"]);

const coder = bdr.agent("@agent.coder", {
  name: "coder",
  workspace: "work/coder",
});
coder.systemPrompt("Implement the task carefully.");
const result = coder.do(main.params.task, { name: "result" });

bdr.when(result.startsWith("DONE:"));
bdr.ret(result);
bdr.otherwise();
bdr.fail("Agent returned an invalid result");
bdr.end();

const source = bdr.build();
```

生成结果是普通 AFL 文本：

```afl
main(task):
    entry:
        coder = agent @agent.coder, [workspace: "work/coder"]
        coder.system_prompt "Implement the task carefully."
        result = coder.do task
        condition_1 = typescript "return String(args[0]).startsWith(String(args[1]))", result, "DONE:"
        branch condition_1, __afl_when_1_then, __afl_when_1_else

    __afl_when_1_then:
        ret result

    __afl_when_1_else:
        fail "Agent returned an invalid result"
```

`startsWith()`、`endsWith()` 和 `includes()` 会生成 `typescript` instruction，因此运行环境需要提供 `scripts` binding。普通比较和算术映射为 `oper`。

## Node

每次调用 `node()` 都开始一个新的 AFL node。开始下一个 node 前，当前 node 的所有可达路径必须已经 `ret()` 或 `fail()`：

```ts
const echo = bdr.node("echo", ["value"], {
  description: "Return the supplied value.",
  parameters: { value: "The input value." },
  returns: "The unchanged value.",
});
const value = echo.params.value;
bdr.ret(value);

const main = bdr.node("main", ["input"]);
const result = echo.call(main.params.input);
bdr.ret(result);
```

`AflNodeRef.params` 提供 node 参数引用，`call()` 生成本地 `call` instruction，并在生成阶段检查参数数量。

## Agent

`agent()` 是 `new Agent(builder, symbol, options)` 的便捷形式。两种写法生成相同的 AFL：

```ts
import { Agent } from "@afl-lang/core";

const coder = new Agent(bdr, "@agent.coder", {
  name: "coder",
  workspace: ["work/coder", "shared/reference"],
});
coder.systemPrompt("Implement the task carefully.");
const result = coder.do(main.params.task, {
  name: "result",
  role: "user",
  schema: "@schema.CodingResult",
});
```

`name` 控制生成的 AFL 目标名称；省略时 generator 根据 Agent symbol 分配唯一名称。`workspace` 接受单个路径、包含主读写目录和只读目录的 string list，或已有 `AflValue`。跨平台代码应使用相对 `executionRoot` 的普通路径，不应嵌入盘符、用户目录或 shell 展开语法。

`memory` 接受已有 Memory 的 `AflValue`。只设置 Memory 时生成 `reviewer = agent @agent.reviewer, [memory: review_memory]`。`do()` 默认使用 `user` role；显式 role 使用标准 role 或 `@role.*`，schema 必须使用 `@schema.*`。需要单 token 状态时设置 `format: "status"`。`Agent.memory` 返回可用于 Memory instruction 的 `agent.memory` 引用。

## `when` 与 `otherwise`

`when()` 打开条件分支，`otherwise()` 切换到 false branch，`end()` 关闭最近一层控制结构：

```ts
bdr.when(result.equals("finish"));
bdr.ret(result);
bdr.otherwise();
bdr.fail("review failed");
bdr.end();
```

省略 `otherwise()` 时，false branch 自动进入合流 block。若两个 branch 都已经 `ret()`、`fail()`、`break()` 或 `continue()`，generator 不创建不可达的合流 block。

## `while`

`while()` 创建 test、body 和 end block。条件在 test block 中物化，因此每次迭代都会重新计算：

```ts
const attempt = bdr.variable("attempt", 0);

bdr.while(attempt.lessThan(10));
attempt.set(attempt.add(1));

bdr.when(attempt.equals(2));
bdr.continue();
bdr.end();

bdr.when(attempt.greaterThanOrEqual(4));
bdr.break();
bdr.end();

bdr.end();
bdr.ret(attempt);
```

## `match`、`case` 与 `default`

`match()` 为已经准备好的 route value 生成有序跳转表。每个 `case()` 接受 `null`、boolean、number 或 string 常量；`default()` 必须显式提供：

```ts
bdr.match(route);
bdr.case("research");
bdr.ret("research-result");
bdr.case("rtl");
bdr.ret("rtl-result");
bdr.default();
bdr.ret("fallback-result");
bdr.end();
```

生成的 `jump` 只对 selector 求值一次，然后按 case 的声明顺序精确匹配。Case 内没有提前 `ret()`、`fail()`、`break()` 或 `continue()` 时，`end()` 会创建公共合流 block。

`variable()` 创建一个稳定的 AFL 名称。`set()` 在当前 block 中重新绑定该名称，适合表达 loop-carried value。AFL validator 仍负责检查同一 block 重复定义、类型冲突和控制流合流后的 definite availability。

## 值与表达式

`AflValue` 表示 parameter、instruction result、symbol 或 path 引用。其操作不会立即生成额外层级，而是创建一个惰性表达式，在被 `when()`、`while()`、`set()`、`ret()` 或其他 instruction 消费时直接写成 AFL：

| TypeScript API | 生成的 AFL |
| --- | --- |
| `value.equals(other)` | `dst = oper value == other` |
| `notEquals`、`lessThan`、`greaterThan` 等 | 对应 `oper` 比较 |
| `add`、`subtract`、`multiply`、`divide` | 对应 `oper` 算术 |
| `condition.not()` | `dst = oper !condition` |
| `condition.and()`、`condition.or()` | `oper` 布尔组合 |
| `startsWith`、`endsWith`、`includes` | 接收两个参数的 `typescript` instruction |
| `bdr.compute(symbol, args)` | `dst = compute symbol, args` |

JavaScript string、number、boolean、`null`、array 和 plain record 作为 AFL literal 编码。生成结果中 array 写作 `[value, ...]`，plain record 写作 `[key: value, ...]`，空 record 写作 `[:]`。引用已有 AFL 名称时使用 `ref()`，引用 symbol 时使用 `symbol()`；不要用普通 string 代替引用。

Agent format 也直接使用 JavaScript array 或 plain record：

```ts
reviewer.do(request, { format: ["finish", "error"] });
reviewer.do(request, {
  format: {
    type: "Result type",
    value: "Result payload",
  },
});
```

array 生成精确枚举，record 生成字段描述契约；两者都必须非空。

## 直接写入 AFL

尚未封装或不值得封装的 instruction 可以直接写入：

```ts
bdr.emit("coder.memory.append user, result");
const reports = bdr.assign("reports", "sync jobs");
const parsed = bdr.compute("@afl.parse.json", [reports], "parsed");
```

- `emit()` 只接受一行普通 instruction。
- `assign(name, body)` 返回对应 `AflValue`。
- `oper()`、`compute()` 和 `typescript()` 返回自动命名或显式命名的值。
- Terminator 必须使用 `when()`、`while()`、`match()`、`ret()`、`fail()`、`break()` 和 `continue()` 表达。
- `__afl_` 前缀保留给 generator 的 block 和临时名称。

## 生成与验证

`build()` 返回带末尾换行的 AFL source，并立即执行 `parseAfl()` 与 `assertValidModule()`。语法错误和静态语义错误保留现有的诊断代码与 `sourceName`。

Builder 和 value 都绑定到创建它们的 node。不要把一个 node 的 parameter、Agent 或 instruction result 直接用于另一个 node；跨 node 传值时使用 `AflNodeRef.call()` 参数。
