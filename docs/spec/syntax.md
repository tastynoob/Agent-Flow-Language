# AFL IR 文本语法

## 1. 范围

本文定义当前 parser 接受的 AFL IR 文本骨架、指令格式、Frag 和 role 写法。外部 symbol 的具体行为由 VM binding 提供；当前 IR 没有 package 或 provider 声明语法。

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

String 使用双引号，转义规则沿用 JSON string。Boolean、number、list 和 record 字面量主要供 `oper`、script executor 和 VM option 使用。List 与 record 统一使用方括号，是否包含顶层 `:` 决定集合类型：

```text
[value0, value1]            # list
[key: value, "other-key": value]  # record
[]                          # empty list
[:]                         # empty record
```

同一层集合不能混写 list item 和 record entry。Record 的裸 key 必须是合法名称；其他字符串 key 使用双引号。

Role operand 可以使用基础 role keyword，也可以引用 VM 定义的 role symbol：

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

Freedom 可见的 Node 可以在 header 后用机器可读注释描述接口：

```text
worker(task):
    # @description Execute one isolated task.
    # @param task The task and necessary context.
    # @returns A concise execution report.
    entry:
        ...
```

Parser 会把 `@description`、`@param` 和 `@returns` 保存进 IR；`@param` 必须引用签名中的真实参数。其他普通 `#` 注释仍只用于源码阅读。

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
branch condition, true_target, false_target
match selector, [case_value: target, ...], default_target
ret
ret value
fail error
```

跳转表的 case 按书写顺序匹配。`case_value` 必须是 `null`、boolean、number 或 string literal，目标必须是当前 node 内的 block 名；所有 case 均未匹配时进入显式的 `default_target`：

```text
route:
    match route_kind, ["research": research, "rtl": implement, "verify": verify], fallback
```

跳转表一次只激活一个目标。需要同时启动多个 flow 时使用 `dispatch`。

循环通过回跳表达：

```text
review:
    review_result = reviewer.do review_prompt
    finish = oper review_result == "finish"
    branch finish, done, revise

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
coder.memory.append user, review_result
```

Operand 可以是名称、字段/索引引用、字面量、role 或外部 symbol。指令自身定义 operand 的数量和含义。

## 5. 结果类别

普通业务数据使用统一的 `Frag`：

```text
Frag = wrapper<string>
```

Frag 在 IR 中表现为一个名称，字符串 wrapper 是其运行时表示。Frag 自身不带 role；JSON、XML、Markdown 或 flow 自定义格式都只是它所包装的字符串内容。

String literal 在需要 Frag 的位置自动包装成 Frag。Prompt symbol 需要由 `prompt` 或 `agent.system_prompt` 交给 Prompt binding 渲染。

指令结果分为三类：

| 类别 | 代表指令 | 返回结果 |
| --- | --- | --- |
| 数据指令 | `do`、`prompt`、`input`、`invoke`、`call`、`sync` | role-free Frag |
| 计算指令 | `oper`、`python`、`typescript`、`shell` | VM compute value |
| 资源指令 | `agent`、Memory `copy`、`with_memory`、`dispatch`、`repeat`、`fork` | Agent、Memory、TaskGroup 等 handle |

Terminator 和 `memory.append` 等 effect instruction 不需要产生结果。

## 6. Agent 指令与 Role

创建 Agent：

```text
coder = agent @agent.coder
worker = agent @agent.worker, [workspace: "workers/worker/"]
reviewer = agent @agent.reviewer, [workspace: ["workers/reviewer/", "docs/", "src/"], tools: "readonly"]
coder = agent @agent.coder, [tools: "coding"]
editor = agent @agent.editor, [tools: ["read", "write", "edit"]]
reviewer = agent @agent.reviewer, [memory: review_memory]
```

第二个 operand 是可选的 typed options record。`workspace` 为单个路径时表示主工作区；为列表时，第一项是主工作区，后续至少一项是只读工作区。只有主工作区时必须使用字符串。省略 `workspace` 时，VM 为这次 Agent allocation 在 `.afl/tmpworkspace/<run-id>/` 下分配稳定且互不重叠的主工作区。`memory` 绑定已有 Memory，不使用空 operand 占位。

`tools` 选择 VM 标准 Agent 工具。它接受 profile 字符串或显式字符串列表：

| Profile | 标准工具 |
| --- | --- |
| `none` | 无文件或命令工具 |
| `readonly` | `read`、`list`、`search` |
| `editing` | `read`、`list`、`search`、`write`、`edit` |
| `coding` | `read`、`list`、`search`、`write`、`edit`、`shell` |

显式列表只能包含上述标准名且不能重复。`shell` 是后端无关名称；例如 Pi 将它映射为 harness 的 `bash` 工具。省略 `tools` 时由 executor binding 决定默认工具，用于高级自定义工具和渐进迁移；显式写出后，executor 必须支持标准工具选择，否则执行失败。`fork` 和 `with_memory` 保留 source Agent 的工具权限。

Reference Pi executor 的 `search` 做递归字面量文本搜索，不调用 Shell，不跟随 symlink，跳过大于 2 MB 的文件，并限制单次扫描最多 10,000 个目录项和 500 条返回结果。它用于常见源码定位，不替代索引服务或项目特有的检索 capability。

设置 system prompt：

```text
coder.system_prompt @prompt.coder
coder.system_prompt "You are responsible for implementation."
```

`system_prompt` 隐含 `system` role，不需要再写 role option。

执行一次 Agent 工作：

```text
step = coder.do prompt
step = coder.do prompt, [role: user]
step = coder.do prompt, [role: user, schema: @schema.StepResult]
```

省略 role 时使用 `user`。显式 role 和 schema 都位于 options 中；schema 校验成功后，返回结果仍然是包含格式化字符串的 Frag。

一次 `do` 表示完整的 Agent 工作激活，可以在执行后端内部包含多个模型 turn 和工具步骤。Core IR、validator、VM 和 adapter API 不再区分单步与连续执行 mode。

Agent 输出在其自身 memory 中使用 `assistant` role，但指令返回的 Frag 不继承该 role。它进入另一个 Agent 或 Memory 时重新指定 role。

## 7. `prompt` 与 `input`

`prompt` 根据 prompt source 和参数创建 role-free Frag：

```text
task_prompt = prompt "Implement the task", task
fix_prompt = prompt @prompt.fix_bugs, review_result, artifact
```

第一个 operand 是文本或 prompt symbol，其余 operand 由对应 formatter 转换为字符串。返回的 Frag 不带 role。

`input` 把 prompt Frag 交给 Input binding，等待其返回字符串，并将结果包装为 role-free Frag：

```text
answer = input "Choose a target branch"
question = prompt @prompt.choose_branch
answer = input question, @schema.BranchChoice
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

