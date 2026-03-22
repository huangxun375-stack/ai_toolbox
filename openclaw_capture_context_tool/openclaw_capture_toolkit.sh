#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

load_env_defaults() {
  local env_file="$1"
  [[ -f "$env_file" ]] || return 0

  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue

    line="${line#"${line%%[![:space:]]*}"}"
    if [[ "$line" == export[[:space:]]* ]]; then
      line="${line#export }"
    fi

    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      local key="${BASH_REMATCH[1]}"
      local value="${BASH_REMATCH[2]}"
      if [[ -z "${ENV_LOCKED_KEYS[$key]+x}" ]]; then
        set +u
        eval "export $key=$value"
        set -u
      fi
    fi
  done < "$env_file"
}

declare -A ENV_LOCKED_KEYS=()
while IFS= read -r key; do
  ENV_LOCKED_KEYS["$key"]=1
done < <(compgen -e)

ENV_FILE="${TOOLKIT_ENV_FILE:-$SCRIPT_DIR/.env}"
load_env_defaults "$ENV_FILE"

STATE_DIR="${STATE_DIR:-$SCRIPT_DIR/.state}"
PID_DIR="$STATE_DIR/pids"

if [[ -f "$SCRIPT_DIR/capture_tool/tools/context_capture/api.py" ]]; then
  DEFAULT_CAPTURE_TOOL_DIR="$SCRIPT_DIR/capture_tool"
  DEFAULT_CAPTURE_DATA_DIR="$SCRIPT_DIR/data/context_capture_live"
else
  DEFAULT_CAPTURE_TOOL_DIR="$REPO_ROOT/.worktrees/context-capture-tool"
  DEFAULT_CAPTURE_DATA_DIR="$DEFAULT_CAPTURE_TOOL_DIR/data/context_capture_live"
fi

CAPTURE_TOOL_DIR="${CAPTURE_TOOL_DIR:-$DEFAULT_CAPTURE_TOOL_DIR}"
CAPTURE_DATA_DIR="${CAPTURE_DATA_DIR:-$DEFAULT_CAPTURE_DATA_DIR}"

MITM_HOST="${MITM_HOST:-127.0.0.1}"
MITM_PORT="${MITM_PORT:-18080}"
CAPTURE_API_HOST="${CAPTURE_API_HOST:-0.0.0.0}"
CAPTURE_API_PORT="${CAPTURE_API_PORT:-8000}"
MITMDUMP_BIN="${MITMDUMP_BIN:-$(command -v mitmdump || true)}"
CAPTURE_API_PYTHON="${CAPTURE_API_PYTHON:-}"
CONTEXT_CAPTURE_HTTP_URL_PREFIX="${CONTEXT_CAPTURE_HTTP_URL_PREFIX:-}"
MITM_LOG="${MITM_LOG:-$STATE_DIR/mitmdump.log}"
API_LOG="${API_LOG:-$STATE_DIR/context_capture_api.log}"
GATEWAY_LOG="${GATEWAY_LOG:-$STATE_DIR/openclaw_gateway_capture.log}"

CAPTURE_API_URL="${CAPTURE_API_URL:-}"
CAPTURE_PROXY_URL="${CAPTURE_PROXY_URL:-}"
GATEWAY_BASE_URL="${GATEWAY_BASE_URL:-http://127.0.0.1:28789}"
OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"
GATEWAY_TOKEN="${GATEWAY_TOKEN:-${OPENCLAW_GATEWAY_TOKEN:-}}"
OPENCLAW_GATEWAY_BIND="${OPENCLAW_GATEWAY_BIND:-loopback}"

if [[ -n "${OPENCLAW_BIN:-}" ]]; then
  OPENCLAW_BIN="$OPENCLAW_BIN"
elif command -v openclaw >/dev/null 2>&1; then
  OPENCLAW_BIN="openclaw"
else
  OPENCLAW_BIN=""
fi

REQUEST_MODEL="${REQUEST_MODEL:-gpt-4.1-mini}"
REQUEST_PROMPT="${REQUEST_PROMPT:-请只回复: OK}"
REQUEST_TIMEOUT="${REQUEST_TIMEOUT:-120}"
REQUEST_USER="${REQUEST_USER:-capture-tool}"
REQUEST_USE_PROXY="${REQUEST_USE_PROXY:-1}"
EXPORT_OUTPUT="${EXPORT_OUTPUT:-}"
EXPORT_TITLE="${EXPORT_TITLE:-OpenClaw Session Capture Offline Report}"
EXPORT_MAX_TRACES="${EXPORT_MAX_TRACES:-200}"

MITM_PID_FILE="$PID_DIR/mitmdump.pid"
API_PID_FILE="$PID_DIR/capture_api.pid"
GATEWAY_PID_FILE="$PID_DIR/openclaw_gateway_capture.pid"

PROXY_RUN_CMD=()
EXTERNAL_CACHE_TRACE_FILE=""

timestamp() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(timestamp)] $*"; }
die() { echo "[ERROR] $*" >&2; exit 2; }

