"""Correlate normalized events into interaction traces."""

from __future__ import annotations

from typing import Any

from tools.context_capture.models import EventRecord


KEY_PRIORITY: tuple[tuple[str, str], ...] = (
    ("request_flow_id", "high"),
    ("run_id", "high"),
    ("session_key", "medium"),
    ("request_id", "medium"),
    ("idempotency_key", "low"),
)
MODEL_RESPONSE_EVENT_TYPES = {"model_delta", "model_final", "ui_delta", "ui_final"}


def _extract_key(event: EventRecord) -> tuple[str, str] | None:
    payload = event.payload_full
    if not isinstance(payload, dict):
        return None

    for key, confidence in KEY_PRIORITY:
        value = payload.get(key)
        if isinstance(value, str) and value:
            return f"{key}:{value}", confidence
    return None


def _finalize_trace(events: list[EventRecord], confidence: str, has_key: bool) -> dict[str, Any]:
    missing_reasons: list[str] = []
    if not has_key:
        missing_reasons.append("no_correlation_keys")
    if not any(event.event_type in MODEL_RESPONSE_EVENT_TYPES for event in events):
        missing_reasons.append("missing_model_response")

    return {
        "events": events,
        "correlation_confidence": confidence,
        "completeness": "partial",
        "missing_reasons": missing_reasons,
    }


def _trace_sort_key(trace: dict[str, Any]) -> int:
    events = trace.get("events")
    if not isinstance(events, list) or not events:
        return 0
    return events[0].ts


def correlate_events(
    events: list[EventRecord],
    *,
    fallback_window_ms: int = 500,
) -> list[dict[str, Any]]:
    keyed_groups: dict[str, dict[str, Any]] = {}
    fallback_groups: list[list[EventRecord]] = []

    for event in sorted(events, key=lambda item: item.ts):
        extracted = _extract_key(event)
        if extracted is not None:
            group_key, confidence = extracted
            group = keyed_groups.setdefault(
                group_key,
                {
                    "events": [],
                    "confidence": confidence,
                },
            )
            group["events"].append(event)
            continue

        if not fallback_groups:
            fallback_groups.append([event])
            continue

        current = fallback_groups[-1]
        if event.ts - current[-1].ts <= fallback_window_ms:
            current.append(event)
        else:
            fallback_groups.append([event])

    traces = [
        _finalize_trace(group["events"], group["confidence"], has_key=True)
        for group in keyed_groups.values()
    ]
    traces.extend(_finalize_trace(group, "low", has_key=False) for group in fallback_groups)
    return sorted(traces, key=_trace_sort_key)
