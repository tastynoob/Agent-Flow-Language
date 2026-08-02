# AFL IR 虚拟机当前工作定义

状态：第一版 reference VM 已实现
日期：2026-08-02

## 1. 本轮目标

用当前 flow-oriented AFL IR 替换仓库中的 Structured HIR 执行路径，使文本 AFL IR 可以被解析、验证并执行，并通过真实的 coder-reviewer、并行 dispatch 和 Agent fork flow 验证语义。

本轮不是在旧 `FlowNode` union 上增加新节点。旧 JSON HIR、slot schema 和树形解释器不作为兼容目标；仍有价值的错误处理、HTTP transport、取消和 trace 思路可以迁移到新实现。

## 2. 需要形成的执行链

```text
AFL source
    -> lexer / parser
    -> module AST
    -> semantic validator
    -> dependency scheduler
    -> VM bindings
    -> Frag result + trace
```

VM API 接收 module、入口 node 名称和参数。文本格式暂不声明全局 `entry`；调用方显式选择入口，CLI 可以默认使用名为 `main` 的 node。

## 3. 本轮覆盖的语言范围

### 3.1 结构与控制流

- node 参数、basic block 和 `entry`；
- block 内数据依赖与资源依赖调度；
- `jump`、条件 `jump`、`ret` 和 `fail`；
- 跨 block 工作值可见性和循环回跳；
- 同一 block activation 内禁止重复 `dst`，不同 block activation 可以更新同名工作值。

### 3.2 值与计算

- role-free `Frag(string)`；
- bool、number、string、list 和 record compute value；
- name、field/index、string/number/boolean literal 与 external symbol；
- `prompt`、`input` 和 `oper`；
- `python`、`typescript`、`shell` 通过显式 script binding 执行，Core VM 不直接给予宿主进程权限。

### 3.3 Agent 与 Memory

- `agent`、`agent.sysprompt`、`agent.do` 和 `agent.seqdo`；
- `memory.append`、`memory.copy` 和 `memory.apply`；
- Agent 默认 Memory、Message role、Memory ownership 和 copy 隔离；
- `fork source_agent, new_agent.do/seqdo ...` 的 copy-and-apply 快捷语义。

### 3.4 Flow 组合与外部能力

- 本地与外部 `call`；
- list dispatch、batch dispatch 和 `sync`；
- `invoke` capability；
- `freedom.move` 与 `freedom.flow` 的受验证 binding contract；
- prompt、schema、formatter、Agent、flow 和 capability symbol resolution。

## 4. AST 与运行时值

Parser 输出语言无关语义的 TypeScript AST：module 包含 node，node 包含 block，block 包含 instruction 和 terminator。AST 保留 source span，用于 validator 和 VM diagnostics。

VM value 分为：

- `Frag`：只暴露 `content: string`；
- compute value：null、boolean、number、string、list 或 record；
- `AgentHandle`、`MemoryHandle` 和 `TaskGroupHandle`；
- external symbol reference。

Handle 具有 VM identity，不允许作为 prompt content 隐式字符串化。Frag 进入 `oper` 或 script 时读取 content；compute value 进入 `prompt` 时由 formatter 显式编码。

## 5. Parser 与 Validator

首版使用无第三方依赖的 lexer/parser，避免在 grammar 尚未稳定时绑定 parser framework。Parser 负责缩进结构、字符串与注释、顶层逗号切分、flow call、fork startup action 和 `oper` expression precedence。

Validator 至少检查：

- node、block、parameter 和 block 内 `dst` 唯一性；
- `entry`、jump target 和 terminator 完整性；
- opcode、receiver、operand 数量和 operand category；
- name 的 definite availability 与 block 内 dependency cycle；
- local call arity 和 dispatch call 形态；
- Agent、Memory、TaskGroup 的静态使用位置；
- `memory.apply` 不能明显复用已绑定 Memory；
- fork startup action 的 receiver 必须与左侧 `dst` 相同；
- node 退出前不存在未消费的本地 TaskGroup；
- external symbol 所需 binding 在执行前可解析。

跨 block 的 definite availability 使用 CFG 数据流计算：一个值只有在所有可达前驱都已定义时，才可在 block 入口直接使用。同一 block 内允许引用该 block 的其他 producer，而不要求 producer 写在前面；validator 根据引用关系检测环。

## 6. Dependency Scheduler

每次 block activation 建立独立的 instruction graph：

- name producer/consumer 形成数据依赖；
- block activation 形成 flow 依赖；
- Agent 和 Memory 的状态操作形成资源依赖；
- VM policy 只延迟 ready instruction，不改变业务依赖。

Scheduler 会并行启动所有 ready instruction。Agent/Memory 使用 handle identity 的异步读写锁：Memory copy 和 fork snapshot 是读操作；Agent call、system prompt、append 和 bind 是写操作。同一资源的冲突操作按源码顺序进入锁队列，不同资源不因文本相邻而串行。

Block terminator 在本次 activation 的全部普通 instruction 完成后执行。Run 使用 step、并发数和 dispatch Worker 数量上限防止无限循环或无界派发。

## 7. 指令执行约定

### 7.1 Prompt 与输入

