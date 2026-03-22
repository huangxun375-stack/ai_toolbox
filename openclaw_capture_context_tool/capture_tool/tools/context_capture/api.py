"""Local API scaffold for context capture tool."""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

from tools.context_capture.correlator import correlate_events
from tools.context_capture.parser import parse_raw_record, parse_raw_records
from tools.context_capture.storage import JsonlStore


REDACTED_KEYS = {"token", "authorization", "api_key", "password", "secret"}
NO_WEB_SEARCH_SUFFIX_RE = re.compile(r"\s*no web search\s*$", re.IGNORECASE)
TOOL_START_PATTERN = re.compile(
    r"embedded run tool start: runId=(?P<run_id>[^ ]+) tool=(?P<tool>[^ ]+) toolCallId=(?P<tool_call_id>[^ ]+)"
)
TOOL_END_PATTERN = re.compile(
    r"embedded run tool end: runId=(?P<run_id>[^ ]+) tool=(?P<tool>[^ ]+) toolCallId=(?P<tool_call_id>[^ ]+)"
)


def _gateway_log_path(data_dir: Path) -> Path | None:
    configured = os.environ.get("CONTEXT_CAPTURE_GATEWAY_LOG_PATH", "").strip()
    if configured:
        path = Path(configured)
        return path if path.exists() else None

    local = data_dir / "gateway.log.jsonl"
    return local if local.exists() else None


def _parse_ts_millis(value: Any) -> int | None:
    if not isinstance(value, str) or not value:
        return None

    normalized = value.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp() * 1000)


def _run_to_request_flow(events: list[Any]) -> dict[str, str]:
    mapping: dict[str, str] = {}
    for event in events:
        payload = getattr(event, "payload_full", None)
        if not isinstance(payload, dict):
            continue
        run_id = payload.get("run_id")
        request_flow_id = payload.get("request_flow_id")
        if isinstance(run_id, str) and run_id and isinstance(request_flow_id, str) and request_flow_id:
            mapping[run_id] = request_flow_id
    return mapping


def _attach_request_flow_id_to_cache_events(events: list[Any], run_to_flow: dict[str, str]) -> None:
    if not run_to_flow:
        return

    for event in events:
        payload = getattr(event, "payload_full", None)
        if not isinstance(payload, dict):
            continue

        if "request_flow_id" in payload:
            continue

        run_id = payload.get("run_id")
        if not isinstance(run_id, str) or not run_id:
            continue

        request_flow_id = run_to_flow.get(run_id)
        if not isinstance(request_flow_id, str) or not request_flow_id:
            continue

        payload["request_flow_id"] = request_flow_id


def _parse_gateway_tool_events(data_dir: Path, *, run_to_flow: dict[str, str]) -> list[Any]:
    log_path = _gateway_log_path(data_dir)
    if log_path is None:
        return []

    parsed_events: list[Any] = []
    try:
        lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []

    for line in lines:
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue

        message = record.get("1")
        if not isinstance(message, str):
            continue

        ts = _parse_ts_millis(record.get("time"))
        if ts is None:
            continue

        start_match = TOOL_START_PATTERN.search(message)
        if start_match is not None:
            run_id = start_match.group("run_id")
            request_flow_id = run_to_flow.get(run_id)
            if not request_flow_id:
                continue
            payload = {
                "source": "gateway_log",
                "run_id": run_id,
                "tool": start_match.group("tool"),
                "tool_call_id": start_match.group("tool_call_id"),
                "request_flow_id": request_flow_id,
            }

            parsed_events.append(
                SimpleNamespace(
                    ts=ts,
                    direction="gateway->tool",
                    channel="gateway_log",
                    event_type="tool_start",
                    payload_full=payload,
                )
            )
            continue

        end_match = TOOL_END_PATTERN.search(message)
        if end_match is None:
            continue

        run_id = end_match.group("run_id")
        request_flow_id = run_to_flow.get(run_id)
        if not request_flow_id:
            continue
        payload = {
            "source": "gateway_log",
            "run_id": run_id,
            "tool": end_match.group("tool"),
            "tool_call_id": end_match.group("tool_call_id"),
            "request_flow_id": request_flow_id,
        }

        parsed_events.append(
            SimpleNamespace(
                ts=ts,
                direction="tool->gateway",
                channel="gateway_log",
                event_type="tool_end",
                payload_full=payload,
            )
        )
        parsed_events.append(
            SimpleNamespace(
                ts=ts + 1,
                direction="gateway->model",
                channel="gateway_log",
                event_type="model_resume_after_tool",
                payload_full={
                    **payload,
                    "resume_after_tool": True,
                },
            )
        )

    return parsed_events


