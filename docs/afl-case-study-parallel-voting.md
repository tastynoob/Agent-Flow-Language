# AFL 案例：Parallel Voting

状态：表达力检验草案
日期：2026-08-02

## 1. 选择这个案例

Parallel Voting 是一种常见的 Agent workflow：多个 Worker 独立处理同一任务，再由一个 Judge 汇总或裁决结果。Anthropic 的 [Building Effective AI Agents](https://www.anthropic.com/engineering/building-effective-agents) 将 voting 归入 parallelization，并以多次代码漏洞审查和内容分类为例。

这个案例可以直接检验两类并行表达：

- 手动列出不同的 child flow；
- 按数量批量启动同一个 flow，并向每个实例传入同一个 task。

它也能检验 Frag 汇合、Worker Memory 隔离和动态 Worker 数量，而不要求 `dispatch` 同时承担 task list 映射。

## 2. Batch Dispatch 表达

下面的 flow 先让 Planner 给出评审数量，再批量运行同一个评审 flow：

```text
review_once(code):
    entry:
        reviewer = agent @agent.security_reviewer
        reviewer.sysprompt @prompt.security_reviewer
        review_prompt = prompt @prompt.security_review, code
        vote = reviewer.seqdo review_prompt
        ret vote

parallel_security_review(code):
    entry:
        planner = agent @agent.review_planner
        count_prompt = prompt @prompt.choose_reviewer_count, code
        count_frag = planner.do count_prompt
        reviewer_count = typescript "return Number(args[0])", count_frag
        jobs = dispatch reviewer_count, review_once, code
        votes = sync jobs, @format.json_array
        judge = agent @agent.review_judge
        judge_prompt = prompt @prompt.judge_reviews, code, votes
        result = judge.seqdo judge_prompt
        ret result
```

`reviewer_count` 是 compute value。Planner 返回的 Frag 需要由 script executor 解析并校验为非负整数；VM policy 还可以设置允许的最大值。

`dispatch reviewer_count, review_once, code` 创建 `reviewer_count` 次 `review_once(code)`。每次调用拥有独立的 node invocation、Agent 和默认 Memory，但接收相同的 `code` Frag。各 Worker 之间没有数据或 Memory dependency，因此可以并行运行；`sync` 是它们的汇合点。

## 3. List Dispatch 表达

当多个 Worker 需要不同的 flow、prompt 或参数时，可以手动列出 flow call：

```text
jobs = dispatch [security_review(code), correctness_review(code), test_review(code)]
reviews = sync jobs, @format.json_array
```

这一形式的三个 child 分别调用不同 flow。列表本身已经描述了 Worker 数量、类型和参数，因此不需要额外的 `count`。

两种形式的含义不同：

| 形式 | 描述的工作 |
| --- | --- |
| `dispatch [flow_a(...), flow_b(...)]` | 手动指定一组可能异构的 child flow call |
| `dispatch count, flow, task` | 用同一个 task 批量启动同一个 flow |

两者都返回 TaskGroup handle，并由 `sync` 收集结果。它们都不隐含“遍历一个 task list 并逐项传参”的语义。

## 4. Frag 与 Memory

这个案例中的数据传递遵循现有最小规则：

1. `code` 作为 role-free Frag 进入每个 child flow；
2. `review_prompt` 组合模板与 `code`，并在 `reviewer.seqdo` 的使用边界以默认 `user` role 写入 Reviewer Memory；
3. 每个 `vote` 是 role-free Frag；
4. `sync` 用 formatter 把多个 vote 编码为一个 Frag；
5. Judge 接收原始代码和汇合结果，给出最终 Frag。

Dispatch Worker 默认不共享 Memory。若评审需要从某个已有 Agent 的上下文继续，可以写成 `reviewer = fork source_agent, reviewer.do review_prompt`；fork 会 copy source Memory、创建 branch Agent 并立即启动工作。若需要换用不同的 Agent binding 或自行控制 Memory，则仍可显式使用 `memory.copy`。

## 5. 表达效果

Batch 版本使用两个 node 和十五条指令表达了动态数量决策、同构 Worker 创建、并行执行、Memory 隔离、结果汇合与最终裁决。Core IR 不需要增加专门的 voting、shared state 或 reducer 指令。

List 版本则说明，同一个并行原语也可以描述固定的多专家审查。Prompt package 可以进一步把安全、正确性和测试等评审范式封装在各自 flow 中。

## 6. 暴露出的边界

这个案例也留下几项需要继续收敛的语义：

- Batch Worker 是否需要可选的实例序号或实例 metadata；
- `count` 的数值校验、最大值和资源预算由 validator 还是 VM policy 负责；
- 单个 child 失败时，`sync` 采用整体失败还是允许 all-settled；
- 结果顺序按声明顺序、实例序号还是完成顺序确定；
- 相同 flow、task、模型配置和确定性推理可能产生重复结果，voting flow 如何声明采样差异；
- 若后续需要把不同 task 逐项分发给同一个 flow，应设计独立的 map 语义，而不是改变 batch dispatch。

这些问题不妨碍当前两种 `dispatch` 形式描述基础 Parallel Voting，但会影响 VM 的可复现性和容错行为。

## 7. 结论

当前 AFL 草案可以较紧凑地表达 Parallel Voting，并且两种 `dispatch` 形式各自保持单一含义：list dispatch 描述显式 child call 集合，batch dispatch 描述同一 flow 与 task 的多实例执行。需要继承 Agent Memory 时再使用 `fork`，使“并行”与“上下文分支”不再混为同一语义。

这个案例能够说明 AFL 对并行审查类 flow 有实际表达力，但还不能代表任意动态派单。带 task list 的 Orchestrator-Workers 更适合在 map、动态 flow 生成或其他分发语义明确后另行检验。
