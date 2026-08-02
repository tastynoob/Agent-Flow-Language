# AFL Documentation

Agent Flow Language（AFL）是项目正式名称。本目录只描述当前 AFL parser、validator、VM 和 CLI 已实现的行为。AFL IR 仍处于 v0 阶段，但本文档中的语法和语义均应能在当前实现中解析、验证或执行。

## IR 规范

- [IR 概览](spec/ir.md)
- [文本语法](spec/syntax.md)
- [执行语义](spec/semantics.md)
- [Memory 语义](spec/memory.md)

## 使用示例

- [AFL IR 示例](guides/examples.md)
- [Parallel Voting](guides/parallel-voting.md)

## VM 与 CLI

VM 的最小命令为：

```text
afl-vm <bindings-module> <flow.afl>
```

VM 默认执行无参 `main()`。完整参数和 bindings module 约定见项目 [README](../README.md#afl-vm)。
