# dsh-plugin · zhaoyu 的 Key 状态观察窗口（可选）

DeepSeek Harness 的客户端插件，在**对话框下方**显示一行实时状态：

```
● 5/6 Key
```

绿 = 全部可用，黄 = 部分限流，红 = 全部耗尽。

## 前提

必须先装好 `proxy/` 并让它跑在 `127.0.0.1:15722`。这个插件只是"显示"，不提供代理功能。

## 安装

```bash
dsh plugin add @sujielearning/dsh-sensenova-key-status
```

或用本地目录（开发/试用）：

让 DSH 用 `plugin_manager` 的 `install_bundle` 安装本目录的绝对路径。

## 它怎么工作

```
代理 :15722/status ──→ 本插件 Host 端(:15799, 加 CORS) ──→ 浏览器 fetch ──→ 渲染
```

- **Host 端**（`index.js`）：监听 `127.0.0.1:15799`，把代理的 `/status` 转成 `{ok, available, total}` 并加上 CORS 头。浏览器直接读 `:15722` 会被 CORS 挡住，所以需要这一层。
- **Client 端**（`client.js`）：注册到 `conversation.composer.dock` 槽位，每 5 秒轮询一次。

Key 总数是**动态读取**的：以后你在代理里加 Key，这里会自动跟着变。

## 文件

| 文件 | 用途 |
|---|---|
| `package.json` | 包声明（`dsh.bundle` 补丁 + `dsh.client` 客户端模块） |
| `cordis.patch.yml` | 把这个插件插进 profile |
| `index.js` | Host 端转发服务 |
| `client.js` | Client 端 UI |
| `icon.svg` | 图标 |

## 排查

| 现象 | 检查 |
|---|---|
| 不显示 | 代理是否在跑？`curl http://127.0.0.1:15722/health` |
| 一直不出现 | `curl http://127.0.0.1:15799/keys` 看 Host 转发是否工作 |
| 显示的数字不动 | 刷新页面；确认代理 `/status` 的 `availableNow` 在变 |

## 卸载

```bash
dsh plugin remove @sujielearning/dsh-sensenova-key-status
```

---

<sub>by **zhaoyu** · [zhaoyu-sensenova-duokey](https://github.com/SUJIElearning/zhaoyu-sensenova-duokey)</sub>
