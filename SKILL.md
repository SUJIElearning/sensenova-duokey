---
name: sensenova-duokey
description: 商汤 SenseNova 多账户 API Key 轮询代理，一键安装。当用户说「装商汤多Key」「商汤老是限流」「我有多个商汤Key想一起用」「提升商汤API吞吐」或需要解决商汤 429/503 限流时使用。安装后多个账号的 Key 自动轮询，单 Key 撞限流时自动切换。
metadata:
  author: zhaoyu
  version: "1.0.0"
  created: 2026-10-20
---

# 商汤多Key轮询（sensenova-duokey）· by zhaoyu

把多个商汤账号的 API Key 变成一个统一的 OpenAI 兼容端点，自动轮询、自动切换、自动冷却。解决"单个商汤账号额度不够、频繁 429/503"的问题。

## 这个技能解决什么

商汤的 API 限流是**按 Key/账号**算的。只有一个 Key 时，额度用尽就只能干等。
这个代理让你把多个账号的 Key 一起挂上：

- 一个 Key 被限流 → 自动换下一个
- 全部被限流 → 按实测恢复时间冷静等待，不疯狂重试
- 对外只暴露一个地址 `http://127.0.0.1:15722/v1`，任何 OpenAI 兼容客户端都能接

## 安装流程（AI 按顺序执行）

### 步骤 1：检查 Node.js

```bash
node --version
```

要求 v18 或更高。没有 Node.js 就引导用户从 https://nodejs.org 安装（选 LTS 版）。

### 步骤 2：把代理脚本放到用户目录

优先从技能自带文件复制（如果本技能目录里有 `proxy/`），否则从仓库下载：

```bash
mkdir -p ~/.sensenova-duokey
# 从仓库下载（二选一，看用户网络）
curl -fsSL https://raw.githubusercontent.com/SUJIElearning/sensenova-duokey/main/proxy/sensenova-multikey-proxy.js -o ~/.sensenova-duokey/sensenova-multikey-proxy.js
# 或者 git clone 整个仓库后复制
```

Windows 用 PowerShell：

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.sensenova-duokey" | Out-Null
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/SUJIElearning/sensenova-duokey/main/proxy/sensenova-multikey-proxy.js" -OutFile "$env:USERPROFILE\.sensenova-duokey\sensenova-multikey-proxy.js"
```

### 步骤 3：向用户收集 API Key

**必须问清楚**，一次问完，不要自己编：

> 请把你的商汤 API Key 发给我，一个账号一个（有几个给几个）。
> 提醒：同一个账号下建多个 Key 共享额度，所以**每个 Key 要来自不同账号**才有效果。

拿到后确认数量：只要 1 个也能用（只是没有轮询收益），建议 2 个以上。

### 步骤 4：写入配置

**如果用户在用 DSH**（存在 `~/.dsh` 目录）：写进 `~/.dsh/.credentials.yaml` 的 `refs` 下，保持已有内容不动，只增补 Key：

```yaml
refs:
  SENSENOVA_API_KEY: sk-第1个Key
  SENSENOVA_API_KEY_1: sk-第2个Key
  SENSENOVA_API_KEY_2: sk-第3个Key
