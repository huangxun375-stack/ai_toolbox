# OpenClaw Context-Engine 可观测工具
对 OpenClaw 的 context-engine 插件（当前为 lossless-claw）进行全链路观测，包括 HTTP 流量抓包、LCM 诊断分析、Web UI 可视化。
## 目录结构要求

本工具需要和 `lossless-claw` 仓库作为兄弟目录放置：
```
parent_dir/
  ai_toolbox/                    <- 本仓库
    openclaw_capture_context_tool/
      deploy_test_env.sh
      openclaw_capture_toolkit.sh
      使用指南.md
      ...
  lossless-claw/                 <- lossless-claw 仓库
    src/
    package.json
    ...
```

## 前置条件

| 依赖 | 版本 | 说明 |
|------|------|------|
| Linux/WSL2 | - | 不支持 Windows 原生 |
| Node.js | 18+ | OpenClaw 运行时 |
| Python | 3.10+ | Capture API |
| OpenClaw | 已安装 | openclaw configure 已完成 |
| 模型 API Key | 已配置 | 在 OpenClaw 中配置好 provider 凭据 |

## 快速开始
### 方式一：隔离测试部署（推荐新用户）

```bash
# 1. 克隆两个仓库到同一父目录
mkdir my-openclaw-tools && cd my-openclaw-tools
git clone <ai_toolbox_repo> ai_toolbox
git clone <lossless-claw_repo> lossless-claw

# 2. 一键部署测试环境
cd ai_toolbox/openclaw_capture_context_tool
bash deploy_test_env.sh

# 3. 按输出提示启动（两个终端）
# 终端1:
cd ~/openclaw-test-deploy/ai_toolbox && ./openclaw_capture_toolkit.sh start
# 终端2:
LCM_DIAGNOSTICS_PATH=~/.openclaw-test/lcm-diagnostics.jsonl \
HTTP_PROXY=http://127.0.0.1:28080 \
HTTPS_PROXY=http://127.0.0.1:28080 \
NODE_TLS_REJECT_UNAUTHORIZED=0 \
openclaw --profile test gateway run --port 28789

# 4. 发送测试请求
LCM_DIAGNOSTICS_PATH=~/.openclaw-test/lcm-diagnostics.jsonl \
HTTP_PROXY=http://127.0.0.1:28080 \
HTTPS_PROXY=http://127.0.0.1:28080 \
NODE_TLS_REJECT_UNAUTHORIZED=0 \
openclaw --profile test agent -m "hello" --session-id "test"

# 5. 打开 Web UI: http://127.0.0.1:9001/
```

deploy_test_env.sh 自动处理: npm install、Python venv、.env 生成、profile 创建、plugin 配置、auth 复制。
### 方式二：直接使用（已有环境）

```bash
cd ai_toolbox/openclaw_capture_context_tool
./openclaw_capture_toolkit.sh setup    # 检测环境、安装依赖
cp env.example .env                    # 编辑配置
./openclaw_capture_toolkit.sh up       # 启动全栈
```

## 主要功能

- **Web UI**：会话轨迹时间线 + LCM 诊断面板 + Assemble 上下文组装可视化
- **命令行诊断**：`./openclaw_capture_toolkit.sh diag --round 2 --stage compaction_evaluate`
- **API 过滤**：`/api/lcm-diagnostics?session_id=X&stage=Y&after_ts=Z`
- **测试数据复现**：`test-fixtures/` 包含可重放的诊断数据

## lossless-claw 新增环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| LCM_DIAGNOSTICS_ENABLED | true | 设为 false 关闭诊断写入 |
| LCM_DIAGNOSTICS_PATH | ~/.openclaw/lcm-diagnostics.jsonl | 自定义诊断文件路径 |

## 详细文档

- [使用指南.md](使用指南.md) - 完整功能说明、LCM 阶段速查表、环境变量参考、故障排除
- [test-fixtures/README.md](test-fixtures/README.md) - 测试数据说明和复现步骤
