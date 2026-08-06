# Agent Flow Language

AFL 是一种面向 Agent 工作流的描述语言，当前实现提供文本 IR、parser、semantic validator、dependency scheduler 和 TypeScript VM。

文本 AFL 通过显式 VM bindings 连接 Agent、Prompt、Input、Script、Capability、外部 Flow、Formatter、Schema、Freedom 和 Trace 实现。当前格式为 v0，API 与文本格式可能继续调整。

AFL提供一种最小IR实现，并不提供高级描述，可以使用python、typescript等语言作为AFL IR generator前端，以提供更加便捷的表达方式

## 架构

```text
AFL IR source -> parser -> validator -> dependency scheduler -> AFL VM -> bindings
```

## 一个代表性工作流

下面的 flow 让 Coder 完成任务，再把 Coder 的完整 Memory 复制给 Reviewer。Reviewer 返回 `finish` 时结束；否则缺陷列表会交回 Coder，随后再次审核：

```text
main(task):
    entry:
        coder = agent @agent.coder
        coder.sysprompt "Implement the requested change and return the current complete result."
        code = coder.do task
        jump review

    review:
        review_memory = memory.copy coder.memory
        reviewer = agent @agent.reviewer, review_memory
        reviewer.sysprompt "Return exactly finish when correct; otherwise return a defect list."
        review_result = reviewer.do "Review the latest implementation."
        finish = oper review_result == "finish"
        jump finish, done, revise

    revise:
        fix_prompt = prompt "Fix every listed defect", review_result
        code = coder.do fix_prompt
        jump review

    done:
        ret code
```

```text
task -> Coder -> copy Memory -> Reviewer -> finish -> result
          ^                         |
          +------ defect list ------+
```

这里的 Agent 调用、Memory 复制、结果依赖、条件跳转和循环都是 VM 执行的 flow 语义，不是宿主代码中的隐藏编排。相同 primitive 还能通过 `dispatch/sync` 表达并行 Worker，通过 `fork` 创建继承上下文的 Agent 分支，并在预定义路径不足时使用受验证的 `freedom` fallback。完整文件见 [`examples/coder-reviewer.afl`](examples/coder-reviewer.afl)，并行案例见 [`docs/guides/parallel-voting.md`](docs/guides/parallel-voting.md)。

## AFL VM

安装 npm 包后，VM 的最短调用只需要 bindings module 与 AFL IR：

```bash
afl-vm ./bindings.mjs ./flow.afl
```

VM 默认调用 `main()`。参数化入口可以显式传入参数，其他选项按需增加：

```bash
afl-vm ./bindings.mjs ./flow.afl --entry main --args '["task"]'
afl-vm ./bindings.mjs ./flow.afl --trace trace.json
```

Bindings module 默认导出 `VmBindings`，也可以使用名为 `bindings` 的导出。它既可以是文件路径，也可以是已安装的 package specifier。VM 按指令实际使用情况检查 binding；纯计算 flow 可以传入只包含 `export default {}` 的空 bindings module。

仓库内开发时可以直接运行：

```bash
npm install
npm run build
./bin/afl-vm.mjs test/fixtures/noop-bindings.mjs test/fixtures/minimal.afl
```

`afl` 命令负责静态验证；旧 `afl run` 形式暂时保留兼容：

```bash
afl validate examples/coder-reviewer.afl
```

## 打包

`package.json` 将 `afl-vm` 声明为 npm executable，并打包 `bin/`、编译后的 `dist/src/`、规范文档与 README。生成并安装本地包后即可脱离源码目录调用：

```bash
npm pack
npm install -g ./afl-lang-core-0.1.0.tgz
afl-vm ./bindings.mjs ./flow.afl
```

## DeepSeek Smoke

DeepSeek bindings 只从环境变量读取密钥。Smoke flow 本身是无参 `main()`，因此命令也只保留 bindings 与 IR 两项：

```bash
DEEPSEEK_API_KEY=... npm run smoke:deepseek
```

`DEEPSEEK_MODEL` 可以覆盖默认的 `deepseek-v4-flash`，`DEEPSEEK_BASE_URL` 可以覆盖默认 API 地址。密钥不会进入 AFL source、fixture 或 trace。

## 文档

[实现文档](docs/README.md)描述当前 parser、validator、VM 与 CLI 已支持的行为。尚未进入实现契约的长期目标和设计讨论保存在仓库的 `proposals/` 目录，不随 npm package 发布。

## License

本仓库中的代码、文档和示例均采用 [Apache License 2.0](LICENSE) 许可。
