# Agent Flow Language

Agent Flow Language（AFL）是一种用于描述 Agent 工作流的语言。它把 Agent 调用、上下文传递、并发协作、条件分支和动态决策写成可阅读、可验证、可执行的工作流，而不是把编排逻辑隐藏在宿主程序或 prompt 中。

AFL 适合表达代码审核循环、并行研究、专家投票、分层组织协作，以及需要 AI 在受控范围内临时规划的工作流。

## 特点

- **行为是一等内容**：循环、分支、调用、并发和失败路径都属于工作流语义，不只是节点图或配置数据。
- **确定性与自主性并存**：可预先确定的步骤使用明确控制流；无法预设的部分通过 `freedom.route` 和 `freedom.flow` 交给 Agent，并保留作用域和验证边界。
- **依赖驱动并发**：没有数据或资源冲突的工作可以自然并行，同一 Agent、Memory 和重叠 Workspace 的操作保持有序。
- **上下文显式流动**：业务数据与消息角色相互分离；Agent Memory 可以复制、应用和分支，不依赖隐式全局对话。
- **运行环境解耦**：工作流使用 symbol 描述 Agent、Prompt、Schema、Capability 和外部 Flow，具体模型与服务由运行环境绑定。
- **组合优先**：Node 可以同步调用、批量派发或动态选择，使工作流能够从简单协作扩展到多层组织。
- **可验证、可追踪**：执行前检查名称、类型、控制流和资源生命周期；运行过程可以输出结构化 trace，运行环境还可以施加预算、授权和 Workspace 策略。

## 示例

下面的工作流让 Coder 完成任务，再把完整上下文交给 Reviewer；审核未通过时，意见会返回给 Coder 继续修订：

```text
main(task):
    entry:
        coder = agent @agent.coder
        code = coder.do task
        jump review

    review:
        review_memory = memory.copy coder.memory
        reviewer = agent @agent.reviewer,, review_memory
        verdict = reviewer.do "Return exactly finish when correct; otherwise list every defect."
        finished = oper verdict == "finish"
        jump finished, done, revise

    revise:
        code = coder.do verdict
        jump review

    done:
        ret code
```

完整示例见 [`examples/coder-reviewer.afl`](examples/coder-reviewer.afl)。

## 可视化

较长的 AFL 可以生成一份直接打开的交互式静态图：

```bash
afl visualize examples/coder-reviewer.afl
```

图只把模型调用和分支显示为节点，其余运算与控制行为折叠到连线上；本地 Node 调用、循环、并发关系和 Freedom 动态候选仍然保留。ELK 分层布局负责减少交叉并生成正交连线。默认输出 `examples/coder-reviewer.graph.html`；更多选项见[工作流可视化](docs/guides/visualization.md)。

## 文档

- [文档索引](docs/README.md)
- [快速开始](docs/guides/getting-started.md)
- [工作流可视化](docs/guides/visualization.md)
- [TypeScript IR Generator](docs/guides/typescript-generator.md)
- [文本语法](docs/spec/syntax.md)
- [执行语义](docs/spec/semantics.md)
- [Memory 语义](docs/spec/memory.md)

AFL 当前处于 v0 阶段，语法与 API 仍可能调整。当前支持范围以 `docs/` 中的规范为准。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。
