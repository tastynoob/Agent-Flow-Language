# Agent Flow Language

Agent Flow Language（AFL）是一种面向 Agent 工作流的描述语言。它以 flow-oriented IR 表达 Agent、Memory、Frag、控制流、依赖并行、公共 flow 和受验证的 `freedom` 行为，使工作流可以被检查、执行、组合和分发。

仓库目前包含第一版 TypeScript reference executor：文本 AFL 经过 parser、semantic validator 和 dependency scheduler 后，由显式 runtime bindings 执行。语言语义仍处于 v0 草案阶段，API 与文本格式可能继续调整。

## 架构

```text
Python / TypeScript generator / future AFL DSL
                         |
                         v
                      AFL IR
                         |
          parser / validator / TypeScript runtime
                         |
       Agent / Prompt / Memory / Capability binding
```

AFL IR 本身保持语言无关。TypeScript 是当前 reference runtime；Python、TypeScript generator 和未来专用 DSL 都可以作为 frontend。`python/` 仍是早期 Structured HIR frontend，仅保留作历史实验，不兼容当前 IR。

## 使用

```bash
npm install
npm test

node bin/afl.mjs validate examples/coder-reviewer.afl
node bin/afl.mjs run test/fixtures/echo.afl --args '["hello"]'
```

运行含 Agent 或外部能力的 flow 时，用 `--adapter <module.mjs>` 提供 `RuntimeBindings`。DeepSeek smoke 示例只从环境变量读取密钥：

```bash
DEEPSEEK_API_KEY=... npm run smoke:deepseek
```

`DEEPSEEK_MODEL` 可以覆盖默认的 `deepseek-v4-flash`，`DEEPSEEK_BASE_URL` 可以覆盖默认 API 地址。密钥不会进入 AFL source、fixture 或 trace。

## 设计文档

- [项目目标](docs/project-goals.md)
- [语言形态分析](docs/language-form.md)
- [执行器工作定义](docs/executor-work.md)
- [AFL IR 设计总览](docs/core-ir-draft.md)
- [AFL IR 文本语法](docs/core-ir-syntax.md)
- [AFL IR 执行语义](docs/core-ir-semantics.md)
- [Memory 基础设施语义](docs/core-ir-memory.md)
- [AFL IR 示例](docs/core-ir-examples.md)
- [AFL IR 设计说明](docs/core-ir-design-notes.md)
- [Parallel Voting 表达力案例](docs/afl-case-study-parallel-voting.md)

语法、执行语义和 Memory 文档描述当前候选规则；设计说明记录推导与开放问题，不属于规范。
