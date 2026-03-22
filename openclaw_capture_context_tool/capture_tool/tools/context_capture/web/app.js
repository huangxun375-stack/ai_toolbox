const state = {
  timeline: [],
  visibleTimeline: [],
  filterNote: "",
  selectedTraceId: null,
  selectedTrace: null,
  traceCache: {},
  loadingToken: 0,
  lcmDiagnostics: [],
  showAllMode: false,
  allTraces: [],
};

function getElement(id) { return document.getElementById(id); }
function setText(id, v) { const el = getElement(id); if (el) el.textContent = v; }
function setHidden(id, h) { const el = getElement(id); if (el) el.hidden = h; }

function formatTs(ts) {
  if (typeof ts !== "number") return "";
  return new Date(ts).toLocaleString();
}
function isObj(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
function fmt(v) { return Number.isFinite(v) ? Math.trunc(v).toLocaleString() : "0"; }

// --------------- direction helpers ---------------

const STAGE_CONFIG = {
  "user->gateway":  { label: "user -> openclaw",    css: "stage-user" },
  "gateway->model": { label: "openclaw -> model",   css: "stage-to-model" },
  "model->gateway": { label: "model -> openclaw",   css: "stage-from-model" },
  "gateway->tool":  { label: "openclaw -> tool",    css: "stage-tool" },
  "tool->gateway":  { label: "tool -> openclaw",    css: "stage-tool" },
  "gateway->ui":    { label: "openclaw -> user",    css: "stage-to-user" },
};

function classifyDirection(event) {
  const d = event?.direction;
  if (typeof d === "string" && STAGE_CONFIG[d]) return d;
  const fs = event?.flow_stage;
  const map = {
    "USER->openclaw": "user->gateway",
    "OPENCLAW->model": "gateway->model",
    "MODEL->openclaw": "model->gateway",
    "OPENCLAW->tool": "gateway->tool",
    "TOOL->openclaw": "tool->gateway",
    "OPENCLAW->user": "gateway->ui",
  };
  if (typeof fs === "string" && map[fs]) return map[fs];
  return d || "unknown";
}

// --------------- content extraction ---------------

function extractTextFromContent(val) {
  if (typeof val === "string") return val;
  if (Array.isArray(val)) {
    return val.map(item => {
      if (typeof item === "string") return item;
      if (isObj(item)) {
        if (typeof item.text === "string" && item.text) return item.text;
        if (item.content) return extractTextFromContent(item.content);
      }
      return "";
    }).filter(Boolean).join("\n");
  }
  if (isObj(val)) {
    if (typeof val.text === "string" && val.text) return val.text;
    if (val.content) return extractTextFromContent(val.content);
  }
  return "";
}

function lastUserMessage(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!isObj(m) || m.role !== "user") continue;
    const text = extractTextFromContent(m.content);
    if (text) return text;
  }
  return "";
}

function extractResponseText(payload) {
  if (!isObj(payload)) return "";
  if (typeof payload.response_text === "string" && payload.response_text) return payload.response_text;
  if (typeof payload.text === "string" && payload.text) return payload.text;
  if (typeof payload.merged_text === "string" && payload.merged_text) return payload.merged_text;
  const output = payload.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!isObj(item)) continue;
      if (typeof item.text === "string" && item.text) return item.text;
      if (Array.isArray(item.content)) {
        for (const b of item.content) {
          if (isObj(b) && typeof b.text === "string" && b.text) return b.text;
        }
      }
    }
  }
  return "";
}

function extractUsage(payload) {
  if (!isObj(payload)) return null;
  let u = payload.usage;
  if (!isObj(u) && isObj(payload.response)) u = payload.response?.usage;
  if (!isObj(u)) return null;
  const input = u.input_tokens || u.inputTokens || u.input || 0;
  const output = u.output_tokens || u.outputTokens || u.output || 0;
  const total = u.total_tokens || u.totalTokens || u.total || (input + output);
  return { input, output, total };
}

function extractToolCalls(payload) {
  if (!isObj(payload)) return [];
  const calls = [];
  if (Array.isArray(payload.tool_calls)) {
    for (const tc of payload.tool_calls) {
      if (!isObj(tc)) continue;
      calls.push({ name: tc.name || "unknown", args: tc.arguments || "", id: tc.id || "" });
    }
  }
  if (typeof payload.tool === "string" && payload.tool) {
    calls.push({ name: payload.tool, args: "", id: payload.tool_call_id || "" });
  }
  return calls;
}

function mergeModelStreamEvents(events) {
  const textParts = [];
  const reasoningParts = [];
  const toolCalls = new Map();
  let usage = null;
  let responseText = "";

  for (const ev of events) {
    const p = ev?.payload_full;
    if (!isObj(p)) continue;

    // Anthropic SSE: content_block_delta with nested delta object
    if (p.type === "content_block_delta" && isObj(p.delta)) {
      if (p.delta.type === "text_delta" && typeof p.delta.text === "string") {
        textParts.push(p.delta.text);
      }
      if (p.delta.type === "thinking_delta" && typeof p.delta.thinking === "string") {
        reasoningParts.push(p.delta.thinking);
      }
      continue;
    }

    // Anthropic SSE: message_delta with usage
    if (p.type === "message_delta" && isObj(p.usage)) {
      const u = extractUsage({ usage: p.usage });
      if (u) usage = u;
      continue;
    }

    // Skip non-content Anthropic SSE events
    if (p.type === "message_start" || p.type === "message_stop" ||
        p.type === "content_block_start" || p.type === "content_block_stop" ||
        p.type === "ping") {
      continue;
    }

    // OpenAI / generic format
    if (typeof p.delta === "string") textParts.push(p.delta);
    if (typeof p.merged_text === "string" && p.merged_text) textParts.push(p.merged_text);
    const rt = extractResponseText(p);
    if (rt) responseText = rt;
    const u = extractUsage(p);
    if (u) usage = u;
    if (Array.isArray(p.choices)) {
      for (const c of p.choices) {
        if (!isObj(c?.delta)) continue;
        if (typeof c.delta.content === "string") textParts.push(c.delta.content);
        if (typeof c.delta.reasoning_content === "string") reasoningParts.push(c.delta.reasoning_content);
      }
    }
    for (const tc of extractToolCalls(p)) {
      const key = tc.id || tc.name;
      if (!toolCalls.has(key)) toolCalls.set(key, tc);
    }
  }
  return {
    text: responseText || textParts.join(""),
    reasoning: reasoningParts.join(""),
    usage,
    toolCalls: [...toolCalls.values()],
  };
}

// --------------- group events into consecutive direction blocks ---------------

function groupIntoBlocks(events) {
  const blocks = [];
  let cur = null;
  let curEvents = [];
  for (const ev of events) {
    const dir = classifyDirection(ev);
    if (dir !== cur && curEvents.length > 0) {
      blocks.push({ direction: cur, events: curEvents });
      curEvents = [];
    }
    cur = dir;
    curEvents.push(ev);
  }
  if (curEvents.length > 0) blocks.push({ direction: cur, events: curEvents });
    return blocks;
  }

// --------------- group blocks into rounds ---------------
// A round starts with user->gateway (or gateway->model if no user event)
// and ends right before the next user->gateway.
// The last block of a round that is gateway->ui is the "output" section.

function groupBlocksIntoRounds(blocks) {
  const rounds = [];
  let currentBlocks = [];

  for (const block of blocks) {
    if (block.direction === "user->gateway" && currentBlocks.length > 0) {
      rounds.push(currentBlocks);
      currentBlocks = [];
    }
    currentBlocks.push(block);
  }
  if (currentBlocks.length > 0) rounds.push(currentBlocks);
  return rounds;
}

