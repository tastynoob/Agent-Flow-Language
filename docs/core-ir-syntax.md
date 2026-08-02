# AFL IR 文本语法草案

状态：讨论稿，供语法检阅
日期：2026-08-02

## 1. 设计范围

本文定义 AFL IR 的文本骨架、指令格式、Frag 和 role 写法。Schema、package、Agent provider 和宿主脚本语言由外部规范或 runtime binding 提供。

一个 IR 文件由若干 node 组成：

```text
node_name(arg0, arg1):
    entry:
        instruction
        terminator
```

缩进表示 node 和 basic block 的范围。每条指令占一行，不使用分号。`#` 后面的内容是注释。

## 2. 名称、Symbol 与字面量

名称由字母或下划线开头，后接字母、数字或下划线：

```text
coder
review_loop
bug_list_2
```

外部 symbol 以 `@` 开头，并用 `.` 分段：

```text
@agent.coder
@prompt.review
@schema.ReviewReport
@flow.security_review
@mcp.github.read_file
```

String 使用双引号，转义规则沿用 JSON string。Boolean、number、list 和 record 字面量主要供 `oper`、script executor 和 runtime option 使用。

Role operand 可以使用基础 role keyword，也可以引用 runtime 定义的 role symbol：

```text
system
user
assistant
tool
@role.custom
```

## 3. Node 与 Basic Block

Node 是可调用的 flow 单元：

```text
name(arg0, arg1, ...):
    entry:
        ...
```

- 参数列表可以为空；
- 每个 node 有一个 `entry` block；
- node 内可以声明其他命名 block；
- `ret` 返回结果，`fail` 以错误结束；
- `call` 可以调用本文件中的 node 或外部 flow symbol。

Basic block 由标签、若干普通指令和一个 terminator 构成：

```text
block_name:
    instruction
    instruction
    jump next_block
```

当前 terminator 形式为：

```text
jump target
jump condition, true_target, false_target
ret
ret value
fail error
```

循环通过回跳表达：

```text
review:
    review_result = reviewer.seqdo review_prompt
    finish = oper review_result == "finish"
    jump finish, done, revise

revise:
    ...
    jump review
```

## 4. 指令格式

产生结果的普通指令使用：

```text
dst = instr arg0, arg1, ...
```

没有参数时省略参数列表：

```text
dst = instr
```

不产生结果的 effect instruction 省略 `dst =`：

```text
instr arg0, arg1, ...
```

Agent、Memory 等资源可以作为指令接收者：

```text
result = coder.do prompt
memory.append coder.memory, user, review_result
```

Operand 可以是名称、字段/索引引用、字面量、role 或外部 symbol。指令自身定义 operand 的数量和含义。

## 5. 结果类别

普通业务数据使用统一的 `Frag`：

```text
Frag = wrapper<string>
```

Frag 在 IR 中表现为一个名称，字符串 wrapper 是其运行时表示。Frag 自身不带 role；JSON、XML、Markdown 或 flow 自定义格式都只是它所包装的字符串内容。

String literal 在需要 Frag 的位置自动包装成 Frag。没有参数的 prompt symbol 也可以直接解析成 Frag；带参数的 formatter 使用 `prompt` 指令显式生成 Frag。

指令结果分为三类：

| 类别 | 代表指令 | 返回结果 |
| --- | --- | --- |
| 数据指令 | `do`、`seqdo`、`prompt`、`input`、`invoke`、`call`、`sync` | role-free Frag |
| 计算指令 | `oper`、`python`、`typescript`、`shell` | runtime compute value |
| 资源指令 | `agent`、`memory.copy`、`memory.apply`、`dispatch`、`fork` | Agent、Memory、TaskGroup 等 handle |

Terminator 和 `memory.append` 等 effect instruction 不需要产生结果。

## 6. Agent 指令与 Role

创建 Agent：

```text
coder = agent @agent.coder
reviewer = agent @agent.reviewer, review_memory
```

