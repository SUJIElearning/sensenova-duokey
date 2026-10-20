// ─────────────────────────────────────────────────────────────
//  商汤 SenseNova 多账户智能代理 (sensenova-duokey)
//  监听 127.0.0.1:15722,转发到 token.sensenova.cn
//  特性:多账户 Key 轮询 + 429 自动切换 + 按实测恢复时间冷却
//
//  作者 / Author: zhaoyu
//  仓库 / Repo:   https://github.com/SUJIElearning/sensenova-duokey
// ─────────────────────────────────────────────────────────────
//
// 用法:
//   1. 在 start-proxy.bat 里设置 Key,或写进 ~/.dsh/.credentials.yaml
//   2. 双击 start-proxy.bat 启动
//   3. 客户端 Base URL 指向 http://127.0.0.1:15722/v1
//
// 水印会在启动横幅中再次出现（见文件末尾的 banner）。
// ─────────────────────────────────────────────────────────────

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============ 配置 ============
const PROXY_PORT = 15722;
const UPSTREAM_HOST = 'token.sensenova.cn';
const UPSTREAM_PORT = 443;

// 429 冷却配置
// 【2026-10-20 v3 修正】v2 用 90-150 秒冷却,配合 30 秒等待上限 =
// 永远等不到 Key 恢复就 503,用户体感"频繁中断、一直重试"。
// 实测观察:单个 Key 撞墙后往往 30-60 秒就能恢复(全组耗尽才需要 8-10 分钟)。
// 因此:45 秒起步、翻倍封顶 120 秒,与 100 秒等待上限配合,
// 让请求有机会等到某个 Key 回血,而不是一撞就死。
//
// 【必须守住的不变量】COOLDOWN_MAX_MS < REQUEST_DEADLINE_MS
// 原因:handle() 在"所有 Key 都在冷却"时会等到最早解冻的那个 Key。
// 若冷却上限超过单请求预算,earliest >= deadline 恒成立,请求会
// 不等任何时间就直接 503——这正是 v1 版本"重启后完全不可用"的根因。
const COOLDOWN_BASE_MS = 45000;       // 被限流后先休息 45s
const COOLDOWN_MAX_MS = 120000;       // 最长休息 120s (必须小于 REQUEST_DEADLINE_MS)
const COOLDOWN_ESCALATE = 2;          // 连续限流时冷却翻倍:45→90→120s(封顶)
const COOLDOWN_DECAY_STEP = 1;        // 每次冷却结束衰减失败计数,防止"死亡螺旋"
const RETRY_GAP_MS = 800;             // 换 Key 重试前的最小间隔,避免毫秒级连打所有 Key
const AUTH_PROBE_MS = 120000;         // 认证失败后 2 分钟探测一次
const REQUEST_DEADLINE_MS = 240000;   // 单请求总预算 4 分钟 (小于 DSH 的 5 分钟流超时)

// 单次用户请求内最多换几个 Key 尝试。
// 【2026-10-20 v3 修正】v2 设成 2,实际效果很差:当 6 个 Key 里有 3 个可用、
// 3 个在冷却时,试 2 个可能恰好都撞上冷却中的,于是直接 503,而另外 3 个
// 好好的 Key 根本没被用过 → 用户看到"频繁中断、一直重试"。
// 正确做法:每个 Key 撞墙后会被冷却,所以"试遍所有 Key"不会重复撞同一个,
// 一轮最多 6 次 × 800ms ≈ 5 秒,却能把成功率拉到最高。
const MAX_KEY_ATTEMPTS = 12;

// 等 Key 恢复的最长时间。
// 【v3 修正】v2 取 30 秒,但冷却要 90 秒才结束 → 永远等不到就失败。
// 改成 100 秒:足够覆盖一个冷却周期,又不至于让用户等到 DSH 超时。
const WAIT_KEY_MAX_MS = 100000;

// 同一个 Key 允许的并发在途请求数。
// 【为什么必须 > 1】用户的实际用法是「同时开多个 DSH 对话」,每个对话都是一个
// 长时流式请求(推理模型"思考"一次可达数分钟)。若锁死为 1,则:
//   6 个 Key × 1 = 池子总槽位仅 6 个,开满 6 个对话即全池占满,
//   第 7 个请求只能干等;此时任一在途请求若撞上 429,该 Key 立刻进冷却,
//   可用槽位瞬间跌破临界 → 新请求等到预算耗尽 → 503。
// 而实测商汤上游对单 Key 并发毫无限制(6 Key 并发全 200、单 Key 连发 5 次全 200),
// 真正的限流只发生在"分钟级配额"维度,由 429 冷却机制处理即可。
// 因此把每 Key 槽位放宽到 4,总并发能力 = 6 × 4 = 24 个对话。
const MAX_INFLIGHT_PER_KEY = 4;

