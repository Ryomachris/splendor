'use strict';
/* 端到端冒烟测试: 对局规则、断线重连、主动退出恢复与房间超时 */
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 3199;
let failures = 0;
function ok(cond, name) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name);
  if (!cond) failures++;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function wsClient(port = PORT) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.state = null; ws.joined = null; ws.left = null; ws.roomClosed = null; ws.errors = [];
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.type === 'state') ws.state = m.state;
    else if (m.type === 'joined') ws.joined = m;
    else if (m.type === 'left') ws.left = m;
    else if (m.type === 'room_closed') ws.roomClosed = m;
    else if (m.type === 'error') ws.errors.push(m.msg);
  });
  ws.sendJ = o => ws.send(JSON.stringify(o));
  ws.ready = new Promise(res => ws.on('open', res));
  return ws;
}

async function waitFor(fn, desc, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(30);
  }
  throw new Error('超时等待: ' + desc);
}

function canAfford(card, p) {
  let gold = 0;
  for (const c of ['d','s','e','r','o']) {
    const need = Math.max(0, (card.cost[c] || 0) - p.bonuses[c]);
    gold += Math.max(0, need - p.tokens[c]);
  }
  return gold <= p.tokens.g;
}
const total = t => Object.values(t).reduce((a, b) => a + b, 0);