第二个 operand 如果存在，表示创建 Agent 时绑定已有 memory；省略时自动创建 memory。

设置 system prompt：

```text
coder.sysprompt @prompt.coder
coder.sysprompt "You are responsible for implementation."
```

`sysprompt` 隐含 `system` role，不需要再写 role operand。

执行一次 Agent 工作：

```text
step = coder.do prompt
step = coder.do user, prompt
step = coder.do user, prompt, @schema.StepResult
```

执行连续多步 Agent 工作：

```text
result = coder.seqdo prompt
result = coder.seqdo user, prompt
result = coder.seqdo user, prompt, @schema.Code
```

省略 role 时使用 `user`。显式 role 位于输入 Frag 之前。末尾 schema symbol 是可选的输出约束；schema 校验成功后，返回结果仍然是包含格式化字符串的 Frag。

Agent 输出在其自身 memory 中使用 `assistant` role，但指令返回的 Frag 不继承该 role。它进入另一个 Agent 或 Memory 时重新指定 role。

## 7. `prompt` 与 `input`

`prompt` 根据 prompt source 和参数创建 role-free Frag：

```text
task_prompt = prompt "Implement the task", task
fix_prompt = prompt @prompt.fix_bugs, review_result, artifact
```

第一个 operand 是文本或 prompt symbol，其余 operand 由对应 formatter 转换为字符串。返回的 Frag 不带 role。

`input` 暂停当前 flow，等待外部输入并返回 role-free Frag：

```text
answer = input "Choose a target branch"
answer = input @prompt.choose_branch, @schema.BranchChoice
```

`input` 不预先指定这份 Frag 将来使用的 role。Schema 可以约束输入采用 JSON 等格式，但不会把返回值改成 Core IR record。

## 8. `oper`

`oper` 后直接书写表达式，不使用字符串包裹：

```text
finish = oper review_result == "finish"
ready = oper accepted & tests_passed & !budget_exhausted
retry = oper attempt < max_attempts
```

Frag 参与 string operation 时读取其包装的字符串。`oper` 不隐式把 Frag 猜测或解析成 JSON object；需要解析 JSON 或自定义格式时使用显式 operation 或 script executor。

初始表达式集合包括逻辑、关系、简单算术、字符串比较、字段/索引读取和括号。`oper` 返回 bool、number、string 等本地计算值，不返回 Frag。

## 9. Script Executor

脚本指令使用双引号包裹源码或命令，后接显式输入：

```text
result = python "script", arg0, arg1, ...
result = typescript "script", arg0, arg1, ...
result = shell "command", arg0, arg1, ...
```

脚本不能隐式读取 node 中的其他值。Frag operand 以其字符串内容传入；脚本输出是 runtime compute value。执行环境、参数编码和权限由对应 runtime binding 定义。

需要把 compute value 传给 Agent 时，可以通过 `prompt` 等数据指令把它格式化为 Frag。

## 10. Flow 组合

同步调用 node 或 flow：

```text
result = call local_node, arg0, arg1
result = call @flow.review, arg0, arg1
```

业务 flow 的调用结果规范化为 Frag。

不继承某个 Agent 上下文，直接派发多个 child flow：

```text
jobs = dispatch [@flow.security(code), @flow.performance(code), @flow.tests(code)]
```

批量启动同一种 child flow：

```text
jobs = dispatch worker_count, @flow.review_once, code
```

List 形式逐项启动显式写出的 flow call，可以混用不同 flow 和不同参数。Batch 形式的第一个 operand `worker_count` 是非负整数 compute value，runtime 启动对应数量的相同调用：

```text
@flow.review_once(code)
@flow.review_once(code)
...
```

`worker_count` 可以是硬编码常量，也可以是 Agent 输出经 `oper` 或 script executor 解析得到的整数。所有 instance 接收同一个 task Frag，但各自具有独立 node invocation、Agent 和 Memory。

从已有 Agent 派生一个并行分支：