// ============ TPM 记账(仅观测,不用于跳过) ============
// 【2026-10-20 v2 重要修正】
// v1 曾用"60秒窗口 + 累计超 280t 就跳过该 Key"做预判式限流。
// 经 GLM-5.2 / Kimi K3 双模型审查,该思路在长对话场景下【不成立】:
//   · 真实长对话单次请求 prompt 可达数万 token,远超任何能拍出来的阈值
//   · 阈值小于单次请求 → 6 个 Key 一次对话全被打满 → 全部跳过 → 反而更惨
//   · 阈值大于单次请求 → 等于不生效,白折腾
// 结论(两模型一致):"不预测,只反应"——不做请求前跳过,只保留记账用于观察,
// 真正的限流响应交给 429 冷却(90-150s)+ 单请求最多试 2 个 Key。
// 因此 TPM_SKIP_THRESHOLD 设为极大值(=关闭跳过),记账逻辑保留。
const TPM_WINDOW_MS = 600000;                        // 观测窗口 10 分钟(匹配实测恢复时间)
const TPM_LIMIT_PER_KEY = 350;                       // 仅作展示参考
const TPM_SKIP_THRESHOLD = Number.MAX_SAFE_INTEGER;  // 关闭预跳过(v2 核心改动)

// 5xx 重试 (单请求内重试,不阻塞其他请求)
const MAX_5XX_RETRIES = 2;
const RETRY_5XX_WAIT_MS = 2000;

// ============ API Key 管理 ============

