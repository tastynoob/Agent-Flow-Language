# AFL 文档

本目录只记录 AFL v0 当前支持的语言与运行行为。

## 开始使用

- [Agent 参考技能](SKILL.md)：供 Agent 编写、审查和移植 AFL 工作流及 binding 的完整指南
- [快速开始](guides/getting-started.md)：安装、验证和执行第一个工作流
- [示例集](guides/examples.md)：常用指令与组合方式
- [并行投票](guides/parallel-voting.md)：并行派发与结果汇合
- [Agent 工具安全](guides/agent-security.md)：工具策略、人工请求与沙箱

## 语言规范

- [IR 概览](spec/ir.md)：结构、值类别、指令和绑定边界
- [文本语法](spec/syntax.md)：AFL 文件的合法写法
- [执行语义](spec/semantics.md)：控制流、依赖调度与运行规则
- [Memory 语义](spec/memory.md)：Message、Memory、复制、分支与持久化

规范文档是当前行为的主要依据；示例用于说明组合方式，不能覆盖规范中的约束。
