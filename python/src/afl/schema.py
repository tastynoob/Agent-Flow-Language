from __future__ import annotations

from .types import JsonPrimitive, Schema


def any() -> Schema:
    return {"type": "any"}


def null() -> Schema:
    return {"type": "null"}


def boolean() -> Schema:
    return {"type": "boolean"}


def number(
    *,
    integer: bool | None = None,
    minimum: int | float | None = None,
    maximum: int | float | None = None,
) -> Schema:
    result: Schema = {"type": "number"}
    _optional(result, "integer", integer)
    _optional(result, "minimum", minimum)
    _optional(result, "maximum", maximum)
    return result


def string(
    *,
    min_length: int | None = None,
    max_length: int | None = None,
    pattern: str | None = None,
) -> Schema:
    result: Schema = {"type": "string"}
    _optional(result, "minLength", min_length)
    _optional(result, "maxLength", max_length)
    _optional(result, "pattern", pattern)
    return result


def enum(values: list[JsonPrimitive]) -> Schema:
    return {"type": "enum", "values": values}


def array(
    items: Schema,
    *,
    min_items: int | None = None,
    max_items: int | None = None,
) -> Schema:
    result: Schema = {"type": "array", "items": items}
    _optional(result, "minItems", min_items)
    _optional(result, "maxItems", max_items)
    return result


def object(
    properties: dict[str, Schema],
    *,
    required: list[str] | None = None,
    additional_properties: bool | None = None,
) -> Schema:
    result: Schema = {"type": "object", "properties": properties}
    _optional(result, "required", required)
    _optional(result, "additionalProperties", additional_properties)
    return result


def one_of(variants: list[Schema]) -> Schema:
    return {"type": "oneOf", "variants": variants}


def ref(name: str) -> Schema:
    return {"type": "ref", "name": name}


def _optional(target: dict, key: str, value: object | None) -> None:
    if value is not None:
        target[key] = value
