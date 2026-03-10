from __future__ import annotations

from typing import Any

try:
    from pydantic import BaseModel
except ModuleNotFoundError:
    class BaseModel:
        def __init__(self, **data: Any) -> None:
            annotations = getattr(self, "__annotations__", {})
            for field_name in annotations:
                if field_name not in data:
                    raise TypeError(f"missing required argument: {field_name}")
                setattr(self, field_name, data[field_name])

        def model_dump(self) -> dict[str, Any]:
            annotations = getattr(self, "__annotations__", {})
            return {field_name: getattr(self, field_name) for field_name in annotations}

        def dict(self) -> dict[str, Any]:
            return self.model_dump()


class EventRecord(BaseModel):
    ts: int
    direction: str
    channel: str
    event_type: str
    payload_full: dict[str, Any]
