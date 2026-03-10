"""CLI entrypoint scaffold for context capture tool."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Optional

import typer

from tools.context_capture.correlator import correlate_events
from tools.context_capture.parser import parse_raw_record
from tools.context_capture.storage import JsonlStore


app = typer.Typer()
capture_app = typer.Typer()
app.add_typer(capture_app, name="capture")


def _ensure_data_dir_exists(data_dir: Path) -> Path:
    if not data_dir.exists() or not data_dir.is_dir():
        raise typer.BadParameter(f"data dir does not exist: {data_dir}")
    return data_dir


def _trace_matches(
    trace: dict[str, Any],
    *,
    session_key: Optional[str],
    run_id: Optional[str],
) -> bool:
    if not session_key and not run_id:
        return True

    has_session_key_match = session_key is None
    has_run_id_match = run_id is None

    for event in trace.get("events", []):
        payload = event.payload_full if hasattr(event, "payload_full") else None
        if not isinstance(payload, dict):
            continue

        if session_key is not None and payload.get("session_key") == session_key:
            has_session_key_match = True
        if run_id is not None and payload.get("run_id") == run_id:
            has_run_id_match = True

        if has_session_key_match and has_run_id_match:
            return True

    return False


def _load_timeline(
    data_dir: Path,
    *,
    session_key: Optional[str] = None,
    run_id: Optional[str] = None,
) -> list[dict[str, Any]]:
    raw_store = JsonlStore(data_dir / "raw.jsonl")
    events = []
    for raw in raw_store.read_all() or []:
        events.extend(parse_raw_record(raw))

    traces = correlate_events(events)
    filtered_traces = [
        trace for trace in traces if _trace_matches(trace, session_key=session_key, run_id=run_id)
    ]
    timeline: list[dict[str, Any]] = []
    for index, trace in enumerate(filtered_traces):
        trace_events = trace.get("events", [])
        start_ts = trace_events[0].ts if trace_events else None
        end_ts = trace_events[-1].ts if trace_events else None
        timeline.append(
            {
                "trace_id": str(index),
                "event_count": len(trace_events),
                "start_ts": start_ts,
                "end_ts": end_ts,
                "correlation_confidence": trace.get("correlation_confidence"),
                "completeness": trace.get("completeness"),
                "missing_reasons": trace.get("missing_reasons"),
            }
        )
    return timeline


@capture_app.command("start")
def capture_start(data_dir: Path = typer.Option(Path("data/context_capture"), "--data-dir")) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    typer.echo(f"mitmproxy would start with data dir: {data_dir}")


@app.command()
def replay(
    data_dir: Path = typer.Option(..., "--data-dir"),
    session_key: Optional[str] = typer.Option(None, "--session-key"),
    run_id: Optional[str] = typer.Option(None, "--run-id"),
) -> None:
    data_dir = _ensure_data_dir_exists(data_dir)
    timeline = _load_timeline(data_dir, session_key=session_key, run_id=run_id)
    typer.echo(
        json.dumps(
            {
                "data_dir": str(data_dir),
                "session_key": session_key,
                "run_id": run_id,
                "traces": timeline,
            },
            ensure_ascii=False,
        )
    )


@app.command()
def export(
    data_dir: Path = typer.Option(..., "--data-dir"),
    format: str = typer.Option("json", "--format"),
    session_key: Optional[str] = typer.Option(None, "--session-key"),
    run_id: Optional[str] = typer.Option(None, "--run-id"),
) -> None:
    data_dir = _ensure_data_dir_exists(data_dir)
    if format not in {"json", "jsonl"}:
        raise typer.BadParameter("format must be json or jsonl")

    timeline = _load_timeline(data_dir, session_key=session_key, run_id=run_id)

    if format == "json":
        typer.echo(json.dumps({"data_dir": str(data_dir), "traces": timeline}, ensure_ascii=False))
        return

    if not timeline:
        return

    for item in timeline:
        typer.echo(json.dumps(item, ensure_ascii=False))


if __name__ == "__main__":
    app()
