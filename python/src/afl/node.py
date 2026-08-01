from __future__ import annotations

from .types import Expression, JsonValue, Node, Target


def noop(node_id: str) -> Node:
    return _node("noop", node_id)


def sequence(node_id: str, steps: list[Node]) -> Node:
    return _node("sequence", node_id, steps=steps)


def assign(node_id: str, target: Target, value: Expression) -> Node:
    return _node("assign", node_id, target=target, value=value)


def invoke(
    node_id: str,
    agent: str,
    operation: str,
    input: Expression,
    *,
    assign: Target | None = None,
) -> Node:
    return _node(
        "invoke",
        node_id,
        agent=agent,
        operation=operation,
        input=input,
        **_optional("assign", assign),
    )


def call_flow(
    node_id: str,
    flow: str,
    input: Expression,
    *,
    assign: Target | None = None,
) -> Node:
    return _node(
        "callFlow",
        node_id,
        flow=flow,
        input=input,
        **_optional("assign", assign),
    )


def case(when: Expression, then: Node) -> dict[str, JsonValue]:
    return {"when": when, "then": then}


def branch(
    node_id: str,
    cases: list[dict[str, JsonValue]],
    *,
    default: Node | None = None,
) -> Node:
    return _node(
        "branch",
        node_id,
        cases=cases,
        **_optional("default", default),
    )


def loop(
    node_id: str,
    condition: Expression,
    body: Node,
    *,
    max_iterations: int,
) -> Node:
    return _node(
        "loop",
        node_id,
        condition=condition,
        body=body,
        maxIterations=max_iterations,
    )


def for_each(
    node_id: str,
    items: Expression,
    item: str,
    body: Node,
    *,
    index: str | None = None,
    max_concurrency: int | None = None,
    assign: Target | None = None,
) -> Node:
    return _node(
        "forEach",
        node_id,
        items=items,
        item=item,
        body=body,
        **_optional("index", index),
        **_optional("maxConcurrency", max_concurrency),
        **_optional("assign", assign),
    )


def parallel_branch(branch_id: str, body: Node) -> dict[str, JsonValue]:
    return {"id": branch_id, "body": body}


def parallel(
    node_id: str,
    branches: list[dict[str, JsonValue]],
    mode: str,
    *,
    assign: Target | None = None,
) -> Node:
    return _node(
        "parallel",
        node_id,
        branches=branches,
        mode=mode,
        **_optional("assign", assign),
    )


def backoff(
    kind: str,
    delay_ms: int | float,
    *,
    max_delay_ms: int | float | None = None,
) -> dict[str, JsonValue]:
    return {
        "kind": kind,
        "delayMs": delay_ms,
        **_optional("maxDelayMs", max_delay_ms),
    }


def retry(
    node_id: str,
    body: Node,
    *,
    max_attempts: int,
    backoff: dict[str, JsonValue] | None = None,
) -> Node:
    return _node(
        "retry",
        node_id,
        body=body,
        maxAttempts=max_attempts,
        **_optional("backoff", backoff),
    )


def timeout(node_id: str, body: Node, timeout_ms: int | float) -> Node:
    return _node("timeout", node_id, body=body, timeoutMs=timeout_ms)


def catch(error: str, body: Node) -> dict[str, JsonValue]:
    return {"error": error, "body": body}


def try_(
    node_id: str,
    body: Node,
    *,
    catch: dict[str, JsonValue] | None = None,
    finally_: Node | None = None,
) -> Node:
    return _node(
        "try",
        node_id,
        body=body,
        **_optional("catch", catch),
        **_optional("finally", finally_),
    )


def delay(node_id: str, duration_ms: Expression) -> Node:
    return _node("delay", node_id, durationMs=duration_ms)


def emit(node_id: str, event: str, payload: Expression) -> Node:
    return _node("emit", node_id, event=event, payload=payload)


def await_event(
    node_id: str,
    event: str,
    *,
    assign: Target | None = None,
    timeout_ms: int | float | None = None,
) -> Node:
    return _node(
        "awaitEvent",
        node_id,
        event=event,
        **_optional("assign", assign),
        **_optional("timeoutMs", timeout_ms),
    )


def checkpoint(node_id: str, label: str | None = None) -> Node:
    return _node("checkpoint", node_id, **_optional("label", label))


def freedom_constraints(
    *,
    max_nodes: int,
    max_depth: int,
    allowed_node_kinds: list[str] | None = None,
    allowed_agents: list[str] | None = None,
    allowed_flows: list[str] | None = None,
    allow_revision: bool | None = None,
) -> dict[str, JsonValue]:
    return {
        "maxNodes": max_nodes,
        "maxDepth": max_depth,
        **_optional("allowedNodeKinds", allowed_node_kinds),
        **_optional("allowedAgents", allowed_agents),
        **_optional("allowedFlows", allowed_flows),
        **_optional("allowRevision", allow_revision),
    }


def freedom(
    node_id: str,
    planner: str,
    operation: str,
    context: Expression,
    constraints: dict[str, JsonValue],
    *,
    assign: Target | None = None,
) -> Node:
    return _node(
        "freedom",
        node_id,
        planner=planner,
        operation=operation,
        context=context,
        constraints=constraints,
        **_optional("assign", assign),
    )


def return_(node_id: str, value: Expression) -> Node:
    return _node("return", node_id, value=value)


def fail(node_id: str, error: Expression) -> Node:
    return _node("fail", node_id, error=error)


def _node(kind: str, node_id: str, **values: JsonValue) -> Node:
    return {"kind": kind, "id": node_id, **values}


def _optional(key: str, value: JsonValue | None) -> dict[str, JsonValue]:
    return {} if value is None else {key: value}
