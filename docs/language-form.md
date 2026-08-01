# Agent Flow Language 的语言形态

状态：建议方案  
日期：2026-08-02

## 1. 要决策的问题

Agent Flow Language 最终应采用哪种形式：

1. 设计独立的领域专用语言（DSL）；
2. 直接提供 Python embedded DSL / generator；
3. 直接提供 TypeScript embedded DSL / generator；
4. 使用统一语义 IR，同时提供多种 authoring frontend。

本决策必须同时考虑语义清晰度、实现成本、静态检查、package 生态、AI 生成体验、runtime 可移植性和长期演进。

## 2. 约束

语言需要表达运行期分支、循环、并发、事件、失败恢复和 `freedom`。因此必须严格区分：

- 编译期的代码生成；
- 运行期的 Agent flow；
- Agent 自己生成的 continuation flow。

例如，宿主 TypeScript 的 `for` 可能表示“编译期生成六个部门”，而 AFL 的 `forEach` 表示“运行期遍历任务”。宿主 Python 的 `if` 在构造 IR 时就已执行，不能表示依赖 reviewer 结果的运行期分支。

如果不明确区分这些阶段，代码看似简洁，实际语义会非常混乱。

## 3. 方案 A：直接设计独立 DSL

示意：

```text
flow review_loop<T>(task: Task, worker: Agent, reviewer: Agent) -> T {
    let artifact = worker.do(task);

    repeat 5 {
        match reviewer.review(task, artifact) {
            Approved => return artifact;
            Changes(issues) => artifact = worker.revise(artifact, issues);
        }
    }

    return freedom flow recovery using imported_patterns;
}
```

优点：

- 可以为 Agent 行为设计准确、简洁的语法；
- 编译期和运行期构造天然可区分；
- 容易做静态分析、格式化、LSP、可视化和跨语言移植；
- package 只包含受控语言结构，不必在安装或加载时执行任意宿主代码；
- `freedom`、Agent interface、prompt function 可以成为真正的一等概念；
- 长期最符合“语言而不是框架”的项目定位。

缺点：

- parser、diagnostics、formatter、LSP 和文档成本高；
- 语义尚未稳定时，语法会频繁推翻；
- 与现有 Python/TypeScript 工具集成需要 FFI 或 adapter；
- 过早设计语法容易把精力消耗在表面形式，而不是运行语义。

结论：适合作为最终主要形态，不适合成为验证语义的第一步。

## 4. 方案 B：Python embedded DSL / generator

示意：

```python
review_loop = flow("review_loop").repeat(
    limit=5,
    body=call(reviewer, "review").match(...),
).otherwise(freedom.flow(...))
```

优点：

- Agent 与 LLM 生态成熟，原型和 runtime adapter 容易实现；
- 开发者和 AI 熟悉 Python；
- 可直接复用 Pydantic、asyncio、测试和模型 SDK；
- 很适合快速探索 API 和语义。

缺点：

- 动态类型使复杂 generic flow 的错误发现较晚；
- native `if/while/for` 与运行期 flow 的同名概念容易混淆；
- import package 会执行任意 Python，难以做安全的远程 flow 分发；
- AST、闭包、lambda 和反射难以稳定序列化；
- 容易逐步演变成“又一个 Python Agent framework”；
- 浏览器编辑器、可视化和 package 静态分析较困难。

结论：适合提供后续 SDK 和 runtime adapter，不建议成为规范或唯一 authoring surface。

## 5. 方案 C：TypeScript embedded DSL / generator

示意：

```ts
export const reviewLoop = flow.fn("reviewLoop", ({ task, worker, reviewer }) =>
  flow.repeat({
    max: 5,
    body: flow.match(call(reviewer, "review", { task })),
  }).otherwise(freedom.flow({ planner: reviewer })),
);
```

优点：

- discriminated union、generic 和 exhaustive match 很适合定义类型化 IR；
- async、event 和 structured result 与 Agent runtime 模型契合；
- npm 可以快速承载早期私有 package；
- 与浏览器、语言服务、可视化编辑器和 OpenClaw/Node 生态衔接较好；
- 编译器与 builder 可以共享类型定义和 validator；
- 相比 Python，更容易在开发期发现错误。

缺点：