def _load_traces(data_dir: Path) -> list[dict[str, Any]]:
    raw_store = JsonlStore(data_dir / "raw.jsonl")
    cache_trace_paths = [data_dir / "cache-trace.jsonl"]
    extra_cache_trace_file = os.environ.get("CONTEXT_CAPTURE_CACHE_TRACE_FILE", "").strip()
    if extra_cache_trace_file:
        extra_path = Path(extra_cache_trace_file)
        if extra_path not in cache_trace_paths:
            cache_trace_paths.append(extra_path)

    events = []
    events.extend(parse_raw_records(raw_store.read_all() or []))
    for cache_trace_path in cache_trace_paths:
        cache_trace_store = JsonlStore(cache_trace_path)
        for raw in cache_trace_store.read_all() or []:
            events.extend(parse_raw_record(raw))

    run_to_flow = _run_to_request_flow(events)
    _attach_request_flow_id_to_cache_events(events, run_to_flow)
    run_to_flow = _run_to_request_flow(events)
    events.extend(_parse_gateway_tool_events(data_dir, run_to_flow=run_to_flow))

    return correlate_events(events)


def _capture_file_paths(data_dir: Path) -> list[Path]:
    paths = [
        data_dir / "raw.jsonl",
        data_dir / "cache-trace.jsonl",
        data_dir / "gateway.log.jsonl",
    ]
    extra_cache_trace_file = os.environ.get("CONTEXT_CAPTURE_CACHE_TRACE_FILE", "").strip()
    if extra_cache_trace_file:
        extra_path = Path(extra_cache_trace_file)
        if extra_path not in paths:
            paths.append(extra_path)
    return paths


def _clear_capture_files(data_dir: Path) -> list[str]:
    cleared: list[str] = []
    for path in _capture_file_paths(data_dir):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("", encoding="utf-8")
        cleared.append(str(path))
    return cleared


def _redact_payload(value: Any) -> Any:
    if isinstance(value, dict):
        redacted: dict[str, Any] = {}
        for key, item in value.items():
            if key.lower() in REDACTED_KEYS:
                redacted[key] = "[REDACTED]"
            else:
                redacted[key] = _redact_payload(item)
        return redacted

    if isinstance(value, list):
        return [_redact_payload(item) for item in value]

    return value


def _flow_stage(direction: Any) -> str:
    mapping = {
        "user->gateway": "USER->openclaw",
        "gateway->model": "OPENCLAW->model",
        "model->gateway": "MODEL->openclaw",
        "gateway->tool": "OPENCLAW->tool",
        "tool->gateway": "TOOL->openclaw",
        "gateway->ui": "OPENCLAW->user",
    }
    if isinstance(direction, str):
        return mapping.get(direction, "UNKNOWN")
    return "UNKNOWN"


def _flow_label(flow_stage: str) -> str:
    return flow_stage


