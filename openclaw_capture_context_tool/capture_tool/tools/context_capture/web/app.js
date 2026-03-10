const state = {
  timeline: [],
  visibleTimeline: [],
  filterNote: "",
  selectedTraceId: null,
  selectedTrace: null,
  traceCache: {},
  loadingToken: 0,
};

function getElement(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const element = getElement(id);
  if (element) {
    element.textContent = value;
  }
}

function setHidden(id, hidden) {
  const element = getElement(id);
  if (element) {
    element.hidden = hidden;
  }
}

function formatTimestamp(ts) {
  if (typeof ts !== "number") {
    return "—";
  }
  return new Date(ts).toLocaleString();
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function eventPayload(event) {
  return isObject(event?.payload_full) ? event.payload_full : {};
}

function formatFlowLabel(event) {
  const label = typeof event?.flow_label === "string" && event.flow_label
    ? event.flow_label
    : (typeof event?.flow_stage === "string" && event.flow_stage
      ? event.flow_stage
      : (typeof event?.direction === "string" && event.direction ? event.direction : "unknown"));

  const labelMap = {
    "USER->openclaw": "user->openclaw",
    "OPENCLAW->model": "openclaw->model",
    "OPENCLAW->model (api_request)": "openclaw->model (api_request)",
    "OPENCLAW->model (internal_ctx)": "openclaw->model (internal_ctx)",
    "MODEL->openclaw": "model->openclaw",
    "MODEL->openclaw (api_response)": "model->openclaw (api_response)",
    "MODEL->openclaw (internal_ctx)": "model->openclaw (internal_ctx)",
    "OPENCLAW->user": "openclaw->user",
    "OPENCLAW->tool": "openclaw->tool",
    "TOOL->openclaw": "tool->openclaw",
    "user->gateway": "user->openclaw",
    "gateway->model": "openclaw->model",
    "model->gateway": "model->openclaw",
    "gateway->ui": "openclaw->user",
    "gateway->tool": "openclaw->tool",
    "tool->gateway": "tool->openclaw",
  };
  return labelMap[label] || label;
}

function isModelToOpenclawEvent(event) {
  return event?.flow_stage === "MODEL->openclaw" || event?.direction === "model->gateway";
}

function isOpenclawToToolEvent(event) {
  return event?.flow_stage === "OPENCLAW->tool" || event?.direction === "gateway->tool";
}

function isToolToOpenclawEvent(event) {
  return event?.flow_stage === "TOOL->openclaw" || event?.direction === "tool->gateway";
}

function toolCallKey(event) {
  const payload = eventPayload(event);
  if (typeof payload.tool_call_id === "string" && payload.tool_call_id) {
    return payload.tool_call_id;
  }
  if (typeof payload.run_id === "string" && payload.run_id) {
    return payload.run_id;
  }
  return null;
}

function isMatchingToolEnd(startEvent, endEvent) {
  if (!isOpenclawToToolEvent(startEvent) || !isToolToOpenclawEvent(endEvent)) {
    return false;
  }

  const startKey = toolCallKey(startEvent);
  const endKey = toolCallKey(endEvent);
  if (startKey && endKey) {
    return startKey === endKey;
  }

  const startPayload = eventPayload(startEvent);
  const endPayload = eventPayload(endEvent);
  return (
    typeof startPayload.tool === "string"
    && startPayload.tool
    && typeof endPayload.tool === "string"
    && endPayload.tool
    && startPayload.tool === endPayload.tool
  );
}

function getModelEventFlowId(event) {
  const payload = event?.payload_full;
  if (isObject(payload) && typeof payload.request_flow_id === "string" && payload.request_flow_id) {
    return payload.request_flow_id;
  }
  return null;
}

function getModelEventTypeName(event) {
  const payload = event?.payload_full;
  if (isObject(payload) && typeof payload.type === "string" && payload.type) {
    return payload.type;
  }
  if (typeof event?.event_type === "string" && event.event_type) {
    return event.event_type;
  }
  return "unknown";
}

function appendText(parts, value) {
  if (typeof value === "string" && value) {
    parts.push(value);
  }
}

function extractPayloadTextBlocks(payload) {
  const blocks = [];
  if (!isObject(payload)) {
    return blocks;
  }

  appendText(blocks, payload.delta);
  appendText(blocks, payload.response_text);
  appendText(blocks, payload.text);

  const output = payload.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!isObject(item)) {
        continue;
      }
      appendText(blocks, item.text);
      if (!Array.isArray(item.content)) {
        continue;
      }
      for (const contentItem of item.content) {
        if (!isObject(contentItem)) {
          continue;
        }
        appendText(blocks, contentItem.text);
      }
    }
  }

  return blocks;
}

