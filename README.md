# Agent Flow Language

> 设计状态：当前代码是 structured HIR prototype。instruction-oriented Core IR 正在重新设计，初步定义见 [Core IR 草案](docs/core-ir-draft.md)，在草案检阅完成前暂不将现有 `FlowNode` 视为最终 Canonical IR。

AFL 是一个 IR-first 的 Agent 工作流语言项目。Canonical Flow IR 定义控制流、状态、并发、可靠性、事件和受控动态规划；Agent、skill、MCP、网页访问和其他具体能力由 runtime adapter 提供。

当前仓库包含：

- 语言无关的 AFL IR v0.1 语义；
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

IR 不包含 provider URL、API key 或 `fetch/browser/shell` 节点。一个 `invoke` 只引用声明过的逻辑 Agent operation，部署方决定如何绑定和授权。

## 开发

```text
npm install
npm test
```

测试使用 Node.js 内建 test runner 和 pytest。TypeScript runtime 没有第三方运行时依赖。

## TypeScript authoring

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

## Python frontend

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
- [Core IR 初步定义](docs/core-ir-draft.md)
- [IR v0.1](docs/ir-v0.1.md)
- [Runtime adapters](docs/runtime-adapters.md)
- [实现状态](docs/implementation-status.md)