// --------------- extract key info per block ---------------

function buildBlockSummary(block) {
  const { direction, events } = block;
  const first = events[0]?.payload_full || {};
  const last = events[events.length - 1]?.payload_full || {};
  const config = STAGE_CONFIG[direction] || { label: direction, css: "" };
  const ts = events[0]?.ts;
  const tsEnd = events[events.length - 1]?.ts;

  const result = { direction, config, ts, tsEnd, title: "", lines: [], meta: [], fields: [] };

  if (direction === "user->gateway") {
    let text = "";
    if (typeof first.text === "string" && first.text) text = first.text;
    if (!text && typeof first.message === "string" && first.message) text = first.message;
    if (!text) text = extractTextFromContent(first.content) || extractTextFromContent(first.input) || "";
    if (!text && Array.isArray(first.messages)) text = lastUserMessage(first.messages);
    result.title = text || "(user input)";

  } else if (direction === "gateway->model") {
    const model = first.model || "unknown";
    const msgs = Array.isArray(first.messages) ? first.messages : [];
    const lastUser = lastUserMessage(msgs);
    result.title = lastUser || "(api request)";
    result.meta.push(`模型: ${model}`);
    if (msgs.length > 0) result.meta.push(`消息数: ${msgs.length}`);
    if (first.max_tokens) result.meta.push(`max_tokens: ${first.max_tokens}`);

    const sys = first.system;
    let sysText = "";
    if (typeof sys === "string") sysText = sys;
    else if (Array.isArray(sys)) sysText = sys.map(s => (isObj(s) ? s.text : "") || "").filter(Boolean).join("\n");
    if (sysText) result.fields.push({ label: "system prompt", value: sysText, long: true });
    for (const m of msgs) {
      if (!isObj(m)) continue;
      const text = extractTextFromContent(m.content);
      if (!text) continue;
      result.fields.push({ label: `[${m.role || "?"}]`, value: text, long: true });
    }

  } else if (direction === "model->gateway") {
    const merged = mergeModelStreamEvents(events);
    result.title = merged.text || (merged.reasoning ? `[thinking] ${merged.reasoning}` : "(model response)");
    if (merged.usage) {
      result.meta.push(`input: ${fmt(merged.usage.input)}`);
      result.meta.push(`output: ${fmt(merged.usage.output)}`);
      result.meta.push(`total: ${fmt(merged.usage.total)}`);
    }
    if (typeof ts === "number" && typeof tsEnd === "number") {
      const dur = tsEnd - ts;
      if (dur > 0) result.meta.push(`耗时: ${fmt(dur)}ms`);
    }
    result.meta.push(`events: ${events.length}`);
    if (merged.toolCalls.length > 0) {
      result.lines.push(`[tool calls] ${merged.toolCalls.map(tc => tc.name).join(", ")}`);
    }
    if (merged.text) result.fields.push({ label: "回复内容", value: merged.text, long: true });
    if (merged.reasoning) result.fields.push({ label: "推理过程", value: merged.reasoning, long: true });
    if (merged.toolCalls.length > 0) {
      for (const tc of merged.toolCalls) {
        result.fields.push({ label: `工具调用: ${tc.name}`, value: tc.args || "(no args)", long: true });
      }
    }

  } else if (direction === "gateway->tool" || direction === "tool->gateway") {
    const toolName = first.tool || first.name || "unknown";
    result.title = `工具: ${toolName}`;
    if (first.tool_call_id) result.meta.push(`call_id: ${first.tool_call_id}`);
    if (first.duration_ms) result.meta.push(`耗时: ${fmt(first.duration_ms)}ms`);

  } else if (direction === "gateway->ui") {
    let text = last.text || extractResponseText(last) || extractTextFromContent(last.content) || "";
    result.title = text || "(final output)";

  } else {
    result.title = direction;
  }

  return result;
}

// --------------- rendering ---------------

function renderBlockCard(summary, compact) {
  const { config, ts, title, lines, meta, fields } = summary;
  const card = document.createElement("div");
  card.className = `stage-card ${config.css}` + (compact ? " stage-compact" : "");

  const header = document.createElement("div");
  header.className = "stage-header";
  const labelEl = document.createElement("span");
  labelEl.className = "stage-label";
  const dot = document.createElement("span");
  dot.className = "stage-dot";
  labelEl.appendChild(dot);
  labelEl.appendChild(document.createTextNode(config.label));
  const timeEl = document.createElement("span");
  timeEl.className = "stage-time";
  timeEl.textContent = formatTs(ts);
  header.appendChild(labelEl);
  header.appendChild(timeEl);
  card.appendChild(header);

  const body = document.createElement("div");
  body.className = "stage-body";

  const titleEl = document.createElement("pre");
  titleEl.className = "stage-text";
  const allText = [title, ...lines].filter(Boolean).join("\n");
  titleEl.textContent = allText;
  body.appendChild(titleEl);

  if (meta.length > 0) {
    const metaRow = document.createElement("div");
    metaRow.className = "stage-meta-row";
    for (const tag of meta) {
      const span = document.createElement("span");
      span.className = "stage-meta-tag";
      span.textContent = tag;
      metaRow.appendChild(span);
    }
    body.appendChild(metaRow);
  }

  if (fields.length > 0) {
    const details = document.createElement("details");
    details.className = "stage-expand";
    const summary = document.createElement("summary");
    summary.textContent = `展开详情 (${fields.length} 项)`;
    details.appendChild(summary);
    const table = document.createElement("div");
    table.className = "stage-fields";
    for (const f of fields) {
      const row = document.createElement("div");
      row.className = "stage-field-row" + (f.long ? " stage-field-long" : "");
      const lbl = document.createElement("span");
      lbl.className = "stage-field-label";
      lbl.textContent = f.label;
      const val = document.createElement("span");
      val.className = "stage-field-value";
      val.textContent = f.value;
      row.appendChild(lbl);
      row.appendChild(val);
      table.appendChild(row);
    }
    details.appendChild(table);
    body.appendChild(details);
  }

  card.appendChild(body);
  return card;
}

function renderInternalArrow() {
  const el = document.createElement("div");
  el.className = "internal-arrow";
  el.textContent = "\u25BC";
  return el;
}

// --------------- LCM diagnostics rendering ---------------

const LCM_STAGE_LABELS = {
  bootstrap_entry: "Bootstrap 开始",
  bootstrap_import: "Bootstrap 导入",
  bootstrap_result: "Bootstrap 结果",
  afterTurn_entry: "afterTurn 回调",
  ingest: "消息持久化",
  assemble_skip: "Assemble 跳过",
  leaf_pass_detail: "叶子压缩详情",
  compact_skip: "压缩跳过",
  compact_phase: "压缩阶段",
  compact_result: "压缩结果",
  assemble_input: "原始消息输入",
  compaction_evaluate: "压缩决策",
  leaf_summary: "叶子摘要",
  dag_aggregate: "DAG 聚合摘要",
  context_assemble: "上下文组装",
  assemble_output: "最终输出",
};

const LCM_STAGE_ORDER = [
  "bootstrap_entry", "bootstrap_import", "bootstrap_result",
  "assemble_skip", "assemble_input", "compaction_evaluate", "leaf_summary",
  "dag_aggregate", "context_assemble", "assemble_output",
  "afterTurn_entry", "ingest",
];

const LCM_SKIP_STAGES = new Set(["assemble_called"]);

const _lcmClaimed = new Set();
const _lcmTraceAssignment = new Map();

function resetLcmClaimed() { _lcmClaimed.clear(); _lcmTraceAssignment.clear(); }

