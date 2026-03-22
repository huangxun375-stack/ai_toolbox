"""LCM diagnostics CLI 鈥?parse and filter lcm-diagnostics.jsonl."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


STAGE_FORMATTERS = {
    "afterTurn_entry": lambda sid, d: (
        f"\n=== afterTurn ({sid}) : {len(d.get('messages', []))} messages, "
        f"total {sum(m.get('tokens', 0) for m in d.get('messages', []))} tokens ==="
        + "".join(
            f"\n  [{i+1:2d}] {m.get('role','?'):12s} {m.get('tokens',0):5d} tok | {m.get('preview','')[:80]}"
            for i, m in enumerate(d.get("messages", []))
        )
    ),
    "ingest": lambda sid, d: (
        f"  INGEST: seq={d.get('seq','')} {d.get('role','?'):10s} "
        f"{d.get('tokenCount',0):5d} tok | {d.get('contentPreview','')[:60]}"
    ),
    "compaction_evaluate": lambda sid, d: (
        f"  COMPACT_EVAL: currentTokens={d.get('currentTokens','')} "
        f"threshold={d.get('threshold','')} shouldCompact={d.get('shouldCompact','')} "
        f"reason={d.get('reason','')}"
    ),
    "leaf_pass_detail": lambda sid, d: (
        f"  LEAF_PASS: {d.get('inputMessageCount','')} msgs "
        f"({d.get('inputTokens','')} tok) -> {d.get('outputTokens','')} tok  "
        f"level={d.get('level','')}"
    ),
    "leaf_summary": lambda sid, d: (
        f"  LEAF_SUM:  {d.get('tokensBefore','')} -> {d.get('tokensAfter','')} "
        f"(saved {d.get('tokensSaved','')}, {d.get('savingPct','')}%)"
    ),
    "dag_aggregate": lambda sid, d: (
        f"  DAG_AGG:   {d.get('tokensBefore','')} -> {d.get('tokensAfter','')} "
        f"(saved {d.get('tokensSaved','')}, {d.get('savingPct','')}%)"
    ),
    "compact_phase": lambda sid, d: (
        f"  COMPACT_PHASE: {d.get('phase','')} {d.get('status','')} | {d.get('reason','')}"
    ),
    "compact_skip": lambda sid, d: (
        f"  COMPACT_SKIP: {d.get('reason','')} tokensBefore={d.get('tokensBefore','')}"
    ),
    "compact_result": lambda sid, d: (
        f"  COMPACT_RESULT: {d.get('tokensBefore','')} -> {d.get('tokensAfter','')} "
        f"(saved {d.get('tokensSaved','')}) condensed={d.get('condensed','')}"
    ),
    "assemble_skip": lambda sid, d: (
        f"\n--- assemble_skip ({sid}): {d.get('reason','')} ---"
    ),
    "assemble_input": lambda sid, d: (
        f"\n--- assemble_input ({sid}): {d.get('messagesCount',0)} msgs, "
        f"estimate {d.get('inputTokenEstimate',0)} tok ---"
    ),
    "assemble_output": lambda sid, d: (
        f"--- assemble_output ({sid}): {d.get('outputMessagesCount',0)} msgs, "
        f"estimate {d.get('estimatedTokens',0)} tok ---"
    ),
    "context_assemble": lambda sid, d: (
        f"  CONTEXT_ASSEMBLE: summaries={d.get('summaryCount',0)} "
        f"freshTail={d.get('freshTailCount',0)} tailTokens={d.get('tailTokens',0)}"
    ),
    "bootstrap_entry": lambda sid, d: (
        f"\n--- bootstrap_entry ({sid}): {d.get('sessionFile','')} ---"
    ),
    "bootstrap_import": lambda sid, d: (
        f"  BOOTSTRAP_IMPORT: {d.get('importedMessages',0)} msgs, {d.get('totalTokens',0)} tok"
    ),
    "bootstrap_result": lambda sid, d: (
        f"  BOOTSTRAP_RESULT: bootstrapped={d.get('bootstrapped','')} reason={d.get('reason','')}"
    ),
}


def parse_entries(path: Path) -> list[dict]:
    entries = []
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return entries


def filter_entries(
    entries: list[dict],
    session: str | None = None,
    stage: str | None = None,
    round_num: int | None = None,
) -> list[dict]:
    if session:
        entries = [e for e in entries if e.get("sessionId") == session]
    if stage:
        stages = set(stage.split(","))
        entries = [e for e in entries if e.get("stage") in stages]
    if round_num is not None:
        count = 0
        start_idx = None
        end_idx = None
        for i, e in enumerate(entries):
            if e.get("stage") == "afterTurn_entry":
                count += 1
                if count == round_num:
                    start_idx = i
                elif count == round_num + 1:
                    end_idx = i
                    break
        if start_idx is not None:
            entries = entries[start_idx:end_idx]
        else:
            entries = []
    return entries


def format_entry(entry: dict, raw: bool = False) -> str:
    if raw:
        return json.dumps(entry, ensure_ascii=False)
    stage = entry.get("stage", "")
    sid = entry.get("sessionId", "")
    data = entry.get("data", {})
    formatter = STAGE_FORMATTERS.get(stage)
    if formatter:
        return formatter(sid, data)
    return f"  [{stage}] ({sid}): {json.dumps(data, ensure_ascii=False)[:120]}"


def main():
    parser = argparse.ArgumentParser(description="Parse LCM diagnostics JSONL")
    parser.add_argument(
        "path",
        nargs="?",
        default=str(Path.home() / ".openclaw" / "lcm-diagnostics.jsonl"),
        help="Path to lcm-diagnostics.jsonl (default: ~/.openclaw/lcm-diagnostics.jsonl)",
    )
    parser.add_argument("--session", help="Filter by sessionId")
    parser.add_argument("--stage", help="Filter by stage (comma-separated)")
    parser.add_argument("--round", type=int, dest="round_num", help="Show only round N (1-based)")
    parser.add_argument("--raw", action="store_true", help="Output raw JSON per line")
    parser.add_argument("--stdin", action="store_true", help="Read from stdin instead of file")
    args = parser.parse_args()

    if args.stdin:
        entries = []
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    else:
        p = Path(args.path)
        if not p.exists():
            print(f"File not found: {p}", file=sys.stderr)
            sys.exit(1)
        entries = parse_entries(p)

    entries = filter_entries(entries, args.session, args.stage, args.round_num)

    for entry in entries:
        print(format_entry(entry, args.raw))


if __name__ == "__main__":
    main()