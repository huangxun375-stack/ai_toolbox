"""Parser scaffold for context capture tool."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse

from tools.context_capture.models import EventRecord


MODEL_RESPONSE_PATHS = {"/v1/responses"}
MODEL_RESPONSE_PATH_PREFIXES = ("/api/coding/v3",)
NO_WEB_SEARCH_SUFFIX_RE = re.compile(r"\s*no web search\s*$", re.IGNORECASE)
UPSTREAM_MATCH_LOOKBACK_MS = 5 * 60 * 1000


class _ParserState:
    def __init__(self) -> None:
        self.pending_openclaw_requests: list[dict[str, Any]] = []
        self.upstream_flow_to_request_flow: dict[str, str] = {}


def _normalize_text_for_match(text: str) -> str:
    collapsed = re.sub(r"\s+", " ", text).strip()
    collapsed = NO_WEB_SEARCH_SUFFIX_RE.sub("", collapsed).strip()
    return collapsed.lower()


def _extract_text_from_content_block(value: Any) -> str:
    if isinstance(value, str):
        return value

    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, str):
                if item.strip():
                    parts.append(item)
                continue

            if not isinstance(item, dict):
                continue

            text_value = item.get("text")
            if isinstance(text_value, str) and text_value.strip():
                parts.append(text_value)
                continue

            inner = item.get("content")
            inner_text = _extract_text_from_content_block(inner)
            if inner_text:
                parts.append(inner_text)
        return "\n".join(parts).strip()

    if isinstance(value, dict):
        text_value = value.get("text")
        if isinstance(text_value, str) and text_value.strip():
            return text_value

        inner = value.get("content")
        return _extract_text_from_content_block(inner)

    return ""


def _extract_candidate_input_text(payload: dict[str, Any]) -> str | None:
    direct_input = payload.get("input")
    if isinstance(direct_input, str) and direct_input.strip():
        return direct_input

    prompt = payload.get("prompt")
    if isinstance(prompt, str) and prompt.strip():
        return prompt

    messages = payload.get("messages")
    if isinstance(messages, list):
        for message in reversed(messages):
            if not isinstance(message, dict):
                continue
            if message.get("role") != "user":
                continue
            content_text = _extract_text_from_content_block(message.get("content"))
            if content_text:
                return content_text

    return None


def _remember_openclaw_request(
    state: _ParserState,
    *,
    ts: int,
    flow_id: Any,
    payload: dict[str, Any],
) -> None:
    if not isinstance(flow_id, str) or not flow_id:
        return

    candidate_input = _extract_candidate_input_text(payload)
    if not isinstance(candidate_input, str) or not candidate_input.strip():
        return

    state.pending_openclaw_requests.append(
        {
            "ts": ts,
            "request_flow_id": flow_id,
            "input_text": candidate_input,
            "normalized_input_text": _normalize_text_for_match(candidate_input),
        }
    )

    # Keep a compact rolling window.
    if len(state.pending_openclaw_requests) > 100:
        state.pending_openclaw_requests = state.pending_openclaw_requests[-100:]


def _best_pending_match(
    state: _ParserState,
    *,
    ts: int,
    candidate_input: str | None,
) -> str | None:
    if not state.pending_openclaw_requests:
        return None

    candidate_normalized = _normalize_text_for_match(candidate_input) if isinstance(candidate_input, str) else ""
    best_index: int | None = None
    best_score = -1

    for index in range(len(state.pending_openclaw_requests) - 1, -1, -1):
        pending = state.pending_openclaw_requests[index]
        pending_ts = pending.get("ts")
        if isinstance(pending_ts, int) and ts - pending_ts > UPSTREAM_MATCH_LOOKBACK_MS:
            continue

        pending_text = pending.get("normalized_input_text")
        if not isinstance(pending_text, str):
            continue

        score = 0
        if candidate_normalized and pending_text:
            if pending_text == candidate_normalized:
                score = 4
            elif pending_text in candidate_normalized or candidate_normalized in pending_text:
                score = 3
        elif isinstance(pending_ts, int):
            # Fallback to recency match when upstream payload doesn't carry clear user text.
            score = 1

        if score > best_score:
            best_score = score
            best_index = index

            if score >= 4:
                break

    if best_index is None or best_score <= 0:
        return None

    matched = state.pending_openclaw_requests.pop(best_index)
    request_flow_id = matched.get("request_flow_id")
    if isinstance(request_flow_id, str) and request_flow_id:
        return request_flow_id
    return None


def _parse_json_object(text: str | None) -> dict[str, Any] | None:
    if not text:
        return None

    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        return None

    if isinstance(value, dict):
        return value
    return None


def _parse_ts_millis(value: Any) -> int | None:
    if isinstance(value, int):
        return value

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


def _is_model_endpoint(url: str | None) -> bool:
    if not isinstance(url, str) or not url:
        return False

    parsed = urlparse(url)
    path = parsed.path
    return path in MODEL_RESPONSE_PATHS or any(path.startswith(prefix) for prefix in MODEL_RESPONSE_PATH_PREFIXES)


def _classify_sse_payload(data: str) -> tuple[str, dict[str, Any]] | None:
    if data == "[DONE]":
        return "model_final", {"done": True}

    payload = _parse_json_object(data)
    if payload is not None:
        return "model_delta", payload

    return None


def _parse_sse_data(body_text: str | None) -> list[tuple[str, dict[str, Any]]]:
    if not body_text:
        return []

    parsed_events: list[tuple[str, dict[str, Any]]] = []
    event_lines: list[str] = []

    for line in body_text.splitlines():
        if line.startswith("data:"):
            event_lines.append(line[5:].strip())
            continue

        if line.strip() == "" and event_lines:
            parsed = _classify_sse_payload("\n".join(event_lines))
            if parsed is not None:
                parsed_events.append(parsed)
            event_lines = []

    if event_lines:
        parsed = _classify_sse_payload("\n".join(event_lines))
        if parsed is not None:
            parsed_events.append(parsed)

    return parsed_events


def _parse_cache_trace_record(raw: dict[str, Any]) -> list[EventRecord]:
    stage = raw.get("stage")
    if not isinstance(stage, str):
        return []

    ts = _parse_ts_millis(raw.get("ts"))
    if ts is None:
        return []

    run_id = raw.get("runId")
    payload_base: dict[str, Any] = {}
    if isinstance(run_id, str) and run_id:
        payload_base["run_id"] = run_id

    if stage == "stream:context":
        payload: dict[str, Any] = {
            **payload_base,
            "provider": raw.get("provider"),
            "model": raw.get("modelId"),
            "prompt": raw.get("prompt"),
            "system": raw.get("system"),
            "messages": raw.get("messages"),
            "options": raw.get("options"),
            "source": "cache_trace",
        }
        return [
            EventRecord(
                ts=ts,
                direction="gateway->model",
                channel="cache_trace",
                event_type="model_request_internal",
                payload_full=payload,
            )
        ]

    if stage == "session:after":
        messages = raw.get("messages")
        if not isinstance(messages, list):
            return []

        assistant_message = next(
            (
                message
                for message in reversed(messages)
                if isinstance(message, dict) and message.get("role") == "assistant"
            ),
            None,
        )
        if assistant_message is None:
            return []

        payload = {
            **payload_base,
            "assistant_message": assistant_message,
            "usage": assistant_message.get("usage") if isinstance(assistant_message, dict) else None,
            "source": "cache_trace",
        }
        return [
            EventRecord(
                ts=ts,
                direction="model->gateway",
                channel="cache_trace",
                event_type="model_response_internal",
                payload_full=payload,
            )
        ]

    return []


def _is_openclaw_responses_endpoint(url: str | None) -> bool:
    if not isinstance(url, str) or not url:
        return False

    parsed = urlparse(url)
    return parsed.path == "/v1/responses"


def _payload_has_user_input(payload: dict[str, Any]) -> bool:
    return any(key in payload for key in ("input", "messages", "prompt"))


def _with_request_flow_id(payload: dict[str, Any], flow_id: Any) -> dict[str, Any]:
    if isinstance(flow_id, str) and flow_id:
        return {**payload, "request_flow_id": flow_id}
    return payload


def _extract_run_id(payload: dict[str, Any]) -> str | None:
    direct_id = payload.get("id")
    if isinstance(direct_id, str) and direct_id:
        return direct_id

    direct_run_id = payload.get("run_id")
    if isinstance(direct_run_id, str) and direct_run_id:
        return direct_run_id

    response = payload.get("response")
    if isinstance(response, dict):
        response_id = response.get("id")
        if isinstance(response_id, str) and response_id:
            return response_id

    response_id = payload.get("response_id")
    if isinstance(response_id, str) and response_id:
        return response_id

    return None


def _with_correlation_keys(payload: dict[str, Any], flow_id: Any) -> dict[str, Any]:
    result = _with_request_flow_id(payload, flow_id)
    run_id = _extract_run_id(payload)
    if run_id and "run_id" not in result:
        result = {**result, "run_id": run_id}
    return result


def _extract_response_text(payload: dict[str, Any]) -> str | None:
    output = payload.get("output")
    if isinstance(output, list):
        for item in output:
            if not isinstance(item, dict):
                continue
            if isinstance(item.get("text"), str) and item.get("text"):
                return item["text"]

            content = item.get("content")
            if not isinstance(content, list):
                continue
            for block in content:
                if not isinstance(block, dict):
                    continue
                if isinstance(block.get("text"), str) and block.get("text"):
                    return block["text"]

    choices = payload.get("choices")
    if isinstance(choices, list) and choices:
        first_choice = choices[0]
        if isinstance(first_choice, dict):
            message = first_choice.get("message")
            if isinstance(message, dict):
                content = message.get("content")
                if isinstance(content, str) and content:
                    return content

    if isinstance(payload.get("output_text"), str) and payload.get("output_text"):
        return payload["output_text"]
    if isinstance(payload.get("text"), str) and payload.get("text"):
        return payload["text"]
    return None


def _extract_response_id(payload: dict[str, Any]) -> str | None:
    response_id = payload.get("response_id")
    if isinstance(response_id, str) and response_id:
        return response_id

    direct_id = payload.get("id")
    if isinstance(direct_id, str) and direct_id:
        return direct_id

    response = payload.get("response")
    if isinstance(response, dict):
        nested_id = response.get("id")
        if isinstance(nested_id, str) and nested_id:
            return nested_id
    return None


def _extract_usage(payload: dict[str, Any]) -> dict[str, Any] | None:
    usage = payload.get("usage")
    if isinstance(usage, dict):
        return usage

    response = payload.get("response")
    if isinstance(response, dict):
        response_usage = response.get("usage")
        if isinstance(response_usage, dict):
            return response_usage
    return None


def _parse_raw_record(raw: dict[str, Any], *, state: _ParserState | None) -> list[EventRecord]:
    if "stage" in raw:
        return _parse_cache_trace_record(raw)

    ts = raw.get("ts")
    channel = raw.get("channel")

    if not isinstance(ts, int) or not isinstance(channel, str):
        return []

    if channel == "ws":
        if raw.get("message_type") != "text":
            return []

        payload = _parse_json_object(raw.get("payload_text"))
        if payload is None:
            return []

        payload_type = payload.get("type")
        if raw.get("direction") == "client->server" and payload_type == "chat.send":
            return [
                EventRecord(
                    ts=ts,
                    direction="user->gateway",
                    channel="ws",
                    event_type="user_input",
                    payload_full=payload,
                )
            ]

        if raw.get("direction") == "server->client" and payload_type == "chat.delta":
            return [
                EventRecord(
                    ts=ts,
                    direction="gateway->ui",
                    channel="ws",
                    event_type="ui_delta",
                    payload_full=payload,
                )
            ]

        if raw.get("direction") == "server->client" and payload_type == "chat.final":
            return [
                EventRecord(
                    ts=ts,
                    direction="gateway->ui",
                    channel="ws",
                    event_type="ui_final",
                    payload_full=payload,
                )
            ]

        return []

    if channel == "http":
        if raw.get("direction") == "request":
            if raw.get("method") != "POST" or not _is_model_endpoint(raw.get("url")):
                return []

            payload = _parse_json_object(raw.get("body_text"))
            if payload is None:
                return []

            flow_id = raw.get("flow_id")
            effective_flow_id = flow_id
            is_openclaw_endpoint = _is_openclaw_responses_endpoint(raw.get("url"))
            if state is not None:
                if is_openclaw_endpoint and _payload_has_user_input(payload):
                    _remember_openclaw_request(state, ts=ts, flow_id=flow_id, payload=payload)
                elif isinstance(flow_id, str) and flow_id:
                    candidate_input = _extract_candidate_input_text(payload)
                    matched_request_flow = _best_pending_match(
                        state,
                        ts=ts,
                        candidate_input=candidate_input,
                    )
                    if matched_request_flow:
                        state.upstream_flow_to_request_flow[flow_id] = matched_request_flow
                        effective_flow_id = matched_request_flow

            payload_with_flow = _with_correlation_keys(payload, effective_flow_id)

            model_request_event = EventRecord(
                ts=ts,
                direction="gateway->model",
                channel="http",
                event_type="model_request",
                payload_full=payload_with_flow,
            )

            if is_openclaw_endpoint and _payload_has_user_input(payload):
                user_event = EventRecord(
                    ts=ts,
                    direction="user->gateway",
                    channel="http",
                    event_type="user_input",
                    payload_full=payload_with_flow,
                )
                return [user_event, model_request_event]

            return [model_request_event]

        if raw.get("direction") == "response":
            if not _is_model_endpoint(raw.get("url")):
                return []

            headers = raw.get("headers")
            content_type = headers.get("content-type") if isinstance(headers, dict) else None
            if not isinstance(content_type, str):
                return []

            flow_id = raw.get("flow_id")
            effective_flow_id = flow_id
            if (
                state is not None
                and not _is_openclaw_responses_endpoint(raw.get("url"))
                and isinstance(flow_id, str)
                and flow_id
            ):
                mapped = state.upstream_flow_to_request_flow.get(flow_id)
                if isinstance(mapped, str) and mapped:
                    effective_flow_id = mapped

            if "application/json" in content_type:
                payload = _parse_json_object(raw.get("body_text"))
                if payload is None:
                    return []

                payload_with_flow = _with_correlation_keys(payload, effective_flow_id)
                response_id = _extract_response_id(payload_with_flow)
                response_text = _extract_response_text(payload_with_flow)
                usage = _extract_usage(payload_with_flow)

                enriched_payload: dict[str, Any] = payload_with_flow
                if response_id and "response_id" not in enriched_payload:
                    enriched_payload = {**enriched_payload, "response_id": response_id}
                if response_text:
                    enriched_payload = {**enriched_payload, "response_text": response_text}
                if usage is not None and "usage" not in enriched_payload:
                    enriched_payload = {**enriched_payload, "usage": usage}

                return [
                    EventRecord(
                        ts=ts,
                        direction="model->gateway",
                        channel="http",
                        event_type="model_response_json",
                        payload_full=enriched_payload,
                    )
                ]

            if "text/event-stream" not in content_type:
                return []

            parsed_events = _parse_sse_data(raw.get("body_text"))
            if not parsed_events:
                return []

            return [
                EventRecord(
                    ts=ts,
                    direction="model->gateway",
                    channel="http",
                    event_type=event_type,
                    payload_full=_with_correlation_keys(payload, effective_flow_id),
                )
                for event_type, payload in parsed_events
            ]

    return []


def parse_raw_record(raw: dict[str, Any]) -> list[EventRecord]:
    return _parse_raw_record(raw, state=None)


def parse_raw_records(raw_records: list[dict[str, Any]]) -> list[EventRecord]:
    state = _ParserState()
    events: list[EventRecord] = []
    for raw in raw_records:
        events.extend(_parse_raw_record(raw, state=state))
    return events
