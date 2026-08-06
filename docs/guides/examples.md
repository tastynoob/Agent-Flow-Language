# AFL IR 示例

## 1. Coder / Reviewer 修订循环

```text
coder_review(task):
    entry:
        coder = agent @agent.coder
        coder.sysprompt @prompt.coder
        task_prompt = prompt "Implement the task", task
        code = coder.do task_prompt
        jump review

    review:
        review_memory = memory.copy coder.memory
        reviewer = agent @agent.reviewer, review_memory
        reviewer.sysprompt @prompt.reviewer
        review_prompt = prompt "Review the implementation. If no defect exists, output exactly finish; otherwise output the defect list"
        review_result = reviewer.do review_prompt
        finish = oper review_result == "finish"
        jump finish, done, revise

    revise:
        fix_prompt = prompt "Fix the following defects", review_result
        code = coder.do fix_prompt
        jump review

    done:
        ret code
```

`review_result` 始终是 role-free Frag。它包含精确的 `finish` 或文本缺陷列表，不需要为了这个分支定义 JSON BugList。`fix_prompt` 也是 Frag；传给 `coder.do` 时默认以 `user` role 加入 Coder Memory。

每次进入 `review` 都从最新 Coder Memory 创建独立 copy。Reviewer 可以看到完整上下文，但其审查过程不会改写 Coder Memory。

## 2. 显式 Memory Append

上一例的 `revise` 也可以写成：

```text
revise:
    memory.append coder.memory, user, review_result
    fix_command = prompt @prompt.fix_current_defects
    code = coder.do fix_command
    jump review
```

这里 role 明确写在 Frag 进入 Memory 的位置。`review_result` 本身仍不带 role。

## 3. Blind Review

```text
blind_review(code):
    entry:
        reviewer = agent @agent.reviewer
        reviewer.sysprompt @prompt.reviewer
        review_prompt = prompt "Review only the supplied code. Return exactly finish when no defect exists", code
        review_result = reviewer.do review_prompt
        ret review_result
```

Reviewer 只看显式传入的 `code` Frag，不继承 Coder 的工作历史。

## 4. 多 Agent 自动并行

```text
parallel_review(code):
    entry:
        security = agent @agent.security_reviewer
        quality = agent @agent.quality_reviewer
        tests = agent @agent.test_reviewer

        security_prompt = prompt "Review security", code
        quality_prompt = prompt "Review maintainability", code
        test_prompt = prompt "Design missing tests", code

        security_report = security.do security_prompt
        quality_report = quality.do quality_prompt
        test_report = tests.do test_prompt

        reports = prompt @prompt.combine_reports, security_report, quality_report, test_report
        ret reports
```

三个 Agent 调用彼此没有数据或 Memory 依赖，因此 VM 可以同时启动。三个 Frag 都完成后，Prompt binding 根据 `@prompt.combine_reports` 将它们组合成新的 Frag。

## 5. Dispatch Child Flow

```text
full_review(code):
    entry:
        jobs = dispatch [@flow.security_review(code), @flow.performance_review(code), @flow.api_review(code)]
        reports = sync jobs
        ret reports
```

`dispatch` 返回 TaskGroup handle；这些 child flow 不继承某个已有 Agent 的 Memory。省略 formatter 的 `sync` 将多个 Frag content 编码成 JSON string array，并包装为一个 Frag。

## 6. Fork Agent Branches

```text
explore_alternatives(coder, task):
    entry:
        fast_prompt = prompt "Try the fastest viable approach", task
        safe_prompt = prompt "Try the lowest-risk approach", task
        simple_prompt = prompt "Try the simplest maintainable approach", task

        fast = fork coder, fast.do fast_prompt
        safe = fork coder, safe.do safe_prompt
        simple = fork coder, simple.do simple_prompt

        finish_prompt = prompt "Finish and return the proposed result"
        fast_result = fast.do finish_prompt
        safe_result = safe.do finish_prompt
        simple_result = simple.do finish_prompt
        alternatives = prompt @prompt.combine_alternatives, fast_result, safe_result, simple_result
        ret alternatives
```

