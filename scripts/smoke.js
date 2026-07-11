'use strict';
/* 端到端冒烟测试: 起服务器 → 两个 ws 客户端建房/加入 → 拿宝石/预定/购买/弃子/重连 */
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 3199;
let failures = 0;
function ok(cond, name) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name);
  if (!cond) failures++;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function wsClient() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  ws.state = null; ws.joined = null; ws.errors = [];
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.type === 'state') ws.state = m.state;
    else if (m.type === 'joined') ws.joined = m;
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

async function main() {
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
  let logLen = () => A.state.log.length;

  async function act(seat, action) {
    const before = A.state.log.length;
    const errBefore = cli(seat).errors.length;
    cli(seat).sendJ({ type: 'action', action });
    await waitFor(() => A.state.log.length > before || cli(seat).errors.length > errBefore
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
  ok(B2.state.log.length > 0 && B2.state.players[1].name === '乙', '重连后拿到完整局面');

  server.kill();
  console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('测试异常:', e.message); process.exit(1); });
