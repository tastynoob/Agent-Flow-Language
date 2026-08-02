# Agent Flow Language

> 设计状态：当前代码是 Structured HIR prototype。新的 flow-oriented AFL IR 已重写为 [设计草案](docs/core-ir-draft.md)，正在检阅语法、dependency、memory 与 `freedom` 语义，尚未进入实现。

AFL 是一个 IR-first 的 Agent 工作流语言项目。新的 IR 使用简单指令、basic block、node 和 dependency 描述可动态执行的 Agent flow；Agent、memory、skill、MCP 和宿主脚本由 runtime binding 提供具体实现。

当前仓库包含：

- 已实现的 Structured HIR v0.1 语义实验；
- 尚在检阅、未实现的新 AFL IR 草案；
- TypeScript IR 类型、validator、builder 和 reference runtime；
- mock Agent、event、checkpoint 和 trace adapter；
- `afl validate` / `afl run` CLI；
- Python generator frontend；
- TypeScript 与 Python 示例和跨语言测试。

## 架构

```text
TypeScript builder --+
Python generator ----+--> .aflir --> Validator --> TypeScript Runtime --> Adapters
未来 AFL DSL --------+
```

IR 不包含 provider URL 或 API key。`invoke` 通过 symbol 引用 skill、MCP 或 capability；显式 `python`、`typescript`、`shell` 指令属于 runtime-bound escape hatch，部署方可以授权、沙箱化或拒绝。

## 开发

```text
npm install
npm test
```

测试使用 Node.js 内建 test runner 和 pytest。TypeScript runtime 没有第三方运行时依赖。

## TypeScript authoring（当前 HIR）

```ts
import {
  defineProgram,
  expression as e,
  node as n,
  schema as s,
} from "@afl-lang/core";

const program = defineProgram({
  irVersion: "0.1",
  name: "echo",
  entry: "main",
  flows: {
    main: {
      input: s.string(),
      output: s.string(),
      body: n.return("return", e.input()),
    },
  },
});
```

完整示例见 [examples/coder-reviewer.ts](examples/coder-reviewer.ts)。

## Python frontend（当前 HIR）

```python
from afl import define_program, expr as e, node as n, schema as s

program = define_program(
    name="echo",
    entry="main",
    flows={
        "main": {
            "input": s.string(),
            "output": s.string(),
            "body": n.return_("return", e.input()),
        }
    },
)
program.emit("echo.aflir")
```

Python package 只生成 IR，不执行 flow。详见 [python/README.md](python/README.md)。

## CLI

```text
afl validate flow.aflir
afl run flow.aflir --input '"hello"'
afl run agent-flow.aflir --input-file task.json --adapter runtime-bindings.mjs
```

adapter module 必须显式导出 `RuntimeBindings`。portable IR 不会自动加载或执行宿主代码。

## 文档

- [项目目标](docs/project-goals.md)
- [语言形态决策](docs/language-form.md)
- [AFL IR 设计总览](docs/core-ir-draft.md)
- [AFL IR 语义定义](docs/core-ir-semantics.md)
- [Memory 基础设施语义](docs/core-ir-memory.md)
- [AFL IR 文本语法](docs/core-ir-syntax.md)
- [AFL IR 示例](docs/core-ir-examples.md)
- [AFL IR 设计说明](docs/core-ir-design-notes.md)
- [Parallel Voting AFL 案例](docs/afl-case-study-parallel-voting.md)
- [Structured HIR v0.1](docs/ir-v0.1.md)
- [Runtime adapters](docs/runtime-adapters.md)
- [实现状态](docs/implementation-status.md)
