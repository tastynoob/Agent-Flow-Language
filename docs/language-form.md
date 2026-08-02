# Agent Flow Language 的语言形态

状态：当前设计分析
日期：2026-08-02

## 1. 讨论范围

AFL 需要同时回答两个不同问题：

1. 使用者通过什么形式编写 flow；
2. runtime 接收什么形式并据此执行。

Python、TypeScript 和未来专用 DSL 都可以提供良好的 authoring 体验，但不适合各自拥有不同的运行语义。AFL 因此需要一层语言无关的 IR，作为 frontend、package、validator 和 runtime 之间的共同边界。

## 2. 当前分层

```text
Python generator --------+
TypeScript generator ----+--> AFL IR --> Validator --> TypeScript Runtime
future AFL DSL ----------+                         --> Other Runtime
```

- **AFL IR**：描述 node、basic block、Agent 工作、Memory、Frag、dependency、控制流和 flow 组合；
- **Frontend**：帮助用户构造 IR，可以提供宿主语言函数、类型检查和 package API；
- **Validator**：检查语法、symbol、operand、resource dependency 和 runtime policy 边界；
- **Runtime**：调度已经验证的 IR，并绑定 Agent、Memory、skill、MCP 和宿主脚本；
- **Package**：发布 prompt、Agent interface、flow、formatter、schema 和 capability contract。

文本形式是 AFL IR 的可读表示。Runtime 内部可以把它解析成 AST、图或其他结构，但内部编码不改变语言语义。

## 3. 为什么不直接以 Python 或 TypeScript 为语义核心

宿主语言很适合生成 IR，但宿主控制流和 Agent flow 控制流处在不同阶段。例如 Python 的 `if` 在生成 IR 时执行，而 AFL 的 `jump` 在 Agent 工作产生结果后执行。若两者没有明确边界，同一段 frontend 代码很难判断是在生成 flow，还是正在运行 flow。

直接分发 Python 或 npm package 还意味着加载 flow 时执行宿主代码，不利于静态检查、能力审查和跨 runtime 移植。因此宿主 generator 可以生成 AFL IR，runtime 不应把 generator 源码当作 portable flow 执行。

这不妨碍 frontend 提供自然的函数、循环和模块 API。只要这些行为最终产生同一套 AFL IR，它们就属于 authoring convenience，而不是新的 runtime 语义。

## 4. 为什么先使用文本 IR

当前最需要验证的是 Agent flow primitive，而不是完整通用 DSL。简洁的文本 IR 有几个实际作用：

- 可以直接检阅 `do`、`seqdo`、`jump`、`dispatch`、`fork` 和 `sync` 的组合效果；
- 可以观察数据依赖与 Memory 依赖，而不被 builder API 隐藏；
- 便于编写 conformance case，并作为不同 frontend 的共同输出；
- grammar 规模较小，语义变化时修改成本相对可控。

它仍然面向 flow，而不是模仿传统汇编。普通逻辑由 `oper` 或显式 script executor 承担；Agent 指令保留 `coder.do`、`reviewer.seqdo` 等形式；`fork` 可以组合 Memory 操作，而不要求使用者手工展开所有基础步骤。

## 5. Runtime 实现语言

TypeScript 暂定用于第一份 reference runtime，主要考虑 Node Agent 生态、类型工具、异步 I/O、CLI 和未来浏览器工具之间的组合。这个选择不表示 AFL IR 依赖 JavaScript，也不表示 Python 无法实现相同的并发语义。

Reference runtime 的价值是落实和检验语义。其他语言实现只要通过同一组 conformance tests，也可以执行 AFL IR。Provider URL、API key、模型 SDK 和 MCP transport 属于 runtime binding，不进入 portable IR。

## 6. Python 与 TypeScript Frontend

Python 和 TypeScript frontend 可以采用 generator 或 builder 形式：

```text
source code -> builder/generator -> AFL IR text or AST
```

Frontend 可以在生成阶段使用宿主语言的模块、常量、函数和循环，也可以把公共 flow 包装成函数。依赖 Agent 输出的运行期分支、循环和动态 Worker 数量必须保留为 AFL IR 指令，不能在生成阶段提前求值。

Frontend 生成的结果应能脱离原宿主进程完成验证、分发和执行。确实需要 Python、TypeScript 或 shell 的 flow 可以使用显式 script executor；这属于受 runtime policy 管理的执行边界，不是 generator 的隐式逃逸。

## 7. 专用 AFL DSL

专用 DSL 仍可能改善大型 flow 的编码效率、静态诊断和可读性，但没有必要在 primitive 尚未稳定时同时维护另一套高层 grammar。

当文本 IR 和多个 frontend 已经暴露出稳定、重复的 authoring 模式时，可以基于这些模式设计 DSL。DSL 应当编译到 AFL IR，并尽量避免新增只有某个 compiler 才理解的隐藏语义。

## 8. 当前结论

当前形态可以概括为：

- AFL IR 是语言无关的 flow 语义边界；
- 当前文本形式用于直接编写、检阅和交换 IR；
- TypeScript 实现第一份 validator 与 reference runtime；
- Python 和 TypeScript 可以提供 generator frontend；
- Prompt 和通用 flow 通过 package/library 复用；
- 专用 DSL 根据真实 authoring 经验再决定形态；
- `freedom` 生成或选择的 child flow 同样需要形成可验证的 AFL IR。

这些选择为当前设计提供方向，不限制后续根据实现和案例结果调整 frontend 或 runtime。
