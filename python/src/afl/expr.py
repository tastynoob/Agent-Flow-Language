from __future__ import annotations

from .types import Expression, JsonValue


def literal(value: JsonValue) -> Expression:
    return {"kind": "literal", "value": value}


def input(name: str | None = None, path: list[str | int] | None = None) -> Expression:
    return _ref("input", name, path)


def state(name: str, path: list[str | int] | None = None) -> Expression:
    return _ref("state", name, path)


def local(name: str, path: list[str | int] | None = None) -> Expression:
    return _ref("local", name, path)


def object(entries: dict[str, Expression]) -> Expression:
    return {"kind": "object", "entries": entries}


def array(items: list[Expression]) -> Expression:
    return {"kind": "array", "items": items}


def unary(op: str, value: Expression) -> Expression:
    return {"kind": "unary", "op": op, "value": value}


def binary(op: str, left: Expression, right: Expression) -> Expression:
    return {"kind": "binary", "op": op, "left": left, "right": right}


def _ref(
    scope: str,
    name: str | None,
    path: list[str | int] | None,
) -> Expression:
    result: Expression = {"kind": "ref", "scope": scope}
    if name is not None:
        result["name"] = name
    if path is not None:
        result["path"] = path
    return result
