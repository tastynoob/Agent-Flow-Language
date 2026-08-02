# AFL 实现状态

最后更新：2026-08-02

## 当前阶段

仓库中的 Structured HIR prototype 已经完成并可运行。新的 AFL IR 正处于设计检阅阶段：文档已从 typed graph/full grammar 方案改写为面向 Agent flow 的简单指令、basic block、node 与 dependency 模型，尚未据此修改 parser、validator 或 runtime。

## 当前方向

- AFL IR 作为语言无关的 flow 表示，TypeScript 实现第一份 reference runtime；
- Python、TypeScript generator 和未来专用 DSL 都生成同一种 IR；
- IR 采用 `dst = instr arg0, arg1, ...` 为主要指令形式；
- Agent 保留 `agent.do`、`agent.seqdo` 等直接、易读的工作指令；
- 无 dependency 的 Agent 工作允许并行，而不是把文本当作全局顺序；
- `oper` 处理常见关系和逻辑，显式宿主脚本处理复杂计算；
- 普通业务结果统一为 role-free `Frag(string)`，JSON 只是可选字符串格式；
- `prompt` 和 `input` 返回 Frag，role 在 Agent/Memory 使用边界决定；
- Agent 默认绑定 memory，并支持 `memory.append`、`memory.copy` 和 `memory.apply`；
- Prompt、schema、Agent、flow 和 capability 通过 package symbol 复用；
- `freedom` 保留为开放式 fallback，并在执行候选 flow 前接受验证与 policy 检查。

这些内容仍属于 v0 草案。具体的 Agent-local 顺序、工作值更新、dispatch/fork mode、memory 扩展和 freedom revision 需要通过案例检验。

## 实现进度

- [x] 项目目标与语言形态分析
- [x] Structured HIR v0.1 语义实验
- [x] Structured HIR TypeScript 类型、validator 和 builder
- [x] Structured HIR reference runtime
- [x] mock adapter 与核心测试
- [x] OpenAI-compatible Agent adapter 概念验证
- [x] Python generator frontend
- [x] 跨语言一致性测试
- [x] 重写 AFL IR 设计、语法、语义、Memory 和示例文档
- [x] 用 Parallel Voting 案例检验 list dispatch 与 batch dispatch
- [x] 区分独立 `dispatch` 与继承 Agent Memory 的 `fork`
- [ ] 检阅并收敛 AFL IR v0 草案
- [ ] 选择首批 conformance case
- [ ] 实现新 IR parser、validator、scheduler 与 HIR lowering

## 文档状态

| 文档 | 作用 | 状态 |
| --- | --- | --- |
| `project-goals.md` | 项目目标和能力边界 | 已有基线 |
| `language-form.md` | IR、frontend 和 runtime 的形态分析 | 初步决策 |
| `core-ir-draft.md` | 新 AFL IR 总览 | 待检阅草案 |
| `core-ir-syntax.md` | 简单文本语法 | 待检阅草案 |
| `core-ir-semantics.md` | dependency 与指令行为 | 待检阅草案 |
| `core-ir-memory.md` | Agent-memory 基础规则 | 待检阅草案 |
| `core-ir-examples.md` | 代表性 flow | 待案例验证 |
| `core-ir-design-notes.md` | 推导、取舍和开放问题 | 非规范说明 |
| `afl-case-study-parallel-voting.md` | 主流 Agent flow 表达力检验 | 待实现验证 |
| `ir-v0.1.md` | 已实现的旧 Structured HIR | 已实现原型 |

## 已有原型验证记录

2026-08-02：

- TypeScript strict compile 通过；
- Node test runner 的 validator、runtime 和 Python 跨语言测试通过；
- Python frontend 4 项 pytest 通过；
- CLI 对旧 `.aflir` 的 validate 和 run 通过；
- OpenAI-compatible chat adapter 的 JSON output、HTTP error 和 secret redaction 测试通过；
- Python 生成的并行 `forEach` HIR flow 已由 TypeScript runtime 执行并得到预期结果。

这些结果验证的是 Structured HIR prototype，不代表新的 AFL IR 草案已经实现。

当前环境没有生成 `package-lock.json`，也没有执行 live provider smoke test。已有 adapter 契约测试使用注入的 mock Fetch API，不包含真实 secret。

## 下一轮实现前需要回答

- `do` 和 `seqdo` 的 adapter contract；
- block 内 dependency 与 Agent-local 顺序能否覆盖长任务；
- Frag formatter 与可选 structured output schema 的 package/linker 接口；
- batch dispatch 的逻辑 Worker 数量、runtime 并发上限和失败传播；
- fork 启动动作失败时，branch Agent handle 的状态与后续操作语义；
- memory append/copy/apply 的一致性与持久 handle 边界；
- `freedom.move/flow` 的选择、生成、验证和 trace 格式；
- coder-reviewer、并行 research、三省六部和长期助手的 conformance case。

在这些问题通过文档与案例检阅前，不继续扩充旧 `FlowNode`，也不把新草案描述成已实现规范。