function preAssignLcmToTraces(allTraces) {
  _lcmTraceAssignment.clear();
  if (!state.lcmDiagnostics || state.lcmDiagnostics.length === 0) return;

  const PRE_HTTP = new Set([
    "bootstrap_entry", "bootstrap_import", "bootstrap_result",
    "assemble_skip", "assemble_input", "context_assemble", "assemble_output",
  ]);

  const traceWindows = allTraces.map((trace, idx) => {
    const events = trace?.events || [];
    if (events.length === 0) return null;
    const start = events[0]?.ts || 0;
    const end = events[events.length - 1]?.ts || start;
    return { idx, start, end };
  }).filter(Boolean);
  if (traceWindows.length === 0) return;

  for (let li = 0; li < state.lcmDiagnostics.length; li++) {
    const entry = state.lcmDiagnostics[li];
    const t = entry.ts;
    if (typeof t !== "number") continue;
    const isPre = PRE_HTTP.has(entry.stage);

    let bestIdx = -1;
    let bestDist = Infinity;
    for (const tw of traceWindows) {
      if (isPre) {
        if (t >= tw.start - 10000 && t <= tw.end + 5000) {
          const dist = Math.abs(t - tw.start);
          if (dist < bestDist) { bestDist = dist; bestIdx = tw.idx; }
        }
      } else {
        if (t >= tw.start - 5000 && t <= tw.end + 15000) {
          const dist = Math.abs(t - tw.end);
          if (dist < bestDist) { bestDist = dist; bestIdx = tw.idx; }
        }
      }
    }
    if (bestIdx < 0) {
      for (const tw of traceWindows) {
        const ref = isPre ? tw.start : tw.end;
        const dist = Math.abs(t - ref);
        if (dist < bestDist) { bestDist = dist; bestIdx = tw.idx; }
      }
    }
    if (bestIdx >= 0) _lcmTraceAssignment.set(li, bestIdx);
  }
}

function preAssignLcmToMergedGroups(mergedGroups) {
  _lcmTraceAssignment.clear();
  if (!state.lcmDiagnostics || state.lcmDiagnostics.length === 0) return;

  const PRE_HTTP = new Set([
    "bootstrap_entry", "bootstrap_import", "bootstrap_result",
    "assemble_skip", "assemble_input", "context_assemble", "assemble_output",
  ]);

  const groupWindows = mergedGroups.map((group, idx) => {
    const events = group?.events || [];
    if (events.length === 0) return null;
    const start = events[0]?.ts || 0;
    const end = events[events.length - 1]?.ts || start;
    return { idx, start, end };
  }).filter(Boolean);
  if (groupWindows.length === 0) return;

  for (let li = 0; li < state.lcmDiagnostics.length; li++) {
    const entry = state.lcmDiagnostics[li];
    const t = entry.ts;
    if (typeof t !== "number") continue;
    const isPre = PRE_HTTP.has(entry.stage);

    let bestIdx = -1;
    let bestDist = Infinity;
    for (const gw of groupWindows) {
      if (isPre) {
        if (t >= gw.start - 10000 && t <= gw.end + 5000) {
          const dist = Math.abs(t - gw.start);
          if (dist < bestDist) { bestDist = dist; bestIdx = gw.idx; }
        }
      } else {
        if (t >= gw.start - 5000 && t <= gw.end + 15000) {
          const dist = Math.abs(t - gw.end);
          if (dist < bestDist) { bestDist = dist; bestIdx = gw.idx; }
        }
      }
    }
    if (bestIdx < 0) {
      for (const gw of groupWindows) {
        const ref = isPre ? gw.start : gw.end;
        const dist = Math.abs(t - ref);
        if (dist < bestDist) { bestDist = dist; bestIdx = gw.idx; }
      }
    }
    if (bestIdx >= 0) _lcmTraceAssignment.set(li, bestIdx);
  }
}

function findLcmEntriesForRound(roundTs, roundEndTs, traceIdx) {
  if (!state.lcmDiagnostics || state.lcmDiagnostics.length === 0) return [];
  if (typeof roundTs !== "number") return [];
  const endTs = typeof roundEndTs === "number" ? roundEndTs : roundTs + 60000;

  return state.lcmDiagnostics.filter((e, idx) => {
    if (LCM_SKIP_STAGES.has(e.stage)) return false;
    if (_lcmTraceAssignment.size > 0 && typeof traceIdx === "number") {
      return _lcmTraceAssignment.get(idx) === traceIdx;
    }
    if (_lcmClaimed.has(idx)) return false;
    const t = e.ts;
    return typeof t === "number" && t >= roundTs - 5000 && t <= endTs + 10000;
  }).map((e) => {
    if (_lcmTraceAssignment.size === 0) {
      const idx = state.lcmDiagnostics.indexOf(e);
      _lcmClaimed.add(idx);
    }
    return e;
  }).sort((a, b) => {
    const ai = LCM_STAGE_ORDER.indexOf(a.stage);
    const bi = LCM_STAGE_ORDER.indexOf(b.stage);
    if (ai !== bi) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    return (a.ts || 0) - (b.ts || 0);
  });
}