abs_from_script_dir() {
  local path="$1"
  if [[ "$path" == /* ]]; then
    printf '%s\n' "$path"
  else
    printf '%s/%s\n' "$SCRIPT_DIR" "$path"
  fi
}

normalize_paths() {
  STATE_DIR="$(abs_from_script_dir "$STATE_DIR")"
  PID_DIR="$(abs_from_script_dir "$PID_DIR")"
  CAPTURE_TOOL_DIR="$(abs_from_script_dir "$CAPTURE_TOOL_DIR")"
  CAPTURE_DATA_DIR="$(abs_from_script_dir "$CAPTURE_DATA_DIR")"
  OPENCLAW_CONFIG="$(abs_from_script_dir "$OPENCLAW_CONFIG")"
  MITM_LOG="$(abs_from_script_dir "$MITM_LOG")"
  API_LOG="$(abs_from_script_dir "$API_LOG")"
  GATEWAY_LOG="$(abs_from_script_dir "$GATEWAY_LOG")"
  MITM_PID_FILE="$(abs_from_script_dir "$MITM_PID_FILE")"
  API_PID_FILE="$(abs_from_script_dir "$API_PID_FILE")"
  GATEWAY_PID_FILE="$(abs_from_script_dir "$GATEWAY_PID_FILE")"
}

usage() {
  cat <<'USAGE'
Usage:
  openclaw_capture_toolkit.sh <command> [options]

Commands:
  start           Start mitmdump + capture API
  stop            Stop mitmdump + capture API
  status          Show process status + data stats
  clear           Clear capture data files
  request         Send one HTTP request to OpenClaw (/v1/responses)
  gateway-start   Start managed OpenClaw gateway with proxy/cache-trace env
  gateway-stop    Stop managed OpenClaw gateway
  gateway-status  Show managed OpenClaw gateway status
  up              start + gateway-start (reuse external gateway if already listening)
  down            gateway-stop + stop
  proxy-env       Print export lines for proxy env
  proxy-run       Run one command with proxy env (use: proxy-run -- <cmd...>)
  export-offline  Export current captured data to standalone HTML
  instructions    Print quick usage steps
  setup           Check prerequisites and create Python venv
  diag            Parse and display LCM diagnostics

Options:
  --state-dir PATH
  --capture-tool-dir PATH
  --capture-data-dir PATH
  --mitm-host HOST
  --mitm-port PORT
  --api-host HOST
  --api-port PORT
  --mitmdump-bin PATH
  --capture-api-python PATH
  --http-url-prefix PREFIX
  --mitm-log PATH
  --api-log PATH
  --gateway-log PATH
  --capture-api-url URL
  --capture-proxy-url URL
  --gateway-base-url URL
  --openclaw-config PATH
  --openclaw-bin PATH
  --gateway-token TOKEN
  --gateway-bind loopback|all
  --model MODEL
  --prompt TEXT
  --user USER
  --use-proxy 0|1
  --output PATH
  --title TEXT
  --max-traces N
  --timeout SECONDS
  --session ID       (diag) filter by sessionId
  --stage STAGES     (diag) filter by stage (comma-separated)
  --round N          (diag) show only round N
  --raw              (diag) output raw JSON
  --help
USAGE
}

ensure_state_dirs() {
  mkdir -p "$STATE_DIR" "$PID_DIR" "$CAPTURE_DATA_DIR"
}

pid_running() {
  local pid_file="$1"
  [[ -f "$pid_file" ]] || return 1
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

remove_pid_file() {
  local pid_file="$1"
  rm -f "$pid_file"
}

stop_pid_file() {
  local pid_file="$1"
  local name="$2"
  if ! [[ -f "$pid_file" ]]; then
    log "$name is not running (no pid file)."
    return 0
  fi

  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ -z "$pid" ]]; then
    remove_pid_file "$pid_file"
    log "$name pid file was empty; cleaned."
    return 0
  fi

  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    sleep 1
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
    log "stopped $name pid=$pid"
  else
    log "$name pid=$pid not alive; cleaned pid file."
  fi
  remove_pid_file "$pid_file"
}

status_one() {
  local pid_file="$1"
  local name="$2"
  if pid_running "$pid_file"; then
    local pid
    pid="$(cat "$pid_file")"
    echo "$name: running (pid=$pid)"
  else
    echo "$name: stopped"
  fi
}

file_line_count() {
  local path="$1"
  if [[ -f "$path" ]]; then
    wc -l < "$path" | tr -d ' '
  else
    echo "0"
  fi
}

discover_external_cache_trace_file() {
  EXTERNAL_CACHE_TRACE_FILE=""
  [[ -f "$OPENCLAW_CONFIG" ]] || return 0

  local configured
  configured="$(
    OPENCLAW_CONFIG="$OPENCLAW_CONFIG" python3 - <<'PY'
import json
import os
from pathlib import Path

path = Path(os.environ["OPENCLAW_CONFIG"])
try:
    data = json.loads(path.read_text(encoding="utf-8"))
except Exception:
    print("")
    raise SystemExit(0)

cache_trace = (data.get("diagnostics") or {}).get("cacheTrace") or {}
file_path = cache_trace.get("filePath")
if not isinstance(file_path, str) or not file_path.strip():
    print("")
    raise SystemExit(0)

print(str(Path(file_path.strip()).expanduser().resolve()))
PY
  )"
  if [[ -z "$configured" ]]; then
    return 0
  fi

  local local_cache="$CAPTURE_DATA_DIR/cache-trace.jsonl"
  if [[ "$configured" != "$local_cache" ]]; then
    EXTERNAL_CACHE_TRACE_FILE="$configured"
  fi
}

proxy_env_exports() {
  cat <<EOF
export HTTP_PROXY='$CAPTURE_PROXY_URL'
export HTTPS_PROXY='$CAPTURE_PROXY_URL'
export ALL_PROXY='$CAPTURE_PROXY_URL'
export NO_PROXY=''
export NODE_USE_ENV_PROXY=1
EOF
}

openclaw_bin_exists() {
  [[ -n "$OPENCLAW_BIN" ]] || return 1
  if [[ -f "$OPENCLAW_BIN" ]]; then
    return 0
  fi
  command -v "$OPENCLAW_BIN" >/dev/null 2>&1
}

gateway_port() {
  GATEWAY_BASE_URL="$GATEWAY_BASE_URL" python3 - <<'PY'
import os
from urllib.parse import urlparse

parsed = urlparse(os.environ["GATEWAY_BASE_URL"])
if parsed.port:
    print(parsed.port)
else:
    print(443 if parsed.scheme == "https" else 80)
PY
}

port_is_listening() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn "( sport = :$port )" | grep -q ":$port"
    return $?
  fi

  python3 - "$port" <<'PY'
import socket
import sys

port = int(sys.argv[1])
s = socket.socket()
s.settimeout(0.5)
try:
    rc = s.connect_ex(("127.0.0.1", port))
finally:
    s.close()
raise SystemExit(0 if rc == 0 else 1)
PY
}

listener_pid_for_port() {
  local port="$1"
  if ! command -v ss >/dev/null 2>&1; then
    return 0
  fi
  ss -ltnp "( sport = :$port )" | sed -n 's/.*pid=\([0-9]\+\).*/\1/p' | head -n 1
}

gateway_http_reachable() {
  curl -s --max-time 2 -o /dev/null "$GATEWAY_BASE_URL/" 2>/dev/null
}

wait_gateway_ready() {
  local attempts=0
  while (( attempts < 45 )); do
    if gateway_http_reachable; then
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 1
  done
  return 1
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --state-dir)
        STATE_DIR="$2"
        PID_DIR="$STATE_DIR/pids"
        MITM_LOG="$STATE_DIR/mitmdump.log"
        API_LOG="$STATE_DIR/context_capture_api.log"
        GATEWAY_LOG="$STATE_DIR/openclaw_gateway_capture.log"
        MITM_PID_FILE="$PID_DIR/mitmdump.pid"
        API_PID_FILE="$PID_DIR/capture_api.pid"
        GATEWAY_PID_FILE="$PID_DIR/openclaw_gateway_capture.pid"
        shift 2
        ;;
      --capture-tool-dir) CAPTURE_TOOL_DIR="$2"; shift 2 ;;
      --capture-data-dir) CAPTURE_DATA_DIR="$2"; shift 2 ;;
      --mitm-host) MITM_HOST="$2"; shift 2 ;;
      --mitm-port) MITM_PORT="$2"; shift 2 ;;
      --api-host) CAPTURE_API_HOST="$2"; shift 2 ;;
      --api-port) CAPTURE_API_PORT="$2"; shift 2 ;;
      --mitmdump-bin) MITMDUMP_BIN="$2"; shift 2 ;;
      --capture-api-python) CAPTURE_API_PYTHON="$2"; shift 2 ;;
      --http-url-prefix) CONTEXT_CAPTURE_HTTP_URL_PREFIX="$2"; shift 2 ;;
      --mitm-log) MITM_LOG="$2"; shift 2 ;;
      --api-log) API_LOG="$2"; shift 2 ;;
      --gateway-log) GATEWAY_LOG="$2"; shift 2 ;;
      --capture-api-url) CAPTURE_API_URL="$2"; shift 2 ;;
      --capture-proxy-url) CAPTURE_PROXY_URL="$2"; shift 2 ;;
      --gateway-base-url) GATEWAY_BASE_URL="$2"; shift 2 ;;
      --openclaw-config) OPENCLAW_CONFIG="$2"; shift 2 ;;
      --openclaw-bin) OPENCLAW_BIN="$2"; shift 2 ;;
      --gateway-token) GATEWAY_TOKEN="$2"; shift 2 ;;
      --gateway-bind) OPENCLAW_GATEWAY_BIND="$2"; shift 2 ;;
      --model) REQUEST_MODEL="$2"; shift 2 ;;
      --prompt) REQUEST_PROMPT="$2"; shift 2 ;;
      --user) REQUEST_USER="$2"; shift 2 ;;
      --use-proxy) REQUEST_USE_PROXY="$2"; shift 2 ;;
      --output) EXPORT_OUTPUT="$2"; shift 2 ;;
      --title) EXPORT_TITLE="$2"; shift 2 ;;
      --max-traces) EXPORT_MAX_TRACES="$2"; shift 2 ;;
      --timeout) REQUEST_TIMEOUT="$2"; shift 2 ;;
      --)
        shift
        PROXY_RUN_CMD=("$@")
        break
        ;;
      --session) DIAG_SESSION="$2"; shift 2 ;;
      --stage) DIAG_STAGE="$2"; shift 2 ;;
      --round) DIAG_ROUND="$2"; shift 2 ;;
      --raw) DIAG_RAW=1; shift ;;
      --help|-h) usage; exit 0 ;;
      *) die "unknown argument: $1" ;;
    esac
  done
}