function pickToolCallIdentity(toolCall, index) {
  const callIndex = Number.isInteger(toolCall?.index) ? toolCall.index : index;
  if (typeof toolCall?.id === "string" && toolCall.id) {
    return `id:${toolCall.id}`;
  }
  return `index:${callIndex}`;
}

function extractModelDeltaParts(payload) {
  const assistantParts = [];
  const reasoningParts = [];
  const toolCalls = new Map();

  if (!isObject(payload)) {
    return { assistantParts, reasoningParts, toolCalls };
  }

  for (const block of extractPayloadTextBlocks(payload)) {
    appendText(assistantParts, block);
  }

  const choices = payload.choices;
  if (!Array.isArray(choices)) {
    return { assistantParts, reasoningParts, toolCalls };
  }

  for (const choice of choices) {
    if (!isObject(choice)) {
      continue;
    }
    const delta = choice.delta;
    if (!isObject(delta)) {
      continue;
    }

    appendText(assistantParts, delta.content);
    appendText(reasoningParts, delta.reasoning_content);

    const deltaToolCalls = delta.tool_calls;
    if (!Array.isArray(deltaToolCalls)) {
      continue;
    }

    for (const [index, toolCall] of deltaToolCalls.entries()) {
      if (!isObject(toolCall)) {
        continue;
      }
      const identity = pickToolCallIdentity(toolCall, index);
      const current = toolCalls.get(identity) || {
        id: typeof toolCall.id === "string" ? toolCall.id : null,
        index: Number.isInteger(toolCall.index) ? toolCall.index : index,
        name: null,
        argumentsParts: [],
      };

      if (typeof toolCall.id === "string" && toolCall.id) {
        current.id = toolCall.id;
      }
      const fn = isObject(toolCall.function) ? toolCall.function : null;
      if (fn && typeof fn.name === "string" && fn.name) {
        current.name = fn.name;
      }
      if (fn && typeof fn.arguments === "string" && fn.arguments) {
        current.argumentsParts.push(fn.arguments);
      }
      toolCalls.set(identity, current);
    }
  }

  return { assistantParts, reasoningParts, toolCalls };
}

