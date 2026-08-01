# AFL Python frontend

This package builds and serializes AFL Canonical Flow IR. It does not execute
flows and does not implement Agent, skill, MCP, browser, or tool behavior.

```python
from afl import define_program, expr as e, node as n, schema as s

program = define_program(
    name="echo",
    entry="main",
    flows={
        "main": {
            "input": s.string(),
            "output": s.string(),
            "body": n.return_("return", e.input()),
        }
    },
)

program.emit("echo.aflir")
```

Validate and execute the output with the TypeScript toolchain:

```text
afl validate echo.aflir
afl run echo.aflir --input '"hello"'
```