start_stack() {
  ensure_state_dirs

  if [[ -z "$MITMDUMP_BIN" || ! -x "$MITMDUMP_BIN" ]]; then
    die "mitmdump binary not found; set --mitmdump-bin PATH or MITMDUMP_BIN"
  fi
  [[ -f "$CAPTURE_TOOL_DIR/tools/context_capture/proxy_addon.py" ]] || die "missing proxy_addon.py under $CAPTURE_TOOL_DIR"

  if pid_running "$MITM_PID_FILE"; then
    log "mitmdump already running (pid=$(cat "$MITM_PID_FILE"))."
  else
    log "starting mitmdump on ${MITM_HOST}:${MITM_PORT}"
    if [[ -n "$CONTEXT_CAPTURE_HTTP_URL_PREFIX" ]]; then
      nohup env CONTEXT_CAPTURE_HTTP_URL_PREFIX="$CONTEXT_CAPTURE_HTTP_URL_PREFIX" \
        "$MITMDUMP_BIN" \
        -s "$CAPTURE_TOOL_DIR/tools/context_capture/proxy_addon.py" \
        --listen-host "$MITM_HOST" \
        --listen-port "$MITM_PORT" \
        --set context_capture_data_dir="$CAPTURE_DATA_DIR" \
        >"$MITM_LOG" 2>&1 &
    else
      nohup "$MITMDUMP_BIN" \
        -s "$CAPTURE_TOOL_DIR/tools/context_capture/proxy_addon.py" \
        --listen-host "$MITM_HOST" \
        --listen-port "$MITM_PORT" \
        --set context_capture_data_dir="$CAPTURE_DATA_DIR" \
        >"$MITM_LOG" 2>&1 &
    fi
    echo $! > "$MITM_PID_FILE"
    sleep 1
    if ! pid_running "$MITM_PID_FILE"; then
      if grep -qi "address already in use" "$MITM_LOG" 2>/dev/null; then
        die "failed to start mitmdump: ${MITM_HOST}:${MITM_PORT} already in use. Try MITM_PORT=18082 CAPTURE_PROXY_URL=http://${MITM_HOST}:18082"
      fi
      die "failed to start mitmdump, check $MITM_LOG"
    fi
  fi

  local api_python="$CAPTURE_API_PYTHON"
  if [[ -z "$api_python" ]]; then
    api_python="$CAPTURE_TOOL_DIR/.venv/bin/python"
  fi
  if [[ ! -x "$api_python" ]]; then
    api_python="$(command -v python3 || true)"
  fi
  [[ -n "$api_python" ]] || die "python3 not found for capture API"
  [[ -f "$CAPTURE_TOOL_DIR/tools/context_capture/api.py" ]] || die "missing api.py under $CAPTURE_TOOL_DIR"

  if pid_running "$API_PID_FILE"; then
    log "capture API already running (pid=$(cat "$API_PID_FILE"))."
  else
    log "starting capture API on ${CAPTURE_API_HOST}:${CAPTURE_API_PORT}"
    local -a api_extra_env=()
    if [[ -n "$EXTERNAL_CACHE_TRACE_FILE" ]]; then
      api_extra_env+=(CONTEXT_CAPTURE_CACHE_TRACE_FILE="$EXTERNAL_CACHE_TRACE_FILE")
      log "capture API extra cache trace file: $EXTERNAL_CACHE_TRACE_FILE"
    fi
    (
      cd "$CAPTURE_TOOL_DIR"
      nohup env \
        CAPTURE_DATA_DIR="$CAPTURE_DATA_DIR" \
        CAPTURE_API_HOST="$CAPTURE_API_HOST" \
        CAPTURE_API_PORT="$CAPTURE_API_PORT" \
        "${api_extra_env[@]}" \
        "$api_python" -c "import os; from pathlib import Path; import uvicorn; from tools.context_capture.api import create_app; uvicorn.run(create_app(data_dir=Path(os.environ['CAPTURE_DATA_DIR'])), host=os.environ['CAPTURE_API_HOST'], port=int(os.environ['CAPTURE_API_PORT']), log_level='info')" \
        >"$API_LOG" 2>&1 &
      echo $! > "$API_PID_FILE"
    )
    sleep 1
    pid_running "$API_PID_FILE" || die "failed to start capture API, check $API_LOG"
  fi

  log "capture stack ready: proxy=$CAPTURE_PROXY_URL api=$CAPTURE_API_URL"
}

