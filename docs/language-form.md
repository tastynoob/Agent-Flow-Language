# Agent Flow Language 的语言形态

状态：初步决策
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

结论：可以成为未来的高效率 authoring frontend，但不预设它一定是最终主要形态，也不适合成为验证语义的第一步。

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

结论：适合作为 TypeScript 工具链之后优先补充的 frontend 和 SDK，不建议成为规范、唯一 authoring surface 或规范 runtime。

## 5. 方案 C：TypeScript builder 与 reference runtime

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

- discriminated union、generic 和 exhaustive match 很适合定义 IR instruction、handle 和 validator；
- Promise、AbortSignal、AsyncIterable、event 和 structured result 与以网络 I/O 为主的 Agent runtime 契合；
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

这里选择 TypeScript 是基于第一阶段的工程适配度，而不是声称它在语义上比 Python 更能表达异步或并行。Python 的 `asyncio` 同样可以实现这些能力；两者进行 CPU 并行时也都需要额外机制。TypeScript 的主要优势是当前 Node Agent 生态、类型工具、流式 I/O、CLI 和未来浏览器工具之间的组合更适合本项目起步。

结论：TypeScript 最适合承载第一阶段的 builder、compiler、validator、simulator 和 reference runtime，但这些实现都不能成为 IR 规范本身。

## 6. 建议：IR 核心 + 多前端

推荐采用第四种方案：长期以语言无关的 Canonical Flow IR 为唯一语义核心，先建设 TypeScript 工具链，再增加 Python 等 frontend。专用 AFL DSL 是否建设以及何时建设，由真实使用需求决定。

```text
TypeScript authoring --> TS builder/compiler --+
Python authoring -----> Python frontend --------+--> Canonical Flow IR --> Validator
未来 AFL DSL ---------> DSL compiler -----------+                          |
可视化编辑器 ---------> editor compiler --------+                          v
freedom continuation -> constrained compiler ---+                 TypeScript reference runtime
                                                                       |-- Agent/Model adapters
                                                                       |-- Tool/MCP adapters
                                                                       `-- Trace/Checkpoint/Policy
```

核心规范由三部分构成：

1. 语义模型：每个构造在状态、事件、并发和失败方面意味着什么；
2. Canonical Flow IR：语言无关、版本化、可序列化的 flow 指令与结构；
3. Conformance tests：相同输入事件和固定 Agent 输出下应产生的状态与 trace。

文本 DSL、TypeScript builder、Python builder 和可视化编辑器都是 IR 的 frontend，不拥有独立语义。

这里需要严格区分两个概念：

- Canonical Flow IR 没有“执行语言”，它是语言无关的规范数据与行为模型；
- TypeScript 是第一份 reference runtime 的实现语言，用于证明和落实 IR 的执行语义。

IR 可以暂时采用 JSON 等通用格式序列化为 `.aflir`，但序列化格式是交换载体，不代表 AFL 只能描述静态节点图。循环、动态分支、事件、并发、continuation 和状态迁移都由 IR 节点及其规范语义表达。

## 7. 三阶段工具链

### 7.1 Authoring

用户使用 TypeScript builder、Python generator 或未来的 AFL DSL 编写 flow。authoring frontend 可以使用宿主语言的函数、模块、循环和代码生成能力，但这些行为只用于构造 IR，不直接成为 AFL 的运行时语义。

Python frontend 的典型使用方式是：

```python
flow = review_loop(
    worker=agent("coder"),
    reviewer=agent("reviewer"),
)

flow.emit("task.aflir")
```

### 7.2 Elaboration / Compilation

frontend 执行生成器、展开 package 和 generic，最终输出规范化的 `.aflir`。宿主语言的 `if/for` 在这个阶段执行；依赖 reviewer 输出的 `branch/loop` 则必须保留为 IR 节点，留到运行期执行。

生成的 IR 必须通过 Frag/schema 格式、symbol、控制流、capability、权限和预算检查。任何无法完整翻译成 Canonical Flow IR 的 Python 或 TypeScript 行为都属于宿主扩展，不是可移植 AFL flow。

### 7.3 Execution

TypeScript reference runtime 只接收通过验证的 Canonical Flow IR，不隐式执行 frontend 的 Python、TypeScript 或未来 DSL 源码：

```text
afl validate task.aflir
afl run task.aflir
```

runtime 负责 scheduler、状态与事件、Agent 调用、并发和取消、adapter binding、checkpoint、trace 与 replay。具体模型 SDK、MCP、tool 和存储实现通过显式 adapter 或 capability 绑定。IR 中明确写出的 `python`、`typescript`、`shell` 指令是受 runtime policy 管理的宿主执行边界，不等同于加载并执行 frontend 源码。

Agent 的普通业务结果在 Core IR 中使用 role-free `Frag(string)`。Flow 可以选择适合任务的字符串协议：简单 Reviewer 可以在完成时返回精确的 `finish`，有缺陷时返回文本列表；需要稳定字段时可以返回经过外部 schema 校验的 JSON 字符串。Role 只在 Frag 被传给 Agent 或写入 Memory 时确定。

### 7.4 Dynamic continuation 与 self-modify

`freedom` 是正式控制指令。它可以作为 `match` 的 default、所有候选分支失败后的 fallback，或显式的开放式规划点。

动态流程遵循以下路径：

```text
freedom
  -> 生成候选 continuation IR 或 IR patch
  -> syntax/format/capability/budget validation
  -> policy 检查与可选人工批准
  -> 创建有作用域的子流程或新的 flow revision
  -> 执行并记录 trace
