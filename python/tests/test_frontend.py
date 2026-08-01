from __future__ import annotations

import json

import pytest

from afl import define_program, expr as e, node as n, schema as s, target as t


def test_program_serializes_canonical_ir_and_defensively_copies() -> None:
    flows = {
        "main": {
            "input": s.string(),
            "output": s.string(),
            "body": n.return_("return", e.input()),
        }
    }
    program = define_program(name="echo", entry="main", flows=flows)
    flows["main"]["body"] = n.fail("mutated", e.literal("bad"))

    emitted = json.loads(program.dumps())

    assert emitted["irVersion"] == "0.1"
    assert emitted["flows"]["main"]["body"]["kind"] == "return"
    copied = program.to_dict()
    copied["name"] = "changed"
    assert program.to_dict()["name"] == "echo"


def test_python_names_are_translated_to_canonical_camel_case() -> None:
    flow = {
        "input": s.array(s.number()),
        "output": s.array(s.number()),
        "locals": {
            "item": {"schema": s.number()},
            "result": {"schema": s.array(s.number()), "initial": []},
        },
        "body": n.for_each(
            "map",
            e.input(),
            "item",
            n.return_("item", e.local("item")),
            max_concurrency=4,
            assign=t.local("result"),
        ),
    }

    body = define_program(name="map", entry="main", flows={"main": flow}).to_dict()[
        "flows"
    ]["main"]["body"]

    assert body["kind"] == "forEach"
    assert body["maxConcurrency"] == 4
    assert body["assign"] == {"scope": "local", "name": "result"}


def test_program_rejects_non_json_and_non_finite_values() -> None:
    with pytest.raises((TypeError, ValueError)):
        define_program(
            name="invalid",
            entry="main",
            metadata={"not_json": object()},  # type: ignore[dict-item]
            flows={
                "main": {
                    "input": s.null(),
                    "output": s.null(),
                    "body": n.return_("return", e.literal(None)),
                }
            },
        )

    with pytest.raises(ValueError):
        define_program(
            name="nan",
            entry="main",
            metadata={"value": float("nan")},
            flows={
                "main": {
                    "input": s.null(),
                    "output": s.null(),
                    "body": n.return_("return", e.literal(None)),
                }
            },
        )


def test_emit_writes_utf8_ir(tmp_path) -> None:
    program = define_program(
        name="中文 flow",
        entry="main",
        flows={
            "main": {
                "input": s.null(),
                "output": s.string(),
                "body": n.return_("return", e.literal("完成")),
            }
        },
    )

    output = program.emit(tmp_path / "flow.aflir")

    assert json.loads(output.read_text(encoding="utf-8"))["name"] == "中文 flow"
