#!/usr/bin/env python3
"""Export current session capture data into a standalone offline HTML."""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from html import escape
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import urlopen


def fetch_json(url: str) -> Any:
    try:
        with urlopen(url, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except HTTPError as exc:
        raise RuntimeError(f"HTTP error {exc.code} for {url}") from exc
    except URLError as exc:
        raise RuntimeError(f"Network error for {url}: {exc}") from exc


def build_payload(api_url: str, max_traces: int) -> dict[str, Any]:
    base = api_url.rstrip("/")
    timeline = fetch_json(f"{base}/api/timeline")
    if not isinstance(timeline, list):
        raise RuntimeError("invalid timeline payload")

    selected = timeline[: max(0, max_traces)]
    traces: dict[str, Any] = {}
    for item in selected:
        trace_id = str(item.get("trace_id", ""))
        if not trace_id:
            continue
        trace = fetch_json(f"{base}/api/trace/{trace_id}")
        traces[trace_id] = trace

    return {"timeline": selected, "traces": traces}


def html_template(title: str, payload: dict[str, Any]) -> str:
    safe_title = escape(title)
    data_json = json.dumps(payload, ensure_ascii=False)
    exported_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    return f"""<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{safe_title}</title>
    <style>
      :root {{
        color-scheme: light;
        font-family: "Segoe UI", "PingFang SC", "Hiragino Sans GB", sans-serif;
        background: #f6f8fb;
        color: #142033;
      }}
      * {{ box-sizing: border-box; }}
      body {{ margin: 0; min-height: 100vh; background: #f6f8fb; }}
      .layout-shell {{ max-width: 1380px; margin: 0 auto; padding: 20px; }}
      .toolbar {{ display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 14px; }}
      .toolbar h1 {{ margin: 0; font-size: 22px; }}
      .toolbar .meta {{ color: #52627a; font-size: 13px; }}
      .workspace {{ display: grid; grid-template-columns: 320px 1fr; gap: 16px; align-items: start; }}
      .sessions-panel, .detail-panel {{ border: 1px solid #e2e8f3; border-radius: 12px; background: #ffffff; }}
      .panel-header {{ padding: 10px 12px; border-bottom: 1px solid #e8eef8; font-size: 14px; font-weight: 700; color: #1f3f8f; }}
      .session-list {{ display: grid; gap: 8px; padding: 10px; max-height: calc(100vh - 180px); overflow: auto; }}
      .session-item {{ width: 100%; border: 1px solid #dce4f2; border-radius: 10px; background: #fff; color: #142033; cursor: pointer; text-align: left; padding: 8px 10px; font: inherit; }}
      .session-item.is-selected {{ border-color: #6f8cff; background: #f4f7ff; }}
      .session-title {{ font-size: 12px; color: #52627a; margin-bottom: 4px; }}
      .session-subtitle {{ font-size: 12px; color: #142033; line-height: 1.35; }}
      .panel-empty {{ padding: 12px; color: #607089; font-size: 13px; }}
      .detail-meta {{ display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #eef2f8; }}
      .meta-pill {{ padding: 4px 8px; border-radius: 999px; background: #eef3ff; color: #3450a1; font-size: 12px; font-weight: 600; }}
      .flow-list {{ display: grid; gap: 10px; padding: 10px 12px; max-height: calc(100vh - 190px); overflow: auto; }}
      .flow-item {{ border-left: 2px solid #d9e2f2; padding-left: 10px; }}
      .flow-header {{ display: flex; justify-content: space-between; gap: 8px; margin-bottom: 6px; }}
      .flow-label {{ color: #1f3f8f; font-weight: 700; font-size: 12px; }}
      .flow-time {{ color: #607089; font-size: 11px; }}
      .flow-preview, .flow-full {{ margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.45; }}
      .flow-details {{ margin-top: 6px; }}
      .flow-details summary {{ cursor: pointer; color: #3450a1; font-size: 12px; font-weight: 600; }}
      @media (max-width: 960px) {{ .workspace {{ grid-template-columns: 1fr; }} .session-list, .flow-list {{ max-height: none; }} }}
    </style>
  </head>
  <body>
    <div class="layout-shell">
      <header class="toolbar">
        <h1>{safe_title}</h1>
        <span class="meta">导出时间: {escape(exported_at)}</span>
      </header>
      <main class="workspace">
        <section class="sessions-panel">
          <div class="panel-header">会话列表</div>
          <div id="session-list" class="session-list"></div>
        </section>
        <section class="detail-panel">
          <div class="panel-header">会话抓包内容</div>
          <div id="session-meta" class="detail-meta"></div>
          <div id="flow-list" class="flow-list"></div>
        </section>
      </main>
    </div>
    <script>
      const DATA = {data_json};
      const state = {{
        timeline: Array.isArray(DATA.timeline) ? DATA.timeline : [],
        traces: DATA.traces && typeof DATA.traces === "object" ? DATA.traces : {{}},
        selectedTraceId: null,
      }};

      function byId(id) {{ return document.getElementById(id); }}
      function fmtTs(ts) {{ return typeof ts === "number" ? new Date(ts).toLocaleString() : "—"; }}
      function clearNode(id) {{ const n = byId(id); if (n) n.replaceChildren(); return n; }}
      function selectedItem() {{
        return state.timeline.find((t) => String(t.trace_id) === String(state.selectedTraceId)) || null;
      }}

      function renderList() {{
        const root = clearNode("session-list");
        if (!root) return;
        if (state.timeline.length === 0) {{
          const d = document.createElement("div");
          d.className = "panel-empty";
          d.textContent = "无会话数据。";
          root.appendChild(d);
          return;
        }}
        for (const item of state.timeline) {{
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "session-item";
          btn.classList.toggle("is-selected", String(item.trace_id) === String(state.selectedTraceId));
          const t = document.createElement("div");
          t.className = "session-title";
          t.textContent = `trace ${{item.trace_id}} | ${{item.event_count || 0}} events`;
          const s = document.createElement("div");
          s.className = "session-subtitle";
          s.textContent = `开始: ${{fmtTs(item.start_ts)}}`;
          btn.appendChild(t); btn.appendChild(s);
          btn.addEventListener("click", () => {{
            state.selectedTraceId = String(item.trace_id);
            renderAll();
          }});
          root.appendChild(btn);
        }}
      }}

      function renderMeta() {{
        const root = clearNode("session-meta");
        if (!root) return;
        const item = selectedItem();
        if (!item) {{
          const d = document.createElement("div");
          d.className = "panel-empty";
          d.textContent = "请选择会话。";
          root.appendChild(d);
          return;
        }}
        const rows = [
          `trace ${{item.trace_id}}`,
          `${{item.event_count || 0}} events`,
          `${{item.correlation_confidence || "unknown"}} confidence`,
          `${{item.completeness || "unknown"}} completeness`,
          `start ${{fmtTs(item.start_ts)}}`,
          `end ${{fmtTs(item.end_ts)}}`,
        ];
        for (const row of rows) {{
          const p = document.createElement("span");
          p.className = "meta-pill";
          p.textContent = row;
          root.appendChild(p);
        }}
      }}

      function renderFlow() {{
        const root = clearNode("flow-list");
        if (!root) return;
        const trace = state.traces[String(state.selectedTraceId)];
        const events = Array.isArray(trace?.events) ? trace.events : [];
        if (events.length === 0) {{
          const d = document.createElement("div");
          d.className = "panel-empty";
          d.textContent = "无会话详情。";
          root.appendChild(d);
          return;
        }}
        for (const e of events) {{
          const item = document.createElement("article");
          item.className = "flow-item";
          const h = document.createElement("header");
          h.className = "flow-header";
          const label = document.createElement("span");
          label.className = "flow-label";
          label.textContent = e.flow_label || e.flow_stage || e.direction || "unknown";
          const time = document.createElement("span");
          time.className = "flow-time";
          time.textContent = e.ts_iso || fmtTs(e.ts);
          h.appendChild(label); h.appendChild(time);
          const preview = document.createElement("pre");
          preview.className = "flow-preview";
          preview.textContent = typeof e.content_preview === "string" ? e.content_preview : "(no content)";
          const details = document.createElement("details");
          details.className = "flow-details";
          const summary = document.createElement("summary");
          summary.textContent = "展开查看完整内容";
          const full = document.createElement("pre");
          full.className = "flow-full";
          full.textContent = typeof e.content_full === "string" ? e.content_full : JSON.stringify(e.payload_full ?? null, null, 2);
          details.appendChild(summary); details.appendChild(full);
          item.appendChild(h); item.appendChild(preview); item.appendChild(details);
          root.appendChild(item);
        }}
      }}

      function renderAll() {{
        renderList();
        renderMeta();
        renderFlow();
      }}

      if (state.timeline.length > 0) {{
        state.selectedTraceId = String(state.timeline[0].trace_id);
      }}
      renderAll();
    </script>
  </body>
</html>
"""


def main() -> int:
    parser = argparse.ArgumentParser(description="Export session capture into offline HTML")
    parser.add_argument("--api-url", default="http://127.0.0.1:8000", help="Capture API base URL")
    parser.add_argument("--output", required=True, help="Output HTML file path")
    parser.add_argument("--title", default="OpenClaw Session Capture Offline Report", help="Report title")
    parser.add_argument("--max-traces", type=int, default=200, help="Max traces to include")
    args = parser.parse_args()

    payload = build_payload(args.api_url, args.max_traces)
    html = html_template(args.title, payload)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(html, encoding="utf-8")
    print(str(output_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
