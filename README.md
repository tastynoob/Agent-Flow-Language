# Agent Flow Language

Agent Flow Language（AFL）是一种面向 Agent 工作流的描述语言。它以 flow-oriented IR 表达 Agent、Memory、Frag、控制流、并发关系、公共 flow 和开放式 `freedom` 行为，使工作流可以被检查、执行、组合和分发。

当前项目处于 AFL IR 语义设计阶段。文本语法、执行语义和 Memory 规则已经形成草案，parser、validator 和新 runtime 尚未实现。

## 当前架构

```text
Python / TypeScript generator / future AFL DSL
                         |
                         v
                      AFL IR
                         |
              validator / TypeScript runtime
                         |
             Agent / Memory / Capability binding
```

AFL IR 本身保持语言无关。TypeScript 暂定用于第一份 reference runtime；Python、TypeScript generator 和未来专用 DSL 都是可替换的 frontend。

## 仓库状态

仓库中的 `src/`、`python/src/`、`bin/`、`examples/` 和现有测试来自早期 Structured HIR 实验。它们尚未实现当前 AFL IR，不应作为新语法、runtime contract 或项目路线的依据。旧实现暂时保留，等待当前语义收敛后再决定迁移或移除。

当前设计以 `docs/` 下列文档为准：

- [项目目标](docs/project-goals.md)
- [语言形态分析](docs/language-form.md)
- [AFL IR 设计总览](docs/core-ir-draft.md)
- [AFL IR 文本语法](docs/core-ir-syntax.md)
- [AFL IR 执行语义](docs/core-ir-semantics.md)
- [Memory 基础设施语义](docs/core-ir-memory.md)
- [AFL IR 示例](docs/core-ir-examples.md)
- [AFL IR 设计说明](docs/core-ir-design-notes.md)
- [Parallel Voting 表达力案例](docs/afl-case-study-parallel-voting.md)

其中语法、执行语义和 Memory 文档描述当前候选规则；设计说明记录推导与开放问题，不属于规范。