function renderLcmStep(entry) {
  const step = document.createElement("div");
  step.className = "lcm-step";

  const header = document.createElement("div");
  header.className = "lcm-step-header";
  const stageLabel = document.createElement("span");
  stageLabel.className = "lcm-step-stage";
  let stageLabelText = LCM_STAGE_LABELS[entry.stage] || entry.stage;
  if (entry._leafPassNum) stageLabelText = `第 ${entry._leafPassNum} 次叶子压缩`;
  stageLabel.textContent = stageLabelText;
  const timeLabel = document.createElement("span");
  timeLabel.className = "lcm-step-time";
  timeLabel.textContent = formatTs(entry.ts);
  header.appendChild(stageLabel);
  header.appendChild(timeLabel);
  step.appendChild(header);

  const body = document.createElement("div");
  body.className = "lcm-step-body";
  const d = entry.data || {};

  const kvPairs = [];

  if (entry.stage === "bootstrap_entry") {
    kvPairs.push(["会话文件", d.sessionFile || ""]);

  } else if (entry.stage === "bootstrap_import") {
    kvPairs.push(["导入消息数", d.importedMessages]);
    kvPairs.push(["总 tokens", fmt(d.totalTokens)]);

  } else if (entry.stage === "bootstrap_result") {
    kvPairs.push(["是否导入", d.bootstrapped ? "是" : "否"]);
    kvPairs.push(["导入消息数", d.importedMessages]);
    if (d.reason) kvPairs.push(["原因", d.reason]);

  } else if (entry.stage === "assemble_skip") {
    kvPairs.push(["原因", d.reason || "unknown"]);
    kvPairs.push(["原始消息数", d.messagesCount]);
    if (d.contextItemsCount != null) kvPairs.push(["context items", d.contextItemsCount]);
    if (d.tokenBudget) kvPairs.push(["tokenBudget", fmt(d.tokenBudget)]);
    if (d.evictableTokens != null) kvPairs.push(["可清除 tokens", fmt(d.evictableTokens)]);

  } else if (entry.stage === "afterTurn_entry") {
    kvPairs.push(["总消息数", d.totalMessages]);
    kvPairs.push(["新消息数", d.newMessageCount]);
    kvPairs.push(["prePrompt 消息数", d.prePromptMessageCount]);
    kvPairs.push(["是否 heartbeat", d.isHeartbeat ? "是" : "否"]);
    if (d.hasAutoCompactionSummary) kvPairs.push(["包含自动压缩摘要", "是"]);

  } else if (entry.stage === "ingest") {
    kvPairs.push(["角色", d.role || "?"]);
    kvPairs.push(["序号", d.seq]);
    kvPairs.push(["tokens", fmt(d.tokenCount)]);
    if (d.contentPreview) kvPairs.push(["内容", d.contentPreview]);

  } else if (entry.stage === "assemble_input") {
    kvPairs.push(["消息数", d.messagesCount]);
    kvPairs.push(["输入 tokens", fmt(d.inputTokenEstimate)]);
    kvPairs.push(["token 预算", fmt(d.tokenBudget)]);
    kvPairs.push(["含摘要", d.hasSummaryItems ? "是" : "否"]);

  } else if (entry.stage === "compaction_evaluate") {
    kvPairs.push(["当前 tokens", fmt(d.currentTokens)]);
    kvPairs.push(["tokenBudget", fmt(d.tokenBudget)]);
    kvPairs.push(["contextThreshold", d.contextThreshold]);
    kvPairs.push(["压缩阈值", `${fmt(d.threshold)} (${((d.contextThreshold || 0) * 100).toFixed(1)}%)`]);
    kvPairs.push(["需要压缩", d.shouldCompact ? "是" : "否"]);
    if (d.reason && d.reason !== "none") kvPairs.push(["原因", d.reason]);

  } else if (entry.stage === "leaf_pass_detail") {
    kvPairs.push(["输入消息数", d.inputMessageCount]);
    kvPairs.push(["输入 tokens", fmt(d.inputTokens)]);
    if (d.leafChunkTokens) kvPairs.push(["leafChunkTokens 阈值", fmt(d.leafChunkTokens)]);
    kvPairs.push(["输出 tokens", fmt(d.outputTokens)]);
    const saved = (d.inputTokens || 0) - (d.outputTokens || 0);
    if (saved > 0) kvPairs.push(["节省", `${fmt(saved)} tokens`, true]);
    if (d.level) kvPairs.push(["级别", d.level]);

  } else if (entry.stage === "compact_skip") {
    kvPairs.push(["原因", d.reason || ""]);
    kvPairs.push(["当前 tokens", fmt(d.tokensBefore)]);
    if (d.threshold) kvPairs.push(["阈值", fmt(d.threshold)]);

  } else if (entry.stage === "compact_phase") {
    kvPairs.push(["阶段", d.phase === "leaf" ? "叶子压缩" : "聚合压缩"]);
    kvPairs.push(["状态", d.status === "no_chunks" ? "无可压缩数据" : "无聚合候选"]);
    kvPairs.push(["原因", d.reason || ""]);
    if (d.currentTokens) kvPairs.push(["当前 tokens", fmt(d.currentTokens)]);
    if (d.threshold) kvPairs.push(["阈值", fmt(d.threshold)]);

  } else if (entry.stage === "compact_result") {
    kvPairs.push(["是否执行", d.actionTaken ? "是" : "否"]);
    kvPairs.push(["压缩前", fmt(d.tokensBefore)]);
    kvPairs.push(["压缩后", fmt(d.tokensAfter)]);
    const saved = d.tokensSaved || 0;
    if (saved > 0) kvPairs.push(["节省", `${fmt(saved)} tokens`, true]);
    if (d.condensed) kvPairs.push(["含聚合", "是"]);

  } else if (entry.stage === "leaf_summary") {
    kvPairs.push(["压缩前", fmt(d.tokensBefore)]);
    kvPairs.push(["压缩后", fmt(d.tokensAfter)]);
    const saved = d.tokensSaved || 0;
    const pct = d.savingPct || 0;
    kvPairs.push(["节省", `${fmt(saved)} tokens (-${pct}%)`, saved > 0]);

  } else if (entry.stage === "dag_aggregate") {
    kvPairs.push(["聚合前", fmt(d.tokensBefore)]);
    kvPairs.push(["聚合后", fmt(d.tokensAfter)]);
    const saved = d.tokensSaved || 0;
    const pct = d.savingPct || 0;
    kvPairs.push(["节省", `${fmt(saved)} tokens (-${pct}%)`, saved > 0]);
    if (d.level) kvPairs.push(["级别", d.level]);

  } else if (entry.stage === "context_assemble") {
    kvPairs.push(["原始消息", d.rawMessageCount]);
    kvPairs.push(["摘要条数", d.summaryCount]);
    kvPairs.push(["尾部 tokens", fmt(d.tailTokens)]);
    kvPairs.push(["可驱逐 tokens", fmt(d.evictableTokens)]);
    kvPairs.push(["预估 tokens", fmt(d.estimatedTokens)]);

  } else if (entry.stage === "assemble_output") {
    kvPairs.push(["输出消息数", d.outputMessagesCount]);
    kvPairs.push(["预估 tokens", fmt(d.estimatedTokens)]);
    kvPairs.push(["原始 tokens", fmt(d.inputTokenEstimate)]);
    const saved = d.tokensSaved || 0;
    const pct = d.savingPct || 0;
    kvPairs.push(["总节省", `${fmt(saved)} tokens (-${pct}%)`, saved > 0]);

  } else {
    for (const [k, v] of Object.entries(d)) {
      kvPairs.push([k, typeof v === "object" ? JSON.stringify(v) : String(v)]);
    }
  }

  for (const [label, value, isSaving] of kvPairs) {
    const row = document.createElement("div");
    row.className = "lcm-kv";
    const lbl = document.createElement("span");
    lbl.className = "lcm-kv-label";
    lbl.textContent = label;
    const val = document.createElement("span");
    val.className = "lcm-kv-value" + (isSaving ? " lcm-saving" : "");
    val.textContent = String(value ?? "");
    row.appendChild(lbl);
    row.appendChild(val);
    body.appendChild(row);
  }

  // Render message list for stages that have it
  const msgs = d.messages || d.assembledMessages || d.inputMessages;
  if (Array.isArray(msgs) && msgs.length > 0) {
    const msgSection = document.createElement("details");
    msgSection.className = "lcm-messages-section";
    const msgSummary = document.createElement("summary");
    msgSummary.textContent = d.inputMessages
      ? `压缩输入（${msgs.length} 条原始消息）`
      : `消息列表 (${msgs.length} 条)`;
    msgSection.appendChild(msgSummary);
    const msgList = document.createElement("div");
    msgList.className = "lcm-messages-list";
    for (const m of msgs) {
      const msgEl = document.createElement("div");
      msgEl.className = "lcm-msg lcm-msg-" + (m.role || "unknown");
      const roleEl = document.createElement("span");
      roleEl.className = "lcm-msg-role";
      roleEl.textContent = m.role || "?";
      const tokEl = document.createElement("span");
      tokEl.className = "lcm-msg-tokens";
      tokEl.textContent = `${fmt(m.tokens)} tok`;
      const textEl = document.createElement("div");
      textEl.className = "lcm-msg-text";
      textEl.textContent = m.preview || "(empty)";
      msgEl.appendChild(roleEl);
      msgEl.appendChild(tokEl);
      msgEl.appendChild(textEl);
      msgList.appendChild(msgEl);
    }
    msgSection.appendChild(msgList);
    body.appendChild(msgSection);
  }

  // Render summary preview for leaf/dag stages
  const summaryText = d.summaryPreview || d.outputSummary;
  if (summaryText && typeof summaryText === "string") {
    const sumSection = document.createElement("details");
    sumSection.className = "lcm-messages-section";
    const sumTitle = document.createElement("summary");
    sumTitle.textContent = d.outputSummary ? "压缩输出（完整摘要）" : "生成的摘要内容";
    sumSection.appendChild(sumTitle);
    const sumText = document.createElement("pre");
    sumText.className = "lcm-summary-preview";
    sumText.textContent = summaryText;
    sumSection.appendChild(sumText);
    body.appendChild(sumSection);
  }

  step.appendChild(body);
  return step;
}