function buildMergedModelEvent(group) {
  const first = group[0];
  const last = group[group.length - 1];

  const typeCounter = new Map();
  const assistantParts = [];
  const reasoningParts = [];
  const mergedToolCalls = new Map();
  let flowId = null;

  for (const event of group) {
    const typeName = getModelEventTypeName(event);
    typeCounter.set(typeName, (typeCounter.get(typeName) || 0) + 1);

    const payload = event?.payload_full;
    if (isObject(payload) && typeof payload.request_flow_id === "string" && payload.request_flow_id) {
      flowId = flowId || payload.request_flow_id;
    }

    const parts = extractModelDeltaParts(payload);
    for (const part of parts.assistantParts) {
      appendText(assistantParts, part);
    }
    for (const part of parts.reasoningParts) {
      appendText(reasoningParts, part);
    }
    for (const [key, value] of parts.toolCalls.entries()) {
      const current = mergedToolCalls.get(key) || {
        id: value.id || null,
        index: value.index,
        name: value.name || null,
        argumentsParts: [],
      };
      if (!current.id && value.id) {
        current.id = value.id;
      }
      if (!current.name && value.name) {
        current.name = value.name;
      }
      if (Array.isArray(value.argumentsParts) && value.argumentsParts.length > 0) {
        current.argumentsParts.push(...value.argumentsParts);
      }
      mergedToolCalls.set(key, current);
    }
  }

  const mergedAssistantText = assistantParts.join("");
  const mergedReasoningText = reasoningParts.join("");
  const toolCallList = [...mergedToolCalls.values()]
    .sort((a, b) => a.index - b.index)
    .map((item) => ({
      id: item.id,
      index: item.index,
      name: item.name || "unknown",
      arguments: item.argumentsParts.join(""),
    }));
  const typeSummary = [...typeCounter.entries()]
    .map(([name, count]) => `${name} x${count}`)
    .join(", ");

  const startTs = first?.ts;
  const endTs = last?.ts;
  const duration = typeof startTs === "number" && typeof endTs === "number"
    ? `${Math.max(0, endTs - startTs)} ms`
    : "unknown";
  const eventCount = group.length;
  const summaryLine = `[merged stream] events=${eventCount}, duration=${duration}${flowId ? `, flow=${flowId}` : ""}`;
  const toolSummary = toolCallList.length > 0
    ? `[tool calls] ${toolCallList.map((item) => `${item.name}${item.id ? `(${item.id})` : ""}`).join(", ")}`
    : "";

  const previewSource = mergedAssistantText || mergedReasoningText || toolSummary;
  const preview = previewSource
    ? previewSource.slice(0, 160)
    : `${summaryLine}${typeSummary ? `, types: ${typeSummary}` : ""}`;

  const fullSections = [];
  if (mergedAssistantText) {
    fullSections.push(`[assistant output]\n${mergedAssistantText}`);
  }
  if (mergedReasoningText) {
    fullSections.push(`[assistant reasoning]\n${mergedReasoningText}`);
  }
  if (toolCallList.length > 0) {
    const toolText = toolCallList.map((item) => {
      const lines = [`name: ${item.name}`, `index: ${item.index}`];
      if (item.id) {
        lines.push(`id: ${item.id}`);
      }
      if (item.arguments) {
        lines.push(`arguments: ${item.arguments}`);
      }
      return lines.join(" | ");
    }).join("\n");
    fullSections.push(`[tool calls]\n${toolText}`);
  }
  fullSections.push(summaryLine);
  if (typeSummary) {
    fullSections.push(`types: ${typeSummary}`);
  }

  return {
    ...first,
    event_type: "model_stream_group",
    flow_label: `${first?.flow_label || "model->openclaw"} (merged ${eventCount})`,
    content_preview: preview,
    content_full: fullSections.join("\n\n"),
    payload_full: {
      merged_stream: true,
      request_flow_id: flowId,
      event_count: eventCount,
      start_ts: startTs,
      end_ts: endTs,
      merged_text: mergedAssistantText,
      merged_reasoning_text: mergedReasoningText,
      tool_calls: toolCallList,
      event_type_counts: Object.fromEntries(typeCounter),
    },
  };
}

function buildMergedToolCallEvent(startEvent, endEvent) {
  const startPayload = eventPayload(startEvent);
  const endPayload = eventPayload(endEvent);
  const toolName = typeof startPayload.tool === "string" && startPayload.tool
    ? startPayload.tool
    : (typeof endPayload.tool === "string" ? endPayload.tool : "unknown");
  const callId = typeof startPayload.tool_call_id === "string" && startPayload.tool_call_id
    ? startPayload.tool_call_id
    : (typeof endPayload.tool_call_id === "string" ? endPayload.tool_call_id : null);
  const runId = typeof startPayload.run_id === "string" && startPayload.run_id
    ? startPayload.run_id
    : (typeof endPayload.run_id === "string" ? endPayload.run_id : null);

  const startTs = typeof startEvent?.ts === "number" ? startEvent.ts : null;
  const endTs = typeof endEvent?.ts === "number" ? endEvent.ts : null;
  const duration = (startTs !== null && endTs !== null) ? Math.max(0, endTs - startTs) : null;
  const previewParts = [`tool=${toolName}`];
  if (callId) {
    previewParts.push(`call=${callId}`);
  }
  if (duration !== null) {
    previewParts.push(`duration=${duration} ms`);
  }

  return {
    ...startEvent,
    event_type: "tool_call_group",
    flow_stage: "OPENCLAW->tool",
    flow_label: "openclaw->tool",
    content_preview: previewParts.join(", "),
    content_full: [
      "[merged tool call]",
      `tool: ${toolName}`,
      callId ? `tool_call_id: ${callId}` : null,
      runId ? `run_id: ${runId}` : null,
      startTs !== null ? `start_ts: ${startTs}` : null,
      endTs !== null ? `end_ts: ${endTs}` : null,
      duration !== null ? `duration_ms: ${duration}` : null,
    ].filter(Boolean).join("\n"),
    payload_full: {
      merged_tool_call: true,
      tool: toolName,
      tool_call_id: callId,
      run_id: runId,
      start_ts: startTs,
      end_ts: endTs,
      duration_ms: duration,
      start_event: startPayload,
      end_event: endPayload,
    },
    ts: startTs ?? endTs ?? startEvent?.ts,
    ts_iso: startEvent?.ts_iso || endEvent?.ts_iso || null,
  };
}

