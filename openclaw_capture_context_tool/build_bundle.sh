#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

OUT_DIR="${OUT_DIR:-$SCRIPT_DIR/dist/openclaw_capture_toolkit_bundle}"

die() {
  echo "[ERROR] $*" >&2
  exit 2
}

usage() {
  cat <<'USAGE'
Usage: build_bundle.sh [--out-dir PATH]

Options:
  --out-dir PATH   Output bundle folder (default: ./dist/openclaw_capture_toolkit_bundle)
  --help           Show this help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

CAPTURE_SRC_DIR=""
for candidate in \
  "$SCRIPT_DIR/capture_tool/tools/context_capture" \
  "$REPO_ROOT/.worktrees/context-capture-tool/tools/context_capture"; do
  if [[ -f "$candidate/api.py" ]]; then
    CAPTURE_SRC_DIR="$candidate"
    break
  fi
done
[[ -n "$CAPTURE_SRC_DIR" ]] || die "cannot locate context_capture source directory"

README_SRC="$SCRIPT_DIR/README.md"
if [[ -f "$SCRIPT_DIR/README.portable.md" ]]; then
  README_SRC="$SCRIPT_DIR/README.portable.md"
fi
[[ -f "$README_SRC" ]] || die "README source file not found"

mkdir -p "$OUT_DIR"
rm -rf "$OUT_DIR"/*

mkdir -p "$OUT_DIR/capture_tool/tools/context_capture"
mkdir -p "$OUT_DIR/capture_tool/tools/context_capture/web"
mkdir -p "$OUT_DIR/data/context_capture_live"

copy_file() {
  local src="$1"
  local dst="$2"
  install -D -m 0644 "$src" "$dst"
}

copy_exec() {
  local src="$1"
  local dst="$2"
  install -D -m 0755 "$src" "$dst"
}

# Toolkit entry and docs
copy_exec "$SCRIPT_DIR/openclaw_capture_toolkit.sh" "$OUT_DIR/openclaw_capture_toolkit.sh"
copy_exec "$SCRIPT_DIR/build_bundle.sh" "$OUT_DIR/build_bundle.sh"
copy_exec "$SCRIPT_DIR/export_session_capture_html.py" "$OUT_DIR/export_session_capture_html.py"
copy_file "$SCRIPT_DIR/env.example" "$OUT_DIR/env.example"
copy_file "$SCRIPT_DIR/.gitignore" "$OUT_DIR/.gitignore"
copy_file "$README_SRC" "$OUT_DIR/README.md"
copy_file "$SCRIPT_DIR/操作手册.md" "$OUT_DIR/操作手册.md"

# context-capture core files
for file in \
  __init__.py \
  api.py \
  cli.py \
  config.py \
  correlator.py \
  models.py \
  parser.py \
  proxy_addon.py \
  storage.py; do
  copy_file "$CAPTURE_SRC_DIR/$file" "$OUT_DIR/capture_tool/tools/context_capture/$file"
done
copy_file "$CAPTURE_SRC_DIR/web/index.html" "$OUT_DIR/capture_tool/tools/context_capture/web/index.html"
copy_file "$CAPTURE_SRC_DIR/web/app.js" "$OUT_DIR/capture_tool/tools/context_capture/web/app.js"

if [[ -f "$SCRIPT_DIR/requirements.txt" ]]; then
  copy_file "$SCRIPT_DIR/requirements.txt" "$OUT_DIR/requirements.txt"
else
  cat > "$OUT_DIR/requirements.txt" <<'REQS'
fastapi>=0.115.0
uvicorn>=0.30.0
pydantic>=2.0.0
REQS
fi

cat > "$OUT_DIR/manifest.json" <<MANIFEST
{
  "bundle_name": "openclaw_capture_toolkit_bundle",
  "generated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "build_source": "local",
  "purpose": "single-session capture for OpenClaw conversation analysis",
  "files": [
    "openclaw_capture_toolkit.sh",
    "env.example",
    "README.md",
    "操作手册.md",
    "export_session_capture_html.py",
    "capture_tool/tools/context_capture/*",
    "capture_tool/tools/context_capture/web/*",
    "requirements.txt"
  ]
}
MANIFEST

TAR_PATH="${OUT_DIR}.tar.gz"
tar -czf "$TAR_PATH" -C "$(dirname "$OUT_DIR")" "$(basename "$OUT_DIR")"

echo "bundle_dir=$OUT_DIR"
echo "bundle_tar=$TAR_PATH"
