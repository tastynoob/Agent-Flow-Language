# AFL 案例：Parallel Voting

## 1. 选择这个案例

Parallel Voting 是一种常见的 Agent workflow：多个 Worker 独立处理同一任务，再由一个 Judge 汇总或裁决结果。Anthropic 的 [Building Effective AI Agents](https://www.anthropic.com/engineering/building-effective-agents) 将 voting 归入 parallelization，并以多次代码漏洞审查和内容分类为例。

这个案例可以直接检验两类并行表达：

- 手动列出不同的 child flow；
- 按数量批量启动同一个 flow，并向每个实例传入同一个 task。

它也能检验 Frag 汇合、Worker Memory 隔离和动态 Worker 数量，而不要求 `dispatch` 同时承担 task list 映射。

## 2. Batch Dispatch 表达

下面的 flow 先让 Planner 给出评审数量，再批量运行同一个评审 flow：

```text
review_once(code, workspace):
    entry:
        reviewer = agent @agent.security_reviewer, workspace
        reviewer.sysprompt @prompt.security_reviewer
        review_prompt = prompt @prompt.security_review, code
        vote = reviewer.do review_prompt
        ret vote

parallel_security_review(code):
    entry:
        planner = agent @agent.review_planner
        count_prompt = prompt @prompt.choose_reviewer_count, code
        count_frag = planner.do count_prompt
        reviewer_count = typescript "return Number(args[0])", count_frag
        jobs = dispatch reviewer_count, @flow.generated_review_once, code
        votes = sync jobs, @format.json_array
        judge = agent @agent.review_judge
        judge_prompt = prompt @prompt.judge_reviews, code, votes
        result = judge.do judge_prompt
        ret result
```

`reviewer_count` 是 compute value。Planner 返回的 Frag 由 Script binding 转换为 number；dispatch 在运行时要求它是非负整数。`maxDispatchTasks` policy 可以限制 task 总数。

Batch dispatch 会创建 `reviewer_count` 个独立 node invocation。当前 batch 形式只向每个 child 传同一个 task，不传 ordinal，因此上例用外部 generator 提供的 `@flow.generated_review_once`：generator 为每个实例生成 `workers/0/`、`workers/1/` 等 sibling 主工作区。若所有 Worker 都省略 Workspace，它们会共享执行根目录，并因写锁而串行；`sync` 仍是结果汇合点。

## 3. List Dispatch 表达

当多个 Worker 需要不同的 flow、prompt 或参数时，可以手动列出 flow call：

```text
jobs = dispatch [review_once(code, "workers/security/"), review_once(code, "workers/correctness/"), review_once(code, "workers/tests/")]
reviews = sync jobs, @format.json_array
```

这一形式显式给每个 child 传入 sibling Workspace。列表本身已经描述了 Worker 数量、类型和参数，因此不需要额外的 `count`；也可以把三个位置换成不同的 review flow。

两种形式的含义不同：

| 形式 | 描述的工作 |
| --- | --- |
| `dispatch [flow_a(...), flow_b(...)]` | 手动指定一组可能异构的 child flow call |
| `dispatch count, flow, task` | 用同一个 task 批量启动同一个 flow |

两者都返回 TaskGroup handle，并由 `sync` 收集结果。它们都不隐含“遍历一个 task list 并逐项传参”的语义。

## 4. Frag 与 Memory

这个案例中的数据传递遵循现有最小规则：

1. `code` 作为 role-free Frag 进入每个 child flow；
2. `review_prompt` 组合模板与 `code`，并在 `reviewer.do` 的使用边界以默认 `user` role 写入 Reviewer Memory；
3. 每个 `vote` 是 role-free Frag；
4. `sync` 用 formatter 把多个 vote 编码为一个 Frag；
5. Judge 接收原始代码和汇合结果，给出最终 Frag。

Dispatch Worker 默认不共享 Memory。若评审需要从某个已有 Agent 的上下文继续，可以写成 `reviewer = fork source_agent, reviewer.do review_prompt`；fork 会 copy source Memory、创建 branch Agent 并立即启动工作。若需要换用不同的 Agent binding 或自行控制 Memory，则仍可显式使用 `memory.copy`。

## 5. 表达效果

Batch 版本使用两个 node 和十五条指令表达了动态数量决策、同构 Worker 创建、并行执行、Memory 隔离、结果汇合与最终裁决。Core IR 不需要增加专门的 voting、shared state 或 reducer 指令。

List 版本说明，同一个并行原语也可以描述固定的多专家审查。不同 Prompt 与外部 Flow symbol 分别由对应 binding 解析。

## 6. 当前行为与限制

- Batch Worker 不接收实例序号或 metadata；需要编号 Workspace 时由 AFL generator 或外部 flow binding 补充；
- `count` 在 VM 运行时校验，默认 task 总数上限为 10,000；
- 默认最多同时运行 16 个 dispatch worker；
- 任一 child 失败会取消同组其他 child，`sync` 不提供 all-settled 结果；
- 结果按 list 声明顺序或 batch ordinal 排列，不按完成顺序排列；
- 当前没有 iterable map、race 或 per-worker sampling 配置语法。

## 7. 结论

当前实现可以用两种 `dispatch` 表达 Parallel Voting：list dispatch 描述显式 child call 集合，batch dispatch 描述同一 flow 与 task 的多实例执行。需要继承 Agent Memory 时使用 `fork`。运行时 task list 的逐项派发不属于这两种形式。