```text
new_agent = fork agent, new_agent.do prompt
long_agent = fork agent, long_agent.seqdo task
```

`fork` 左侧的 `dst` 在同一条指令的启动动作中表示新分支 Agent。Runtime 复制 source Agent 的 Memory，用相同 Agent binding 创建 `dst`，再在该分支上启动右侧的 `do` 或 `seqdo`：

```text
security = fork coder, security.do security_prompt
quality = fork coder, quality.seqdo quality_prompt
```

两条 `fork` 都只读取 fork 时的 `coder` 状态，彼此没有依赖，因此可以并行。Source Agent、各 branch Agent 和各份 Memory 在 fork 后互相独立。后续对 branch Agent 的状态性调用排在其启动动作之后。

等待 child flow：

```text
reports = sync jobs
reports = sync jobs, @format.json_array
```

`dispatch` 返回 TaskGroup handle。`sync` 返回包含 child flow 结果集合的 Frag；可选 formatter 决定字符串格式，省略时使用 task group interface 的默认 formatter。`fork` 返回派生的 Agent handle，不使用 `sync` 汇合；需要结果时继续调用该 Agent，前一次输出已经保存在其 Memory 中。Race 和 all-settled 等形式留待并行案例继续收敛。

## 11. Capability

`invoke` 显式调用 skill、MCP method 或 runtime capability，并把 capability 输出格式化为 Frag：

```text
page = invoke @skill.web.read, url
issue = invoke @mcp.github.get_issue, repository, number
```

Symbol 的输入、输出格式和授权由 package/runtime binding 提供。

## 12. Memory

Agent 创建后可以通过 `.memory` 引用其 working memory。

把 role-free Frag 加入 Memory：

```text
memory.append coder.memory, user, review_result
memory.append coder.memory, tool, tool_result
```

复制完整 Memory：

```text
review_memory = memory.copy coder.memory
reviewer = agent @agent.reviewer, review_memory
```

把 Memory 应用到已有 Agent 的配置副本：

```text
branch_memory = memory.copy coder.memory
branch = memory.apply coder, branch_memory
```

`memory.apply` 返回新的 Agent handle。新 Agent 沿用 source Agent 的 binding 与配置并使用给定 Memory；source Agent 不发生变化。第一版要求给定 Memory 尚未绑定其他 Agent。

`memory.append` 需要 role，因为它建立从 Frag 到 Memory message 的边界。`memory.copy` 保留来源消息已有的 role，因此不接收新的 role。

## 13. Freedom

`freedom.move` 从显式候选 move 中选择并执行一步：

```text
result = freedom.move planner, moves, prompt, context
result = freedom.move planner, moves, prompt, context, @schema.Result
```

`freedom.flow` 选择已有 flow 或生成临时 child flow：

```text
result = freedom.flow planner, prompt, context
result = freedom.flow planner, prompt, context, @schema.Result
```

两种指令的业务结果都是 Frag。Schema 只约束其字符串编码。

## 14. 指令形式汇总

```text
dst = agent symbol [, memory]
agent.sysprompt prompt
dst = agent.do [role,] frag [, schema]
dst = agent.seqdo [role,] frag [, schema]

dst = prompt prompt_source [, value ...]
dst = input prompt_source [, schema]

dst = oper expression
dst = python "script" [, value ...]
dst = typescript "script" [, value ...]
dst = shell "command" [, value ...]

dst = call flow [, value ...]
dst = dispatch [flow_call, flow_call, ...]
dst = dispatch count, flow, task
dst = fork source_agent, dst.do [role,] frag [, schema]
dst = fork source_agent, dst.seqdo [role,] frag [, schema]
dst = sync task_group [, formatter]
dst = invoke symbol [, value ...]

memory.append memory, role, frag
dst = memory.copy memory
dst = memory.apply source_agent, memory

dst = freedom.move planner, moves, prompt, context [, schema]
dst = freedom.flow planner, prompt, context [, schema]

jump target
jump condition, true_target, false_target
ret [value]
fail error
```