function mergeFlowTimelineEvents(events) {
  const merged = [];
  let modelGroup = [];
  let groupFlowId = null;

  const flushModelGroup = () => {
    if (modelGroup.length === 0) {
      return;
    }
    merged.push(modelGroup.length === 1 ? modelGroup[0] : buildMergedModelEvent(modelGroup));
    modelGroup = [];
    groupFlowId = null;
  };

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!isModelToOpenclawEvent(event)) {
      flushModelGroup();
      if (isOpenclawToToolEvent(event) && index + 1 < events.length) {
        const nextEvent = events[index + 1];
        if (isMatchingToolEnd(event, nextEvent)) {
          merged.push(buildMergedToolCallEvent(event, nextEvent));
          index += 1;
          continue;
        }
      }
      merged.push(event);
      continue;
    }

    const flowId = getModelEventFlowId(event);
    if (modelGroup.length === 0) {
      modelGroup.push(event);
      groupFlowId = flowId;
      continue;
    }

    if (groupFlowId && flowId && groupFlowId !== flowId) {
      flushModelGroup();
      modelGroup.push(event);
      groupFlowId = flowId;
      continue;
    }
    if (!groupFlowId && flowId) {
      groupFlowId = flowId;
    }
    modelGroup.push(event);
  }

  flushModelGroup();
  return merged;
}

function buildVisibleTimeline(timeline) {
  const ordered = [...timeline].sort((a, b) => {
    const tsA = typeof a?.start_ts === "number" ? a.start_ts : 0;
    const tsB = typeof b?.start_ts === "number" ? b.start_ts : 0;
    return tsB - tsA;
  });

  if (ordered.length > 0) {
    return {
      list: ordered,
      note: `当前显示全部会话，共 ${ordered.length} 条。`,
    };
  }

  return {
    list: [],
    note: "暂无会话数据。",
  };
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

function selectedTimelineItem() {
  return state.visibleTimeline.find((item) => String(item.trace_id) === String(state.selectedTraceId)) || null;
}

function renderSessionList() {
  const container = getElement("session-list");
  if (!container) {
    return;
  }
  container.replaceChildren();

  if (state.visibleTimeline.length === 0) {
    const empty = document.createElement("div");
    empty.className = "panel-empty";
    empty.textContent = "没有可展示的会话。";
    container.appendChild(empty);
    return;
  }

  for (const trace of state.visibleTimeline) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "session-item";
    button.classList.toggle("is-selected", String(trace.trace_id) === String(state.selectedTraceId));

    const title = document.createElement("div");
    title.className = "session-title";
    title.textContent = `trace ${trace.trace_id} | ${trace.event_count || 0} events`;

    const subtitle = document.createElement("div");
    subtitle.className = "session-subtitle";
    subtitle.textContent = `开始: ${formatTimestamp(trace.start_ts)}`;

    button.appendChild(title);
    button.appendChild(subtitle);
    button.addEventListener("click", () => {
      void selectTrace(trace.trace_id);
    });

    container.appendChild(button);
  }
}

function renderSessionMeta() {
  const container = getElement("session-meta");
  if (!container) {
    return;
  }
  container.replaceChildren();

  const selectedItem = selectedTimelineItem();
  if (!selectedItem) {
    const empty = document.createElement("div");
    empty.className = "panel-empty";
    empty.textContent = "请选择左侧会话查看抓包内容。";
    container.appendChild(empty);
    return;
  }

  const metaRows = [
    `trace ${selectedItem.trace_id}`,
    `${selectedItem.event_count || 0} events`,
    `${selectedItem.correlation_confidence || "unknown"} confidence`,
    `${selectedItem.completeness || "unknown"} completeness`,
    `start ${formatTimestamp(selectedItem.start_ts)}`,
    `end ${formatTimestamp(selectedItem.end_ts)}`,
  ];

  for (const row of metaRows) {
    const pill = document.createElement("span");
    pill.className = "meta-pill";
    pill.textContent = row;
    container.appendChild(pill);
  }
}

