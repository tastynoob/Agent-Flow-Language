from afl import define_program, expr as e, node as n, schema as s, target as t


review = s.object(
    {
        "status": s.enum(["accepted", "revision_required", "blocked"]),
        "issues": s.array(s.string()),
    },
    required=["status", "issues"],
    additional_properties=False,
)

program = define_program(
    name="python-coder-reviewer",
    entry="main",
    agents={
        "coder": {
            "capabilities": ["code.write"],
            "operations": {
                "implement": {"input": s.string(), "output": s.string()},
                "revise": {
                    "input": s.object(
                        {
                            "artifact": s.string(),
                            "issues": s.array(s.string()),
                        },
                        required=["artifact", "issues"],
                        additional_properties=False,
                    ),
                    "output": s.string(),
                },
            },
        },
        "reviewer": {
            "capabilities": ["code.review"],
            "operations": {
                "review": {"input": s.string(), "output": review},
            },
        },
    },
    flows={
        "main": {
            "input": s.object(
                {"task": s.string()},
                required=["task"],
                additional_properties=False,
            ),
            "output": s.string(),
            "state": {
                "artifact": {"schema": s.string(), "initial": ""},
                "review": {
                    "schema": review,
                    "initial": {
                        "status": "revision_required",
                        "issues": ["not reviewed"],
                    },
                },
            },
            "body": n.sequence(
                "main",
                [
                    n.invoke(
                        "implement",
                        "coder",
                        "implement",
                        e.input("task"),
                        assign=t.state("artifact"),
                    ),
                    n.loop(
                        "review-loop",
                        e.binary(
                            "neq",
                            e.state("review", ["status"]),
                            e.literal("accepted"),
                        ),
                        n.sequence(
                            "review-iteration",
                            [
                                n.invoke(
                                    "review",
                                    "reviewer",
                                    "review",
                                    e.state("artifact"),
                                    assign=t.state("review"),
                                ),
                                n.branch(
                                    "review-result",
                                    [
                                        n.case(
                                            e.binary(
                                                "eq",
                                                e.state("review", ["status"]),
                                                e.literal("revision_required"),
                                            ),
                                            n.invoke(
                                                "revise",
                                                "coder",
                                                "revise",
                                                e.object(
                                                    {
                                                        "artifact": e.state("artifact"),
                                                        "issues": e.state(
                                                            "review", ["issues"]
                                                        ),
                                                    }
                                                ),
                                                assign=t.state("artifact"),
                                            ),
                                        )
                                    ],
                                ),
                            ],
                        ),
                        max_iterations=5,
                    ),
                    n.return_("return-artifact", e.state("artifact")),
                ],
            ),
        }
    },
)


if __name__ == "__main__":
    print(program.dumps())