- native JavaScript 控制流仍然会与 AFL 运行期语义混淆；
- npm package 加载会执行代码，不是安全的可移植 flow 格式；
- TypeScript 类型在运行时擦除，仍需要独立 schema validator；
- 若直接把 builder API 当语言，最终仍是框架而不是独立规范；
- 非 Node runtime 需要额外桥接。

结论：三种直接实现中最适合第一阶段，但只能作为生成器前端。

## 6. 建议：IR 核心 + 多前端

推荐采用第四种方案：最终建设独立 DSL，但不从 parser 开始。

```text
独立 AFL 源码 ---------+
TypeScript builder ----+--> Canonical Flow IR --> Validator --> Runtime Adapter
Python builder --------+                         |              |-- OpenClaw
可视化编辑器 ----------+                         |              |-- Codex/Claude
freedom 生成的 Flow ---+                         |              `-- Custom runtime
                                                 `--> Simulator / Replay / Graph
```

核心规范由三部分构成：

1. 语义模型：每个构造在状态、事件、并发和失败方面意味着什么；
2. Canonical Flow IR：语言无关、版本化、可序列化的类型化 AST；
3. Conformance tests：相同输入事件和固定 Agent 输出下应产生的状态与 trace。

文本 DSL、TypeScript builder、Python builder 和可视化编辑器都是 IR 的 frontend，不拥有独立语义。

## 7. 为什么先做 TypeScript builder

第一阶段需要频繁修改语义结构。如果先写 parser，每次概念变化都要同步修改 grammar、AST、错误恢复和格式化器。TypeScript builder 可以利用宿主语言先验证：

- 哪些 primitive 真正必要；
- generic Agent 和 flow function 是否可表达；
- `freedom flow` 生成的 IR 如何验证；
- 并发、失败和 cancellation 的 AST 是否合理；
- 三省六部等复杂案例是否需要 escape hatch。

但 builder 必须坚持以下规则：

- 所有运行期控制流使用显式的 `flow.match`、`flow.loop`、`flow.parallel`；
- native `if/for` 只允许用于编译期生成，并在文档中称为 elaboration；
- builder 的结果必须可以完整序列化为 Canonical IR；
- 闭包内不得捕获无法序列化的运行时对象；
- runtime 不执行原始 TypeScript 源，只执行验证后的 IR；
- package 的可移植产物是 IR、prompt 和 manifest，不是 npm 模块本身。

## 8. Package 的两层形式

建议区分 authoring package 与 portable flow package。

### 8.1 Authoring package

早期可以使用 npm 发布 builder、类型、compiler plugin 和 adapter。它在构建阶段执行，因此必须按普通代码依赖处理。

### 8.2 Portable flow package

由编译器输出，仅包含：

- manifest 和 language/IR version；
- Canonical Flow IR；
- prompt、schema、test 和静态资源；
- capability 与 permission 声明；
- 依赖范围、lock information 和内容哈希；
- 可选签名。

portable package 加载时不执行任意 Python、JavaScript 或 shell。需要宿主代码的功能通过显式 adapter/FFI capability 引用，由部署方绑定。

## 9. 独立 DSL 的启动条件

满足以下条件后再固定文本语法：

1. 核心 IR 已能表达至少五个代表性 flow；
2. coder-reviewer、parallel research、freedom fallback、三省六部均可运行；
3. 连续两个 IR 版本没有推翻顶层语义模型；
4. flow function、prompt function、generic 和 package import 已有真实用例；
5. simulator 和至少一个真实 runtime 对同一 IR 通过 conformance tests。

届时根据实际 builder 使用模式设计 DSL，而不是先猜测用户需要什么语法。

## 10. 当前决策

当前建议为：

- **最终产品形态**：独立的 Agent Flow DSL；
- **规范核心**：语言无关的语义说明、Canonical Flow IR 和 conformance tests；
- **第一实现**：TypeScript 类型模型、builder、validator 和 simulator；
- **第二前端**：独立文本 DSL；
- **后续前端**：Python builder、可视化编辑器和其他语言 SDK；
- **分发格式**：不执行宿主代码的 portable flow package；
- **运行方式**：adapter 将已验证 IR 映射到具体 Agent runtime。

这个选择兼顾两点：不在项目早期承担完整语言工具链成本，同时避免项目最终退化为只能在 Python 或 TypeScript 中使用的 Agent framework。