function renderFlow() {
  const container = getElement("flow-list");
  if (!container) {
    return;
  }
  container.replaceChildren();

  if (!isObject(state.selectedTrace) || !Array.isArray(state.selectedTrace.events)) {
    const empty = document.createElement("div");
    empty.className = "panel-empty";
    empty.textContent = "暂无会话详情。";
    container.appendChild(empty);
    return;
  }

  const events = mergeFlowTimelineEvents(state.selectedTrace.events);
  if (events.length === 0) {
    const empty = document.createElement("div");
    empty.className = "panel-empty";
    empty.textContent = "该会话没有可展示事件。";
    container.appendChild(empty);
    return;
  }

  for (const event of events) {
    const item = document.createElement("article");
    item.className = "flow-item";

    const header = document.createElement("header");
    header.className = "flow-header";

    const label = document.createElement("span");
    label.className = "flow-label";
    label.textContent = formatFlowLabel(event);

    const time = document.createElement("span");
    time.className = "flow-time";
    time.textContent = event?.ts_iso || formatTimestamp(event?.ts);

    header.appendChild(label);
    header.appendChild(time);

    const preview = document.createElement("pre");
    preview.className = "flow-preview";
    preview.textContent = typeof event?.content_preview === "string"
      ? event.content_preview
      : "(no content)";

    const details = document.createElement("details");
    details.className = "flow-details";
    const summary = document.createElement("summary");
    summary.textContent = "展开查看完整内容";
    const full = document.createElement("pre");
    full.className = "flow-full";
    full.textContent = typeof event?.content_full === "string"
      ? event.content_full
      : JSON.stringify(event?.payload_full ?? null, null, 2);

    details.appendChild(summary);
    details.appendChild(full);

    item.appendChild(header);
    item.appendChild(preview);
    item.appendChild(details);
    container.appendChild(item);
  }
}

function renderAll() {
  renderSessionList();
  renderSessionMeta();
  renderFlow();
  setText("session-filter-note", state.filterNote);
}

async function selectTrace(traceId) {
  state.selectedTraceId = String(traceId);
  const cacheHit = state.traceCache[state.selectedTraceId];
  if (cacheHit) {
    state.selectedTrace = cacheHit;
    renderAll();
    return;
  }

  const token = state.loadingToken + 1;
  state.loadingToken = token;
  state.selectedTrace = null;
  renderAll();

  try {
    const trace = await fetchJson(`/api/trace/${traceId}`);
    if (token !== state.loadingToken) {
      return;
    }
    state.traceCache[state.selectedTraceId] = trace;
    state.selectedTrace = trace;
    setHidden("error-state", true);
  } catch (_error) {
    if (token !== state.loadingToken) {
      return;
    }
    state.selectedTrace = null;
    setHidden("error-state", false);
  }
  renderAll();
}

async function loadTimelineAndSelect() {
  try {
    const timeline = await fetchJson("/api/timeline");
    if (!Array.isArray(timeline)) {
      throw new Error("invalid timeline payload");
    }

    state.timeline = timeline;
    const visible = buildVisibleTimeline(timeline);
    state.visibleTimeline = visible.list;
    state.filterNote = visible.note;
    setText("last-refresh-time", `最近刷新: ${new Date().toLocaleTimeString()}`);
    setHidden("error-state", true);

    if (state.visibleTimeline.length === 0) {
      state.selectedTraceId = null;
      state.selectedTrace = null;
      renderAll();
      return;
    }

    const stillExists = state.visibleTimeline.some(
      (item) => String(item.trace_id) === String(state.selectedTraceId),
    );
    const nextId = stillExists && state.selectedTraceId !== null
      ? state.selectedTraceId
      : state.visibleTimeline[0].trace_id;
    await selectTrace(nextId);
  } catch (_error) {
    state.timeline = [];
    state.visibleTimeline = [];
    state.selectedTraceId = null;
    state.selectedTrace = null;
    state.filterNote = "加载失败。";
    setHidden("error-state", false);
    renderAll();
  }
}

function bindEvents() {
  const refreshButton = getElement("refresh-button");
  if (refreshButton) {
    refreshButton.addEventListener("click", () => {
      void loadTimelineAndSelect();
    });
  }
}

bindEvents();
void loadTimelineAndSelect();
