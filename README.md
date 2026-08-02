# Agent Flow Language

Agent Flow Language（AFL）是一种面向 Agent 工作流的描述语言。它以 flow-oriented IR 表达 Agent、Memory、Frag、控制流、依赖并行、公共 flow 和受验证的 `freedom` 行为，使工作流可以被检查、执行、组合和分发。

仓库目前包含第一版 TypeScript reference VM：文本 AFL 经过 parser、semantic validator 和 dependency scheduler 后，由显式 VM bindings 执行。语言语义仍处于 v0 草案阶段，API 与文本格式可能继续调整。

## 架构

```text
Python / TypeScript generator / future AFL DSL
                         |
                         v
                      AFL IR
                         |
              parser / validator / AFL VM
                         |
       Agent / Prompt / Memory / Capability binding
```

AFL IR 本身保持语言无关。TypeScript 是当前 reference VM；Python、TypeScript generator 和未来专用 DSL 都可以作为 frontend。`python/` 仍是早期 Structured HIR frontend，仅保留作历史实验，不兼容当前 IR。

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

## 设计文档

- [项目目标](docs/project-goals.md)
- [语言形态分析](docs/language-form.md)
- [虚拟机工作定义](docs/vm-work.md)
- [AFL IR 设计总览](docs/core-ir-draft.md)
- [AFL IR 文本语法](docs/core-ir-syntax.md)
- [AFL IR 执行语义](docs/core-ir-semantics.md)
- [Memory 基础设施语义](docs/core-ir-memory.md)
- [AFL IR 示例](docs/core-ir-examples.md)
- [AFL IR 设计说明](docs/core-ir-design-notes.md)
- [Parallel Voting 表达力案例](docs/afl-case-study-parallel-voting.md)

语法、执行语义和 Memory 文档描述当前候选规则；设计说明记录推导与开放问题，不属于规范。