def _extract_text_from_content(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()

    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            text = _extract_text_from_content(item)
            if text:
                parts.append(text)
        return " ".join(parts).strip()

    if isinstance(value, dict):
        text_value = value.get("text")
        if isinstance(text_value, str) and text_value.strip():
            return text_value.strip()
        inner = value.get("content")
        return _extract_text_from_content(inner)

    return ""


def _internal_request_preview(payload: dict[str, Any], *, max_length: int = 140) -> str:
    model = payload.get("model")
    provider = payload.get("provider")
    messages = payload.get("messages")
    message_count = len(messages) if isinstance(messages, list) else 0

    last_user_text = ""
    if isinstance(messages, list):
        for message in reversed(messages):
            if not isinstance(message, dict):
                continue
            if message.get("role") != "user":
                continue
            last_user_text = _extract_text_from_content(message.get("content"))
            if last_user_text:
                break

    parts = [f"internal_ctx messages={message_count}"]
    if isinstance(model, str) and model:
        parts.append(f"model={model}")
    if isinstance(provider, str) and provider:
        parts.append(f"provider={provider}")
    if last_user_text:
        parts.append(f"last_user={last_user_text}")
    return ", ".join(parts)[:max_length]


def _flow_label_for_event(direction: Any, event_type: Any) -> str:
    stage = _flow_stage(direction)
    if not isinstance(event_type, str):
        return _flow_label(stage)

    if event_type == "model_request_internal":
        return "OPENCLAW->model (internal_ctx)"
    if event_type == "model_request":
        return "OPENCLAW->model (api_request)"
    if event_type == "model_response_internal":
        return "MODEL->openclaw (internal_ctx)"
    if event_type == "model_response_json":
        return "MODEL->openclaw (api_response)"

    return _flow_label(stage)


def _content_full(payload: Any) -> str:
    if payload is None:
        return ""
    if isinstance(payload, str):
        return payload
    return str(payload)


def _content_preview(payload: Any, *, max_length: int = 140) -> str:
    if isinstance(payload, dict):
        for key in ("response_text", "text", "delta", "content", "input", "prompt", "message"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value[:max_length]
        full = _content_full(payload)
        return full[:max_length] if full else "(no content)"

    if isinstance(payload, list):
        full = _content_full(payload)
        return full[:max_length] if full else "(no content)"

    if isinstance(payload, str):
        return payload[:max_length] if payload else "(no content)"

    return "(no content)"


def _aggregate_trace_events(events: list[Any]) -> list[Any]:
    ordered_events = sorted(events, key=_event_sort_key)

    delta_text_parts: list[str] = []
    delta_start_ts: int | None = None
    retained: list[Any] = []

    for event in ordered_events:
        direction = getattr(event, "direction", None)
        event_type = getattr(event, "event_type", None)
        payload = getattr(event, "payload_full", None)

        if (
            direction == "model->gateway"
            and event_type == "model_delta"
            and isinstance(payload, dict)
            and isinstance(payload.get("delta"), str)
        ):
            if delta_start_ts is None and isinstance(getattr(event, "ts", None), int):
                delta_start_ts = event.ts
            delta_text_parts.append(payload["delta"])
            retained.append(event)
            continue

        retained.append(event)

        if (
            direction == "model->gateway"
            and event_type == "model_response_json"
            and isinstance(payload, dict)
            and isinstance(payload.get("response_text"), str)
            and payload.get("response_text")
        ):
            retained.append(
                SimpleNamespace(
                    ts=getattr(event, "ts", None),
                    direction="gateway->ui",
                    channel=getattr(event, "channel", "http"),
                    event_type="ui_final",
                    payload_full={"text": payload["response_text"], "usage": payload.get("usage")},
                )
            )
            continue

        if direction == "model->gateway" and event_type == "model_final" and delta_text_parts:
            joined = "".join(delta_text_parts)
            ts_value = getattr(event, "ts", None)
            aggregate_ts = ts_value if isinstance(ts_value, int) else (delta_start_ts or 0)
            retained.append(
                SimpleNamespace(
                    ts=aggregate_ts,
                    direction="gateway->ui",
                    channel="http",
                    event_type="ui_final",
                    payload_full={"text": joined},
                )
            )
            delta_text_parts = []
            delta_start_ts = None

    return retained


def _ts_iso(ts: Any) -> str | None:
    if not isinstance(ts, int):
        return None

    try:
        return datetime.fromtimestamp(ts / 1000, tz=timezone.utc).isoformat()
    except (OSError, OverflowError, ValueError):
        return None


def _trace_event_payload(event: Any) -> dict[str, Any]:
    redacted_payload = _redact_payload(event.payload_full)
    direction = getattr(event, "direction", None)
    event_type = getattr(event, "event_type", None)
    flow_stage = _flow_stage(direction)
    content_preview = _content_preview(redacted_payload)
    if event_type == "model_request_internal" and isinstance(redacted_payload, dict):
        content_preview = _internal_request_preview(redacted_payload)

    return {
        "ts": event.ts,
        "direction": direction,
        "channel": event.channel,
        "event_type": event_type,
        "payload_full": redacted_payload,
        "flow_stage": flow_stage,
        "flow_label": _flow_label_for_event(direction, event_type),
        "content_preview": content_preview,
        "content_full": _content_full(redacted_payload),
        "ts_iso": _ts_iso(event.ts),
    }


def _event_sort_key(event: Any) -> tuple[int, int]:
    ts = getattr(event, "ts", None)
    if isinstance(ts, int):
        return (0, ts)
    return (1, 0)


def _trace_detail(trace_id: str, trace: dict[str, Any]) -> dict[str, Any]:
    events = trace.get("events", [])
    ordered_events = _aggregate_trace_events(events)
    return {
        "trace_id": trace_id,
        "correlation_confidence": trace.get("correlation_confidence"),
        "completeness": trace.get("completeness"),
        "missing_reasons": trace.get("missing_reasons"),
        "events": [_trace_event_payload(event) for event in ordered_events],
    }


def _timeline_item(trace_id: str, trace: dict[str, Any]) -> dict[str, Any]:
    events = trace.get("events", [])
    start_ts = events[0].ts if events else None
    end_ts = events[-1].ts if events else None

    return {
        "trace_id": trace_id,
        "event_count": len(events),
        "start_ts": start_ts,
        "end_ts": end_ts,
        "correlation_confidence": trace.get("correlation_confidence"),
        "completeness": trace.get("completeness"),
        "missing_reasons": trace.get("missing_reasons"),
    }


def _to_int(value: Any) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return 0
        try:
            return int(float(text))
        except ValueError:
            return 0
    return 0


def _normalize_usage(usage: Any) -> dict[str, int]:
    if not isinstance(usage, dict):
        return {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}

    input_tokens = _to_int(usage.get("input_tokens"))
    if input_tokens == 0:
        input_tokens = _to_int(usage.get("inputTokens"))
    if input_tokens == 0:
        input_tokens = _to_int(usage.get("input"))

    output_tokens = _to_int(usage.get("output_tokens"))
    if output_tokens == 0:
        output_tokens = _to_int(usage.get("outputTokens"))
    if output_tokens == 0:
        output_tokens = _to_int(usage.get("output"))

    total_tokens = _to_int(usage.get("total_tokens"))
    if total_tokens == 0:
        total_tokens = _to_int(usage.get("totalTokens"))
    if total_tokens == 0:
        total_tokens = _to_int(usage.get("total"))
    if total_tokens == 0:
        total_tokens = input_tokens + output_tokens

    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
    }


def _question_text(input_text: str) -> str:
    cleaned = input_text.strip()
    cleaned = NO_WEB_SEARCH_SUFFIX_RE.sub("", cleaned).strip()
    return cleaned


def _looks_like_qa_input(input_text: str) -> bool:
    lower = input_text.lower()
    if "[group chat conversation:" in lower:
        return False
    return "no web search" in lower


def _question_key(question: str) -> str:
    return re.sub(r"\s+", " ", question).strip().lower()


def _extract_response_text(payload: dict[str, Any]) -> str:
    response_text = payload.get("response_text")
    if isinstance(response_text, str) and response_text.strip():
        return response_text.strip()

    if isinstance(payload.get("text"), str) and payload.get("text").strip():
        return payload["text"].strip()

    output = payload.get("output")
    if isinstance(output, list):
        for item in output:
            if not isinstance(item, dict):
                continue
            if isinstance(item.get("text"), str) and item.get("text").strip():
                return item["text"].strip()
            content = item.get("content")
            if not isinstance(content, list):
                continue
            for block in content:
                if not isinstance(block, dict):
                    continue
                text = block.get("text")
                if isinstance(text, str) and text.strip():
                    return text.strip()

    assistant_message = payload.get("assistant_message")
    if isinstance(assistant_message, dict):
        content = assistant_message.get("content")
        if isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                text = block.get("text")
                if isinstance(text, str) and text.strip():
                    return text.strip()

    return ""


def _extract_compare_item(trace_id: str, trace: dict[str, Any]) -> dict[str, Any] | None:
    events = sorted(trace.get("events", []), key=_event_sort_key)
    request_payload: dict[str, Any] | None = None
    request_ts: int | None = None
    for event in events:
        if getattr(event, "direction", None) != "gateway->model":
            continue
        if getattr(event, "event_type", None) != "model_request":
            continue
        payload = getattr(event, "payload_full", None)
        if not isinstance(payload, dict):
            continue
        input_text = payload.get("input")
        if not isinstance(input_text, str) or not input_text.strip():
            continue
        if not _looks_like_qa_input(input_text):
            continue
        request_payload = payload
        request_ts = getattr(event, "ts", None) if isinstance(getattr(event, "ts", None), int) else None
        break

    if request_payload is None:
        return None

    question_raw = request_payload.get("input")
    if not isinstance(question_raw, str):
        return None
    question = _question_text(question_raw)
    if not question:
        return None

    response_payload: dict[str, Any] | None = None
    for event in events:
        if getattr(event, "direction", None) != "model->gateway":
            continue
        if getattr(event, "event_type", None) == "model_response_json":
            payload = getattr(event, "payload_full", None)
            if isinstance(payload, dict):
                response_payload = payload
                break
    if response_payload is None:
        for event in events:
            if getattr(event, "direction", None) != "model->gateway":
                continue
            if getattr(event, "event_type", None) != "model_response_internal":
                continue
            payload = getattr(event, "payload_full", None)
            if isinstance(payload, dict):
                response_payload = payload
                break

    if response_payload is None:
        return None

    user = request_payload.get("user")
    return {
        "trace_id": trace_id,
        "user": user if isinstance(user, str) else "",
        "question": question,
        "question_key": _question_key(question),
        "usage": _normalize_usage(response_payload.get("usage")),
        "response_text": _extract_response_text(response_payload),
        "request_ts": request_ts,
    }


def _usage_add(usage_a: dict[str, int], usage_b: dict[str, int]) -> dict[str, int]:
    return {
        "input_tokens": usage_a["input_tokens"] + usage_b["input_tokens"],
        "output_tokens": usage_a["output_tokens"] + usage_b["output_tokens"],
        "total_tokens": usage_a["total_tokens"] + usage_b["total_tokens"],
    }


def _usage_diff_b_minus_a(usage_a: dict[str, int], usage_b: dict[str, int]) -> dict[str, int]:
    return {
        "input_tokens": usage_b["input_tokens"] - usage_a["input_tokens"],
        "output_tokens": usage_b["output_tokens"] - usage_a["output_tokens"],
        "total_tokens": usage_b["total_tokens"] - usage_a["total_tokens"],
    }


def _usage_reduction_pct_from_a(usage_a: dict[str, int], usage_b: dict[str, int]) -> dict[str, float | None]:
    result: dict[str, float | None] = {}
    for key in ("input_tokens", "output_tokens", "total_tokens"):
        base = usage_a[key]
        if base <= 0:
            result[key] = None
            continue
        result[key] = ((base - usage_b[key]) / base) * 100.0
    return result


def _sum_usage(items: list[dict[str, Any]]) -> dict[str, int]:
    total = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
    for item in items:
        usage = item.get("usage")
        if not isinstance(usage, dict):
            continue
        normalized = _normalize_usage(usage)
        total = _usage_add(total, normalized)
    return total


def _pair_compare_items(
    scenario_a_items: list[dict[str, Any]],
    scenario_b_items: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    buckets_b: dict[str, list[dict[str, Any]]] = {}
    for item in scenario_b_items:
        key = item["question_key"]
        buckets_b.setdefault(key, []).append(item)

    paired: list[dict[str, Any]] = []
    unmatched_a: list[dict[str, Any]] = []
    matched_b_trace_ids: set[str] = set()

    for item_a in scenario_a_items:
        key = item_a["question_key"]
        candidates = buckets_b.get(key, [])
        if not candidates:
            unmatched_a.append(item_a)
            continue
        item_b = candidates.pop(0)
        matched_b_trace_ids.add(item_b["trace_id"])
        paired.append(
            {
                "question": item_a["question"],
                "match_type": "question",
                "scenario_a": item_a,
                "scenario_b": item_b,
                "delta_b_minus_a": _usage_diff_b_minus_a(item_a["usage"], item_b["usage"]),
            }
        )

    remaining_b = [item for item in scenario_b_items if item["trace_id"] not in matched_b_trace_ids]
    fallback_pair_count = min(len(unmatched_a), len(remaining_b))

    for index in range(fallback_pair_count):
        item_a = unmatched_a[index]
        item_b = remaining_b[index]
        paired.append(
            {
                "question": item_a["question"],
                "match_type": "index",
                "scenario_a": item_a,
                "scenario_b": item_b,
                "delta_b_minus_a": _usage_diff_b_minus_a(item_a["usage"], item_b["usage"]),
            }
        )

    unpaired_a = unmatched_a[fallback_pair_count:]
    unpaired_b = remaining_b[fallback_pair_count:]
    return paired, unpaired_a, unpaired_b


def _public_compare_item(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "trace_id": item["trace_id"],
        "user": item["user"],
        "question": item["question"],
        "usage": item["usage"],
        "response_text": item["response_text"],
        "request_ts": item["request_ts"],
    }


def _build_memory_token_compare(
    traces: list[dict[str, Any]],
    *,
    scenario_a_prefix: str,
    scenario_b_prefix: str,
) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    for index, trace in enumerate(traces):
        item = _extract_compare_item(str(index), trace)
        if item is not None:
            items.append(item)

    sorted_items = sorted(
        items,
        key=lambda item: item["request_ts"] if isinstance(item.get("request_ts"), int) else -1,
    )
    scenario_a_items = [item for item in sorted_items if item["user"].startswith(scenario_a_prefix)]
    scenario_b_items = [item for item in sorted_items if item["user"].startswith(scenario_b_prefix)]

    paired, unpaired_a, unpaired_b = _pair_compare_items(scenario_a_items, scenario_b_items)
    paired_payload = [
        {
            "question": item["question"],
            "match_type": item["match_type"],
            "scenario_a": _public_compare_item(item["scenario_a"]),
            "scenario_b": _public_compare_item(item["scenario_b"]),
            "delta_b_minus_a": item["delta_b_minus_a"],
        }
        for item in paired
    ]

    totals_a = _sum_usage(scenario_a_items)
    totals_b = _sum_usage(scenario_b_items)
    return {
        "scenario_a": {
            "prefix": scenario_a_prefix,
            "request_count": len(scenario_a_items),
            "totals": totals_a,
        },
        "scenario_b": {
            "prefix": scenario_b_prefix,
            "request_count": len(scenario_b_items),
            "totals": totals_b,
        },
        "delta_b_minus_a": _usage_diff_b_minus_a(totals_a, totals_b),
        "reduction_pct_from_a": _usage_reduction_pct_from_a(totals_a, totals_b),
        "paired": paired_payload,
        "unpaired": {
            "scenario_a": [_public_compare_item(item) for item in unpaired_a],
            "scenario_b": [_public_compare_item(item) for item in unpaired_b],
        },
    }


def create_app(*, data_dir: Path) -> FastAPI:
    app = FastAPI()
    app.state.data_dir = data_dir
    web_dir = Path(__file__).resolve().parent / "web"

    @app.get("/api/timeline")
    def get_timeline() -> list[dict[str, Any]]:
        traces = _load_traces(data_dir)
        return [_timeline_item(str(index), trace) for index, trace in enumerate(traces)]

    @app.get("/api/trace/{trace_id}")
    def get_trace(trace_id: str) -> dict[str, Any]:
        traces = _load_traces(data_dir)
        if not trace_id.isdigit():
            raise HTTPException(status_code=404, detail="trace not found")

        index = int(trace_id)
        if index < 0 or index >= len(traces):
            raise HTTPException(status_code=404, detail="trace not found")

        return _trace_detail(trace_id, traces[index])

    @app.get("/api/compare/memory-tokens")
    def get_memory_token_compare(
        scenario_a_prefix: str = "cmp-ovonly-s1",
        scenario_b_prefix: str = "cmp-nativecore-s1",
    ) -> dict[str, Any]:
        traces = _load_traces(data_dir)
        return _build_memory_token_compare(
            traces,
            scenario_a_prefix=scenario_a_prefix,
            scenario_b_prefix=scenario_b_prefix,
        )

    _lcm_cache: dict[str, Any] = {"mtime": 0.0, "size": 0, "entries": []}

    @app.get("/api/lcm-diagnostics")
    def get_lcm_diagnostics(
        session_id: str | None = None,
        stage: str | None = None,
        after_ts: int | None = None,
    ) -> list[dict[str, Any]]:
        lcm_path = os.environ.get("LCM_DIAGNOSTICS_PATH")
        lcm_log = Path(os.path.expanduser(lcm_path)) if lcm_path else Path.home() / ".openclaw" / "lcm-diagnostics.jsonl"
        if not lcm_log.exists():
            return []

        try:
            stat = lcm_log.stat()
            cur_mtime = stat.st_mtime
            cur_size = stat.st_size
        except OSError:
            return []

        if cur_mtime != _lcm_cache["mtime"] or cur_size != _lcm_cache["size"]:
            entries: list[dict[str, Any]] = []
            try:
                for raw_line in lcm_log.read_text(encoding="utf-8", errors="replace").splitlines():
                    raw_line = raw_line.strip()
                    if not raw_line:
                        continue
                    try:
                        parsed = json.loads(raw_line)
                        if isinstance(parsed, dict):
                            entries.append(parsed)
                    except json.JSONDecodeError:
                        continue
            except OSError:
                return []
            _lcm_cache["mtime"] = cur_mtime
            _lcm_cache["size"] = cur_size
            _lcm_cache["entries"] = entries

        result = _lcm_cache["entries"]

        if session_id:
            result = [e for e in result if e.get("sessionId") == session_id]
        if stage:
            stages = set(stage.split(","))
            result = [e for e in result if e.get("stage") in stages]
        if after_ts is not None:
            result = [e for e in result if isinstance(e.get("ts"), (int, float)) and e["ts"] > after_ts]

        return result

    @app.post("/api/clear-capture")
    def clear_capture() -> dict[str, Any]:
        cleared = _clear_capture_files(data_dir)
        return {"ok": True, "cleared_files": cleared}

    @app.get("/")
    def get_web_root() -> FileResponse:
        return FileResponse(web_dir / "index.html")

    @app.get("/web/app.js")
    def get_web_app_js() -> FileResponse:
        return FileResponse(web_dir / "app.js")

    return app
