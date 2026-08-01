from __future__ import annotations

import copy
import json
from dataclasses import dataclass
from pathlib import Path

from .types import Agent, Flow, JsonValue, Schema


@dataclass(frozen=True, slots=True)
class Program:
    _value: dict[str, JsonValue]

    def to_dict(self) -> dict[str, JsonValue]:
        return copy.deepcopy(self._value)

    def dumps(self, *, indent: int | None = 2) -> str:
        return json.dumps(
            self._value,
            ensure_ascii=False,
            allow_nan=False,
            indent=indent,
            sort_keys=False,
        )

    def emit(self, path: str | Path, *, indent: int | None = 2) -> Path:
        output = Path(path)
        output.write_text(f"{self.dumps(indent=indent)}\n", encoding="utf-8")
        return output


def define_program(
    *,
    name: str,
    entry: str,
    flows: dict[str, Flow],
    schemas: dict[str, Schema] | None = None,
    agents: dict[str, Agent] | None = None,
    metadata: dict[str, JsonValue] | None = None,
) -> Program:
    value: dict[str, JsonValue] = {
        "irVersion": "0.1",
        "name": name,
        "entry": entry,
        "flows": flows,
    }
    if schemas is not None:
        value["schemas"] = schemas
    if agents is not None:
        value["agents"] = agents
    if metadata is not None:
        value["metadata"] = metadata
    json.dumps(value, allow_nan=False)
    return Program(copy.deepcopy(value))
