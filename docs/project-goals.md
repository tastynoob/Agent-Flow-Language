# Agent Flow Language 项目目标

状态：草案
日期：2026-08-02

## 1. 愿景

设计一门用于描述 Agent 工作流的语言，使复杂的 Agent 协作方式可以像程序一样被定义、组合、验证、发布和复用，而不必绑定到 Claude Code、Codex、OpenClaw、LangGraph 或某个特定运行时。

这门语言描述的不是静态节点图，而是 Agent 系统的行为：状态如何变化、事件如何触发、Agent 如何通信、任务如何并发、失败如何恢复，以及何时把下一步决策交给 AI。

最终希望形成一个 Flow 生态：开发者可以发布 prompt、Agent 接口、通用子流程和完整组织范式，其他项目通过包和函数直接复用。

## 2. 当前问题

现有 Agent flow 通常散落在以下位置：

- orchestrator 的 Python 或 TypeScript 代码；
- Agent 的 system prompt、skill 和项目约定；
- 某个框架专用的 JSON、YAML 或节点图；
- shell 脚本、hooks、任务列表和人工操作说明；
- 只能由特定产品识别的 sub-agent、memory 和 tool 配置。

这导致同一种协作范式被反复实现，并产生几个问题：

- 难以从实现代码中看出完整行为；
- 难以移植到另一种 Agent VM；
- prompt、角色和控制流耦合，不能独立替换；
- 缺少统一的数据格式、失败、并发和事件语义；
- 很难把“三省六部”“coder-reviewer”“辩论投票”等范式作为库发布；
- AI 可以临时规划，但规划通常是不可检查、不可重放的自然语言。

## 3. 项目定位

Agent Flow Language（暂称 AFL）是一门行为描述与编排语言。

一个 AFL 程序应当能够声明：

- Agent 及其 Frag 输入输出格式和能力要求；
- prompt 模板及其参数、结果契约和模型能力要求；
- flow 的状态、事件、消息、artifact 和 memory 引用；
- 顺序、并行、竞争、循环、分支、等待、取消和汇合；
- retry、recover、compensation、timeout 和人工介入；
- 可复用 flow function、pattern、module 和 package；
- AI 决策型控制流 `freedom`；
- 执行预算、权限和可观测性要求。

语言源文件本身不直接实现模型调用。Frontend 将其转换为 AFL IR，再由符合语义约定的 VM 执行，并通过 binding 连接模型、Agent、tool 和存储实现。

## 4. 核心设计原则

### 4.1 描述行为，而不只是保存图

语言必须具有明确的运行期语义。循环表示运行期状态回边，并行表示并发分支，事件表示对外部变化的响应，而不是 UI 节点的序列化格式。

### 4.2 确定性控制与 AI 决策共存

能够确定表达的流程应保持确定，例如格式与接口检查、状态迁移、审批门和并发 join。只有在需要语义判断、开放式规划或预设分支无法处理时，才显式使用 Agent 决策。

### 4.3 组合优先

prompt、Agent、move 和 flow 都应具有可声明的接口，可以作为参数传递、组合和导出。一个 review loop 不应绑定到特定 coder、reviewer、模型或 memory 实现。

### 4.4 VM 无关

核心语义不依赖特定厂商。模型地址、API key、部署位置和产品专用配置属于 VM binding，不属于可移植 flow。

### 4.5 状态和数据流显式化

避免使用一个隐式全局 `Memory` 隐藏全部数据流。普通业务数据使用 role-free Frag 传递，Frag 进入 Agent 或 Memory 时再指定 role；Agent Memory、artifact、长期存储和运行时 handle 应当可区分，并明确读写范围。

### 4.6 可验证、可追踪、可重放

每次 Agent 调用、状态更新、分支选择、freedom 决策和失败恢复都应形成结构化事件。记录 Agent 输出后，同一控制流程应当可以离线重放。

### 4.7 包就是代码

远程 prompt 和 flow 可能获得工具、文件或网络能力。包系统必须支持版本锁定、内容哈希、能力声明、依赖审查和可选签名。

## 5. `freedom` 指令

`freedom` 是一等控制流指令，不是权限模式，也不默认表示修改当前程序。

它用于在确定性流程无法给出下一步时，将决策显式交给 Agent。典型触发位置包括：

- `match` 没有任何 guard 匹配时的 `default`；
- 已选择的 flow 执行失败后的 `recover`；
- 多个候选策略全部失败后的 `exhausted`；
- 任务本身无法由预定义范式覆盖时的开放式规划。

语言应区分两个层级：

- `freedom.move`：从当前暴露的 move、Agent 或子流程中选择下一步；
- `freedom.flow`：组合或生成一个临时的 continuation flow。

`freedom` 至少接收以下上下文：

- 当前目标和可见状态；
- 已失败分支及失败原因；
- 可用 Agent、move、flow package 和 tool；
- 剩余预算、deadline、权限和必须保持的约束。

`freedom.flow` 的结果应当是可解析、可验证的 AFL IR，而不是不可检查的自然语言计划。生成结果在执行前需要经过 symbol、格式、能力、预算和 policy 验证，并作为有作用域的子流程运行。

## 6. 语言能力范围