function renderAssembleMsgList(msgs) {
  const list = document.createElement("div");
  list.className = "lcm-messages-list";
  for (const m of msgs) {
    const el = document.createElement("div");
    const kind = m.kind || "raw";
    el.className = "lcm-msg lcm-msg-" + (m.role || "unknown") + (kind === "summary" ? " lcm-msg-summary" : "");
    const roleEl = document.createElement("span");
    roleEl.className = "lcm-msg-role";
    roleEl.textContent = (kind === "summary" ? "\u2702 " : "") + (m.role || "?");
    const tokEl = document.createElement("span");
    tokEl.className = "lcm-msg-tokens";
    tokEl.textContent = `${fmt(m.tokens)} tok` + (kind === "summary" ? " [\u6458\u8981]" : "");
    const textEl = document.createElement("div");
    textEl.className = "lcm-msg-text";
    textEl.textContent = m.preview || m.content || "(empty)";
    el.appendChild(roleEl);
    el.appendChild(tokEl);
    el.appendChild(textEl);
    list.appendChild(el);
  }
  return list;
}

function renderAssembleCard(assembleEntries) {
  const card = document.createElement("div");
  card.className = "stage-card stage-lcm";
  const header = document.createElement("div");
  header.className = "lcm-step-header";
  const label = document.createElement("span");
  label.className = "lcm-step-stage";
  label.textContent = "Assemble \u4e0a\u4e0b\u6587\u7ec4\u88c5";
  const timeLabel = document.createElement("span");
  timeLabel.className = "lcm-step-time";
  timeLabel.textContent = formatTs(assembleEntries[0]?.ts);
  header.appendChild(label);
  header.appendChild(timeLabel);
  card.appendChild(header);
  const body = document.createElement("div");
  body.className = "lcm-step-body";

  const inputEntry = assembleEntries.find(e => e.stage === "assemble_input");
  const contextEntry = assembleEntries.find(e => e.stage === "context_assemble");
  const outputEntry = assembleEntries.find(e => e.stage === "assemble_output");

  const aiD = inputEntry?.data || {};
  const caD = contextEntry?.data || {};
  const aoD = outputEntry?.data || {};
  const budget = aiD.tokenBudget || caD.tokenBudget || 0;
  const inputTok = aiD.inputTokenEstimate || 0;
  const outputTok = aoD.estimatedTokens || caD.estimatedTokens || 0;
  const saved = aoD.tokensSaved || 0;
  const savePct = aoD.savingPct || 0;
  const rawCount = caD.rawMessageCount || 0;
  const sumCount = caD.summaryCount || 0;
  const budgetPct = budget > 0 ? ((outputTok / budget) * 100).toFixed(1) : "?";
  const sumPanel = document.createElement("div");
  sumPanel.className = "lcm-assemble-summary";
  const summaryKvs = [
    ["tokenBudget", fmt(budget)],
    ["\u8f93\u5165 tokens", fmt(inputTok) + " (\u6570\u5b8c\u6574\u6d88\u606f JSON)"],
    ["\u7ec4\u88c5\u540e tokens", fmt(outputTok) + " (\u6570 content JSON\uff0c\u5360\u9884\u7b97 " + budgetPct + "%)"],
  ];
  if (saved > 0) summaryKvs.push(["\u8282\u7701", fmt(saved) + " tokens (-" + savePct + "%)"]);
  summaryKvs.push(["\u6d88\u606f\u7ec4\u6210", rawCount + " \u539f\u6587 + " + sumCount + " \u6458\u8981"]);
  for (const [k, v] of summaryKvs) {
    const row = document.createElement("div");
    row.className = "lcm-kv";
    const rl = document.createElement("span"); rl.className = "lcm-kv-label"; rl.textContent = k;
    const rv = document.createElement("span"); rv.className = "lcm-kv-value" + (k.includes("\u8282\u7701") ? " lcm-saving" : ""); rv.textContent = v;
    row.appendChild(rl); row.appendChild(rv); sumPanel.appendChild(row);
  }
  const jsonOverhead = inputTok - outputTok;
  const noteLines = [
    "\u2139 token \u8ba1\u6570\u8bf4\u660e\uff08\u5168\u90e8\u4e3a \u5b57\u7b26\u6570/4 \u7c97\u4f30\uff09\uff1a",
    "  \u00b7 \u8f93\u5165 " + fmt(inputTok) + " = \u6d88\u606f\u5185\u5bb9 " + fmt(outputTok) + " + JSON \u7ed3\u6784\u5f00\u9500 " + fmt(jsonOverhead),
    "  \u00b7 \u7ec4\u88c5\u540e " + fmt(outputTok) + " = \u6570 content JSON (\u5982 [{\"type\":\"text\",\"text\":\"...\"}])",
    "  \u00b7 \u6d88\u606f\u5217\u8868 tok = \u6570\u7eaf\u6587\u672c\uff0c\u4e0d\u542b JSON \u5305\u88c5\uff0c\u6240\u4ee5\u504f\u5c0f",
  ];
  const note = document.createElement("div");
  note.className = "lcm-assemble-note";
  note.textContent = noteLines.join("\n");
  note.style.whiteSpace = "pre-wrap";
  sumPanel.appendChild(note);
  body.appendChild(sumPanel);

  if (inputEntry) {
    const d = inputEntry.data || {};
    const section = document.createElement("details");
    section.className = "lcm-messages-section";
    const sum = document.createElement("summary");
    const inputMsgs = d.messages || [];
    const inputMsgTokens = inputMsgs.reduce((s, m) => s + (m.tokens || 0), 0);
    sum.textContent = "\u{1f4e5} \u5386\u53f2\u4e0a\u4e0b\u6587\u6d88\u606f\uff08" + (d.messagesCount||0) + " \u6761\uff0c" + fmt(inputMsgTokens) + " tok\uff09";
    section.appendChild(sum);
    const meta = document.createElement("div");
    meta.className = "lcm-kv";
    const estRow = document.createElement("div"); estRow.className = "lcm-kv";
    const estL = document.createElement("span"); estL.className = "lcm-kv-label"; estL.textContent = "inputTokenEstimate";
    const estV = document.createElement("span"); estV.className = "lcm-kv-value"; estV.textContent = fmt(d.inputTokenEstimate) + " (含开销)";
    estRow.appendChild(estL); estRow.appendChild(estV); section.appendChild(estRow);
    const ml = document.createElement("span"); ml.className = "lcm-kv-label"; ml.textContent = "tokenBudget";
    const mv = document.createElement("span"); mv.className = "lcm-kv-value"; mv.textContent = fmt(d.tokenBudget);
    meta.appendChild(ml); meta.appendChild(mv);
    section.appendChild(meta);
    if (d.hasSummaryItems) {
      const m2 = document.createElement("div"); m2.className = "lcm-kv";
      const m2l = document.createElement("span"); m2l.className = "lcm-kv-label"; m2l.textContent = "\u542b\u6458\u8981";
      const m2v = document.createElement("span"); m2v.className = "lcm-kv-value"; m2v.textContent = "\u662f";
      m2.appendChild(m2l); m2.appendChild(m2v); section.appendChild(m2);
    }
    const msgs = d.messages || [];
    if (msgs.length > 0) section.appendChild(renderAssembleMsgList(msgs));
    body.appendChild(section);
  }

  if (contextEntry) {
    const d = contextEntry.data || {};
    const section = document.createElement("details");
    section.className = "lcm-messages-section";
    const sc = d.summaryCount||0, rc = d.rawMessageCount||0, fc = d.freshTailCount||0;
    const sum = document.createElement("summary");
    const asmMsgs = d.assembledMessages || [];
    const asmTokSum = asmMsgs.reduce((s, m) => s + (m.tokens || 0), 0);
    sum.textContent = "\u{1f527} LCM \u7ec4\u88c5\u7ed3\u679c\uff08raw=" + rc + ", summaries=" + sc + ", freshTail=" + fc + ", " + fmt(asmTokSum) + " tok\uff09";
    section.appendChild(sum);
    const kvs = [
      ["\u539f\u59cb\u6d88\u606f", rc], ["\u6458\u8981\u6761\u6570", sc],
      ["\u4fdd\u62a4\u5c3e\u90e8", fc], ["\u5c3e\u90e8 tokens", fmt(d.tailTokens)],
      ["estimatedTokens", fmt(d.estimatedTokens) + " (\u6570 content JSON)"], ["tokenBudget", fmt(d.tokenBudget)]
    ];
    for (const [k, v] of kvs) {
      const row = document.createElement("div"); row.className = "lcm-kv";
      const rl = document.createElement("span"); rl.className = "lcm-kv-label"; rl.textContent = k;
      const rv = document.createElement("span"); rv.className = "lcm-kv-value"; rv.textContent = String(v??"");
      row.appendChild(rl); row.appendChild(rv); section.appendChild(row);
    }
    const asm = d.assembledMessages || [];
    if (asm.length > 0) section.appendChild(renderAssembleMsgList(asm));
    body.appendChild(section);
  }

  if (outputEntry) {
    const d = outputEntry.data || {};
    const section = document.createElement("details");
    section.className = "lcm-messages-section";
    const sum = document.createElement("summary");
    const outMsgs = d.messages || [];
    const outTokSum = outMsgs.reduce((s, m) => s + (m.tokens || 0), 0);
    sum.textContent = "\u{1f4e4} \u7ec4\u88c5\u8f93\u51fa\uff08" + (d.outputMessagesCount||0) + " \u6761\uff0c" + fmt(outTokSum) + " tok\uff09";
    section.appendChild(sum);
    if (d.estimatedTokens) {
      const etRow = document.createElement("div"); etRow.className = "lcm-kv";
      const etL = document.createElement("span"); etL.className = "lcm-kv-label"; etL.textContent = "estimatedTokens";
      const etV = document.createElement("span"); etV.className = "lcm-kv-value"; etV.textContent = fmt(d.estimatedTokens) + " (\u6570 content JSON)";
      etRow.appendChild(etL); etRow.appendChild(etV); section.appendChild(etRow);
    }
    const saved = d.tokensSaved || 0;
    if (saved > 0) {
      const row = document.createElement("div"); row.className = "lcm-kv";
      const rl = document.createElement("span"); rl.className = "lcm-kv-label"; rl.textContent = "\u8282\u7701";
      const rv = document.createElement("span"); rv.className = "lcm-kv-value lcm-saving"; rv.textContent = fmt(saved) + " tokens (-" + (d.savingPct||0) + "%)";
      row.appendChild(rl); row.appendChild(rv); section.appendChild(row);
    }
    const msgs = d.messages || [];
    if (msgs.length > 0) section.appendChild(renderAssembleMsgList(msgs));
    body.appendChild(section);
  }

  card.appendChild(body);
  return card;
}
function renderIngestBatchCard(entries) {
  const card = document.createElement("div");
  card.className = "stage-card stage-lcm";

  const header = document.createElement("div");
  header.className = "lcm-step-header";
  const stageLabel = document.createElement("span");
  stageLabel.className = "lcm-step-stage";
  stageLabel.textContent = `ingestBatch (${entries.length} 条消息持久化)`;
  const timeLabel = document.createElement("span");
  timeLabel.className = "lcm-step-time";
  timeLabel.textContent = formatTs(entries[0]?.ts);
  header.appendChild(stageLabel);
  header.appendChild(timeLabel);
  card.appendChild(header);

  const body = document.createElement("div");
  body.className = "lcm-step-body";

  const totalTokens = entries.reduce((s, e) => s + (e.data?.tokenCount || 0), 0);
  const metaRow = document.createElement("div");
  metaRow.className = "lcm-kv";
  const metaLabel = document.createElement("span");
  metaLabel.className = "lcm-kv-label";
  metaLabel.textContent = "总 tokens";
  const metaVal = document.createElement("span");
  metaVal.className = "lcm-kv-value";
  metaVal.textContent = fmt(totalTokens);
  metaRow.appendChild(metaLabel);
  metaRow.appendChild(metaVal);
  body.appendChild(metaRow);

  const msgList = document.createElement("div");
  msgList.className = "lcm-messages-list";
  for (const e of entries) {
    const d = e.data || {};
    const msgEl = document.createElement("div");
    msgEl.className = "lcm-msg lcm-msg-" + (d.role || "unknown");
    const roleEl = document.createElement("span");
    roleEl.className = "lcm-msg-role";
    roleEl.textContent = d.role || "?";
    const tokEl = document.createElement("span");
    tokEl.className = "lcm-msg-tokens";
    tokEl.textContent = `seq=${d.seq || "?"} ${fmt(d.tokenCount)} tok`;
    const textEl = document.createElement("div");
    textEl.className = "lcm-msg-text";
    textEl.textContent = d.contentPreview || "(empty)";
    msgEl.appendChild(roleEl);
    msgEl.appendChild(tokEl);
    msgEl.appendChild(textEl);
    msgList.appendChild(msgEl);
  }
  body.appendChild(msgList);
  card.appendChild(body);
  return card;
}