stop_stack() {
  stop_pid_file "$MITM_PID_FILE" "mitmdump"
  stop_pid_file "$API_PID_FILE" "capture API"
}

status_stack() {
  status_one "$MITM_PID_FILE" "mitmdump"
  status_one "$API_PID_FILE" "capture API"
  echo "proxy url: $CAPTURE_PROXY_URL"
  echo "api url: $CAPTURE_API_URL"
  echo "web ui: ${CAPTURE_API_URL%/}/"
  echo "capture data dir: $CAPTURE_DATA_DIR"
  echo "raw.jsonl lines: $(file_line_count "$CAPTURE_DATA_DIR/raw.jsonl")"
  echo "cache-trace.jsonl lines: $(file_line_count "$CAPTURE_DATA_DIR/cache-trace.jsonl")"
  if [[ -n "$EXTERNAL_CACHE_TRACE_FILE" ]]; then
    echo "external cache-trace file: $EXTERNAL_CACHE_TRACE_FILE"
    echo "external cache-trace lines: $(file_line_count "$EXTERNAL_CACHE_TRACE_FILE")"
  fi
}

clear_capture() {
  ensure_state_dirs
  local files=(
    "$CAPTURE_DATA_DIR/raw.jsonl"
    "$CAPTURE_DATA_DIR/cache-trace.jsonl"
    "$CAPTURE_DATA_DIR/gateway.log.jsonl"
  )
  if [[ -n "$EXTERNAL_CACHE_TRACE_FILE" ]]; then
    files+=("$EXTERNAL_CACHE_TRACE_FILE")
  fi
  for file in "${files[@]}"; do
    : > "$file"
    log "cleared $file"
  done
}