| 类别 | 必需能力 |
| --- | --- |
| 数据 | Frag string、compute value、VM handle、可选 schema/format adapter |
| Agent | interface、instance、capability、Frag call、stream、cancel |
| 状态 | local state、shared store handle、artifact、memory handle |
| 控制流 | sequence、match、loop、return、finish、fail |
| 并发 | parallel、race、join、map、reduce、structured cancellation |
| 事件 | on、emit、timer、external trigger、human input |
| 可靠性 | retry、timeout、recover、compensate、checkpoint |
| 动态性 | `freedom.move`、`freedom.flow`、受控 child flow |
| 组合 | function、pattern、module、generic、import/export |
| 工程化 | trace、replay、test、mock、visualize、lint |

核心语言应尽量小。review、debate、vote、three-departments 等属于标准库或第三方 pattern，而不是语法关键字。

## 7. 包与库生态

一个 package 可以导出：

- Frag format、schema 和 Agent interface；
- prompt formatter/function；
- 原子 move；
- 有独立运行状态的 flow function；
- 编译期展开的 flow pattern；
- 完整组织范式；
- policy、测试和 eval case；
- VM adapter。

示意用法：

```text
use @afl/prompts/code-review@^2;
use @afl/patterns/review-loop@^1;
use @community/orgs/three-departments@3;
```

Prompt package 可以是简单字符串，也可以是带参数的 formatter。它还可以声明输出格式、所需工具或模型能力，并携带示例与 eval case；执行 formatter 后产生的仍是 role-free Frag。

flow function 应支持依赖注入，例如将 worker、reviewer、prompt、memory handle 和 policy 作为参数，从而让同一个 review loop 用于代码、文案、合同或研究报告。

## 8. 预期效果

项目成熟后，使用者应当能够：

1. 阅读一个源文件，理解 Agent 系统的主要行为和失败路径；
2. 用相同语言描述固定流程、事件驱动流程和 AI 自由兜底流程；
3. 将同一 flow 绑定到不同模型、Agent VM 和工具实现；
4. 把 prompt、审核循环、并行研究、组织架构等发布为版本化 package；
5. 对 flow 做格式检查、依赖检查、权限检查和基本的死路分析；
6. 用 mock Agent 仿真，不调用真实模型；
7. 记录真实运行轨迹，并在固定 Agent 输出下确定性重放；
8. 查看 freedom 为什么被触发、看到了哪些选择、生成了什么 continuation；
9. 从源文件生成流程图、运行看板或目标 VM 的执行计划。

## 9. 代表性验收场景

第一批设计必须能够自然表达以下场景：

1. coder 完成任务，reviewer 反复审核并打回，直到通过或超限；
2. 多个 researcher 并行调查，synthesizer 汇总，失败分支互不污染；
3. router 处理已知任务，未知任务进入 `freedom.flow` fallback；
4. 多个候选 flow 依次或并行尝试，全部失败后由 freedom 恢复；
5. 三省六部：分拣、规划、审核封驳、派发、部门并行执行、回奏和审计；
6. OpenClaw 式长期助手：由 channel、timer 和外部事件唤醒，使用持久 memory；
7. debate/vote：参与者可参数化，投票策略作为可替换 flow function；
8. human approval：暂停、持久化、恢复、拒绝和补偿；
9. 递归任务拆分，但受深度、成本和并发限制；
10. 同一 review-loop package 分别注入代码和合同领域的 Agent 与 prompt。

如果某个场景必须依靠 VM 中未声明的自定义 orchestration 代码才能成立，说明语言核心仍缺少语义。

## 10. 非目标

- 不重新定义模型 API、MCP 或 A2A 等已有通信协议；
- 不保证不同模型或 VM 产生相同业务输出；
- 不将 chain-of-thought 作为必须保存或交换的数据；
- 不把任意 Python、TypeScript 或 shell 代码伪装成可移植 flow；
- 不在可移植 package 中保存 API key 等 secret；
- 不以覆盖所有厂商私有特性为代价无限扩大核心语言；
- 不在语义尚未稳定时优先建设 package registry 或复杂 UI。

## 11. 相关项目与借鉴方向

- [OpenProse](https://github.com/openprose/prose)：可移植 Agent workflow、function、pattern、test 和 VM contract；
- [OpenClaw](https://github.com/openclaw/openclaw)：长期运行 Agent、skills、sessions、channels、tools 和多 Agent routing；
- [Edict 三省六部](https://github.com/cft0808/edict)：制度化审核、事件总线、状态机、并行调度、权限和审计；
- [AgentSPEX](https://agentspex.ai/)：类型化步骤、分支、循环、并行和显式状态；
- [SCXML](https://www.w3.org/TR/scxml/)：事件队列、并行状态、invoke/cancel 和 microstep 语义；
- [Promela/SPIN](https://spinroot.com/spin/Man/Manual.html)：并发进程、channel、仿真和模型检查；
- [CMMN](https://www.omg.org/cmmn/)：面向不可预先确定顺序的知识型工作与 adaptive case management。

借鉴这些项目时优先复用已经证明有效的概念，不以语法原创作为目标。项目的价值在于形成一致、可组合、可移植并支持 `freedom` continuation 的行为语义。