function loadApiKeys() {
  const keys = [];

  // 1. 从环境变量读取 SENSENOVA_API_KEY_1, _2, _3 ...
  for (let i = 1; i <= 20; i++) {
    const key = process.env[`SENSENOVA_API_KEY_${i}`];
    if (key && key.trim()) {
      keys.push(key.trim());
    }
  }

  // 2. 降级:尝试 SENSENOVA_API_KEY
  if (keys.length === 0) {
    const singleKey = process.env['SENSENOVA_API_KEY'];
    if (singleKey && singleKey.trim()) {
      keys.push(singleKey.trim());
    }
  }

  // 3. 如果还没有,从 .credentials.yaml 读取 (跳过注释行)
  if (keys.length === 0) {
    try {
      const homeDir = process.env['USERPROFILE'] || process.env['HOME'];
      const credPath = path.join(homeDir, '.dsh', '.credentials.yaml');
      if (fs.existsSync(credPath)) {
        const content = fs.readFileSync(credPath, 'utf8');
        const lines = content.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          // 跳过空行和注释行
          if (!trimmed || trimmed.startsWith('#')) continue;
          const match = trimmed.match(/^SENSENOVA_API_KEY(?:_\d+)?:\s*(.+)/);
          if (match) {
            const key = match[1].trim().replace(/["']/g, '');
            if (key) {
              keys.push(key);
            }
          }
        }
      }
    } catch (e) {
      // 忽略
    }
  }

  return keys;
}

function maskKey(key) {
  if (key.length <= 8) return key.substring(0, 4) + '****';
  return key.substring(0, 6) + '****' + key.substring(key.length - 4);
}

// ============ 多 Key 管理器 ============

class KeyManager {
  constructor(keys) {
    this.keys = keys;
    this.roundRobin = 0;
    this.states = keys.map(key => ({
      key,
      masked: maskKey(key),
      available: true,
      cooldownUntil: 0,
      consecutiveErrors: 0,
      authFailed: false,            // 是否被标记为认证失败
      probeTimer: null,             // 探测定时器
      inFlight: 0,                  // 当前在途请求数(防止并发打爆同一个 Key)
      tokenWindow: [],              // TPM记账:近60秒该Key消耗的token [{t, tokens}]
      totalRequests: 0,
      totalErrors: 0,
    }));
  }

  // 获取当前可用的 Key (排除在途占用)
  getAvailableKeys() {
    const now = Date.now();
    for (const s of this.states) {
      if (!s.available && !s.authFailed && s.cooldownUntil < now) {
        s.available = true;
        // 冷却结束 = 已经乖乖等够了惩罚时间,应当衰减失败计数。
        // 若不衰减,一次启动风暴会让所有 Key 的 consecutiveErrors 一路累加,
        // 冷却时间被推向 120s 上限,再也降不回来(死亡螺旋)。
        if (s.consecutiveErrors > 0) {
          s.consecutiveErrors = Math.max(0, s.consecutiveErrors - COOLDOWN_DECAY_STEP);
        }
        console.log(`[KEY] ${s.masked} 冷却结束(剩余失败计数${s.consecutiveErrors})`);
      }
    }
    return this.states.filter(s => s.available && !s.authFailed && s.inFlight < MAX_INFLIGHT_PER_KEY);
  }

  // 未被限流/未被封的 Key 数量(用于日志,反映"池子健康度")
  getHealthyCount() {
    return this.states.filter(s => s.available && !s.authFailed).length;
  }

  // 轮询选一个 Key (选中即标记占用,请求结束必须 releaseKey)
  //
  // 返回的是「一次占用凭证」而非 Key 状态对象本身。
  // 原因:同一个 Key 可能被并发 pick 多次,若直接返回状态对象引用,
  // 两次占用会共享同一个 releaseToken 字段 —— 第一次 release 核销掉后,
  // 第二次 release 就会被误判为"重复释放"而丢弃,导致 inFlight 只增不减、
  // 槽位永久泄漏(实测 3 Key×3 并发泄漏了 3 个槽)。
  // 因此每次占用都发放一个独立的凭证对象,一对一核销。
  pickKey() {
    // 先走冷却解封逻辑(getAvailableKeys 会把到期的 Key 置为可用)
    const available = this.getAvailableKeys();
    if (available.length === 0) return null;

    // 在可用 Key 里按 TPM 剩余额度排序:窗口消耗少的优先(避免撞 TPM 墙)
    const usable = available.map(s => ({ state: s, used: this.windowTokenCount(s) }));
    usable.sort((a, b) => a.used - b.used);
    // 预算最好的前一半里轮询,避免总选同一个(兼顾 TPM 与均匀性)
    const topN = Math.max(1, Math.ceil(usable.length / 2));
    const pool = usable.slice(0, topN);
    const idx = this.roundRobin % pool.length;
    const state = pool[idx].state;
    this.roundRobin = (idx + 1) % pool.length;
    state.inFlight++;
    return { state, masked: state.masked, key: state.key, released: false };
  }

  // 释放 Key 占用 (成功/失败/换 Key 都必须调用,否则该 Key 永久占满名额)
  //
  // 凭证一对一核销:同一次占用重复调用 releaseKey 只会生效一次,
  // 既不会把 inFlight 扣成负值(伪造空闲槽位),也不会漏减(槽位泄漏)。
  releaseKey(handle) {
    if (!handle || handle.released) return;
    handle.released = true;
    const state = handle.state;
    if (state && state.inFlight > 0) state.inFlight--;
    // 有槽位空出 → 立刻唤醒正在排队等 Key 的请求
    this.notifySlotFreed();
  }

  // 所有 Key 都在冷却/TPM耗尽时,最早可能重新拿到 Key 的时间
  earliestAvailableAt() {
    const now = Date.now();
    let earliest = Infinity;
    for (const s of this.states) {
      if (s.authFailed) continue;
      // 可用 + 槽位有空 + TPM 未耗尽 → 现在就能用
      if (s.available && s.inFlight < MAX_INFLIGHT_PER_KEY && this.windowTokenCount(s) < TPM_SKIP_THRESHOLD) return now;
      // 关键修复:TPM 已耗尽(但冷却没触发)的 Key 不能视为 now 可用,
      // 否则请求会在 handle 里"空转"——pickKey 每次都跳过它,却不等待。
      const readyAt = Math.max(
        s.cooldownUntil,
        s.tokenWindow.length > 0 ? Math.min(...s.tokenWindow.map(e => e.t)) + TPM_WINDOW_MS : now,
        now + 200
      );
      if (readyAt < earliest) earliest = readyAt;
    }
    return earliest;
  }

  // 是否"纯粹因为槽位被占满"而暂时拿不到 Key(而非冷却/认证失败)
  isSlotBound() {
    for (const s of this.states) {
      if (s.authFailed) continue;
      if (s.available && s.inFlight < MAX_INFLIGHT_PER_KEY) return false;
      // 存在已解冻但槽位满的 Key → 瓶颈是并发槽位,不是限流
      if (s.available && s.cooldownUntil <= Date.now()) return true;
    }
    return false;
  }

  // 等待一个槽位释放(事件驱动)。
  // 长流式请求可能持续数分钟,而槽位满时 cooldownUntil 是 0,
  // 纯轮询会空转到预算耗尽才 503。这里改为"释放时立即唤醒",
  // 让排队的请求以毫秒级精度接上刚空出的槽位。
  waitForSlot(timeoutMs) {
    if (this._slotWaiters == null) this._slotWaiters = [];
    if (this.getAvailableKeys().length > 0) return Promise.resolve();
    return new Promise((resolve) => {
      let finished = false;
      const waiter = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        const i = this._slotWaiters.indexOf(waiter);
        if (i >= 0) this._slotWaiters.splice(i, 1);
        resolve();
      }, Math.max(timeoutMs, 100));
      this._slotWaiters.push(waiter);
    });
  }

  // 唤醒所有等待槽位的请求(在有 Key 被释放时调用)
  notifySlotFreed() {
    if (!this._slotWaiters || this._slotWaiters.length === 0) return;
    const waiters = this._slotWaiters;
    this._slotWaiters = [];
    for (const w of waiters) {
      try { w(); } catch (_) {}
    }
  }

  // 标记 Key 被限流
  // 指数退避:同一账户连续被限流时,休息时间逐次翻倍
  // 第1次 20s → 第2次 40s → 第3次 80s → 上限 120s
  // 上限刻意压在 REQUEST_DEADLINE_MS 之下,保证单请求预算内一定能等到它解冻。
  markRateLimited(keyObj, retryAfterHeader) {
    keyObj.consecutiveErrors++;
    keyObj.totalErrors++;

    const exponent = Math.min(keyObj.consecutiveErrors - 1, 5);
    let waitMs = Math.min(COOLDOWN_BASE_MS * Math.pow(COOLDOWN_ESCALATE, exponent), COOLDOWN_MAX_MS);

    // 服务端给了 retry-after 且更长时,以服务端为准(但不超过上限)
    if (retryAfterHeader) {
      const seconds = parseInt(retryAfterHeader, 10);
      if (!isNaN(seconds) && seconds > 0) {
        waitMs = Math.max(waitMs, Math.min(seconds * 1000, COOLDOWN_MAX_MS));
      }
    }

    keyObj.available = false;
    keyObj.cooldownUntil = Date.now() + waitMs;

    // 如果是认证失败期间被限流,清除认证标记(说明 Key 能用,只是被限了)
    if (keyObj.authFailed) {
      keyObj.authFailed = false;
      if (keyObj.probeTimer) {
        clearTimeout(keyObj.probeTimer);
        keyObj.probeTimer = null;
      }
    }

    console.log(`[429] ${keyObj.masked} 休息 ${Math.round(waitMs/1000)}s (该账户连续第${keyObj.consecutiveErrors}次, 未限流:${this.getHealthyCount()}/${this.keys.length})`);
  }

  // 标记 Key 认证失败 (无效 Key),2 分钟后探测是否恢复
  markAuthFailed(keyObj) {
    keyObj.available = false;
    keyObj.authFailed = true;
    keyObj.consecutiveErrors++;
    keyObj.totalErrors++;
    console.log(`[AUTH] ${keyObj.masked} 认证失败,${AUTH_PROBE_MS/1000}s 后探测恢复`);
    this.scheduleProbe(keyObj);
  }

  // 定时探测一个认证失败的 Key
  scheduleProbe(keyObj) {
    if (keyObj.probeTimer) return; // 已有定时器,不重复
    keyObj.probeTimer = setTimeout(() => {
      keyObj.probeTimer = null;
      // 若已被其他路径解封,不再探测
      if (!keyObj.authFailed) return;
      this.probeKey(keyObj);
    }, AUTH_PROBE_MS);
  }

  // 探测 Key 是否恢复:发一个最小请求
  probeKey(keyObj) {
    const body = JSON.stringify({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
    });

    const req = https.request({
      hostname: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${keyObj.key}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (res) => {
      const status = res.statusCode;
      res.resume(); // 丢弃响应体
      res.on('end', () => {
        if (status >= 200 && status < 300) {
          // 恢复成功
          keyObj.authFailed = false;
          keyObj.available = true;
          keyObj.consecutiveErrors = 0;
          console.log(`[PROBE] ${keyObj.masked} 已恢复,解封!`);
        } else if (status === 429) {
          // 不是认证问题,是限流:按限流处理
          keyObj.authFailed = false;
          console.log(`[PROBE] ${keyObj.masked} 返回 429(限流),按限流解冻`);
          this.markRateLimited(keyObj, res.headers['retry-after']);
        } else {
          // 仍失败,继续定时探测
          console.log(`[PROBE] ${keyObj.masked} 仍失败(${status}),${AUTH_PROBE_MS/1000}s 后再试`);
          this.scheduleProbe(keyObj);
        }
      });
    });

    req.on('error', (e) => {
      console.log(`[PROBE] ${keyObj.masked} 网络错误: ${e.message},${AUTH_PROBE_MS/1000}s 后再试`);
      this.scheduleProbe(keyObj);
    });
    req.on('timeout', () => {
      req.destroy();
      console.log(`[PROBE] ${keyObj.masked} 探测超时,${AUTH_PROBE_MS/1000}s 后再试`);
      this.scheduleProbe(keyObj);
    });

    req.write(body);
    req.end();
  }

  markSuccess(keyObj) {
    keyObj.consecutiveErrors = 0;
    keyObj.totalRequests++;
    // 能成功说明 Key 是好的,清除认证失败标记
    if (keyObj.authFailed) {
      keyObj.authFailed = false;
      keyObj.available = true;
      if (keyObj.probeTimer) {
        clearTimeout(keyObj.probeTimer);
        keyObj.probeTimer = null;
      }
      console.log(`[KEY] ${keyObj.masked} 请求成功,撤销认证失败标记`);
    }
  }

  // ============ TPM 记账(2026-10-20 新增,防推理模型撞 TPM 墙) ============
  // 成功响应后调用:把本次消耗的 token 记入该 Key 的 60 秒滑动窗口。
  // 注意:无论请求是成功还是部分成功(如 max_tokens 截断),usage 都代表真实消耗,
  // 都应记账;只有完全拿不到 usage(异常)才不记,避免低估。
  recordTokenUsage(keyObj, totalTokens) {
    if (!keyObj || !Number.isFinite(totalTokens) || totalTokens <= 0) return;
    const now = Date.now();
    // 清理 60 秒窗口外的旧记录
    keyObj.tokenWindow = keyObj.tokenWindow.filter(e => now - e.t < TPM_WINDOW_MS);
    keyObj.tokenWindow.push({ t: now, tokens: totalTokens });
  }

  // 该 Key 在当前 60 秒窗口内累计消耗的 token
  windowTokenCount(keyObj) {
    const now = Date.now();
    // 顺带清理过期记录,避免数组无限增长
    if (keyObj.tokenWindow.length > 0) {
      keyObj.tokenWindow = keyObj.tokenWindow.filter(e => now - e.t < TPM_WINDOW_MS);
    }
    let sum = 0;
    for (const e of keyObj.tokenWindow) sum += e.tokens;
    return sum;
  }

  // 该 Key 是否已被 TPM 窗口额度"接近耗尽"→ 应跳过
  isTpmExhausted(keyObj) {
    return this.windowTokenCount(keyObj) >= TPM_SKIP_THRESHOLD;
  }

  // 在当前窗口内"剩余 token 额度最多"的 Key(优先选择)
  // 返回按剩余额度从大到小排序的可选 Key 列表
  pickByTpmBudget() {
    const candidates = [];
    for (const s of this.states) {
      if (!s.available || s.authFailed || s.inFlight >= MAX_INFLIGHT_PER_KEY) continue;
      candidates.push({ state: s, used: this.windowTokenCount(s) });
    }
    // 升序:窗口消耗少的排前面(即剩余额度多的)
    candidates.sort((a, b) => a.used - b.used);
    return candidates;
  }

  // 所有 TPM 窗口都接近耗尽时,最早"窗口滑出"的时间(用于等待)
  earliestWindowFreeAt() {
    let earliest = Infinity;
    for (const s of this.states) {
      if (s.authFailed) continue;
      if (s.inFlight < MAX_INFLIGHT_PER_KEY && this.windowTokenCount(s) < TPM_SKIP_THRESHOLD) return Date.now();
      // 估最早一条记录移出窗口的时间
      if (s.tokenWindow.length > 0) {
        const oldest = Math.min(...s.tokenWindow.map(e => e.t));
        const freeAt = oldest + TPM_WINDOW_MS;
        if (freeAt < earliest) earliest = freeAt;
      } else {
        if (Date.now() < earliest) earliest = Date.now();
      }
    }
    return earliest;
  }

  getStatus() {
    const now = Date.now();
    const totalSlots = this.keys.length * MAX_INFLIGHT_PER_KEY;
    let usedSlots = 0;
    for (const s of this.states) usedSlots += s.inFlight;
    return {
      totalKeys: this.keys.length,
      availableNow: this.getAvailableKeys().length,
      // 池子容量视角:一眼看出"是不是并发槽位用满了"
      totalSlots: totalSlots,
      usedSlots: usedSlots,
      freeSlots: totalSlots - usedSlots,
      maxInflightPerKey: MAX_INFLIGHT_PER_KEY,
      keys: this.states.map(s => ({
        key: s.masked,
        available: s.available && !s.authFailed && s.inFlight < MAX_INFLIGHT_PER_KEY && this.windowTokenCount(s) < TPM_SKIP_THRESHOLD,
        busy: s.inFlight > 0,
        inFlight: s.inFlight,
        authFailed: s.authFailed,
        cooldownRemaining: s.available && !s.authFailed ? 0 : Math.max(0, Math.ceil((s.cooldownUntil - now) / 1000)),
        consecutiveErrors: s.consecutiveErrors,
        tpmWindowTokens: this.windowTokenCount(s),
        requests: s.totalRequests,
        errors: s.totalErrors,
      })),
    };
  }
}