read_gateway_token() {
  if [[ -n "${GATEWAY_TOKEN:-}" ]]; then
    printf "%s\n" "$GATEWAY_TOKEN"
    return 0
  fi

  local gateway_pid
  gateway_pid="$(pgrep -f "openclaw-gatewa" | head -n 1 || true)"
  if [[ -n "$gateway_pid" && -r "/proc/$gateway_pid/environ" ]]; then
    local process_token
    process_token="$(
      tr '\0' '\n' < "/proc/$gateway_pid/environ" \
        | awk -F= '/^OPENCLAW_GATEWAY_TOKEN=/{print substr($0, index($0, "=") + 1); exit}'
    )"
    if [[ -n "$process_token" ]]; then
      printf "%s\n" "$process_token"
      return 0
    fi
  fi

  if [[ -f "$OPENCLAW_CONFIG" ]]; then
    OPENCLAW_CONFIG="$OPENCLAW_CONFIG" python3 - <<'PY'
import json
import os

config_path = os.environ["OPENCLAW_CONFIG"]
try:
    with open(config_path, "r", encoding="utf-8") as f:
        data = json.load(f)
except Exception:
    print("")
    raise SystemExit(0)

token = (
    data.get("gateway", {})
    .get("auth", {})
    .get("token", "")
)
print(token if isinstance(token, str) else "")
PY
    return 0
  fi

  echo ""
}

