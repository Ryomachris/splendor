# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

双人在线对战的「璀璨宝石 (Splendor)」网页游戏。Node.js + WebSocket,唯一依赖是 `ws`。没有构建步骤、没有 lint 配置、没有 TypeScript。代码注释、UI 文案、错误信息和提交信息均使用中文。

## 常用命令

```bash
npm install                          # 安装依赖(仅 ws)
npm start                            # 等同 node server.js,默认端口 3000
PORT=8080 ROOM_TIMEOUT_MS=900000 node server.js   # 自定义端口 / 房间超时(毫秒,默认 600000)
npm test                             # 端到端冒烟测试 scripts/smoke.js
```

- 测试会自行 spawn `server.js`,分别占用端口 **3199**(规则与重连)和 **3200**(生命周期测试,`ROOM_TIMEOUT_MS=400`)。无需事先启动服务器,但这两个端口必须空闲。
- 没有测试框架,也不能单独跑某一个用例:`scripts/smoke.js` 是一个脚本,`main()` 跑完规则/重连部分后调用 `lifecycleTests()`。调试某部分时可临时注释另一部分。断言用自定义的 `ok(cond, name)`,任一失败则进程退出码为 1。
- 部署方式(systemd、Nginx 反代 80 端口、HTTPS)见 README;另有 `Dockerfile`(node:20-alpine,只复制 `server.js` 和 `public/`)。

## 架构

全部服务端逻辑在单文件 `server.js` 中,依次为四段:

1. **牌库数据** —— `ALL_CARDS`(90 张,三级)、`ALL_NOBLES`(10 位)。颜色用单字母键:`d` 钻石、`s` 蓝宝石、`e` 祖母绿、`r` 红宝石、`o` 玛瑙、`g` 黄金。`COLORS` 不含 `g`。前端使用同一套键。
2. **规则引擎** —— 纯函数式地修改游戏状态 `st`:`newGame` → `applyAction(st, seat, action)` → `checkNobles` → `finishTurn`。
   - 非法操作通过 `assert(cond, msg)` 抛出 `ActionError`,消息会作为 `{type:'error', msg}` 原样发给客户端,所以文案要写给玩家看。其他异常一律回复「服务器内部错误」。
   - `st.pending` 是回合内的阻塞阶段(`discard`:宝石超过 10 枚须弃;`noble`:多位贵族可选)。存在 pending 时只接受对应操作。回合顺序为 弃宝石 → 贵族 → `finishTurn`。
   - 终局:有人 ≥15 分后,轮到 `starter` 时结束(保证双方回合数相同)。平分时购卡少者胜,仍相同则 `winner = -1`。
3. **房间管理** —— 内存中的 `rooms: Map<code, room>`,不做持久化,重启即丢失所有对局。
   - 玩家身份是加入时生成的随机 `key`;客户端把 `{room, key}` 存进 `localStorage`,用 `rejoin` 断线重连。
   - **服务端永远不直接广播 `st`**,而是用 `viewFor(room, seat)` 为每个座位生成视图:隐藏牌堆内容,并把对手从牌堆盲预定的卡(`fromDeck`)替换为 `{hidden:true, tier}`。新增状态字段时必须同时决定它在 `viewFor` 中是否对对手可见。
   - 两种过期:未开局房间按 `createdAt` 绝对过期(`invite_expired`);已开局房间按 `lastActivityAt` 空闲过期(`idle_timeout`)。已认证玩家的**任何**应用层消息(包括非法或未知消息)都会刷新活动时间,WebSocket ping/pong 心跳**不会**。过期既由定时清扫触发,也在收到消息或 `activeRoom()` 查询时惰性检查。冒烟测试对这些语义都有断言。
   - `leave`:等待阶段退出直接删除房间(邀请码立即失效);开局后退出只断开连接、保留座位,可 `rejoin`。
4. **HTTP + WebSocket** —— 同一个 `http.Server` 既提供 `public/` 静态文件,又承载 `ws`。

### 客户端协议(JSON over WebSocket)

- 客户端 → 服务端:`create`、`join`、`rejoin`、`action`(`take` / `reserve` / `buy` / `discard` / `noble`)、`rematch`、`leave`
- 服务端 → 客户端:`joined`、`state`(每次变化全量推送 `viewFor` 视图)、`left`、`room_closed`、`error`

### 前端

`public/index.html` 是单文件(HTML + CSS + 原生 JS),无框架、无构建。它只根据服务端推送的 `state` 渲染,不做权威判定。但其中的 `canAfford` / `paymentOf`(可购买高亮与支付预览)复制了服务端 `computePayment` 的算法,修改支付规则时两边要同步改。状态栏里的「最近动作」由 `recordActions` 对比前后两次 `state` 推断得出(服务端不发送动作日志),新增状态字段时如影响展示需同步考虑。邀请链接 `/?room=XXXX` 只在前端读取并预填房间码。手机竖屏(`max-width: 899px` 且 portrait)下 `#game` 固定为视口高度不滚动,由 `fitBoard` 按剩余空间计算卡牌宽度 `--cw` 并在「贵族在上方」与「贵族在右侧」两种排布间选卡牌更大的一种;在固定区域里加内容时注意别把棋盘挤没。WebSocket 地址由 `location` 推导(HTTPS 下自动用 `wss://`),所以反代时需要转发 `Upgrade` 头。
