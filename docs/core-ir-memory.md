# AFL Memory 规则草案

状态：基础规则讨论稿
日期：2026-08-02

## 1. 最小模型

第一版只需要三个概念：

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

模型没有显式输出的内部推理不属于 AFL Memory。

## 2. Agent 默认绑定

创建 Agent 时，runtime 默认同时创建并绑定一份 working Memory：

```text
coder = agent @agent.coder
```

后续 `coder.do/seqdo` 自动使用 `coder.memory`，不需要每次显式传入 Memory handle。

默认 Memory 至少在当前 node invocation 内保持。跨 invocation 或长期持久化可以由 runtime 提供持久 handle，不改变 Agent 指令形式。

## 3. Agent 输入与输出

```text
result = coder.do prompt
```

省略 role 时，这条指令依次执行：

1. 把 `prompt.content` 以 `user` role append 到 `coder.memory`；
2. 执行 Coder；
3. 把 Coder 输出以 `assistant` role append 到 `coder.memory`；
4. 返回包装相同输出字符串的 role-free Frag `result`。

显式 role 写在输入 Frag 前：

```text
result = coder.do tool, tool_result
```

Agent 输出在来源 Memory 中是 assistant Message，但返回 Frag 不带 `assistant`。因此它进入另一个 Agent 时可以重新解释为 `user`、`tool` 或其他 role。

`seqdo` 使用相同的边界规则。其内部可以向 Agent Memory 加入多条 assistant/tool Message，最后只把约定的业务输出作为 role-free Frag 返回。

## 4. `memory.append`

```text
memory.append target_memory, role, frag
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
memory.append coder.memory, user, review_result
memory.append analyst.memory, tool, review_result
memory.append archive.memory, assistant, review_result
```

这些操作不会修改原 Frag。

## 5. `memory.copy`

```text
review_memory = memory.copy coder.memory
```

`memory.copy` 创建一份独立 Memory，并按顺序复制 source 中已经完成的 Message：

- 每条 Message 保留原 role 和 content；
- source 与 copy 具有不同 identity；
- copy 之后双方写入互不自动传播；
- source 后续新增 Message 不会出现在既有 copy 中。

Copy 不需要 role operand。它处理的是已经带 role 的完整 Message 序列；把单个 role-free Frag 加入 Memory 应使用 `memory.append`。

## 6. `memory.apply`

```text
branch = memory.apply source_agent, branch_memory
```

`memory.apply` 使用 source Agent 的 binding 与配置创建新的 Agent，并把指定 Memory 绑定为它的 working Memory。它不修改 source Agent，也不隐式复制 Memory。第一版要求传入尚未绑定其他 Agent 的 Memory；shared Memory 另行定义。需要隔离时先执行 `memory.copy`：

```text
branch_memory = memory.copy source_agent.memory
branch = memory.apply source_agent, branch_memory
```

## 7. System Prompt

```text
coder.sysprompt @prompt.coder
```

`sysprompt` 隐含 `system` role。Runtime 可以把 system prompt 保存为 Memory 中的特殊 Message，也可以映射为 provider 的独立配置；对 AFL flow 来说，它都属于该 Agent 后续可见的 system context。

设置 Reviewer system prompt 不会修改被复制的 Coder Memory，也不会反向影响 Coder 配置。

## 8. Contextual Review

```text
review_memory = memory.copy coder.memory
reviewer = agent @agent.reviewer, review_memory
reviewer.sysprompt @prompt.reviewer
review_result = reviewer.seqdo review_prompt
```

Reviewer 从 Coder 的完整 role/message 历史开始工作。Review 输出写入 Reviewer Memory，同时以 role-free Frag 返回给 flow。

如果每轮修订后都要查看最新上下文，可以在 review block 的每次 activation 中重新执行 `memory.copy`。

## 9. 把 Review 交给 Coder

最直接的方式是把 review Frag 作为下一次 Agent 输入。`do/seqdo` 默认使用 `user` role：

```text
fixed = coder.seqdo review_result
```

需要补充固定指令时，可以先生成新的 Frag：

```text
fix_prompt = prompt "Fix the following defects", review_result
fixed = coder.seqdo fix_prompt
```

也可以先显式写入 Memory：

```text
memory.append coder.memory, user, review_result
fix_command = prompt @prompt.fix_current_defects
fixed = coder.seqdo fix_command
```

三种写法都能传递 review 内容，但 prompt 组织方式和最终进入 Coder Memory 的 Message 数量不同。

## 10. Blind Review

```text
reviewer = agent @agent.reviewer
review_prompt = prompt "Review only this artifact", artifact
review_result = reviewer.seqdo review_prompt
```

Reviewer 只接收显式 Frag，不继承 Coder Memory。这可以减少历史信息的影响，但也可能缺少需求和实现过程中的上下文。

## 11. Dependency 与并发

同一 Memory 上的 append 和 Agent 调用形成资源依赖，避免并发写入导致 Message 顺序不确定。

不同 Agent 默认拥有不同 Memory，可以在没有其他 dependency 时并行工作。需要把相同上下文分发给多个 Agent 时，可以分别 copy：

```text
security_memory = memory.copy coder.memory
quality_memory = memory.copy coder.memory
security = agent @agent.security, security_memory
quality = agent @agent.quality, quality_memory
```

两个 Reviewer 从相同 Message 序列开始，但各自写入独立 Memory。

## 12. `fork`

需要从同一个 Agent 上下文派生并立即启动新分支时，可以使用 `fork`：

```text
security = fork coder, security.do security_prompt
quality = fork coder, quality.seqdo quality_prompt
```

每条指令依次完成 `memory.copy`、`memory.apply` 和右侧启动动作。左侧名称可以在同一条指令的启动动作中引用，因此不需要逐个声明临时 Memory 与 Agent。

Fork 完成后：

- `coder.memory` 保持原 identity；
- 每个 branch 拥有不同的 Agent 和 Memory identity；
- fork 时已经完成的 Message 保留 role 与顺序；
- source 或任一 branch 的后续写入不传播给其他分支。

不需要继承上下文的并行 child flow 使用 `dispatch`。显式 `memory.copy` 仍然保留，用于 Reviewer 与 Coder 使用不同 Agent binding、只复制但暂不执行，或需要自行决定 Memory 交给哪个 Agent 的场景。

## 13. 后续扩展

`append`、`copy` 和 `apply` 构成当前最小语义。以下能力可以在真实用例中继续评估：

- `memory.format`：把完整 Memory 序列化成一个 role-free Frag；
- `memory.select`：选择部分 Message 并保留 role；
- `memory.merge`：显式合并多份 Memory；
- shared Memory：多个 Agent 受协调地写入同一 Memory；
- persistent Memory：跨 flow invocation 继续存在。

这些扩展需要同时定义 Message 顺序、写冲突、权限和 replay 行为。