start_gateway_capture() {
  ensure_state_dirs

  local port
  port="$(gateway_port)"

  if pid_running "$GATEWAY_PID_FILE"; then
    log "managed capture gateway already running (pid=$(cat "$GATEWAY_PID_FILE"))."
    return 0
  fi

  if port_is_listening "$port"; then
    if gateway_http_reachable; then
      log "detected existing gateway on $GATEWAY_BASE_URL (port $port); reusing it."
      return 0
    fi
    local existing_listener_pid
    existing_listener_pid="$(listener_pid_for_port "$port" || true)"
    if [[ -n "$existing_listener_pid" ]]; then
      die "port $port already in use by pid=$existing_listener_pid and $GATEWAY_BASE_URL is not reachable; stop it or change --gateway-base-url"
    fi
    die "port $port already in use and $GATEWAY_BASE_URL is not reachable; stop existing process or change --gateway-base-url"
  fi

  openclaw_bin_exists || die "openclaw binary not found; set --openclaw-bin PATH or OPENCLAW_BIN (or point --gateway-base-url to a running gateway)"

  local token
  token="$(read_gateway_token)"
  if [[ -z "$token" ]]; then
    die "gateway token is empty; set --gateway-token or OPENCLAW_GATEWAY_TOKEN, or ensure OPENCLAW_CONFIG has gateway.auth.token"
  fi

  log "starting managed capture gateway on $GATEWAY_BASE_URL (bind=$OPENCLAW_GATEWAY_BIND)"
  if [[ -f "$OPENCLAW_BIN" ]]; then
    nohup env \
      HTTP_PROXY="$CAPTURE_PROXY_URL" \
      HTTPS_PROXY="$CAPTURE_PROXY_URL" \
      ALL_PROXY="$CAPTURE_PROXY_URL" \
      NO_PROXY="" \
      NODE_USE_ENV_PROXY=1 \
      OPENCLAW_GATEWAY_TOKEN="$token" \
      OPENCLAW_CACHE_TRACE=1 \
      OPENCLAW_CACHE_TRACE_FILE="$CAPTURE_DATA_DIR/cache-trace.jsonl" \
      OPENCLAW_CACHE_TRACE_MESSAGES=1 \
      OPENCLAW_CACHE_TRACE_PROMPT=1 \
      OPENCLAW_CACHE_TRACE_SYSTEM=1 \
      node "$OPENCLAW_BIN" gateway --port "$port" --token "$token" --bind "$OPENCLAW_GATEWAY_BIND" \
        >"$GATEWAY_LOG" 2>&1 &
  else
    nohup env \
      HTTP_PROXY="$CAPTURE_PROXY_URL" \
      HTTPS_PROXY="$CAPTURE_PROXY_URL" \
      ALL_PROXY="$CAPTURE_PROXY_URL" \
      NO_PROXY="" \
      NODE_USE_ENV_PROXY=1 \
      OPENCLAW_GATEWAY_TOKEN="$token" \
      OPENCLAW_CACHE_TRACE=1 \
      OPENCLAW_CACHE_TRACE_FILE="$CAPTURE_DATA_DIR/cache-trace.jsonl" \
      OPENCLAW_CACHE_TRACE_MESSAGES=1 \
      OPENCLAW_CACHE_TRACE_PROMPT=1 \
      OPENCLAW_CACHE_TRACE_SYSTEM=1 \
      "$OPENCLAW_BIN" gateway --port "$port" --token "$token" --bind "$OPENCLAW_GATEWAY_BIND" \
        >"$GATEWAY_LOG" 2>&1 &
  fi
  echo $! > "$GATEWAY_PID_FILE"

  sleep 1
  pid_running "$GATEWAY_PID_FILE" || die "failed to start managed capture gateway, check $GATEWAY_LOG"
  if ! wait_gateway_ready; then
    tail -n 80 "$GATEWAY_LOG" >&2 || true
    die "gateway not reachable at $GATEWAY_BASE_URL after start"
  fi
  local listener_pid
  listener_pid="$(listener_pid_for_port "$port" || true)"
  if [[ -n "$listener_pid" ]]; then
    echo "$listener_pid" > "$GATEWAY_PID_FILE"
  fi
  log "managed capture gateway ready: $GATEWAY_BASE_URL"
}

stop_gateway_capture() {
  stop_pid_file "$GATEWAY_PID_FILE" "managed capture gateway"
}

status_gateway_capture() {
  status_one "$GATEWAY_PID_FILE" "managed capture gateway"
  echo "gateway base url: $GATEWAY_BASE_URL"
  local port
  port="$(gateway_port)"
  if port_is_listening "$port"; then
    echo "gateway port listen: yes ($port)"
  else
    echo "gateway port listen: no ($port)"
  fi
}

request_once() {
  local token
  token="$(read_gateway_token)"
  if [[ -z "$token" ]]; then
    die "gateway token is empty; set --gateway-token or OPENCLAW_GATEWAY_TOKEN, or ensure OPENCLAW_CONFIG has gateway.auth.token"
  fi

  local body
  body="$(
    REQUEST_MODEL="$REQUEST_MODEL" REQUEST_PROMPT="$REQUEST_PROMPT" REQUEST_USER="$REQUEST_USER" python3 - <<'PY'
import json
import os

print(
    json.dumps(
        {
            "model": os.environ["REQUEST_MODEL"],
            "input": os.environ["REQUEST_PROMPT"],
            "stream": False,
            "user": os.environ["REQUEST_USER"],
            "metadata": {"source": "openclaw_capture_toolkit"},
        },
        ensure_ascii=False,
    )
)
PY
  )"

  local endpoint="${GATEWAY_BASE_URL%/}/v1/responses"
  local response_file="$STATE_DIR/last_request_response.json"
  local http_status
  local curl_rc
  local -a curl_proxy_args=()

  if [[ "$REQUEST_USE_PROXY" == "1" ]]; then
    curl_proxy_args+=(--proxy "$CAPTURE_PROXY_URL" --noproxy "")
  fi

  log "sending request to $endpoint"
  set +e
  http_status="$(
    curl -sS -o "$response_file" -w "%{http_code}" \
      --max-time "$REQUEST_TIMEOUT" \
      "${curl_proxy_args[@]}" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $token" \
      -d "$body" \
      "$endpoint"
  )"
  curl_rc=$?
  set -e
  if (( curl_rc != 0 )); then
    die "request failed (curl exit=$curl_rc)"
  fi

  if [[ ! "$http_status" =~ ^2 ]]; then
    echo "[ERROR] HTTP $http_status from gateway" >&2
    if [[ "$http_status" == "401" ]]; then
      echo "[ERROR] token mismatch: set GATEWAY_TOKEN/--gateway-token to target gateway token, or use a managed gateway on a dedicated port." >&2
    fi
    echo "[ERROR] response body:" >&2
    cat "$response_file" >&2 || true
    exit 2
  fi

  log "request success (HTTP $http_status), response saved: $response_file"
  RESPONSE_FILE="$response_file" python3 - <<'PY'
import json
import os
from typing import Any

path = os.environ["RESPONSE_FILE"]
with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)