Literal prompt 使用稳定的默认 formatter；prompt symbol 由 binding 渲染。`input` 通过 Input binding 挂起并取得字符串，再包装成 Frag。

### 7.2 Agent call

Agent binding 接收 operation mode、Agent symbol、system prompt、完整 Message snapshot、可选 schema 和 AbortSignal，返回最终文本与可选的内部 Message。VM 负责写入输入 Message 和最终 assistant Message。

`do` 表示一次 adapter 工作单元；`seqdo` 允许 adapter 内部执行多轮模型/tool 交互。简单 chat adapter 可以把两者都映射为一次 completion，但 contract 不把 `seqdo` 限制为单轮。

### 7.3 Fork

```text
branch = fork source, branch.do prompt
```

等价于复制 source Memory、把副本 apply 到 source Agent 配置的新实例，再执行 startup action。Fork instruction 在 startup action 完成后产生 branch Agent handle；startup Frag 只进入 branch Memory，不另设返回值。Startup 失败时 fork instruction 失败，不产生可用 handle。

多条 fork instruction 可以并行读取同一 source snapshot。后续 branch 操作与各自 startup action 按 Agent 资源顺序执行。

### 7.4 Dispatch 与 Sync

`dispatch` 启动 child invocation 并立即返回 TaskGroup；`sync` 等待并按 list position 或 batch ordinal 收集 Frag。默认 formatter 输出 JSON string array，显式 formatter symbol 可以替换编码。

TaskGroup 遵循 structured concurrency：创建它的 node 在退出前必须 `sync`。任一 child 失败时，基础 `sync` 失败并取消同组未完成 child；all-settled、race 和其他 mode 等语言语义明确后再增加。

### 7.5 External effect

`invoke`、script executor、external flow、schema 和 formatter 都经过 VM binding。未绑定 symbol 产生稳定错误，不进行名称猜测或隐式网络访问。

### 7.6 Freedom

Freedom binding 返回结构化计划：

- move plan 引用已注册 move；
- flow plan 引用已有 flow，或提供带入口的临时 AFL source。

VM 检查候选范围、symbol、capability、预算和 policy；临时 source 必须经过同一个 parser 与 validator，之后作为有作用域的 child module 执行。Freedom adapter 不能直接返回已经执行的最终结果来绕过验证。

## 8. 迁移边界

新实现完成后：

- `src/ir.ts`、parser、validator、VM 和 adapter API 以当前 AFL IR 为准；
- 旧 builder、expression、value、旧 JSON fixture 和旧 HIR tests 移除；
- CLI 改为读取文本 `.afl`，支持 validate 与 run；
- Python 旧 frontend 继续保持 legacy 标记，本轮不伪装成新 frontend；
- README 在实际实现通过后更新运行方法，不提前宣称完成。

## 9. 完成证据

本轮完成需要同时具备以下证据：

1. parser/validator 的成功与错误定位测试；
2. coder-reviewer 循环实际执行，Memory copy 后 Reviewer 能看到 Coder 上下文，缺陷能返回 Coder 修订；
3. 无依赖 Agent 工作确实并发，而同一 Agent 工作保持顺序；
4. list dispatch、动态 count batch dispatch、sync 顺序与失败取消测试；
5. fork 的 source snapshot、分支隔离和后续继续工作测试；
6. input、invoke、script binding、local/external call 和 freedom validation 测试；
7. OpenAI-compatible adapter 的 HTTP contract、secret redaction 和取消测试；
8. 至少一个文本 AFL 文件通过 CLI 完整运行；
9. 在可安全提供 API key 的环境中运行一次真实模型 flow；若环境没有 secret，只能把 live smoke test 明确记录为未完成，不能用 mock 结果替代。

真实 provider secret 只从环境变量读取，不写入 source、fixture、命令输出或 trace。

当前自动化测试已覆盖前八项，并额外覆盖动态任务总量限制、VM handle alias 排序与 Memory 重复绑定诊断。真实 provider smoke 入口为 `npm run smoke:deepseek`；它只有在调用环境提供 `DEEPSEEK_API_KEY` 时执行，不属于默认测试，不能由 mock 替代。

2026-08-02 已使用环境变量中的 DeepSeek API key 完成第九项验证：`examples/live-smoke.afl` 经 CLI、OpenAI-compatible adapter 和真实模型执行后返回 Frag `afl-live-ok`。密钥未写入 source、fixture 或 trace。

## 10. VM 可执行入口

Reference VM 通过 npm `bin` 暴露为 `afl-vm`。当前最小调用由两个位置参数构成：

```text
afl-vm <bindings-module> <flow.afl>
```

VM 默认调用无参 `main()`。入口名、node 参数、trace 和 run id 是可选 CLI 覆盖，不改变最小接口。Bindings 可以来自本地 JavaScript module 或已安装 package；VM 在加载 AFL 前先建立显式宿主能力边界，不从 IR 猜测 provider、密钥或工具实现。

`package.json` 的发布清单包含 `bin/`、`dist/src/`、规范文档与 README。安装生成的 npm tarball 后，`node_modules/.bin/afl-vm` 必须能在仓库外执行同一份 AFL IR；源码目录中的 wrapper 成功不作为打包完成的充分证据。
