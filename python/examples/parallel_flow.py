from afl import define_program, expr as e, node as n, schema as s, target as t


program = define_program(
    name="python-parallel-map",
    entry="main",
    flows={
        "main": {
            "input": s.array(s.number()),
            "output": s.array(s.number()),
            "locals": {
                "item": {"schema": s.number()},
                "index": {"schema": s.number(integer=True)},
                "results": {"schema": s.array(s.number()), "initial": []},
            },
            "body": n.sequence(
                "main",
                [
                    n.for_each(
                        "double-items",
                        e.input(),
                        "item",
                        n.return_(
                            "return-double",
                            e.binary("multiply", e.local("item"), e.literal(2)),
                        ),
                        index="index",
                        max_concurrency=3,
                        assign=t.local("results"),
                    ),
                    n.return_("return-results", e.local("results")),
                ],
            ),
        }
    },
)


if __name__ == "__main__":
    print(program.dumps())