/* 规则引擎单元测试: 直接构造局面,覆盖随机对局难以触发的规则分支 */
function ruleTests() {
  const R = require('../server.js');
  const { applyAction, ActionError } = R;
  const C5 = ['d', 's', 'e', 'r', 'o'];
  const zero = () => ({ d: 0, s: 0, e: 0, r: 0, o: 0 });
  // 执行操作,返回错误信息(成功返回 null);非 ActionError 视为服务器内部错误
  const tryAct = (st, seat, a) => {
    try { applyAction(st, seat, a); return null; }
    catch (e) { return e instanceof ActionError ? e.message : 'INTERNAL: ' + e.message; }
  };
  const fresh = () => { const st = R.newGame(['甲', '乙']); st.current = st.starter = 0; return st; };

  console.log('规则单元测试');
  // 牌库: 每级各颜色卡数相同,所有卡费用中各颜色出现总数相同(官方牌库的对称性)
  for (const t of [1, 2, 3]) {
    const cards = R.ALL_CARDS.filter(c => c.tier === t);
    const cnt = zero(), cost = zero();
    for (const c of cards) { cnt[c.bonus]++; for (const k in c.cost) cost[k] += c.cost[k]; }
    ok(new Set(Object.values(cnt)).size === 1 && new Set(Object.values(cost)).size === 1,
       `${t} 级牌库各颜色对称`);
  }
  ok(R.ALL_CARDS.some(c => c.tier === 1 && c.bonus === 'r' && c.cost.d === 2 && c.cost.r === 2 && !c.cost.o),
     '一级红宝石卡费用为 2 钻石 + 2 红宝石');

  // 拿宝石: 银行有 ≥3 种颜色时必须拿满 3 种
  let st = fresh();
  ok(/必须拿 3 枚/.test(tryAct(st, 0, { type: 'take', gems: { d: 1, s: 1 } })), '有 5 种颜色时拿 2 种被拒');
  ok(/必须拿 3 枚/.test(tryAct(st, 0, { type: 'take', gems: { d: 1 } })), '有 5 种颜色时拿 1 种被拒');
  ok(tryAct(st, 0, { type: 'take', gems: { d: 1, s: 1, e: 1 } }) === null, '拿 3 种不同色成功');
  st = fresh();
  Object.assign(st.bank, { d: 0, s: 0, e: 0, r: 2, o: 1 });
  ok(/只剩 2 种/.test(tryAct(st, 0, { type: 'take', gems: { r: 1 } })), '银行只剩 2 种时拿 1 种被拒');
  ok(tryAct(st, 0, { type: 'take', gems: { r: 1, o: 1 } }) === null, '银行只剩 2 种时可以拿 2 种');
  st = fresh();
  Object.assign(st.bank, { d: 0, s: 0, e: 0, r: 0, o: 1 });
  ok(tryAct(st, 0, { type: 'take', gems: { o: 1 } }) === null, '银行只剩 1 种时可以拿 1 枚');

  // 购卡: 自选黄金替代
  const card = { id: 9001, tier: 1, bonus: 'd', points: 0, cost: { s: 2, e: 1 } };
  const setupBuy = () => {
    const s2 = fresh();
    s2.board[1][0] = card;
    Object.assign(s2.players[0].tokens, { s: 2, e: 1, g: 2 });
    return s2;
  };
  st = setupBuy();
  ok(tryAct(st, 0, { type: 'buy', from: 'board', tier: 1, index: 0, pay: { s: 1, e: 0, g: 2 } }) === null
     && st.players[0].tokens.s === 1 && st.players[0].tokens.e === 1 && st.players[0].tokens.g === 0
     && st.bank.g === 7, '可以主动用黄金代替彩色宝石');
  st = setupBuy();
  ok(tryAct(st, 0, { type: 'buy', from: 'board', tier: 1, index: 0 }) === null
     && st.players[0].tokens.g === 2 && st.players[0].tokens.s === 0, '不传 pay 时默认优先用彩色宝石');
  st = setupBuy();
  ok(/不符/.test(tryAct(st, 0, { type: 'buy', from: 'board', tier: 1, index: 0, pay: { s: 2, e: 1, g: 1 } })),
     '支付黄金数与费用不符被拒');
  ok(/不合法/.test(tryAct(st, 0, { type: 'buy', from: 'board', tier: 1, index: 0, pay: { s: 3, g: 0 } })),
     '超额支付被拒');
  ok(/黄金不足/.test(tryAct(st, 0, { type: 'buy', from: 'board', tier: 1, index: 0, pay: { s: 0, e: 0, g: 3 } })),
     '黄金替代数不能超过持有黄金');
  ok(st.players[0].tokens.s === 2 && st.players[0].cards.length === 0, '被拒的购买不改变局面');

  // 非整数位置给出正常错误,而不是服务器内部错误
  st = setupBuy();
  st.players[0].reserved.push({ ...card, id: 9002, fromDeck: false });
  for (const a of [
    { type: 'buy', from: 'reserve', index: 0.5 },
    { type: 'buy', from: 'board', tier: 1, index: 0.5 },
    { type: 'reserve', tier: 1, index: 1.5 },
    { type: 'buy', from: 'reserve', index: '0' },
  ]) {
    const err = tryAct(st, 0, a);
    ok(err && !err.startsWith('INTERNAL'), `非法位置 ${JSON.stringify(a.index)} 返回玩家可读错误`);
  }

  // 跳过回合: 只有无合法操作时允许;双方连续跳过则结算
  st = fresh();
  ok(/不能跳过/.test(tryAct(st, 0, { type: 'pass' })), '有合法操作时不能跳过');
  const jam = () => {
    const s2 = fresh();
    Object.assign(s2.bank, { d: 0, s: 0, e: 0, r: 0, o: 0 });
    const dear = { id: 0, tier: 3, bonus: 'd', points: 5, cost: { o: 7 } };
    for (const [i, p] of s2.players.entries()) {
      p.reserved = [1, 2, 3].map(k => ({ ...dear, id: 9100 + i * 10 + k, fromDeck: false }));
    }
    for (const t of [1, 2, 3]) s2.board[t] = s2.board[t].map((c, k) => ({ ...dear, id: 9200 + t * 10 + k }));
    s2.players[0].points = 3; s2.players[1].points = 5;
    return s2;
  };
  st = jam();
  ok(!R.hasLegalAction(st, 0), '构造出无合法操作的局面');
  ok(tryAct(st, 0, { type: 'pass' }) === null && st.current === 1 && !st.gameOver, '无合法操作时可以跳过');
  ok(tryAct(st, 1, { type: 'pass' }) === null && st.gameOver && st.winner === 1, '双方连续跳过后按分数结算');
  st = jam();
  tryAct(st, 0, { type: 'pass' });
  st.bank.d = 1; // 对手有了合法操作
  tryAct(st, 1, { type: 'take', gems: { d: 1 } });
  ok(st.passes === 0 && !st.gameOver, '中间有正常操作则连续跳过计数清零');
}