```

编号从 1 开始顺延，**不要覆盖已有的其他凭据行**（比如 GEMINI_API_KEY）。

**如果用户不用 DSH**：写一个启动脚本，把 Key 作为环境变量传给 Node：

```bash
# Linux/macOS: start.sh
export SENSENOVA_API_KEY_1=sk-xxx
export SENSENOVA_API_KEY_2=sk-yyy
node ~/.sensenova-duokey/sensenova-multikey-proxy.js
```

```bat
REM Windows: start.bat (必须存成 GBK/ANSI 编码，否则中文注释乱码)
@echo off
set SENSENOVA_API_KEY_1=sk-xxx
set SENSENOVA_API_KEY_2=sk-yyy
node "%USERPROFILE%\.sensenova-duokey\sensenova-multikey-proxy.js"
pause
```

### 步骤 5：启动代理

```bash
node ~/.sensenova-duokey/sensenova-multikey-proxy.js
```

Windows 要后台隐藏运行：

```powershell
Start-Process -FilePath "node" -ArgumentList "$env:USERPROFILE\.sensenova-duokey\sensenova-multikey-proxy.js" -WindowStyle Minimized
```

**重启代理的正确姿势**（重要，避免用户网络中断）：
先启动新进程，确认新进程就绪后，再终止旧进程。**不要先杀后启**，中间会有一段连不上的空窗期。

### 步骤 6：验证（必须真实执行，不能只看代码）

```bash
curl http://127.0.0.1:15722/health
# 期望：{"status":"ok","type":"multi-account-proxy","accounts":N}

curl http://127.0.0.1:15722/status
# 期望：看到 totalKeys=N、availableNow=M、每个 key 的 available/cooldownRemaining
```

再发一个真实请求验证端到端：

```bash
curl -X POST http://127.0.0.1:15722/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"hi"}],"max_tokens":5}'
```

HTTP 200 且有 content 才算成功。要是 429，把 `/status` 里的 `total429s` 和 `availableNow` 报给用户看。

### 步骤 7：把客户端指过来

告诉用户改客户端配置：

- **Base URL**：`http://127.0.0.1:15722/v1`
- **API Key**：随便填一个真实的商汤 Key（代理会自己轮换，客户端填什么不影响）
- **模型名**：用商汤的模型名，如 `deepseek-flash`、`deepseek-v4-flash`、`glm-5.2`、`kimi-k3`

DSH 用户在设置里加 provider：

```yaml
llm-pi-ai:
  providers:
    sensenova:
      displayName: sensenova
      apiKeyEnv: SENSENOVA_API_KEY
      api: openai-completions
      baseURL: http://127.0.0.1:15722/v1
      models:
        - id: deepseek-flash
          name: deepseek-flash
          contextWindow: 1000000
          maxTokens: 64000
```

### 步骤 8（可选）：装 Key 观察窗口

只有 DSH 用户需要。装完能在对话框下方看到 `● 5/6 Key` 的实时状态。

```bash
dsh plugin add @sujielearning/dsh-sensenova-key-status
```

或者用本地目录安装：让 DSH 用 plugin_manager 安装 `dsh-plugin/` 目录。

## 运维

- **看状态**：`curl http://127.0.0.1:15722/status`
- **加 Key**：往 `.credentials.yaml` 的 `refs` 里加 `SENSENOVA_API_KEY_N`，然后重启代理
- **停代理**：`netstat -ano | findstr 15722` 找到 PID，`taskkill /F /PID <pid>`（Windows）
- **换端口**：改脚本里的 `PROXY_PORT`

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动即退出，提示端口占用 | 已有代理在跑 | 先找旧进程杀掉，再启动 |
| 全是 429 / 503 | 额度真不够 | 加账号 Key、缩短对话上下文、或换模型 |
| 某个 Key 一直不可用 | 该账号额度耗尽 | 等恢复（实测 8-10 分钟）或换新账号 |
| 客户端连不上 | baseURL 没改对 | 确认是 `http://127.0.0.1:15722/v1`，注意结尾 `/v1` |
| 中文日志乱码 | bat 文件编码错 | 把脚本存成 GBK/ANSI 编码 |

## 关键提醒（给 AI）

1. **不要替用户编造 Key**。没拿到就停下来问。
2. **不要先杀旧进程再启动新的**，会造成用户网络中断。先起新的、验证通过、再停旧的。
3. **验证必须真实发请求**，不能只 `node --check` 语法通过就说装好了。
4. **用户如果反馈"很慢"**：先看 `/status` 里 `availableNow/totalKeys`，可用少说明额度紧，那不是代理的锅。

[PROTOCOL]: 变更此技能时更新本头部，然后检查本包其他文件。