// ============ 并发请求处理器 ============
// 每个请求独立转发,不排队。429 时在同一请求内换 Key 重试。

class RequestQueue {
  constructor(keyManager) {
    this.keyManager = keyManager;
    this.activeRequests = 0;
    this.total429s = 0;
    this.total5xxs = 0;
  }

  // 处理一个请求 (并发,不阻塞其他请求)
  async handle(req, res, body, startTime) {
    this.activeRequests++;

    // 单请求总预算。必须大于 COOLDOWN_MAX_MS —— 否则"所有 Key 都冷却"时
    // earliest >= deadline 恒成立,请求不等任何时间就 503(这正是上一版的致命 bug)。
    const deadline = Date.now() + REQUEST_DEADLINE_MS;
    // 【v2 快速失败】等 Key 恢复最多等这么久,超过就立刻返回错误,
    // 不让用户对着一个转圈等 4 分钟。GLM-5.2/Kimi K3 审查共同建议:
    // 宁可快速告知"资源繁忙",也别让用户干等一个不确定的结果。
    const waitKeyDeadline = Date.now() + WAIT_KEY_MAX_MS;
    let attempts = 0;

    // 注入 stream_options.include_usage,让商汤流式响应在末尾返回 usage chunk,
    // 代理才能据此做 TPM 记账(用于观察各 Key 的真实消耗)。
    // 只对 JSON 请求体且原本未声明时注入;解析失败则原样透传,不阻塞请求。
    let fwdBody = body;
    if (Buffer.isBuffer(body) && body.length > 0) {
      try {
        const parsed = JSON.parse(body.toString('utf8'));
        if (parsed && typeof parsed === 'object' && !(parsed.stream_options && parsed.stream_options.include_usage)) {
          parsed.stream_options = { ...(parsed.stream_options || {}), include_usage: true };
          fwdBody = Buffer.from(JSON.stringify(parsed), 'utf8');
        }
      } catch (_) { /* 非 JSON,原样转发 */ }
    }

    try {
      while (Date.now() < deadline) {
        // 已试够 Key 个数 → 快速失败,不再死磕
        if (attempts >= MAX_KEY_ATTEMPTS) {
          console.log(`[FAST-FAIL] 已尝试 ${attempts} 个 Key 均被限流,快速返回错误`);
          break;
        }

        const keyObj = this.keyManager.pickKey();

        if (!keyObj) {
          // 拿不到 Key 有两种截然不同的原因,处理方式也不同:
          //  (a) 槽位被长流式请求占满 → 事件驱动等待,槽位一空立刻接上
          //  (b) 所有 Key 都在 429 冷却 → 等到最早解冻时刻
          const budget = deadline - Date.now();
          if (budget <= 0) break;

          // 等 Key 的时间超过快速失败上限 → 不再等,直接返回错误
          if (Date.now() >= waitKeyDeadline) {
            console.log(`[FAST-FAIL] 无可用 Key 且已等待超过 ${Math.round(WAIT_KEY_MAX_MS / 1000)}s,快速返回`);
            break;
          }

          if (this.keyManager.isSlotBound()) {
            // 瓶颈是并发槽位。长请求可能持续数分钟,必须事件驱动等待,
            // 否则轮询会一路空转到 240s 预算耗尽才 503。
            console.log(`[WAIT] 并发槽位已满(${this.activeRequests} 个对话在跑),排队等待空位...`);
            await this.keyManager.waitForSlot(Math.min(budget, 5000));
            continue;
          }

          const earliest = this.keyManager.earliestAvailableAt();
          if (earliest === Infinity) break;
          const waitMs = Math.min(
            Math.max(earliest - Date.now(), 100),
            budget,
            1000,
            Math.max(0, waitKeyDeadline - Date.now())
          );
          if (waitMs <= 0) break;
          await sleep(waitMs);
          continue;
        }

        attempts++;
        let result;
        try {
          result = await this.sendOnce(req, res, fwdBody, keyObj, startTime);
        } finally {
          // 成功/失败/换 Key 都必须释放占用,否则该 Key 名额被永久占住
          this.keyManager.releaseKey(keyObj);
        }

        if (result === 'ok' || result === 'sent') return;

        // result === 'retry' (429 / 5xx):换 Key 重试前留间隔,
        // 避免毫秒级连打所有 Key(既打不出结果,又会刷新服务端惩罚计时器)。
        await sleep(RETRY_GAP_MS);
      }

      // 预算耗尽或所有 Key 都不可用
      if (!res.headersSent) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'All API keys exhausted or rate-limited', type: 'proxy_error' } }));
      }
    } finally {
      this.activeRequests--;
    }
  }

  // 单次转发尝试 (返回 'ok'/'sent'/'retry')
  // handle 传入的是「占用凭证」,真正的 Key 状态在 handle.state 上。
  sendOnce(req, res, body, handle, startTime) {
    return new Promise((resolve) => {
      const keyObj = handle.state;
      const apiKey = keyObj.key;
      let responded = false; // 防止重复响应
      let settled = false;   // 保证 Promise 只结算一次
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };

      // 客户端在转发开始前就已经断开:直接结算,不占用 Key
      if (res.destroyed || res.writableEnded) { done('sent'); return; }

      const headers = { ...req.headers };
      headers['host'] = UPSTREAM_HOST;
      headers['authorization'] = `Bearer ${apiKey}`;
      delete headers['content-length'];
      delete headers['connection'];

      const options = {
        hostname: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        path: req.url,
        method: req.method,
        headers: headers,
        timeout: 300000,
      };

      const upstreamReq = https.request(options, (upstreamRes) => {
        const status = upstreamRes.statusCode;

        // 429: 标记 Key,换一个重试 (不响应客户端)
        if (status === 429) {
          this.total429s++;
          this.keyManager.markRateLimited(keyObj, upstreamRes.headers['retry-after']);
          upstreamRes.resume(); // 丢弃响应体
          done('retry');
          return;
        }

        // 5xx: 单请求内重试 (最多 MAX_5XX_RETRIES 次)
        if (status >= 500 && status < 600) {
          this.total5xxs++;
          upstreamRes.resume();
          if (attempt5xx(req) <= MAX_5XX_RETRIES) {
            console.log(`[${status}] 5xx,换 Key 重试`);
            done('retry');
          } else {
            console.log(`[${status}] 5xx,超过重试上限,返回错误`);
            responded = true;
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: `Upstream ${status}`, type: 'upstream_error' } }));
            done('sent');
          }
          return;
        }

        // 3xx 重定向: 透传
        if (status >= 300 && status < 400) {
          console.log(`[${status}] 重定向`);
          responded = true;
          res.writeHead(status, upstreamRes.headers);
          upstreamRes.pipe(res);
          upstreamRes.on('end', () => done('sent'));
          upstreamRes.on('error', () => { try { res.end(); } catch (_) {} done('sent'); });
          return;
        }

        // 2xx: 成功,流式透传给客户端,同时扫描 usage 做 TPM 记账
        if (status >= 200 && status < 300) {
          this.keyManager.markSuccess(keyObj);
          const elapsed = Date.now() - startTime;
          // 是否流式响应(SSE):是 → 逐 chunk 透传并扫描 usage;否 → 直接 pipe
          const isStream = String(upstreamRes.headers['content-type'] || '').includes('text/event-stream');
          let usageTokens = 0;

          if (isStream) {
            let buffer = '';
            upstreamRes.on('data', (chunk) => {
              // 原样转发给客户端
              try { res.write(chunk); } catch (_) {}
              // 边转发边扫描 SSE 行,抓 usage chunk(choices 为空、带 usage 的那条)
              buffer += chunk.toString('utf8');
              let nl;
              while ((nl = buffer.indexOf('\n')) >= 0) {
                const line = buffer.substring(0, nl).trim();
                buffer = buffer.substring(nl + 1);
                if (line.startsWith('data:')) {
                  const payload = line.substring(5).trim();
                  if (payload === '[DONE]') continue;
                  try {
                    const j = JSON.parse(payload);
                    if (j.usage && j.usage.total_tokens) usageTokens = j.usage.total_tokens;
                  } catch (_) {}
                }
              }
            });
            upstreamRes.on('end', () => {
              // TPM 记账:把本次消耗 token 记入该 Key 的 60 秒窗口
              this.keyManager.recordTokenUsage(keyObj, usageTokens);
              if (usageTokens > 0) {
                console.log(`[TPM] ${keyObj.masked} +${usageTokens}t (窗口累计 ${this.keyManager.windowTokenCount(keyObj)}t / 预算 ${TPM_LIMIT_PER_KEY}t)`);
              }
              console.log(`[OK] ${elapsed}ms | ${keyObj.masked} | 在途${this.activeRequests}个 (未限流Key ${this.keyManager.getHealthyCount()}/${this.keyManager.keys.length})`);
              try { res.end(); } catch (_) {}
              done('sent');
            });
            upstreamRes.on('error', (e) => {
              console.error(`[ERROR] 上游断开: ${e.message}`);
              try { res.end(); } catch (_) {}
              done('sent');
            });
          } else {
            // 非流式(极少数):直接透传,响应体可整读,尝试从 body 抓 usage
            const bodyChunks = [];
            let bodyTooBig = false;
            upstreamRes.on('data', (c) => {
              if (!bodyTooBig && bodyChunks.length < 262144) bodyChunks.push(c);
              else bodyTooBig = true;
            });
            upstreamRes.on('end', () => {
              if (!bodyTooBig) {
                try {
                  const j = JSON.parse(Buffer.concat(bodyChunks).toString('utf8'));
                  if (j.usage && j.usage.total_tokens) usageTokens = j.usage.total_tokens;
                } catch (_) {}
              }
              this.keyManager.recordTokenUsage(keyObj, usageTokens);
              console.log(`[OK] ${elapsed}ms | ${keyObj.masked} | 非流式${usageTokens ? ' +' + usageTokens + 't' : ''}`);
              responded = true;
              if (!res.headersSent) {
                try { res.writeHead(status, upstreamRes.headers); } catch (_) {}
              }
              try { res.end(bodyTooBig ? Buffer.alloc(0) : Buffer.concat(bodyChunks)); } catch (_) {}
              done('sent');
            });
            upstreamRes.on('error', (e) => {
              console.error(`[ERROR] 上游断开: ${e.message}`);
              if (!res.headersSent) { try { res.writeHead(status, upstreamRes.headers); } catch (_) {} }
              try { res.end(); } catch (_) {}
              done('sent');
            });
          }
          return; // 已自行处理转发与结算,跳过公共透传逻辑
        } else {
          // 非成功状态码:收集响应体,区分"限流过渡态"与"认证失败"
          // 商汤在限流高峰会返回 400 + code 400001("inference request is invalid"),
          // 语义是限流过渡态而非真格式错误。若按 401/403 处理会错杀 Key(封 2 分钟),
          // 正确做法是走 429 冷却路径: 封 15s + 换 Key 重试。
          const bodyChunks = [];
          let bodyTooBig = false;
          upstreamRes.on('data', (c) => {
            if (!bodyTooBig && bodyChunks.length < 131072) bodyChunks.push(c);
            else bodyTooBig = true;
          });
          upstreamRes.on('end', () => {
            const bodyBuf = bodyTooBig ? Buffer.alloc(0) : Buffer.concat(bodyChunks);
            const bodyText = bodyBuf.toString('utf8');
            const isRateLimitTransient = status === 400 && /400001|inference request is invalid/i.test(bodyText);

            if (isRateLimitTransient) {
              // 限流过渡态: 按 429 处理(冷却该 Key + 换 Key 重试,不响应客户端)
              this.total429s++;
              this.keyManager.markRateLimited(keyObj, upstreamRes.headers['retry-after']);
              console.log(`[400001] ${keyObj.masked} 限流过渡态,按 429 冷却并换 Key`);
              done('retry');
              return;
            }

            if (status === 401 || status === 403) {
              // 真认证失败: 封 Key 并定时探测恢复
              console.log(`[${status}] ${keyObj.masked} 认证失败,封 Key`);
              this.keyManager.markAuthFailed(keyObj);
            } else {
              // 其他错误: 透传,但不标记 Key(避免把暂时性错误误判为认证失败)
              console.log(`[${status}] ${keyObj.masked} 非成功状态码,透传`);
            }

            responded = true;
            if (!res.headersSent) {
              try { res.writeHead(status, upstreamRes.headers); } catch (_) {}
            }
            try { res.end(bodyBuf); } catch (_) {}
            done('sent');
          });
          upstreamRes.on('error', (e) => {
            console.error(`[ERROR] 上游断开: ${e.message}`);
            if (!res.headersSent) {
              try { res.writeHead(status, upstreamRes.headers); } catch (_) {}
            }
            try { res.end(); } catch (_) {}
            done('sent');
          });
          return; // 已自行转发,跳过公共透传逻辑
        }
      });

      upstreamReq.on('error', (e) => {
        // 已响应过客户端就不能再换 Key(会重复响应),直接结算
        console.log(`[NET] ${e.message}`);
        done(responded ? 'sent' : 'retry');
      });

      upstreamReq.on('timeout', () => {
        upstreamReq.destroy();
        console.log(`[TIMEOUT] ${keyObj.masked} 超时`);
        done(responded ? 'sent' : 'retry');
      });

      // 客户端提前断开(用户点"停止生成"/关闭页面)时,必须立刻结算本次尝试。
      // 否则 upstreamRes 永远不会触发 'end',Promise 永挂,
      // 该 Key 的 inFlight 名额被永久占死 —— 连续断几次就会锁死整个 Key 池。
      res.on('close', () => {
        if (settled || res.writableEnded) return;
        console.log(`[ABORT] 客户端断开,释放 ${keyObj.masked}`);
        try { upstreamReq.destroy(); } catch (_) {}
        done('sent');
      });

      upstreamReq.write(body);
      upstreamReq.end();
    });
  }

  getStatus() {
    return {
      activeRequests: this.activeRequests,
      total429s: this.total429s,
      total5xxs: this.total5xxs,
      ...this.keyManager.getStatus(),
    };
  }
}