```

普通的动态规划优先生成为有作用域的 child flow。只有确实需要改变后续长期行为时才生成 IR patch，并基于当前 flow 创建可追踪的新 revision。runtime 不应无记录地原地改写正在执行且已经验证的 IR。

## 8. 为什么第一阶段采用 TypeScript

第一阶段需要频繁修改语义结构。如果先写 parser，每次概念变化都要同步修改 grammar、AST、错误恢复和格式化器。TypeScript builder 可以利用宿主语言先验证：

- 哪些 primitive 真正必要；
- generic Agent 和 flow function 是否可表达；
- `freedom flow` 生成的 IR 如何验证；
- 并发、失败和 cancellation 的 AST 是否合理；
- 三省六部等复杂案例是否需要 escape hatch。

TypeScript reference runtime 还需要通过 conformance tests 明确并发分支的状态隔离、写冲突、join 顺序、失败传播和 structured cancellation。仅仅把节点交给 `Promise.all` 不足以定义 AFL 的并发语义。

builder 必须坚持以下规则：

- 所有运行期控制流都应生成显式 AFL IR 指令与 basic block；
- native `if/for` 只允许用于编译期生成，并在文档中称为 elaboration；
- builder 的结果必须可以完整序列化为 Canonical Flow IR；
- 闭包内不得捕获无法序列化的运行时对象；
- runtime 不执行原始 frontend 源，只执行验证后的 IR；IR 内显式宿主脚本按部署 policy 处理；
- package 的可移植产物是 IR、prompt 和 manifest，不是 npm 模块本身。

## 9. Package 的两层形式

建议区分 authoring package 与 portable flow package。

### 9.1 Authoring package

早期可以使用 npm 发布 builder、类型、compiler plugin 和 adapter。Python frontend 加入后可以通过 Python package 发布对应 generator。authoring package 在构建阶段执行，因此必须按普通代码依赖处理。

### 9.2 Portable flow package

由编译器输出，仅包含：

- manifest 和 language/IR version；
- Canonical Flow IR；
- prompt、schema、test 和静态资源；
- capability 与 permission 声明；
- 依赖范围、lock information 和内容哈希；
- 可选签名。

portable package 可以禁止内联 Python、JavaScript 或 shell，只允许显式 adapter/FFI capability。需要宿主脚本的环境绑定 package 应在 manifest 中声明运行环境和权限，不能伪装成跨 runtime 可移植 flow。

## 10. 专用 DSL 的启动条件

专用 AFL DSL 是可选的后续 frontend。满足以下条件后再评估和固定文本语法：

1. 核心 IR 已能表达至少五个代表性 flow；
2. coder-reviewer、parallel research、freedom fallback、三省六部均可运行；
3. 连续两个 IR 版本没有推翻顶层语义模型；
4. flow function、prompt function、generic 和 package import 已有真实用例；
5. TypeScript 与 Python frontend 已暴露出重复、冗长或容易误用的模式；
6. simulator 和至少一个真实 runtime 对同一 IR 通过 conformance tests。

届时应根据实际 authoring 经验判断专用 DSL 能否显著提高编码效率、可读性和静态诊断质量，而不是先假设项目一定需要自有语法。即使增加专用 DSL，它也只是新的 frontend，不改变 Canonical Flow IR、package 格式和 runtime contract。

## 11. 当前决策

当前决定为：

- **长期规范核心**：语言无关的语义说明、Canonical Flow IR 和 conformance tests；
- **第一套工具链**：TypeScript 类型模型、builder/compiler、validator、simulator 和 reference runtime；
- **运行边界**：reference runtime 只执行通过验证的 IR，通过 adapter 连接具体 Agent、模型、MCP、tool 和存储；
- **下一类 frontend**：Python generator，以及根据需求增加的可视化编辑器和其他语言 SDK；
- **专用 DSL**：不作为当前前置目标，在 IR 和真实 authoring 模式稳定后按收益决定；
- **分发格式**：不执行宿主代码的 portable flow package；
- **动态修改**：`freedom` 生成受验证、受策略约束且可追踪的 child flow 或 flow revision。

这条路线允许项目先借助 TypeScript 生态验证运行语义，同时保证 Python 和未来 DSL 只是可替换的 frontend，不会让 AFL 退化成只能在某一种宿主语言中使用的 Agent framework。