def extract_text(payload: dict[str, Any]) -> str:
    out: list[str] = []
    output = payload.get("output")
    if isinstance(output, list):
        for item in output:
            if not isinstance(item, dict):
                continue
            text = item.get("text")
            if isinstance(text, str) and text:
                out.append(text)
            content = item.get("content")
            if isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    t = block.get("text")
                    if isinstance(t, str) and t:
                        out.append(t)
    return "".join(out).strip()

resp_id = data.get("id") or data.get("response_id") or ""
usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
text = data.get("output_text") if isinstance(data.get("output_text"), str) else extract_text(data)

print(f"response.id={resp_id}")
print("usage=" + json.dumps(usage, ensure_ascii=False))
if text:
    preview = text[:500]
    suffix = "..." if len(text) > 500 else ""
    print("assistant=" + preview + suffix)
else:
    print("assistant=(empty)")
PY
}

proxy_run() {
  if [[ "${#PROXY_RUN_CMD[@]}" -eq 0 ]]; then
    die "proxy-run requires a command. Example: proxy-run -- curl -sS http://127.0.0.1:30789/"
  fi
  env \
    HTTP_PROXY="$CAPTURE_PROXY_URL" \
    HTTPS_PROXY="$CAPTURE_PROXY_URL" \
    ALL_PROXY="$CAPTURE_PROXY_URL" \
    NO_PROXY="" \
    NODE_USE_ENV_PROXY=1 \
    "${PROXY_RUN_CMD[@]}"
}