// 5xx 重试计数 (按请求对象跟踪)
const _retryCounter = new WeakMap();
function attempt5xx(req) {
  const n = (_retryCounter.get(req) || 0) + 1;
  _retryCounter.set(req, n);
  return n;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ============ 启动 ============

const apiKeys = loadApiKeys();

if (apiKeys.length === 0) {
  console.error('==========================================');
  console.error(' [错误] 没有找到 API Key!');
  console.error('==========================================');
  console.error('请在 start-proxy.bat 里设置:');
  console.error('  set SENSENOVA_API_KEY_1=你的第一个Key');
  console.error('  set SENSENOVA_API_KEY_2=你的第二个Key');
  console.error('  (有几个账户设几个)');
  console.error('==========================================');
  process.exit(1);
}

const keyManager = new KeyManager(apiKeys);
const queue = new RequestQueue(keyManager);

console.log('==========================================');
console.log('  商汤 SenseNova 多账户智能代理');
console.log('  sensenova-duokey  by zhaoyu');
console.log('  https://github.com/SUJIElearning/sensenova-duokey');
console.log('==========================================');
console.log(` 监听地址:  http://127.0.0.1:${PROXY_PORT}`);
console.log(` 上游地址:  https://${UPSTREAM_HOST}`);
console.log(` 已加载:    ${apiKeys.length} 个账户 Key`);
for (const s of keyManager.states) {
  console.log(`   - ${s.masked}`);
}
console.log(` 策略:      并发转发 → 429 换 Key(最多试 ${MAX_KEY_ATTEMPTS} 个),失败快速返回`);
console.log(` 冷却:      ${COOLDOWN_BASE_MS/1000}s 起,连续限流翻倍(上限 ${COOLDOWN_MAX_MS/1000}s)`);
console.log(` 等Key上限: ${WAIT_KEY_MAX_MS/1000}s (超时即快速失败,不让用户干等)`);
console.log(` 观测:      TPM ${TPM_WINDOW_MS/60000}分钟窗口记账(仅展示,不预跳过)`);
console.log(` 重试间隔:  ${RETRY_GAP_MS}ms (避免毫秒级连打所有 Key)`);
console.log(` 单请求预算:${REQUEST_DEADLINE_MS/1000}s (必须 > 冷却上限 ${COOLDOWN_MAX_MS/1000}s)`);
console.log(` 并发容量:  ${apiKeys.length} Key × ${MAX_INFLIGHT_PER_KEY} 槽 = ${apiKeys.length * MAX_INFLIGHT_PER_KEY} 个对话`);
// 下面这行是给 重启代理.bat 抓取用的「机器可读摘要」,保持纯 ASCII 不含中文,
// 避免批处理在不同代码页下解析中文日志时出现乱码 / 匹配失败。
console.log(`[SUMMARY] keys=${apiKeys.length} slotsPerKey=${MAX_INFLIGHT_PER_KEY} totalSlots=${apiKeys.length * MAX_INFLIGHT_PER_KEY} cooldownBase=${COOLDOWN_BASE_MS/1000}s cooldownMax=${COOLDOWN_MAX_MS/1000}s deadline=${REQUEST_DEADLINE_MS/1000}s maxAttempts=${MAX_KEY_ATTEMPTS} waitKeyMax=${WAIT_KEY_MAX_MS/1000}s tpmWindow=${TPM_WINDOW_MS/60000}min`);
console.log('==========================================');
console.log('');
console.log('使用方法:DSH 配置不用改,直接启动就行');
console.log('  baseURL: http://127.0.0.1:15722/v1');
console.log('');
console.log('健康检查: http://127.0.0.1:' + PROXY_PORT + '/health');
console.log('Key 状态: http://127.0.0.1:' + PROXY_PORT + '/status');
console.log('按 Ctrl+C 停止');
console.log('');

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', type: 'multi-account-proxy', accounts: apiKeys.length }));
    return;
  }

  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(queue.getStatus(), null, 2));
    return;
  }

  const bodyChunks = [];
  const startTime = Date.now();
  req.on('data', c => bodyChunks.push(c));
  req.on('end', async () => {
    const body = Buffer.concat(bodyChunks);
    const active = queue.getStatus().activeRequests;
    console.log(`[REQ] ${req.method} ${req.url} (并发${active}个)`);
    await queue.handle(req, res, body, startTime);
  });

  req.on('error', (e) => {
    console.error(`[ERROR] 读取请求失败: ${e.message}`);
    try { res.writeHead(500); res.end(); } catch (_) {}
  });
});

server.listen(PROXY_PORT, '127.0.0.1');

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[FATAL] 端口 ${PROXY_PORT} 已被占用`);
    console.error('解决:关掉旧的代理窗口,再试一次');
  } else {
    console.error(`[FATAL] 服务器错误: ${e.message}`);
  }
  process.exit(1);
});