function renderLcmAsCard(entry) {
  const card = document.createElement("div");
  card.className = "stage-card stage-lcm";
  const step = renderLcmStep(entry);
  for (const child of [...step.children]) card.appendChild(child);
  return card;
}

function renderRound(roundBlocks, roundIndex, traceIdx) {
  const container = document.createElement("section");
  container.className = "round";

  const startTs = roundBlocks[0]?.events?.[0]?.ts;
  const lastBlock = roundBlocks[roundBlocks.length - 1];
  const endTs = lastBlock?.events?.[lastBlock.events.length - 1]?.ts;
  let durText = "";
  if (typeof startTs === "number" && typeof endTs === "number") {
    durText = ` (${fmt(endTs - startTs)}ms)`;
  }
  const roundHeader = document.createElement("div");
  roundHeader.className = "round-header";
  roundHeader.textContent = `第 ${roundIndex + 1} 轮${durText}`;
  container.appendChild(roundHeader);

  // Synthesize user block if missing
  let userBlock = roundBlocks[0]?.direction === "user->gateway" ? roundBlocks[0] : null;
  const allBlocks = roundBlocks.filter(b => b !== userBlock);
  if (!userBlock) {
    const firstModel = allBlocks.find(b => b.direction === "gateway->model");
    if (firstModel) {
      const p = firstModel.events[0]?.payload_full || {};
      const msgs = Array.isArray(p.messages) ? p.messages : [];
      const userText = lastUserMessage(msgs);
      if (userText) {
        userBlock = {
          direction: "user->gateway",
          events: [{ ts: firstModel.events[0]?.ts, payload_full: { text: userText }, direction: "user->gateway" }],
        };
      }
    }
  }

  // Collect LCM entries for this round
  const roundStartTs = roundBlocks[0]?.events?.[0]?.ts;
  const roundEndTs = endTs;
  const lcmEntries = findLcmEntriesForRound(roundStartTs, roundEndTs, traceIdx);

  // Split LCM entries by semantic phase
  const PRE_HTTP_STAGES = new Set([
    "bootstrap_entry", "bootstrap_import", "bootstrap_result",
    "assemble_skip", "assemble_input", "context_assemble", "assemble_output",
  ]);
  const preLcm = lcmEntries.filter(e => PRE_HTTP_STAGES.has(e.stage));
  const postLcm = lcmEntries.filter(e => !PRE_HTTP_STAGES.has(e.stage));

  // Build unified timeline by semantic order
  const timeline = [];

  // 1. User input
  if (userBlock) {
    timeline.push({ type: "http", block: userBlock });
  }

  // 2. Pre-HTTP LCM (bootstrap, assemble)
  const assembleGroup = preLcm.filter(e => ["assemble_input","context_assemble","assemble_output"].includes(e.stage));
  const otherPreLcm = preLcm.filter(e => !["assemble_input","context_assemble","assemble_output"].includes(e.stage));
  for (const le of otherPreLcm) {
    timeline.push({ type: "lcm", entry: le });
  }
  if (assembleGroup.length > 0) {
    timeline.push({ type: "assemble_group", entries: assembleGroup });
  }

  // 3. HTTP blocks (gateway->model, model->gateway, tool calls)
  for (const block of allBlocks) {
    if (block.direction === "gateway->ui") continue;
    timeline.push({ type: "http", block });
  }

  // 4. Post-HTTP LCM (afterTurn, ingest, compaction) — sorted by timestamp
  // Merge consecutive ingest entries into one ingestBatch entry
  const postLcmSorted = [...postLcm].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  let ingestGroup = [];
  for (const le of postLcmSorted) {
    if (le.stage === "ingest") {
      ingestGroup.push(le);
    } else {
      if (ingestGroup.length > 0) {
        timeline.push({ type: "lcm_batch", entries: ingestGroup });
        ingestGroup = [];
      }
      timeline.push({ type: "lcm", entry: le });
    }
  }
  if (ingestGroup.length > 0) {
    timeline.push({ type: "lcm_batch", entries: ingestGroup });
  }

  // 5. Output block
  let outputBlock = roundBlocks[roundBlocks.length - 1]?.direction === "gateway->ui"
    ? roundBlocks[roundBlocks.length - 1] : null;
  if (!outputBlock) {
    const lastModel = [...allBlocks].reverse().find(b => b.direction === "model->gateway");
    if (lastModel) {
      const merged = mergeModelStreamEvents(lastModel.events);
      if (merged.text) {
        outputBlock = {
          direction: "gateway->ui",
          events: [{ ts: lastModel.events[lastModel.events.length - 1]?.ts, payload_full: { text: merged.text }, direction: "gateway->ui" }],
        };
      }
    }
  }
  if (outputBlock) {
    timeline.push({ type: "http", block: outputBlock });
  }

  // Render unified timeline
  let leafPassCount = 0;
  for (let i = 0; i < timeline.length; i++) {
    const item = timeline[i];
    if (item.type === "lcm") {
      if (item.entry.stage === "leaf_pass_detail") {
        leafPassCount++;
        item.entry = { ...item.entry, _leafPassNum: leafPassCount };
      }
      container.appendChild(renderLcmAsCard(item.entry));
    } else if (item.type === "assemble_group") {
      container.appendChild(renderAssembleCard(item.entries));
    } else if (item.type === "lcm_batch") {
      container.appendChild(renderIngestBatchCard(item.entries));
    } else {
      const summary = buildBlockSummary(item.block);
      const isMiddle = item.block.direction !== "user->gateway" && item.block.direction !== "gateway->ui";
      container.appendChild(renderBlockCard(summary, isMiddle));
    }
    if (i < timeline.length - 1) {
      container.appendChild(renderInternalArrow());
    }
  }

  return container;
}

