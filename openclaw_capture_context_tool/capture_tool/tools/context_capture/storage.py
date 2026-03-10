"""Storage layer for raw records and indexed events."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterator


class JsonlStore:
    def __init__(self, path: Path) -> None:
        self.path = path

    def append(self, record: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False))
            f.write("\n")

    def read_all(self) -> Iterator[dict[str, Any]]:
        if not self.path.exists():
            return
        with self.path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    parsed = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(parsed, dict):
                    yield parsed


class EventIndex:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _connect(self):
        # Keep sqlite optional at import time so proxy addon can run on
        # Python builds without _sqlite3 (it only needs JsonlStore).
        try:
            import sqlite3
        except ModuleNotFoundError as exc:
            raise RuntimeError(
                "sqlite3 module is unavailable in this Python runtime; "
                "EventIndex requires sqlite support."
            ) from exc

        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS events_index (
                    event_id TEXT PRIMARY KEY,
                    ts INTEGER NOT NULL,
                    session_key TEXT,
                    run_id TEXT,
                    event_type TEXT NOT NULL
                )
                """
            )
            conn.commit()

    def insert(
        self,
        *,
        event_id: str,
        ts: int,
        session_key: str | None,
        run_id: str | None,
        event_type: str,
    ) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO events_index (event_id, ts, session_key, run_id, event_type)
                VALUES (?, ?, ?, ?, ?)
                """,
                (event_id, ts, session_key, run_id, event_type),
            )
            conn.commit()

    def query(
        self,
        *,
        session_key: str | None = None,
        run_id: str | None = None,
    ) -> list[dict[str, Any]]:
        sql = "SELECT event_id, ts, session_key, run_id, event_type FROM events_index"
        conditions: list[str] = []
        params: list[Any] = []

        if session_key is not None:
            conditions.append("session_key = ?")
            params.append(session_key)
        if run_id is not None:
            conditions.append("run_id = ?")
            params.append(run_id)

        if conditions:
            sql += " WHERE " + " AND ".join(conditions)
        sql += " ORDER BY ts ASC, event_id ASC"

        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()

        return [dict(row) for row in rows]
