from .types import Target


def state(name: str) -> Target:
    return {"scope": "state", "name": name}


def local(name: str) -> Target:
    return {"scope": "local", "name": name}