export_offline() {
  local exporter="$SCRIPT_DIR/export_session_capture_html.py"
  [[ -f "$exporter" ]] || die "export script not found: $exporter"

  local output="$EXPORT_OUTPUT"
  if [[ -z "$output" ]]; then
    output="$STATE_DIR/session_capture_offline_$(date +%Y%m%d_%H%M%S).html"
  fi
  if [[ "$output" != /* ]]; then
    output="$SCRIPT_DIR/$output"
  fi

  local api_python="$CAPTURE_API_PYTHON"
  if [[ -z "$api_python" ]]; then
    api_python="$CAPTURE_TOOL_DIR/.venv/bin/python"
  fi
  if [[ ! -x "$api_python" ]]; then
    api_python="$(command -v python3 || true)"
  fi
  [[ -n "$api_python" ]] || die "python3 not found for export"

  log "exporting offline html to $output"
  "$api_python" "$exporter" \
    --api-url "$CAPTURE_API_URL" \
    --output "$output" \
    --title "$EXPORT_TITLE" \
    --max-traces "$EXPORT_MAX_TRACES"
  log "offline html ready: $output"
}

print_instructions() {
  cat <<EOF
Quick Steps (recommended):
0) 配置说明:
   脚本会自动加载同目录 .env（可用 TOOLKIT_ENV_FILE 指定其它 env 文件）
1) 一键拉起抓包栈 + 托管网关:
   ./openclaw_capture_toolkit.sh up
   如果目标端口已有可访问网关，会自动复用，不会重复启动。
2) 清空旧抓包数据:
   ./openclaw_capture_toolkit.sh clear
3) 在代理环境里发起真实会话（封装完成）:
   ./openclaw_capture_toolkit.sh proxy-run -- curl -sS http://127.0.0.1:30789/
   或:
   eval "\$(./openclaw_capture_toolkit.sh proxy-env)"
   注意: 这里不要写尖括号 <>，要写真实可执行命令。
4) 打开网页查看:
   $CAPTURE_API_URL/

可选：快速验证链路
  ./openclaw_capture_toolkit.sh request --prompt "请只回复: OK"

导出离线 HTML:
  ./openclaw_capture_toolkit.sh export-offline --output ./output/session_capture_offline.html

当前配置:
- gateway: $GATEWAY_BASE_URL
- proxy:   $CAPTURE_PROXY_URL
- api:     $CAPTURE_API_URL
- data:    $CAPTURE_DATA_DIR
EOF
}

# ---- setup command ----

cmd_setup() {
  log "=== OpenClaw Capture Toolkit Setup ==="
  local ok=true

  # Check Python
  local py=""
  if [[ -n "${CAPTURE_API_PYTHON:-}" ]] && command -v "$CAPTURE_API_PYTHON" &>/dev/null; then
    py="$CAPTURE_API_PYTHON"
  elif [[ -x "$CAPTURE_TOOL_DIR/.venv/bin/python" ]]; then
    py="$CAPTURE_TOOL_DIR/.venv/bin/python"
  elif command -v python3 &>/dev/null; then
    py="$(command -v python3)"
  fi

  if [[ -n "$py" ]]; then
    local pyver
    pyver="$("$py" --version 2>&1)"
    log "[OK] Python found: $pyver ($py)"
  else
    log "[MISSING] python3 not found. Install Python 3.10+ first."
    ok=false
  fi

  # Check mitmdump
  local mitm="${MITMDUMP_BIN:-$(command -v mitmdump 2>/dev/null || true)}"
  if [[ -n "$mitm" ]]; then
    local mver
    mver="$("$mitm" --version 2>&1 | head -1)"
    log "[OK] mitmdump found: $mver"
  else
    log "[MISSING] mitmdump not found. Install: pip install 'mitmproxy>=11.0.0'"
    ok=false
  fi

  # Create venv if not exists
  local venv_dir="$CAPTURE_TOOL_DIR/.venv"
  if [[ -d "$venv_dir" ]]; then
    log "[OK] Python venv exists: $venv_dir"
  else
    if [[ -n "$py" ]]; then
      log "Creating Python venv at $venv_dir ..."
      "$py" -m venv "$venv_dir"
      log "[OK] venv created"
    else
      log "[SKIP] Cannot create venv (python3 not found)"
      ok=false
    fi
  fi

  # Install requirements
  local req_file="$SCRIPT_DIR/requirements.txt"
  if [[ -f "$req_file" ]] && [[ -x "$venv_dir/bin/pip" ]]; then
    log "Installing requirements ..."
    "$venv_dir/bin/pip" install -q -r "$req_file"
    log "[OK] Requirements installed"
  fi

  # Copy env.example if .env missing
  local env_file="${TOOLKIT_ENV_FILE:-$SCRIPT_DIR/.env}"
  if [[ ! -f "$env_file" ]] && [[ -f "$SCRIPT_DIR/env.example" ]]; then
    cp "$SCRIPT_DIR/env.example" "$env_file"
    log "[OK] Copied env.example -> .env (review and edit as needed)"
  elif [[ -f "$env_file" ]]; then
    log "[OK] .env file exists"
  fi

  # Check ports
  for port in "${MITM_PORT:-18080}" "${CAPTURE_API_PORT:-8000}"; do
    if ss -tlnp 2>/dev/null | grep -q ":${port} " ; then
      log "[WARN] Port $port is already in use"
    else
      log "[OK] Port $port is available"
    fi
  done

  # Check OpenClaw
  local oc_bin="${OPENCLAW_BIN:-$(command -v openclaw 2>/dev/null || true)}"
  if [[ -n "$oc_bin" ]]; then
    log "[OK] OpenClaw binary found: $oc_bin"
  else
    log "[INFO] openclaw not in PATH (optional: set OPENCLAW_BIN or install openclaw)"
  fi

  if $ok; then
    log "=== Setup complete. Run: ./openclaw_capture_toolkit.sh up ==="
  else
    log "=== Setup incomplete. Fix the items marked [MISSING] above. ==="
  fi
}

# ---- diag command ----

cmd_diag() {
  local api_python="$CAPTURE_API_PYTHON"
  if [[ -z "$api_python" ]]; then
    api_python="$CAPTURE_TOOL_DIR/.venv/bin/python"
  fi
  if [[ ! -x "$api_python" ]]; then
    api_python="$(command -v python3 || true)"
  fi
  [[ -n "$api_python" ]] || die "python3 not found"

  local diag_script
  diag_script="$(dirname "$CAPTURE_TOOL_DIR")/capture_tool/tools/context_capture/diag_cli.py"
  if [[ ! -f "$diag_script" ]]; then
    diag_script="$CAPTURE_TOOL_DIR/tools/context_capture/diag_cli.py"
  fi
  [[ -f "$diag_script" ]] || die "diag_cli.py not found at $diag_script"

  local args=()
  [[ -n "${DIAG_SESSION:-}" ]] && args+=(--session "$DIAG_SESSION")
  [[ -n "${DIAG_STAGE:-}" ]] && args+=(--stage "$DIAG_STAGE")
  [[ -n "${DIAG_ROUND:-}" ]] && args+=(--round "$DIAG_ROUND")
  [[ -n "${DIAG_RAW:-}" ]] && args+=(--raw)

  "$api_python" "$diag_script" "${args[@]}" "$@"
}

main() {
  if [[ $# -lt 1 ]]; then
    usage
    exit 1
  fi

  local cmd="$1"
  shift
  if [[ "$cmd" == "--help" || "$cmd" == "-h" ]]; then
    usage
    exit 0
  fi
  parse_args "$@"
  normalize_paths
  discover_external_cache_trace_file

  CAPTURE_API_URL="${CAPTURE_API_URL:-http://127.0.0.1:${CAPTURE_API_PORT}}"
  CAPTURE_PROXY_URL="${CAPTURE_PROXY_URL:-http://${MITM_HOST}:${MITM_PORT}}"

  case "$cmd" in
    start) start_stack ;;
    stop) stop_stack ;;
    status) status_stack ;;
    clear) clear_capture ;;
    request) request_once ;;
    gateway-start) start_gateway_capture ;;
    gateway-stop) stop_gateway_capture ;;
    gateway-status) status_gateway_capture ;;
    up)
      start_stack
      start_gateway_capture
      ;;
    down)
      stop_gateway_capture
      stop_stack
      ;;
    proxy-env) proxy_env_exports ;;
    proxy-run) proxy_run ;;
    export-offline) export_offline ;;
    instructions) print_instructions ;;
    setup) cmd_setup ;;
    diag) cmd_diag "$@" ;;
    *) die "unknown command: $cmd" ;;
  esac
}

main "$@"