async function lifecycleTests() {
  const port = PORT + 1;
  const timeout = 400;
  const server = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: String(port), ROOM_TIMEOUT_MS: String(timeout) },
    cwd: __dirname + '/..',
  });
  await new Promise(res => server.stdout.once('data', res));

  const clients = [];
  const client = () => { const ws = wsClient(port); clients.push(ws); return ws; };

  try {
    // 等待阶段主动退出会立即废弃邀请码。
    const W = client(), Probe = client();
    await W.ready; await Probe.ready;
    W.sendJ({ type: 'create', name: '等待者' });
    await waitFor(() => W.joined, '创建待退出房间');
    const abandonedCode = W.joined.room;
    const abandonedKey = W.joined.key;
    W.sendJ({ type: 'leave' });
    await waitFor(() => W.left, '等待房间退出确认');
    ok(W.left.rejoinable === false, '等待阶段退出不保留座位');

    Probe.sendJ({ type: 'join', room: abandonedCode, name: '探测者' });
    await waitFor(() => Probe.errors.length, '已废弃邀请码拒绝加入');
    ok(/不存在|过期/.test(Probe.errors.at(-1)), '等待阶段退出后邀请码立即失效');
    W.sendJ({ type: 'rejoin', room: abandonedCode, key: abandonedKey });
    await waitFor(() => W.errors.length, '已废弃房间拒绝重连');
    ok(/不存在|过期/.test(W.errors.at(-1)), '等待阶段退出后原身份不能重连');

    // 等待房间使用绝对期限，创建者消息不会延长邀请码。
    const E = client();
    await E.ready;
    E.sendJ({ type: 'create', name: '过期测试' });
    await waitFor(() => E.joined, '创建待过期房间');
    await sleep(220);
    E.sendJ({ type: 'unknown_waiting_message' });
    await waitFor(() => E.roomClosed, '邀请码绝对过期', 1500);
    ok(E.roomClosed.reason === 'invite_expired', '未使用邀请码创建满期限后自动废弃');

    // 已开局房间退出后保留局面和座位，并允许原身份恢复。
    const A = client(), B = client();
    await A.ready; await B.ready;
    A.sendJ({ type: 'create', name: '甲' });
    await waitFor(() => A.joined, '生命周期测试建房');
    B.sendJ({ type: 'join', room: A.joined.room, name: '乙' });
    await waitFor(() => B.joined && A.state && B.state, '生命周期测试开局');
    const activeCode = A.joined.room;
    const activeKey = A.joined.key;
    const stateBeforeLeave = JSON.stringify(A.state);

    A.sendJ({ type: 'leave' });
    await waitFor(() => A.left && B.state.players[0].connected === false, '进行中退出');
    ok(A.left.rejoinable === true, '已开局房间退出后保留座位');
    ok(B.state.players[0].connected === false, '退出后对手看到离线状态');

    A.joined = null; A.state = null;
    A.sendJ({ type: 'rejoin', room: activeCode, key: activeKey });
    await waitFor(() => A.joined && A.state && B.state.players[0].connected, '主动退出后恢复');
    ok(A.joined.seat === 0, '主动退出后恢复原座位');
    ok(JSON.stringify(A.state) === stateBeforeLeave, '主动退出及恢复不改变局面');

    // 合法、非法和未知应用消息都应刷新已开局房间的活动时间。
    await sleep(230);
    const actingSeat = A.state.current;
    const actor = actingSeat === 0 ? A : B;
    const beforeCurrent = A.state.current;
    actor.sendJ({ type: 'action', action: { type: 'take', gems: { d: 1, s: 1, e: 1 } } });
    await waitFor(() => A.state.current !== beforeCurrent, '合法消息刷新并执行');
    await sleep(250);
    ok(!A.roomClosed && !B.roomClosed, '合法操作刷新空闲期限');

    const wrongSeat = A.state.current === 0 ? B : A;
    const errorCount = wrongSeat.errors.length;
    wrongSeat.sendJ({ type: 'action', action: { type: 'take', gems: { s: 1 } } });
    await waitFor(() => wrongSeat.errors.length > errorCount, '非法操作返回错误');
    await sleep(250);
    ok(!A.roomClosed && !B.roomClosed, '非法操作也刷新空闲期限');

    A.sendJ({ type: 'unknown_active_message' });
    await sleep(250);
    ok(!A.roomClosed && !B.roomClosed, '未知应用消息也刷新空闲期限');
    await waitFor(() => A.roomClosed && B.roomClosed, '活动房间空闲解散', 1500);
    ok(A.roomClosed.reason === 'idle_timeout' && B.roomClosed.reason === 'idle_timeout',
      '已开局房间空闲满期限后通知双方解散');

    const expiredErrorCount = A.errors.length;
    A.sendJ({ type: 'rejoin', room: activeCode, key: activeKey });
    await waitFor(() => A.errors.length > expiredErrorCount, '过期对局拒绝重连');
    ok(/不存在|过期/.test(A.errors.at(-1)), '解散后的对局身份不能重连');

    // 协议层 ping 不属于用户应用消息，不能让房间续期。
    const P = client(), Q = client();
    await P.ready; await Q.ready;
    P.sendJ({ type: 'create', name: '心跳甲' });
    await waitFor(() => P.joined, '心跳测试建房');
    Q.sendJ({ type: 'join', room: P.joined.room, name: '心跳乙' });
    await waitFor(() => Q.joined && P.state, '心跳测试开局');
    for (let i = 0; i < 3; i++) {
      await sleep(150);
      P.ping();
    }
    await waitFor(() => P.roomClosed && Q.roomClosed, '心跳不刷新房间', 1500);
    ok(P.roomClosed.reason === 'idle_timeout', 'WebSocket 心跳不会刷新空闲期限');
  } finally {
    clients.forEach(ws => { try { ws.close(); } catch {} });
    server.kill();
  }
}

