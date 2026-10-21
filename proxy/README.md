# proxy · zhaoyu 的多 Key 轮询代理

纯 Node.js 实现，**零第三方依赖**（只用 `http`/`https`/`fs`/`path` 内置模块）。

## 文件

| 文件 | 用途 |
|---|---|
| `sensenova-multikey-proxy.js` | 代理主体 |
| `start-proxy.bat` | Windows 启动器（含清理旧进程逻辑） |
| `install-autostart.bat` | 一键安装开机自启（双击一次，以后随 Windows 启动） |
| `uninstall-autostart.bat` | 移除开机自启 |
| `stop-proxy.bat` | 停止正在运行的代理 |
| `unblock-files.bat` | 去掉「来自互联网」标记，消除「未知发布者」弹窗 |

## 配置 Key 的三种方式

优先级从高到低：

1. **环境变量** `SENSENOVA_API_KEY_1` … `SENSENOVA_API_KEY_20`
2. **环境变量** `SENSENOVA_API_KEY`（单个）
3. **`~/.dsh/.credentials.yaml`** 的 `refs` 下：

```yaml
refs:
  SENSENOVA_API_KEY: sk-第一个
  SENSENOVA_API_KEY_1: sk-第二个
  SENSENOVA_API_KEY_2: sk-第三个
```

> ⚠️ 同一个商汤账号下建多个 Key **共享额度**，所以每个 Key 要来自**不同账号**才有效果。

## 启动

```bash
node sensenova-multikey-proxy.js
```

Windows 可双击 `start-proxy.bat`（它会先清理占用 15722 的旧进程，再启动）。

## 检查

```bash
curl http://127.0.0.1:15722/health   # 存活检查
curl http://127.0.0.1:15722/status   # 每个 Key 的详细状态
```

`/status` 返回示例：

```json
{
  "activeRequests": 0,
  "total429s": 12,
  "totalKeys": 6,
  "availableNow": 5,
  "keys": [
    { "key": "sk-eMv****EEBz", "available": true, "cooldownRemaining": 0,
      "consecutiveErrors": 0, "tpmWindowTokens": 128, "requests": 9, "errors": 1 }
  ]
}
```

## 可调参数（脚本顶部）

| 常量 | 默认 | 含义 |
|---|---|---|
| `PROXY_PORT` | `15722` | 监听端口 |
| `COOLDOWN_BASE_MS` | `45000` | Key 撞限流后首次冷却时长 |
| `COOLDOWN_MAX_MS` | `120000` | 冷却上限（**必须小于 `REQUEST_DEADLINE_MS`**） |
| `MAX_KEY_ATTEMPTS` | `12` | 单请求最多试几个 Key |
| `WAIT_KEY_MAX_MS` | `100000` | 等 Key 恢复的上限，超时即返回错误 |
| `MAX_INFLIGHT_PER_KEY` | `4` | 每 Key 允许的并发请求数 |

**改参数时注意**：`COOLDOWN_MAX_MS < REQUEST_DEADLINE_MS` 是硬约束。冷却上限一旦超过单请求预算，请求会在"所有 Key 都冷却"时立刻返回 503，等于代理不可用。

---

<sub>by **zhaoyu** · [zhaoyu-sensenova-duokey](https://github.com/SUJIElearning/zhaoyu-sensenova-duokey)</sub>