// --------------- timeline / session ---------------

function isLcmInternalTrace(trace) {
  if (!isObj(trace) || !Array.isArray(trace.events)) return false;
  for (const e of trace.events) {
    if (e?.direction !== "gateway->model") continue;
    const p = e?.payload_full;
    if (!isObj(p)) continue;
    const sys = p.system;
    let sysText = "";
    if (typeof sys === "string") sysText = sys;
    else if (Array.isArray(sys)) {
      for (const s of sys) {
        if (isObj(s) && typeof s.text === "string") { sysText = s.text; break; }
      }
    }
    if (sysText.includes("You summarize a SEGMENT") || sysText.includes("context-compaction summarization engine")) return true;
    const msgs = p.messages;
    if (Array.isArray(msgs) && msgs.length > 0) {
      const firstContent = extractTextFromContent(msgs[0]?.content);
      if (firstContent.includes("You summarize a SEGMENT")) return true;
    }
  }
  return false;
}

function buildVisibleTimeline(timeline) {
  const ordered = [...timeline].sort((a, b) => {
    const tsA = typeof a?.start_ts === "number" ? a.start_ts : 0;
    const tsB = typeof b?.start_ts === "number" ? b.start_ts : 0;
    return tsB - tsA;
  });
  if (ordered.length > 0) return { list: ordered, note: `共 ${ordered.length} 条会话` };
  return { list: [], note: "暂无会话数据。" };
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

function selectedTimelineItem() {
  return state.visibleTimeline.find(i => String(i.trace_id) === String(state.selectedTraceId)) || null;
}

function renderSessionList() {
  const container = getElement("session-list");
  if (!container) return;
  container.replaceChildren();
  if (state.visibleTimeline.length === 0) {
    const empty = document.createElement("div");
    empty.className = "panel-empty";
    empty.textContent = "没有可展示的会话。";
    container.appendChild(empty);
    return;
  }
  for (const trace of state.visibleTimeline) {
    const cached = state.traceCache[String(trace.trace_id)];
    const isInternal = cached && isLcmInternalTrace(cached);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "session-item"
      + (String(trace.trace_id) === String(state.selectedTraceId) ? " is-selected" : "")
      + (isInternal ? " session-internal" : "");
    const title = document.createElement("div");
    title.className = "session-title";
    title.textContent = (isInternal ? "[LCM 内部] " : "") + `trace ${trace.trace_id} | ${trace.event_count || 0} events`;
    const sub = document.createElement("div");
    sub.className = "session-subtitle";
    sub.textContent = formatTs(trace.start_ts);
    btn.appendChild(title);
    btn.appendChild(sub);
    btn.addEventListener("click", () => void selectTrace(trace.trace_id));
    container.appendChild(btn);
  }
}

function renderSessionMeta() {
  const container = getElement("session-meta");
  if (!container) return;
  container.replaceChildren();
  const item = selectedTimelineItem();
  if (!item) {
    const empty = document.createElement("div");
    empty.className = "panel-empty";
    empty.textContent = "请选择左侧会话查看对话流向。";
    container.appendChild(empty);
    return;
  }
  const pills = [
    `trace ${item.trace_id}`,
    `${item.event_count || 0} events`,
    item.completeness || "",
    `${formatTs(item.start_ts)} - ${formatTs(item.end_ts)}`,
  ].filter(Boolean);
  for (const text of pills) {
    const pill = document.createElement("span");
    pill.className = "meta-pill";
    pill.textContent = text;
    container.appendChild(pill);
  }
}

function mergeAdjacentTraces(traces) {
  if (traces.length <= 1) return traces;

  // Find afterTurn timestamps — these mark round boundaries
  const afterTurnTimestamps = state.lcmDiagnostics
    .filter(e => e.stage === "afterTurn_entry")
    .map(e => e.ts)
    .sort((a, b) => a - b);

  function hasAfterTurnBetween(tsA, tsB) {
    return afterTurnTimestamps.some(at => at > tsA && at < tsB);
  }

  const merged = [];
  let current = { events: [...(traces[0]?.events || [])], sourceIndices: [0] };

  for (let i = 1; i < traces.length; i++) {
    const prev = traces[i - 1];
    const cur = traces[i];
    const prevEnd = prev?.events?.[prev.events.length - 1]?.ts || 0;
    const curStart = cur?.events?.[0]?.ts || 0;
    const gap = curStart - prevEnd;

    // Merge if: gap < 5s AND no afterTurn event between them
    // (afterTurn marks end of a user turn, so a new turn starts after it)
    if (gap < 5000 && gap >= 0 && !hasAfterTurnBetween(prevEnd, curStart)) {
      current.events.push(...(cur.events || []));
      current.sourceIndices.push(i);
    } else {
      merged.push(current);
      current = { events: [...(cur?.events || [])], sourceIndices: [i] };
    }
  }
  merged.push(current);
  return merged;
}

function renderSingleTrace(container, trace, roundOffset, traceIdx) {
  if (!isObj(trace) || !Array.isArray(trace.events) || trace.events.length === 0) return 0;
  const blocks = groupIntoBlocks(trace.events);
  const rounds = groupBlocksIntoRounds(blocks);
  for (let i = 0; i < rounds.length; i++) {
    container.appendChild(renderRound(rounds[i], roundOffset + i, traceIdx));
  }
  return rounds.length;
}

function renderFlow() {
  const container = getElement("flow-list");
  if (!container) return;
  container.replaceChildren();
  resetLcmClaimed();

  if (state.showAllMode && state.allTraces.length > 0) {
    const mergedGroups = mergeAdjacentTraces(state.allTraces);
    // Pre-assign LCM entries to merged groups
    preAssignLcmToMergedGroups(mergedGroups);
    let roundIdx = 0;
    for (let g = 0; g < mergedGroups.length; g++) {
      const group = mergedGroups[g];
      const count = renderSingleTrace(container, group, roundIdx, g);
      roundIdx += count;
    }
    if (roundIdx === 0) {
    const empty = document.createElement("div");
    empty.className = "panel-empty";
      empty.textContent = "暂无对话数据。";
    container.appendChild(empty);
    }
    return;
  }

  const trace = state.selectedTrace;
  if (!isObj(trace) || !Array.isArray(trace.events) || trace.events.length === 0) {
    const empty = document.createElement("div");
    empty.className = "panel-empty";
    empty.textContent = state.showAllMode ? "正在加载..." : "暂无对话数据。";
    container.appendChild(empty);
    return;
  }

  renderSingleTrace(container, trace, 0);
}

function renderAll() {
  renderSessionList();
  renderSessionMeta();
  renderFlow();
  setText("session-filter-note", state.filterNote);
}

async function refreshLcmDiagnostics() {
  try {
    const data = await fetchJson("/api/lcm-diagnostics");
    state.lcmDiagnostics = Array.isArray(data) ? data : [];
  } catch {
    // keep existing
  }
}

async function selectTrace(traceId) {
  state.showAllMode = false;
  state.allTraces = [];
  const showBtn = getElement("show-all-button");
  if (showBtn) showBtn.classList.remove("is-active");

  state.selectedTraceId = String(traceId);
  await refreshLcmDiagnostics();
  const cached = state.traceCache[state.selectedTraceId];
  if (cached) { state.selectedTrace = cached; renderAll(); return; }
  const token = ++state.loadingToken;
  state.selectedTrace = null;
  renderAll();
  try {
    const trace = await fetchJson(`/api/trace/${traceId}`);
    if (token !== state.loadingToken) return;
    state.traceCache[state.selectedTraceId] = trace;
    state.selectedTrace = trace;
    setHidden("error-state", true);
  } catch (_) {
    if (token !== state.loadingToken) return;
    state.selectedTrace = null;
    setHidden("error-state", false);
  }
  renderAll();
}

async function loadTimelineAndSelect() {
  try {
    const [timeline, lcmDiag] = await Promise.all([
      fetchJson("/api/timeline"),
      fetchJson("/api/lcm-diagnostics").catch(() => []),
    ]);
    if (!Array.isArray(timeline)) throw new Error("bad data");
    state.timeline = timeline;
    state.lcmDiagnostics = Array.isArray(lcmDiag) ? lcmDiag : [];
    const visible = buildVisibleTimeline(timeline);
    state.visibleTimeline = visible.list;
    state.filterNote = visible.note;
    setText("last-refresh-time", `刷新: ${new Date().toLocaleTimeString()}`);
    setHidden("error-state", true);
    if (state.visibleTimeline.length === 0) {
      state.selectedTraceId = null; state.selectedTrace = null; renderAll(); return;
    }
    const still = state.visibleTimeline.some(i => String(i.trace_id) === String(state.selectedTraceId));
    const nextId = still && state.selectedTraceId !== null ? state.selectedTraceId : state.visibleTimeline[0].trace_id;
    await selectTrace(nextId);
  } catch (_) {
    state.timeline = []; state.visibleTimeline = [];
    state.selectedTraceId = null; state.selectedTrace = null;
    state.filterNote = "加载失败。"; setHidden("error-state", false); renderAll();
  }
}

async function showAllTraces() {
  state.showAllMode = true;
    state.selectedTraceId = null;
    state.selectedTrace = null;
  await refreshLcmDiagnostics();

  const btn = getElement("show-all-button");
  if (btn) btn.classList.add("is-active");

  const metaContainer = getElement("session-meta");
  if (metaContainer) {
    metaContainer.replaceChildren();
    const pill = document.createElement("span");
    pill.className = "meta-pill";
    pill.textContent = `全量视图: ${state.visibleTimeline.length} 条 trace`;
    metaContainer.appendChild(pill);
  }

  const sorted = [...state.visibleTimeline].sort((a, b) => {
    const tsA = typeof a?.start_ts === "number" ? a.start_ts : 0;
    const tsB = typeof b?.start_ts === "number" ? b.start_ts : 0;
    return tsA - tsB;
  });

  const allTraces = [];
  let skipped = 0;
  for (const item of sorted) {
    const id = String(item.trace_id);
    let trace;
    if (state.traceCache[id]) {
      trace = state.traceCache[id];
    } else {
      try {
        trace = await fetchJson(`/api/trace/${id}`);
        state.traceCache[id] = trace;
      } catch {
        continue;
      }
    }
    if (isLcmInternalTrace(trace)) {
      skipped++;
      continue;
    }
    allTraces.push(trace);
  }

  state.allTraces = allTraces;
  if (skipped > 0) {
    const pill2 = document.createElement("span");
    pill2.className = "meta-pill";
    pill2.textContent = `已过滤 ${skipped} 条 LCM 内部请求`;
    if (metaContainer) metaContainer.appendChild(pill2);
  }
  renderSessionList();
  renderFlow();
}

async function exitShowAll() {
  state.showAllMode = false;
  state.allTraces = [];
  const btn = getElement("show-all-button");
  if (btn) btn.classList.remove("is-active");
  if (state.visibleTimeline.length > 0) {
    await selectTrace(state.visibleTimeline[0].trace_id);
  } else {
    renderAll();
  }
}

const refreshBtn = getElement("refresh-button");
if (refreshBtn) refreshBtn.addEventListener("click", () => void loadTimelineAndSelect());

const showAllBtn = getElement("show-all-button");
if (showAllBtn) {
  showAllBtn.addEventListener("click", () => {
    if (state.showAllMode) {
      void exitShowAll();
    } else {
      void showAllTraces();
    }
  });
}

void loadTimelineAndSelect();
