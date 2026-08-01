# AFL 实现状态

最后更新：2026-08-02

## 当前阶段

IR v0.1 设计与 reference implementation 起步。

## 已确认决策

- Canonical Flow IR 是语言无关的唯一语义核心；
- TypeScript 用于第一份 builder、validator、simulator 和 reference runtime；
- Python 作为 generator frontend，只生成 `.aflir`；
- IR 只定义 workflow，不内建网页、文件、shell 或 MCP tool 行为；
- Agent 和外部能力只能经声明接口与 runtime adapter 绑定；
- 并发分支默认 frame 隔离，不隐式合并可变状态；
- 动态 continuation/revision 必须先验证再执行。

## 实现进度

- [x] 项目目标与语言形态决策
- [x] IR v0.1 语义基线
- [x] TypeScript IR 类型与 validator
- [x] TypeScript builder
- [x] TypeScript reference runtime
- [x] mock adapter 与核心测试
- [ ] Python generator frontend
- [ ] 跨语言一致性测试

## 状态调整记录

### 2026-08-02：IR 与 runtime 实现语言解耦

早期表述中的“IR 执行语言为 TypeScript”调整为“TypeScript 实现第一份 reference runtime”。IR 本身保持语言无关，避免 frontend、portable package 和其他 runtime 被 Node.js 绑定。

### 2026-08-02：限制 v0.1 的动态修改方式

动态修改不直接覆盖正在运行的 Program。`freedom` 可以生成在当前 frame 中运行的 continuation，或生成作为独立 flow revision 运行的新 FlowDefinition。两者都必须经过 validation、policy 和 trace；持久替换已部署 package 留待后续版本定义发布与审批协议。
