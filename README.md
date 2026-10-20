# sensenova-duokey · zhaoyu 的商汤多Key轮询

> 把多个商汤（SenseNova）账号的 API Key 变成一个统一的 OpenAI 兼容端点。
> 一个 Key 被限流自动换下一个，全部限流就安静等待——不再频繁报 429/503。
>
> **作者：zhaoyu** · [GitHub](https://github.com/SUJIElearning)

## 为什么需要它

商汤的 API 限流是**按账号/Key** 计算的。只挂一个 Key 时：

- 聊几轮深度思考就撞限流（`tpm exhausted` / `EndpointTPMExceeded`）
- 高峰期频繁 429，客户端一直重试、对话一直中断
- 智能体（Agent）多轮工具调用更是雪上加霜

多挂几个账号的 Key，让代理帮你轮询，就能把额度叠起来用，而且**单个 Key 撞墙时不影响整体**。

## 两个包

| 目录 | 是什么 | 谁需要 |
|---|---|---|
| [`proxy/`](./proxy) | 多 Key 轮询代理（纯 Node.js，零依赖） | **所有人**（任何 OpenAI 兼容客户端） |
| [`dsh-plugin/`](./dsh-plugin) | DSH 的 Key 状态观察窗口（对话框下方显示 `● 5/6 Key`） | 用 DeepSeek Harness 的人（可选） |

## 快速开始

### 方式一：让 AI 帮你装（推荐，DSH 用户）

把这两句话发给你的 DSH：

> 帮我安装 `sensenova-duokey` 技能，仓库地址：
> `https://github.com/SUJIElearning/sensenova-duokey`

AI 会读取仓库里的 `SKILL.md`，自动完成：下载脚本 → 问你收集 Key → 写好配置 → 启动 → 验证。

### 方式二：手动装

```bash
# 1. 下载
git clone https://github.com/SUJIElearning/sensenova-duokey.git
cd sensenova-duokey/proxy

# 2. 配 Key（Windows 用 start-proxy.bat 里的 set 行；macOS/Linux 用环境变量）
set SENSENOVA_API_KEY_1=sk-你的第一个Key
set SENSENOVA_API_KEY_2=sk-你的第二个Key

# 3. 启动
node sensenova-multikey-proxy.js
```

看到这行就成功了：

```
 监听地址:  http://127.0.0.1:15722
 已加载:    2 个账户 Key
```

### 方式三：DSH 一键装观察窗口

```bash
dsh plugin add @sujielearning/dsh-sensenova-key-status
```

装完对话框下方会多一行 `● 5/6 Key`，绿=全好、黄=部分限流、红=全部耗尽。

## 客户端怎么接

把任何 OpenAI 兼容客户端的 Base URL 改成：

```
http://127.0.0.1:15722/v1
```

API Key 填任意一个真实的商汤 Key 即可（代理会自己轮换）。

模型名用商汤的：`deepseek-flash`、`deepseek-v4-flash`、`glm-5.2`、`kimi-k3` 等。

## 常用操作

```bash
# 看健康状态
curl http://127.0.0.1:15722/health

# 看每个 Key 的详细状态（可用/冷却中/累计错误）
curl http://127.0.0.1:15722/status

# 加 Key：往配置里追加一行，然后重启代理
```

## 它做了什么（工作原理）

```
你的客户端 ──→ 本地代理(15722) ──→ 商汤 API
                    │
                    ├─ 按"最近消耗最少"选 Key
                    ├─ 撞 429 → 该 Key 冷却 45-120 秒
                    ├─ 其余 Key 顶上，最多试 12 次
                    └─ 全部不可用 → 等最多 100 秒再放弃
```

- **不是魔法**：它不能突破商汤给你的物理额度上限，只是把多个账号的额度叠起来用，并且避免"白白撞墙"
- **零依赖**：只用 Node.js 内置模块，不需要 `npm install`
- **不存数据**：只在本机转发，Key 只存在你本地的配置文件里

## 限度说明（诚实版）

- 它救不了"额度真的不够"：如果 6 个账号都耗尽，还是得等或加账号
- 长对话特别吃额度：商汤把 prompt token 也算进限流，几十轮对话单次请求就可能几万 token
- 单 Key 撞墙后恢复要几分钟（实测 8-10 分钟全组恢复），代理能做的是"不等死、换人上"

## 许可

[MIT](./LICENSE) — 随便用、随便改、商用也行，出事别找我。

---

<sub>by **zhaoyu** · [sensenova-duokey](https://github.com/SUJIElearning/sensenova-duokey)</sub>