三条 `fork` 分别从 `coder` 派生一个 Agent，并立即执行各自的首轮工作。每个 branch 的初始 Memory 都是 `coder.memory` 的独立副本，后续工作互不改写。同一 branch 上后续的 `do` 排在启动动作之后，三个 branch 之间仍可并行。

## 7. `do` 与交互式路由

```text
guided_work(task):
    entry:
        worker = agent @agent.worker
        start_prompt = prompt "Start the task. Output ask_user if external input is required"
        step = worker.do start_prompt
        needs_user = oper step == "ask_user"
        jump needs_user, ask_user, continue_work

    ask_user:
        answer = input "Provide the missing information"
        resume_prompt = prompt "Continue with this answer", answer
        result = worker.do resume_prompt
        ret result

    continue_work:
        continue_prompt = prompt "Continue and finish the task", task, step
        result = worker.do continue_prompt
        ret result
```

每次 `do` 都表示一次完整的 Agent 工作激活。执行后端可以在其中完成多个模型 turn、工具调用或其他内部步骤；Agent 结束当前工作后，`do` 才把最终结果交还给 flow。

## 8. JSON 仍然只是 Frag 格式

```text
structured_review(code):
    entry:
        reviewer = agent @agent.reviewer
        review_prompt = prompt "Return the review as JSON", code
        report = reviewer.do review_prompt, @schema.ReviewReport
        ret report
```

`@schema.ReviewReport` 由 Schema binding 校验，但 `report` 仍是 role-free Frag，其 content 是 JSON 字符串。解析、转换或复杂判断交给 script binding。

## 9. `oper` 与 Script Executor

```text
review_decision(review, tests, policy):
    entry:
        normal_finish = oper review == "finish" & tests == "pass"
        policy_finish = typescript "return decide(args[0], args[1], args[2])", review, tests, policy
        finish = oper normal_finish & policy_finish
        ret finish
```

Frag 在 `oper` 和 script 中作为 content string 使用。`oper` 与 script 返回本地 compute value，不会把结果自动加入 Agent Memory。

## 10. 显式 Capability 调用

```text
inspect_issue(repository, number):
    entry:
        issue = invoke @mcp.github.get_issue, repository, number
        analyst = agent @agent.analyst
        analysis_prompt = prompt "Analyze this issue", issue
        report = analyst.do analysis_prompt
        ret report
```

`invoke` 通过 Capability binding 调用 `@mcp.github.get_issue`，并把返回字符串包装为 role-free Frag。若由 Analyst 在 `do` 内自行调用工具，则属于 Agent executor 内部行为。

## 11. Freedom Fallback

```text
route_task(task):
    entry:
        router = agent @agent.router
        route_prompt = prompt "Return a known route name, or exactly unknown", task
        route = router.do route_prompt
        known = oper route != "unknown"
        jump known, known_route, fallback

    known_route:
        result = call @flow.known_dispatch, task, route
        ret result

    fallback:
        planner = agent @agent.planner
        freedom_prompt = prompt "Choose or construct a flow for this unresolved task"
        context = prompt @prompt.freedom_context, task, route
        result = freedom.flow planner, freedom_prompt, context
        ret result
```

`freedom.flow` 在已知路由无法覆盖任务时接管，并返回 role-free Frag。Freedom binding 返回的 plan 需要通过 mode 和结构检查；generated flow 还会经过 parser 与 validator，可选 policy 可以拒绝执行。

## 12. 可复用 Flow 集

```text
deliver(task):
    entry:
        draft = call @flow.common.implement, task
        reviewed = call @flow.common.review_until_pass, task, draft
        packaged = call @flow.common.package_result, reviewed
        ret packaged
```

`@flow.*` symbol 由 External Flow binding 解析，业务输入输出通过 Frag 或 compute value 传递。当前 IR 没有 package 声明或导入语法。
