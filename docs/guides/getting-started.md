# AFL 快速开始

## 环境要求

- Node.js 22.19.0 或更高版本
- npm

在仓库中安装依赖并构建：

```bash
npm install
npm run build
```

## 验证 AFL 文件

`afl` 命令用于解析并静态验证 AFL 文件：

```bash
./bin/afl.mjs validate examples/coder-reviewer.afl
```

诊断信息包含稳定的错误代码和源码位置。验证会检查结构、名称、操作数类别、控制流、依赖环和 TaskGroup 生命周期，不会执行 Agent 或外部能力。

## 执行 AFL 文件

`afl-vm` 接收一个 `bindings` 模块和一个 AFL 文件，默认执行 `main()`：

```bash
./bin/afl-vm.mjs test/fixtures/noop-bindings.mjs test/fixtures/minimal.afl
```

入口参数和 trace 文件可以显式指定：

```bash
./bin/afl-vm.mjs ./bindings.mjs ./flow.afl --entry main --args '["task"]'
./bin/afl-vm.mjs ./bindings.mjs ./flow.afl --args-file ./args.json --trace ./trace.json
```

安装 npm 包后可以直接使用 `afl` 和 `afl-vm` 命令：

```bash
afl validate ./flow.afl
afl-vm ./bindings.mjs ./flow.afl
```

## `bindings` 模块

`bindings` 模块默认导出一个 `VmBindings` 对象，也可以提供名为 `bindings` 的导出。最小模块只需导出空对象：

```js
export default {};
```

各项 binding 均在工作流实际使用时按需检查。纯计算工作流可以使用空对象；使用 Agent、Prompt、Script、Capability、外部 Flow、Formatter 或 Schema 时，再提供对应 adapter。可用字段见 [IR 概览](../spec/ir.md#6-bindings)。

带原生 agent loop 和 session 的运行时通过 `agentExecutor` 接入。Pi 配置示例见 [`examples/pi-bindings.mjs`](../../examples/pi-bindings.mjs)；不同 Agent 可以通过 Pi backend 的 `agents` map 绑定不同模型和工具。工具权限、人工请求及 bubblewrap 配置见 [Agent 工具安全](agent-security.md)。

## 开发与测试

```bash
npm test
```

完整测试会构建 TypeScript、运行 VM 与 adapter 测试、验证 CLI，并检查打包后的安装结果。

需要真实模型的冒烟测试从环境变量读取凭据：

```bash
DEEPSEEK_API_KEY=... npm run smoke:deepseek
DEEPSEEK_API_KEY=... npm run smoke:pi
```

`DEEPSEEK_MODEL` 可以覆盖两个命令使用的默认模型；`DEEPSEEK_BASE_URL` 只用于 `smoke:deepseek` 的 OpenAI-compatible API 地址。密钥不应写入 AFL source、fixture 或 trace。

## 本地打包

```bash
npm pack
npm install -g ./afl-lang-core-*.tgz
```

生成的 npm 包包含 CLI、编译产物、正式文档和示例。