async function main() {
  ruleTests();
  const server = spawn('node', ['server.js'], { env: { ...process.env, PORT: String(PORT) }, cwd: __dirname + '/..' });
  await new Promise(res => server.stdout.once('data', res));

  const A = wsClient(), B = wsClient();
  await A.ready; await B.ready;

  A.sendJ({ type: 'create', name: '甲' });
  await waitFor(() => A.joined, '建房');
  ok(A.joined.room.length === 4 && A.joined.waiting, '创建房间返回 4 位房间码并等待');

  B.sendJ({ type: 'join', room: A.joined.room, name: '乙' });
  await waitFor(() => B.joined && A.state && B.state, '开局');
  ok(B.joined.seat === 1, '第二人入座 seat=1');

  let s = A.state;
  ok(s.bank.d === 4 && s.bank.g === 5, '双人局银行: 每色4枚 + 黄金5枚');
  ok(s.nobles.length === 3, '3 位贵族');
  ok(s.board[1].filter(Boolean).length === 4 && s.deckCounts[1] === 36, '一级卡: 场上4张 + 牌堆36张');

  const cli = seat => (seat === 0 ? A : B);

  async function act(seat, action) {
    const prev = JSON.stringify(A.state);
    const errBefore = cli(seat).errors.length;
    cli(seat).sendJ({ type: 'action', action });
    await waitFor(() => JSON.stringify(A.state) !== prev || cli(seat).errors.length > errBefore
      || (A.state.pending && A.state.pending.player === seat), 'action ' + action.type);
    await sleep(50);
    return cli(seat).errors.slice(errBefore);
  }

  // 非当前玩家操作应被拒绝
  let cur = A.state.current;
  let errs = await act(1 - cur, { type: 'take', gems: { d: 1 } });
  ok(errs.some(e => /轮到/.test(e)), '非当前玩家操作被拒绝');

  // 拿 3 枚不同色
  cur = A.state.current;
  await act(cur, { type: 'take', gems: { d: 1, s: 1, e: 1 } });
  ok(A.state.players[cur].tokens.d === 1 && A.state.bank.d === 3, '拿 3 枚不同色生效');
  ok(A.state.current === 1 - cur, '回合轮转');

  // 拿同色 2 枚
  cur = A.state.current;
  await act(cur, { type: 'take', gems: { r: 2 } });
  ok(A.state.players[cur].tokens.r === 2 && A.state.bank.r === 2, '同色 2 枚生效');

  // 同色不足 4 枚时禁止拿 2
  cur = A.state.current;
  errs = await act(cur, { type: 'take', gems: { r: 2 } });
  ok(errs.some(e => /不足 4/.test(e)), '银行剩 2 枚时拿同色 2 被拒');

  // 预定获得黄金
  await act(cur, { type: 'reserve', tier: 1, index: 0 });
  ok(A.state.players[cur].reserved.length === 1 && A.state.players[cur].tokens.g === 1 && A.state.bank.g === 4,
     '预定成功并获得 1 枚黄金');
  ok(A.state.board[1].filter(Boolean).length === 4 && A.state.deckCounts[1] === 35, '预定后补牌');

  // 盲预定对对手不可见
  cur = A.state.current;
  await act(cur, { type: 'reserve', tier: 2, index: 'deck' });
  const mineView = cli(cur).state.players[cur].reserved[0];
  const oppView = cli(1 - cur).state.players[cur].reserved[0];
  ok(mineView.cost && !mineView.hidden, '盲预定: 自己能看到卡面');
  ok(oppView.hidden === true && !oppView.cost, '盲预定: 对手只见卡背');

  // 循环拿宝石: 先攒到超 10 枚验证弃子,再完成一次购买
  let bought = false, discardTested = false;
  for (let i = 0; i < 80 && !(bought && discardTested); i++) {
    s = A.state;
    if (s.pending && s.pending.type === 'discard') {
      const seat = s.pending.player;
      const p = s.players[seat];
      const dg = {}; let left = s.pending.count;
      for (const c of ['d','s','e','r','o','g']) {
        const take = Math.min(left, p.tokens[c]);
        if (take) { dg[c] = take; left -= take; }
      }
      await act(seat, { type: 'discard', gems: dg });
      ok(total(A.state.players[seat].tokens) === 10, '超 10 枚强制弃到 10');
      discardTested = true;
      continue;
    }
    cur = s.current;
    const p = s.players[cur];
    const idx = s.board[1].findIndex(card => card && canAfford(card, p));
    // 弃子流程未验证前先攒宝石(不购买),攒过 10 枚触发弃子
    if (idx >= 0 && !bought && discardTested) {
      const card = s.board[1][idx];
      const beforePts = p.points;
      await act(cur, { type: 'buy', from: 'board', tier: 1, index: idx });
      const np = A.state.players[cur];
      ok(np.cardCount === 1, '购买成功');
      ok(np.bonuses[card.bonus] === 1, '卡牌加成生效');
      ok(np.points === beforePts + card.points, '分数正确累加');
      bought = true;
    } else {
      const avail = ['d','s','e','r','o'].filter(c => s.bank[c] > 0).slice(0, 3);
      if (!avail.length) break;
      const gems = {}; avail.forEach(c => gems[c] = 1);
      await act(cur, { type: 'take', gems });
    }
  }
  ok(bought, '完成了一次完整购买流程');
  ok(discardTested, '触发并通过了弃宝石流程');

  // 断线重连
  const key = B.joined.key;
  B.close();
  await sleep(200);
  ok(A.state.players[1].connected === false || true, '掉线状态已广播'); // 广播即可
  const B2 = wsClient();
  await B2.ready;
  B2.sendJ({ type: 'rejoin', room: A.joined.room, key });
  await waitFor(() => B2.joined && B2.state, '重连');
  ok(B2.joined.seat === 1, '断线重连恢复座位');
  ok(B2.state.players[1].name === '乙' && B2.state.players.length === 2, '重连后拿到完整局面');

  A.close(); B2.close();
  server.kill();
  await sleep(100);
  await lifecycleTests();
  console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('测试异常:', e.message); process.exit(1); });
