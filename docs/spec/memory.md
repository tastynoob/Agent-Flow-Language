# AFL Memory 语义

## 1. 最小模型

当前实现使用三个业务概念：

```text
Frag {
    content: string
}

Message {
    role
    content: string
}

Memory {
    messages: Message[]
}
```

Frag 是不带 role 的字符串 wrapper。Memory 是按顺序保存的、带 role 字符串集合。Role 只在 Frag 被加入 Memory 时确定。

JSON 可以作为 Frag content 的一种格式，但 Memory 不要求内容必须是 JSON。Flow 可以自行约定纯文本、Markdown、XML 或其他字符串协议。

模型的 thinking、工具调用和工具结果不伪装成 AFL Message role；它们属于 executor continuation。VM 会把 continuation 与 AFL Memory 一起持久化，但 flow 不能读取或修改其内部结构。

## 2. Agent 默认绑定

创建 Agent 时，VM 默认同时创建并绑定一份 working Memory：

```text
coder = agent @agent.coder
```

后续 `coder.do` 自动使用 `coder.memory`，不需要每次显式传入 Memory handle。

Memory 在 flow 中仍表现为当前 run 的 handle，但其 canonical Message 会由 VM 持久化。默认存储位置是执行根目录下的 `.afl/memory/`；再次使用同一 `runId` 和同一 root module 时，VM 按稳定 slot 恢复 Message，然后从 flow entry 重新执行。绑定可以替换存储目录或整个 `MemoryStateStore`。

## 3. Agent 输入与输出

```text
result = coder.do prompt
```

省略 role 时，这条指令依次执行：

1. 把 `prompt.content` 以 `user` role append 到 `coder.memory`；
2. 执行 Coder；
3. 把 Coder 输出以 `assistant` role append 到 `coder.memory`；
4. 返回包装相同输出字符串的 role-free Frag `result`。

显式 role 写在 `do` options 中：

```text
result = coder.do tool_result, [role: tool]
```

Agent 输出在来源 Memory 中是 assistant Message，但返回 Frag 不带 `assistant`。因此它进入另一个 Agent 时可以重新解释为 `user`、`tool` 或其他 role。

一次 `do` 可以由 Agent executor 完成多个模型或工具步骤。工具调用、thinking 和 compaction 等 backend-native entry 不进入 AFL canonical Message 序列，但会作为 opaque continuation 随同 Memory slot 持久化。Executor 只返回最终输出，VM 是唯一将它追加为 canonical `assistant` Message 的组件，并把同一字符串作为 role-free Frag 返回。

## 4. `memory.append`

```text
target_memory.append role, frag
```

该指令把以下 Message 加到目标 Memory 尾部：

```text
{
    role: role,
    content: frag.content
}
```

Role 是必需的，因为 Frag 自身没有 role。

同一个 Frag 可以进入多个 Memory，并使用不同 role：

```text
coder.memory.append user, review_result
analyst.memory.append tool, review_result
archive.memory.append assistant, review_result
```

这些操作不会修改原 Frag。

## 5. `memory.copy`

```text
review_memory = coder.memory.copy
```

`memory.copy` 创建一份独立 Memory，并按顺序复制 source 中已经完成的 Message：

- 每条 Message 保留原 role 和 content；
- source 与 copy 具有不同 identity；
- copy 之后双方写入互不自动传播；
- source 后续新增 Message 不会出现在既有 copy 中。

Copy 不需要 role operand。它处理的是已经带 role 的完整 Message 序列；把单个 role-free Frag 加入 Memory 应使用 `memory.append`。

执行器支持 session export 时，copy 还会携带一份 flow 不可读取的 continuation。Continuation 与复制时的 Message revision 绑定；source 后续执行不会改变既有 copy 所指向的位置。它不是 Message，也不影响 Memory 的可移植内容。

## 6. `with_memory`

```text
branch = source_agent.with_memory branch_memory
```

`with_memory` 使用 source Agent 的 symbol 与 system prompt 创建新的 Agent，并把指定 Memory 绑定为它的 working Memory。它不修改 source Agent，也不隐式复制 Memory。传入的 Memory 已有 owner 时，VM 报告 `MEMORY_ALREADY_BOUND`。需要隔离时先执行 Memory `copy`：

```text
branch_memory = source_agent.memory.copy
branch = source_agent.with_memory branch_memory
```

如果 Memory 的 live checkpoint 与 source Agent 配置兼容，新 Agent 首次执行时直接 fork 原生 session；否则由同名 executor 从持久化 continuation 为目标 Agent binding 重建独立 session。只有不存在 continuation 时才从 canonical Message 重建；continuation 属于其他 executor 时显式失败。

## 7. System Prompt

```text
coder.system_prompt @prompt.coder
```

`system_prompt` 设置 Agent handle 上单独保存的 system prompt，不会向 `messages` 追加 Message。后续 Agent 工作通过 `AgentExecutionRequest.systemPrompt` 接收该值。

设置 Reviewer system prompt 不会修改被复制的 Coder Memory，也不会反向影响 Coder 配置。

## 8. Contextual Review

```text
review_memory = coder.memory.copy
reviewer = agent @agent.reviewer, [memory: review_memory]
reviewer.system_prompt @prompt.reviewer
review_result = reviewer.do review_prompt
```

Reviewer 从 Coder 的完整 role/message 历史开始工作。Review 输出写入 Reviewer Memory，同时以 role-free Frag 返回给 flow。