表达式支持 `!`、一元 `-`、`&`、`|`、`==`、`!=`、`<`、`<=`、`>`、`>=`、`+`、`-`、`*`、`/`、字段/索引读取和括号。`oper` 返回 compute value，不返回 Frag。

## 9. Script Executor

脚本指令使用双引号包裹源码或命令，后接显式输入：

```text
result = python "script", arg0, arg1, ...
result = typescript "script", arg0, arg1, ...
result = shell "command", arg0, arg1, ...
```

脚本不能隐式读取 node 中的其他值。Frag operand 以其字符串内容传入；脚本输出是 VM compute value。执行环境、参数编码和权限由对应 VM binding 定义。

需要把 compute value 传给 Agent 时，可以通过 `prompt` 等数据指令把它格式化为 Frag。

## 10. Flow 组合

同步调用 node 或 flow：

```text
result = call local_node(arg0, arg1)
result = call @flow.review(arg0, arg1)
```

业务 flow 的调用结果规范化为 Frag。

不继承某个 Agent 上下文，直接派发多个 child flow：

```text
jobs = dispatch [@flow.security(code), @flow.performance(code), @flow.tests(code)]
```

批量启动同一种 child flow：

```text
jobs = repeat worker_count, @flow.review_once(code)
```

List 形式逐项启动显式写出的 flow call，可以混用不同 flow 和不同参数。`repeat` 的第一个 operand `worker_count` 是非负整数 compute value，VM 启动对应数量的相同调用：

```text
@flow.review_once(code)
@flow.review_once(code)
...
```

`worker_count` 可以是硬编码常量，也可以是 Agent 输出经 `oper` 或 script executor 解析得到的整数。所有 instance 接收同一个 task Frag，但各自具有独立 node invocation、Agent 和 Memory。

从已有 Agent 派生一个并行分支：

```text
new_agent = agent.fork prompt
long_agent = agent.fork task
```

VM 复制 receiver Agent 的 Memory，用相同 Agent binding 创建左侧的新分支 Agent，再在该分支上执行一次 `do`：

```text
security = coder.fork security_prompt
quality = coder.fork quality_prompt
```

两条 `fork` 都只读取 fork 时的 `coder` Memory，Source Agent、各 branch Agent 和各份 Memory 在 fork 后互相独立。Branch 继承 source Workspace；如果它们共享可写路径，实际 Agent 执行会由 Workspace lock 串行。后续对 branch Agent 的状态性调用排在其启动动作之后。

等待 child flow：

```text
reports = sync jobs
reports = sync jobs, @format.json_array
```

`dispatch` 返回 TaskGroup handle。`sync` 返回包含 child flow 结果集合的 Frag；省略 formatter 时，content 是按声明顺序排列的 JSON string array。显式 formatter 由 Formatter binding 执行。`fork` 返回派生的 Agent handle，不使用 `sync` 汇合；需要结果时继续调用该 Agent，前一次输出已经保存在其 Memory 中。

