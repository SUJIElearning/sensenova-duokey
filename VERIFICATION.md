# 陌生用户实测记录（VERIFICATION）

> 按 README 从零走一遍，记录**实际命令与实际输出**。
> 测试时间：2026-10-20 23:20 (UTC+8)
> 测试环境：Windows 11 + Node.js v26.5.0

## 测试方法

模拟一个"刚拿到这个仓库的陌生用户"：

1. 把 `proxy/` 复制到一个**隔离目录**（不碰开发者的现有安装）
2. 把端口从 `15722` 改成 `15788`（避免撞开发者正在跑的实例）
3. 按 README 用**环境变量**方式配 Key（不落盘）
4. 逐项验证，记录真实输出

## 验证点与结果

### ✅ 1. 代理能独立启动

```powershell
$env:SENSENOVA_API_KEY_1 = "<key1>"
$env:SENSENOVA_API_KEY_2 = "<key2>"
node sensenova-multikey-proxy.js
```

**实际输出**（关键行）：

```
 监听地址:  http://127.0.0.1:15788
 已加载:    2 个账户 Key
 策略:      并发转发 → 429 换 Key(最多试 12 个),失败快速返回
 冷却:      45s 起,连续限流翻倍(上限 120s)
 等Key上限: 100s (超时即快速失败,不让用户干等)
 单请求预算:240s (必须 > 冷却上限 120s)
 并发容量:  2 Key × 4 槽 = 8 个对话
```

**结论**：零依赖启动成功，正确读到了 2 个环境变量 Key。

### ✅ 2. 健康检查

```bash
curl http://127.0.0.1:15788/health
```

**实际结果**：

```json
{"status":"ok","type":"multi-account-proxy","accounts":2}
```

### ✅ 3. 状态接口

```bash
curl http://127.0.0.1:15788/status
```

**实际结果**：

```
totalKeys=2  availableNow=2  total429s=0
```

### ✅ 4. 真实请求端到端

```bash
curl -X POST http://127.0.0.1:15788/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"回答一个字:好"}],"max_tokens":5}'
```

**实际结果**：

```
HTTP 200  耗时 1912ms
{"id":"7a3811bc15cc4c2e9c58b1239706e61f","created":1792509836,"model":"deepseek-v4-flash",...}
```

**结论**：真实打通商汤 API，返回正常。

### ✅ 5. 状态正确反映调用（TPM 记账）

发完上一步请求后立即查 `/status`：

```
sk-eMv****EEBz: req=1 err=0 tpm=91
sk-k7c****RVqJ: req=0 err=0 tpm=0
```

**结论**：`req` 计数 +1、`tpmWindowTokens` 记录了本次的 91 token，记账链路正常。

### ✅ 6. 停止与重启

| 操作 | 实际结果 |
|---|---|
| 停止进程 | 端口 15788 立即释放 |
| 重新启动（只传 1 个 Key） | `{"status":"ok","accounts":1}` |

**结论**：可反复开关；环境变量优先级正确（只传 1 个就只加载 1 个）。

### ✅ 7. 与生产实例互不干扰

测试全程使用 15788 端口，开发者本机 15722 的生产代理**一直在正常运行**，未受影响。

## DSH 插件部分

插件已在开发者本机验证（同一套代码）：

| 验证点 | 结果 |
|---|---|
| Host 转发服务 | `curl http://127.0.0.1:15799/keys` → `{"ok":true,"available":6,"total":6}` |
| Client 注册 | 已注册到 `conversation.composer.dock`（order 50, active） |
| 安装流程 | `plugin_manager install_bundle` → `application: applied` |

## 未覆盖 / 已知限制

| 项目 | 说明 |
|---|---|
| **未在"全新机器"上测** | 本次是隔离目录，不是新装系统。Node.js 安装环节未实测 |
| **未测 macOS / Linux** | 只在 Windows 11 验证 |
| **未测 DSH 插件的一键安装** | `dsh plugin add` 需要包已发布到 npm，当前未发布 |
| **未做高并发压测** | 只验证了单请求可用性 |
| **限流行为未复现** | 测试时 Key 额度充足，没有触发 429 分支 |

## 结论

**核心路径可用**：陌生人按 README 能装起来、能通、能看状态。

**待补**：发布到 GitHub 后，应请一位真实用户（不同机器）完整走一遍，重点验证"没有 Node.js 的环境"和"DSH 插件一键安装"。
