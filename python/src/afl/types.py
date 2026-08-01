from __future__ import annotations

from typing import TypeAlias

JsonPrimitive: TypeAlias = None | bool | int | float | str
JsonValue: TypeAlias = JsonPrimitive | list["JsonValue"] | dict[str, "JsonValue"]
Schema: TypeAlias = dict[str, JsonValue]
Expression: TypeAlias = dict[str, JsonValue]
Target: TypeAlias = dict[str, JsonValue]
Node: TypeAlias = dict[str, JsonValue]
Flow: TypeAlias = dict[str, JsonValue]
Agent: TypeAlias = dict[str, JsonValue]