## 11. Capability

`invoke` 显式调用 skill、MCP method 或 VM capability，并把 capability 输出格式化为 Frag：

```text
page = invoke @skill.web.read, url
issue = invoke @mcp.github.get_issue, repository, number
```

Symbol 的输入、输出格式和授权由 Capability binding 与 policy 提供。

## 12. Memory

Agent 创建后可以通过 `.memory` 引用其 working memory。

把 role-free Frag 加入 Memory：

```text
coder.memory.append user, review_result
coder.memory.append tool, tool_result
```

复制完整 Memory：

```text
review_memory = coder.memory.copy
reviewer = agent @agent.reviewer, [memory: review_memory]
```

把 Memory 应用到已有 Agent 的配置副本：

```text
branch_memory = coder.memory.copy
branch = coder.with_memory branch_memory
```

`with_memory` 返回新的 Agent handle。新 Agent 沿用 source Agent 的 binding 与配置并使用给定 Memory；source Agent 不发生变化。给定 Memory 已绑定 Agent 时，VM 报告 `MEMORY_ALREADY_BOUND`。

`memory.append` 需要 role，因为它建立从 Frag 到 Memory message 的边界。`memory.copy` 保留来源消息已有的 role，因此不接收新的 role。

## 13. Freedom

`agent.route` 临时向普通 planner Agent 暴露环境查询和动态路由登记工具，并返回 TaskGroup：

```text
jobs = planner.route prompt, [nodes: [node0, node1], params: [task: task, spec: spec], min_routes: 1, max_routes: 2]
reports = sync jobs
```

Planner 通过 `afl.route.add` 登记 Node 调用；Node 在 planner activation 完成后由 VM 按 dispatch policy 启动，不把结果隐式交回 planner。`sync` 负责等待、格式化结果和传播 child failure。

`agent.flow` 暴露环境查询、既有 Node 执行以及 generated IR 的校验和执行工具：

```text
result = writer.flow prompt, [nodes: [node0, node1], agents: [@agent.fast, @agent.strong], params: [task: task], min_routes: 0, max_routes: 4]
```

Node allowlist 只接受本 module 的 Node 名称；Flow 的 Agent allowlist 只接受 `@agent.*` symbol。`min_routes` 和 `max_routes` 分别要求本次 activation 至少和至多路由多少次；`min_routes` 可以为 0，`max_routes` 必须为正整数且不小于前者。并行度、超时和工具调用预算属于 VM policy，不进入 AFL options。所有语境中 `[]` 都是空 list，`[:]` 都是空 record；空 typed options 也写作 `[:]`，通常直接省略。

受控参数也使用具名 record。Agent 可以通过 `{ref: "param:name"}` 选择显式参数，也可以通过 `{string: "..."}` 传入自由文本；这里的 `{...}` 是临时 tool 的 JSON 参数，不是 AFL record 语法。Flow writer 还可以引用本次 activation 中先前工具产生的结果。Route planner 完成后，VM 检查已登记 route 是否满足 `min_routes` 并返回 TaskGroup；零 route 对应合法的空 TaskGroup。Flow 成功执行过 Node 或 generated IR 时返回 writer 的 final response Frag，未成功执行任何内容时返回空 Frag。临时工具都不会泄漏到该 Agent 后续的普通 `do`。

Freedom activation 延续该 Agent 已有的 Memory 和 executor session，指令的 `prompt` 作为普通 user message 加入同一份 Memory。`environment.get` 不返回 AFL 语法；当前调用方可以在 `prompt` 中直接给出必要的最小语法，后续再由 AFL skill 提供完整语言知识。

## 14. 指令形式汇总

```text
dst = agent symbol [, [workspace: value, memory: memory, tools: profile-or-list]]
agent.system_prompt prompt
dst = agent.do frag [, [role: role, schema: schema]]

dst = prompt prompt_source [, value ...]
dst = input prompt_source [, schema]

dst = oper expression
dst = python "script" [, value ...]
dst = typescript "script" [, value ...]
dst = shell "command" [, value ...]

dst = call flow(value ...)
dst = dispatch [flow_call, flow_call, ...]
dst = repeat count, flow(task)
dst = source_agent.fork frag
dst = sync task_group [, formatter]
dst = invoke symbol [, value ...]

target_memory.append role, frag
dst = source_memory.copy
dst = source_agent.with_memory memory

dst = planner.route prompt, [nodes: [node ...], params: [param: value ...], min_routes: value, max_routes: value]
dst = writer.flow prompt, [nodes: [node ...], agents: [agent_symbol ...], params: [param: value ...], min_routes: value, max_routes: value]

jump target
branch condition, true_target, false_target
match selector, [case_value: target, ...], default_target
ret [value]
fail error
```