如果每轮修订后都要查看最新上下文，可以在 review block 的每次 activation 中重新执行 `memory.copy`。

## 9. 把 Review 交给 Coder

最直接的方式是把 review Frag 作为下一次 Agent 输入。`do` 默认使用 `user` role：

```text
fixed = coder.do review_result
```

需要补充固定指令时，可以先生成新的 Frag：

```text
fix_prompt = prompt "Fix the following defects", review_result
fixed = coder.do fix_prompt
```

也可以先显式写入 Memory：

```text
coder.memory.append user, review_result
fix_command = prompt @prompt.fix_current_defects
fixed = coder.do fix_command
```

三种写法都能传递 review 内容，但 prompt 组织方式和最终进入 Coder Memory 的 Message 数量不同。

## 10. Blind Review

```text
reviewer = agent @agent.reviewer
review_prompt = prompt "Review only this artifact", artifact
review_result = reviewer.do review_prompt
```

Reviewer 只接收显式 Frag，不继承 Coder Memory。这可以减少历史信息的影响，但也可能缺少需求和实现过程中的上下文。

## 11. Dependency 与并发

同一 Memory 上的 append 和 Agent 调用形成资源依赖，避免并发写入导致 Message 顺序不确定。

不同 Agent 默认拥有不同 Memory；省略 Workspace 时，每次 Agent allocation 也会在 `.afl/tmpworkspace/<run-id>/` 下获得独立主工作区，因此互不依赖的 Agent 可以并行。需要固定目录或共享只读代码时，可以显式指定互不重叠的主工作区和公共只读工作区；要分发相同上下文时可以分别 copy：

```text
security_memory = coder.memory.copy
quality_memory = coder.memory.copy
security = agent @agent.security, [workspace: "workers/security/", memory: security_memory]
quality = agent @agent.quality, [workspace: "workers/quality/", memory: quality_memory]
```

两个 Reviewer 从相同 Message 序列开始，但各自写入独立 Memory。

## 12. `fork`

需要从同一个 Agent 上下文派生并立即启动新分支时，可以使用 `fork`：

```text
security = coder.fork security_prompt
quality = coder.fork quality_prompt
```

每条指令依次完成 Memory copy、`with_memory` 和首次 `do`，不需要逐个声明临时 Memory 与 Agent。Fork 继承 source Agent 的 Workspace；多个 branch 因而仍可能被同一可写 Workspace 串行化。

Fork 完成后：

- `coder.memory` 保持原 identity；
- 每个 branch 拥有不同的 Agent 和 Memory identity；
- fork 时已经完成的 Message 保留 role 与顺序；
- executor 支持原生 fork 时，branch 从复制时的 checkpoint 派生独立 session；
- source 或任一 branch 的后续写入不传播给其他分支。

不需要继承上下文的并行 child flow 使用 `dispatch`。显式 `memory.copy` 仍然保留，用于 Reviewer 与 Coder 使用不同 Agent binding、只复制但暂不执行，或需要自行决定 Memory 交给哪个 Agent 的场景。

## 13. 当前限制

当前 parser 和 VM 只实现 Memory 的 `append`、`copy`、Agent 的 `with_memory` 以及 `.memory` 引用。没有 `format`、`select`、`merge` 或 shared Memory 指令；持久化是 VM 内部行为，不增加 AFL 指令。

实验格式固定使用 `version: 0`。默认文件布局为 `.afl/memory/afl-<YYYYMMDD-HHmmss>-<short-id>/program.jsons` 加同目录下的 `<memory-label>.jsons`。文件不是 JSONL，也不是单个 JSON array，而是两空格缩进、对象间空行分隔的顶层 JSON object stream。每个真正进入过 `agent.do` 的稳定 Memory slot 使用一份文件；仅声明 Agent、Memory `copy`、`fork`、`with_memory` 或首次使用前的 `append` 都不会单独物化文件。

Memory 文件依次保存 `memory` header、`do.begin`、连续的 `user`/`assistant`/`tool.result` 等浅层 records，以及正常结束或可控错误时的可选 `do.end`；错误 tail 使用浅层 `error_code`/`error_message`。Pi 在每个完整语义消息形成后 append 并 sync，因此 thinking、tool call 和 tool result 不必等整次 `do` 完成才落盘。每个完整 JSON object 本身就是可恢复状态；缺少 `do.end` 表示进程可能直接中断，但不撤销此前完整 records。EOF 处不完整的最后一个 object 会截断到上一个完整 object 的结束字节，文件中部损坏则显式失败。

`memory.copy` 和 `fork` 的新 slot header 使用 source file/revision 作为 base，只保存自身后续增量，不复制 canonical Message 或 Pi continuation 前缀；源尚未物化时会先递归物化源引用。逻辑加载结果仍是完整 Memory。持久化不包含 VM instruction pointer、TaskGroup、外部工具进程或 Workspace 文件 snapshot；再次运行仍从 flow entry 开始。

Pi Agent binding 可以用 `thinkingReplay: "include" | "exclude"` 决定历史 thinking 是否进入后续模型上下文，默认是 `include`。该选项只过滤 request context，不修改持久化 records。存在 continuation 时必须由同名 executor 恢复；VM 不允许切换 executor 后静默丢弃完整记录。相同 `runId` 在同一个 store namespace 上一次只允许一个活跃的顶层 VM run；同一 run 内的并发 Agent 共享一条持久化队列。
