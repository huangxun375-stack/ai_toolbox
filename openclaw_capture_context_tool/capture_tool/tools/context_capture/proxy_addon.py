"""mitmproxy addon helpers for context capture tool."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Mapping, Optional, Union
from urllib.parse import urlparse

try:
    from tools.context_capture.storage import JsonlStore
except ModuleNotFoundError as exc:
    if exc.name != "tools":
        raise
    import sys

    _proxy_dir = Path(__file__).resolve().parent
    _project_root = _proxy_dir.parent.parent
    if str(_project_root) not in sys.path:
        sys.path.insert(0, str(_project_root))
    from tools.context_capture.storage import JsonlStore


BytesLike = Union[bytes, bytearray, memoryview]


def _normalize_headers(headers: Optional[Mapping[str, Any]]) -> dict[str, str]:
    if not headers:
        return {}

    normalized: dict[str, str] = {}
    for key, value in headers.items():
        normalized[str(key).lower()] = str(value)
    return normalized


def _decode_body(body: Optional[BytesLike]) -> Optional[str]:
    if body is None:
        return None
    return bytes(body).decode("utf-8", errors="replace")


def _to_ts(value: Any) -> int:
    if isinstance(value, (int, float)):
        return int(value * 1000)
    return 0


def build_http_raw_record(
    *,
    ts: int,
    flow_id: str,
    direction: str,
    method: str,
    url: str,
    headers: Optional[Mapping[str, Any]],
    body: Optional[BytesLike],
    status_code: Optional[int] = None,
) -> dict[str, Any]:
    return {
        "ts": ts,
        "channel": "http",
        "flow_id": flow_id,
        "direction": direction,
        "method": method,
        "url": url,
        "headers": _normalize_headers(headers),
        "body_text": _decode_body(body),
        "status_code": status_code,
    }


def build_ws_raw_record(
    *,
    ts: int,
    flow_id: str,
    direction: str,
    message_type: str,
    payload: Union[str, BytesLike],
) -> dict[str, Any]:
    payload_text: Optional[str] = None
    payload_hex: Optional[str] = None

    if isinstance(payload, str):
        payload_text = payload
    else:
        payload_hex = bytes(payload).hex()

    return {
        "ts": ts,
        "channel": "ws",
        "flow_id": flow_id,
        "direction": direction,
        "message_type": message_type,
        "payload_text": payload_text,
        "payload_hex": payload_hex,
    }


class ContextCaptureAddon:
    def __init__(self, data_dir: Path | None = None) -> None:
        self._data_dir = data_dir
        self._store: JsonlStore | None = None

    def _http_url_filter_prefix(self) -> str:
        return os.environ.get("CONTEXT_CAPTURE_HTTP_URL_PREFIX", "").strip()

    def _should_capture_http_url(self, url: str) -> bool:
        prefix = self._http_url_filter_prefix()
        if not prefix:
            return True

        parsed_url = urlparse(url)
        parsed_prefix = urlparse(prefix)

        if parsed_prefix.scheme and parsed_url.scheme != parsed_prefix.scheme:
            return False
        if parsed_prefix.netloc and parsed_url.netloc != parsed_prefix.netloc:
            return False

        prefix_path = parsed_prefix.path or "/"
        return parsed_url.path.startswith(prefix_path)

    def load(self, loader: Any) -> None:
        loader.add_option(
            name="context_capture_data_dir",
            typespec=str,
            default="",
            help="Directory for context capture raw.jsonl output",
        )

    def configure(self, updates: set[str]) -> None:
        if "context_capture_data_dir" not in updates:
            return

        try:
            from mitmproxy import ctx

            configured = str(getattr(ctx.options, "context_capture_data_dir", "") or "").strip()
        except (ImportError, AttributeError):
            configured = ""

        if configured:
            self._data_dir = Path(configured)
            self._store = JsonlStore(self._data_dir / "raw.jsonl")
        else:
            self._data_dir = None
            self._store = None

    def _resolve_store(self) -> JsonlStore | None:
        if self._store is not None:
            return self._store

        if self._data_dir is None:
            env_dir = os.environ.get("CONTEXT_CAPTURE_DATA_DIR", "").strip()
            if env_dir:
                self._data_dir = Path(env_dir)

        if self._data_dir is None:
            return None

        self._store = JsonlStore(self._data_dir / "raw.jsonl")
        return self._store

    def request(self, flow: Any) -> None:
        store = self._resolve_store()
        if store is None:
            return

        req = getattr(flow, "request", None)
        if req is None:
            return

        request_url = str(getattr(req, "pretty_url", ""))
        if not self._should_capture_http_url(request_url):
            return

        record = build_http_raw_record(
            ts=_to_ts(getattr(req, "timestamp_start", None)),
            flow_id=str(getattr(flow, "id", "")),
            direction="request",
            method=str(getattr(req, "method", "")),
            url=request_url,
            headers=getattr(req, "headers", None),
            body=getattr(req, "raw_content", None),
        )
        store.append(record)

    def response(self, flow: Any) -> None:
        store = self._resolve_store()
        if store is None:
            return

        req = getattr(flow, "request", None)
        resp = getattr(flow, "response", None)
        if req is None or resp is None:
            return

        request_url = str(getattr(req, "pretty_url", ""))
        if not self._should_capture_http_url(request_url):
            return

        record = build_http_raw_record(
            ts=_to_ts(getattr(resp, "timestamp_end", None)),
            flow_id=str(getattr(flow, "id", "")),
            direction="response",
            method=str(getattr(req, "method", "")),
            url=request_url,
            headers=getattr(resp, "headers", None),
            body=getattr(resp, "raw_content", None),
            status_code=getattr(resp, "status_code", None),
        )
        store.append(record)

    def websocket_message(self, flow: Any) -> None:
        store = self._resolve_store()
        if store is None:
            return

        websocket = getattr(flow, "websocket", None)
        messages = getattr(websocket, "messages", None)
        if not isinstance(messages, list) or not messages:
            return

        message = messages[-1]
        direction = "client->server" if bool(getattr(message, "from_client", False)) else "server->client"

        is_text = bool(getattr(message, "is_text", False))
        payload = getattr(message, "content", b"")
        if is_text and isinstance(payload, bytes):
            payload = payload.decode("utf-8", errors="replace")

        record = build_ws_raw_record(
            ts=_to_ts(getattr(message, "timestamp", None)),
            flow_id=str(getattr(flow, "id", "")),
            direction=direction,
            message_type="text" if is_text else "binary",
            payload=payload,
        )
        store.append(record)


addons = [ContextCaptureAddon()]
