# OpenClaw Session Capture Toolkit (Portable Bundle)

这是可分发给其他用户的单目录版本。  
目标是把代理配置、抓包链路和导出流程打包好，拿到目录即可抓真实 OpenClaw 会话。

## 1. 包含内容

- `openclaw_capture_toolkit.sh`
- `env.example`
- `capture_tool/tools/context_capture/*`
- `capture_tool/tools/context_capture/web/*`
- `export_session_capture_html.py`
- `requirements.txt`

## 2. 前置依赖

必需：
- `python3`
- `mitmdump`（或在 `.env` 中设置 `MITMDUMP_BIN`）

安装依赖：

```bash
python3 -m pip install -r requirements.txt
python3 -m pip install --user "mitmproxy>=11.0.0"
```

## 3. 快速开始（推荐）

1) 配置

```bash
cp env.example .env
```

说明：脚本会自动加载同目录 `.env`，不需要每次手动 `source .env`。

2) 一键启动（抓包栈 + 网关）

```bash
./openclaw_capture_toolkit.sh up
```

说明：
- 若 `GATEWAY_BASE_URL` 对应端口已经有可访问网关，工具会自动复用该网关。
- 若该端口没有网关且 `openclaw` 不在 PATH，请在 `.env` 设置 `OPENCLAW_BIN`（支持指向 `openclaw.mjs`）。
- 推荐优先使用独立端口，避免与现有服务冲突，例如：

```bash
GATEWAY_BASE_URL=http://127.0.0.1:30790 ./openclaw_capture_toolkit.sh up
```

3) 清空旧数据

```bash
./openclaw_capture_toolkit.sh clear
```

4) 通过封装代理执行真实会话命令

```bash
./openclaw_capture_toolkit.sh proxy-run -- curl -sS http://127.0.0.1:30789/
```

注意：`proxy-run --` 后必须是真实可执行命令，不要写 `<你的会话命令>` 占位符。

5) 打开网页查看

```text
http://127.0.0.1:<CAPTURE_API_PORT>/
```

6) 导出离线单文件 HTML（可分享）

```bash
./openclaw_capture_toolkit.sh export-offline --output ./output/session_capture_offline.html
```

## 4. 可选链路验证

```bash
./openclaw_capture_toolkit.sh request --prompt "请只回复: OK" --user "capture-demo"
```

`request` 默认通过抓包代理转发。  
如果返回 `401 Unauthorized`，通常是当前 `GATEWAY_TOKEN` 与目标网关不一致，设置 `GATEWAY_TOKEN` 或改用工具托管的独立网关端口即可。

## 5. 常用命令

```bash
./openclaw_capture_toolkit.sh status
./openclaw_capture_toolkit.sh gateway-status
./openclaw_capture_toolkit.sh proxy-env
./openclaw_capture_toolkit.sh instructions
./openclaw_capture_toolkit.sh down
```

## 6. 常见问题

1) `address already in use`（端口占用）

```bash
MITM_PORT=18082 CAPTURE_PROXY_URL=http://127.0.0.1:18082 \
CAPTURE_API_PORT=8001 CAPTURE_API_URL=http://127.0.0.1:8001 \
./openclaw_capture_toolkit.sh up
```

2) `openclaw binary not found`

- 在 `.env` 设置 `OPENCLAW_BIN=/绝对路径/openclaw.mjs`；或
- 把 `GATEWAY_BASE_URL` 指向已有可访问网关（`up` 会自动复用）。

3) `request` 返回 `401`

- 目标网关 token 不匹配，设置 `.env` 中的 `GATEWAY_TOKEN=` 为目标网关 token。

4) `status` 本地 `cache-trace.jsonl lines=0`，但出现 `external cache-trace file`

- 说明 OpenClaw 配置固定了 `diagnostics.cacheTrace.filePath`，工具已自动接入该外部文件。

## 7. 归档前脱敏建议

以下目录/文件可能包含 token、用户名路径或会话内容，不建议直接对外归档：
- `data/context_capture_live/*.jsonl`
- `output/*.html`
- `.state/*`
- `.env`
- `dist/test_bundle*`（历史测试产物）

建议只归档一份新打包产物（`build_bundle.sh` 生成的目录或 `.tar.gz`）。

## 8. 对外发布打包（推荐）

```bash
./build_bundle.sh --out-dir ./dist/archive_ready_bundle
```

产物：
- 目录：`./dist/archive_ready_bundle`
- 压缩包：`./dist/archive_ready_bundle.tar.gz`

建议只把 `archive_ready_bundle.tar.gz` 发给别人，不要直接发当前工作目录。

## 9. 发版前自测（建议跑一遍）

```bash
./openclaw_capture_toolkit.sh up
./openclaw_capture_toolkit.sh clear
./openclaw_capture_toolkit.sh request --prompt "请只回复: OK" --user "self-check"
./openclaw_capture_toolkit.sh status
./openclaw_capture_toolkit.sh export-offline --output ./output/self_check_offline.html
./openclaw_capture_toolkit.sh down
```

验收标准：
- `status` 中 `raw.jsonl lines > 0`
- 成功导出离线 HTML
