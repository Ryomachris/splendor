'use strict';
/*
 * 璀璨宝石 (Splendor) 双人对战服务器
 * 运行: node server.js   (默认端口 3000, 可用环境变量 PORT 修改)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const configuredRoomTimeout = Number(process.env.ROOM_TIMEOUT_MS);
const ROOM_TIMEOUT_MS = Number.isFinite(configuredRoomTimeout) && configuredRoomTimeout > 0
  ? configuredRoomTimeout : 10 * 60 * 1000;
const ROOM_SWEEP_INTERVAL_MS = Math.min(1000, Math.max(25, Math.floor(ROOM_TIMEOUT_MS / 4)));
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ================= 牌库数据 =================
 * 宝石颜色: d=钻石(白) s=蓝宝石(蓝) e=祖母绿(绿) r=红宝石(红) o=玛瑙(黑) g=黄金(万能)
 */
const COLORS = ['d', 's', 'e', 'r', 'o'];

function C(tier, bonus, points, cost) { return { tier, bonus, points, cost }; }

const ALL_CARDS = [
  // ---- 一级卡 (40 张) ----
  // 玛瑙 o
  C(1,'o',0,{d:1,s:1,e:1,r:1}), C(1,'o',0,{d:1,s:2,e:1,r:1}), C(1,'o',0,{d:2,s:2,r:1}),
  C(1,'o',0,{e:1,r:3,o:1}),     C(1,'o',0,{e:2,r:1}),         C(1,'o',0,{d:2,e:2}),
  C(1,'o',0,{e:3}),             C(1,'o',1,{s:4}),
  // 蓝宝石 s
  C(1,'s',0,{d:1,e:1,r:1,o:1}), C(1,'s',0,{d:1,e:1,r:2,o:1}), C(1,'s',0,{d:1,e:2,r:2}),
  C(1,'s',0,{s:1,e:3,r:1}),     C(1,'s',0,{d:1,o:2}),         C(1,'s',0,{e:2,o:2}),
  C(1,'s',0,{o:3}),             C(1,'s',1,{r:4}),
  // 钻石 d
  C(1,'d',0,{s:1,e:1,r:1,o:1}), C(1,'d',0,{s:1,e:2,r:1,o:1}), C(1,'d',0,{s:2,e:2,o:1}),
  C(1,'d',0,{d:3,s:1,o:1}),     C(1,'d',0,{r:2,o:1}),         C(1,'d',0,{s:2,o:2}),
  C(1,'d',0,{s:3}),             C(1,'d',1,{e:4}),
  // 祖母绿 e
  C(1,'e',0,{d:1,s:1,r:1,o:1}), C(1,'e',0,{d:1,s:1,r:1,o:2}), C(1,'e',0,{s:1,r:2,o:2}),
  C(1,'e',0,{d:1,s:3,e:1}),     C(1,'e',0,{d:2,s:1}),         C(1,'e',0,{s:2,r:2}),
  C(1,'e',0,{r:3}),             C(1,'e',1,{o:4}),
  // 红宝石 r
  C(1,'r',0,{d:1,s:1,e:1,o:1}), C(1,'r',0,{d:2,s:1,e:1,o:1}), C(1,'r',0,{d:2,e:1,o:2}),
  C(1,'r',0,{d:1,r:1,o:3}),     C(1,'r',0,{s:2,e:1}),         C(1,'r',0,{d:2,o:2}),
  C(1,'r',0,{d:3}),             C(1,'r',1,{d:4}),

  // ---- 二级卡 (30 张) ----
  // 玛瑙
  C(2,'o',1,{d:3,s:2,e:2}), C(2,'o',1,{d:3,e:3,o:2}), C(2,'o',2,{s:1,e:4,r:2}),
  C(2,'o',2,{e:5,r:3}),     C(2,'o',2,{d:5}),         C(2,'o',3,{o:6}),
  // 蓝宝石
  C(2,'s',1,{s:2,e:2,r:3}), C(2,'s',1,{s:2,e:3,o:3}), C(2,'s',2,{d:5,s:3}),
  C(2,'s',2,{d:2,r:1,o:4}), C(2,'s',2,{s:5}),         C(2,'s',3,{s:6}),
  // 钻石
  C(2,'d',1,{e:3,r:2,o:2}), C(2,'d',1,{d:2,s:3,r:3}), C(2,'d',2,{e:1,r:4,o:2}),
  C(2,'d',2,{r:5,o:3}),     C(2,'d',2,{r:5}),         C(2,'d',3,{d:6}),
  // 祖母绿
  C(2,'e',1,{d:3,e:2,r:3}), C(2,'e',1,{d:2,s:3,o:2}), C(2,'e',2,{d:4,s:2,o:1}),
  C(2,'e',2,{s:5,e:3}),     C(2,'e',2,{e:5}),         C(2,'e',3,{e:6}),
  // 红宝石
  C(2,'r',1,{d:2,r:2,o:3}), C(2,'r',1,{s:3,r:2,o:3}), C(2,'r',2,{d:1,s:4,e:2}),
  C(2,'r',2,{d:3,o:5}),     C(2,'r',2,{o:5}),         C(2,'r',3,{r:6}),

  // ---- 三级卡 (20 张) ----
  // 玛瑙
  C(3,'o',3,{d:3,s:3,e:5,r:3}), C(3,'o',4,{r:7}), C(3,'o',4,{e:3,r:6,o:3}), C(3,'o',5,{r:7,o:3}),
  // 蓝宝石
  C(3,'s',3,{d:3,e:3,r:3,o:5}), C(3,'s',4,{d:7}), C(3,'s',4,{d:6,s:3,o:3}), C(3,'s',5,{d:7,s:3}),
  // 钻石
  C(3,'d',3,{s:3,e:3,r:5,o:3}), C(3,'d',4,{o:7}), C(3,'d',4,{d:3,r:3,o:6}), C(3,'d',5,{d:3,o:7}),
  // 祖母绿
  C(3,'e',3,{d:5,s:3,r:3,o:3}), C(3,'e',4,{s:7}), C(3,'e',4,{d:3,s:6,e:3}), C(3,'e',5,{s:7,e:3}),
  // 红宝石
  C(3,'r',3,{d:3,s:5,e:3,o:3}), C(3,'r',4,{e:7}), C(3,'r',4,{s:3,e:6,r:3}), C(3,'r',5,{e:7,r:3}),
];

const ALL_NOBLES = [
  {req:{o:4,r:4}}, {req:{s:4,e:4}}, {req:{d:4,s:4}}, {req:{d:4,o:4}}, {req:{e:4,r:4}},
  {req:{d:3,s:3,e:3}}, {req:{s:3,e:3,r:3}}, {req:{e:3,r:3,o:3}}, {req:{d:3,r:3,o:3}}, {req:{d:3,s:3,o:3}},
].map(n => ({ ...n, points: 3 }));

const GEM_NAMES = { d:'钻石', s:'蓝宝石', e:'祖母绿', r:'红宝石', o:'玛瑙', g:'黄金' };

/* ================= 游戏逻辑 ================= */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

let cardSeq = 0;
function newGame(names) {
  const decks = { 1: [], 2: [], 3: [] };
  for (const c of shuffle(ALL_CARDS)) decks[c.tier].push({ ...c, id: ++cardSeq });
  const board = { 1: [], 2: [], 3: [] };
  for (const t of [1, 2, 3]) for (let i = 0; i < 4; i++) board[t].push(decks[t].pop() || null);
  const starter = Math.floor(Math.random() * 2);
  return {
    bank: { d: 4, s: 4, e: 4, r: 4, o: 4, g: 5 },   // 双人局: 每色 4 枚
    decks, board,
    nobles: shuffle(ALL_NOBLES).slice(0, 3),          // 双人局: 3 位贵族
    players: names.map(name => ({
      name,
      tokens: { d: 0, s: 0, e: 0, r: 0, o: 0, g: 0 },
      bonuses: { d: 0, s: 0, e: 0, r: 0, o: 0 },
      cards: [], reserved: [], nobles: [], points: 0,
    })),
    starter, current: starter,
    pending: null,        // {type:'discard',player,count} | {type:'noble',player,options}
    gameOver: false, winner: null,
  };
}

const sum = obj => Object.values(obj).reduce((a, b) => a + (b || 0), 0);

function computePayment(card, p) {
  let gold = 0; const pay = {};
  for (const c of COLORS) {
    const need = Math.max(0, (card.cost[c] || 0) - p.bonuses[c]);
    const fromTokens = Math.min(need, p.tokens[c]);
    pay[c] = fromTokens;
    gold += need - fromTokens;
  }
  if (gold > p.tokens.g) return null;
  pay.g = gold;
  return pay;
}

function meetsNoble(p, noble) {
  return COLORS.every(c => p.bonuses[c] >= (noble.req[c] || 0));
}

class ActionError extends Error {}
function assert(cond, msg) { if (!cond) throw new ActionError(msg); }

function applyAction(st, seat, a) {
  assert(!st.gameOver, '游戏已结束');
  const p = st.players[seat];

  // 待处理阶段(弃宝石 / 选贵族)只接受对应操作
  if (st.pending) {
    assert(st.pending.player === seat, '等待对方操作');
    if (st.pending.type === 'discard') {
      assert(a.type === 'discard', '请先弃掉多余的宝石');
      const gems = a.gems || {};
      assert(sum(gems) === st.pending.count, `需要弃掉 ${st.pending.count} 枚宝石`);
      for (const [c, n] of Object.entries(gems)) {
        assert(n >= 0 && Number.isInteger(n) && p.tokens[c] >= n, '宝石数量不合法');
      }
      for (const [c, n] of Object.entries(gems)) { p.tokens[c] -= n; st.bank[c] += n; }
      st.pending = null;
      checkNobles(st);
      return;
    }
    if (st.pending.type === 'noble') {
      assert(a.type === 'noble', '请先选择一位贵族');
      assert(st.pending.options.includes(a.index), '不能选择该贵族');
      awardNoble(st, seat, a.index);
      st.pending = null;
      finishTurn(st);
      return;
    }
  }

  assert(st.current === seat, '还没轮到你');

  switch (a.type) {
    case 'take': {
      const gems = a.gems || {};
      assert(!gems.g, '黄金只能通过预定获得');
      const colors = Object.keys(gems).filter(c => gems[c] > 0);
      assert(colors.length > 0 && colors.every(c => COLORS.includes(c)), '选择不合法');
      if (colors.length === 1 && gems[colors[0]] === 2) {
        assert(st.bank[colors[0]] >= 4, '该颜色宝石不足 4 枚,不能拿 2 枚');
      } else {
        assert(colors.length <= 3 && colors.every(c => gems[c] === 1), '只能拿 3 枚不同色,或同色 2 枚');
      }
      for (const c of colors) assert(st.bank[c] >= gems[c], '银行宝石不足');
      for (const c of colors) { st.bank[c] -= gems[c]; p.tokens[c] += gems[c]; }
      break;
    }
    case 'reserve': {
      assert(p.reserved.length < 3, '最多只能预定 3 张卡');
      const tier = a.tier;
      assert([1, 2, 3].includes(tier), '牌级不合法');
      let card, fromDeck = false;
      if (a.index === 'deck') {
        card = st.decks[tier].pop();
        assert(card, '该级牌堆已空');
        fromDeck = true;
      } else {
        assert(a.index >= 0 && a.index < 4, '位置不合法');
        card = st.board[tier][a.index];
        assert(card, '该位置没有卡牌');
        st.board[tier][a.index] = st.decks[tier].pop() || null;
      }
      p.reserved.push({ ...card, fromDeck });
      if (st.bank.g > 0) { st.bank.g--; p.tokens.g++; }
      break;
    }
    case 'buy': {
      let card;
      if (a.from === 'reserve') {
        assert(a.index >= 0 && a.index < p.reserved.length, '预定卡不存在');
        card = p.reserved[a.index];
      } else {
        assert([1, 2, 3].includes(a.tier) && a.index >= 0 && a.index < 4, '位置不合法');
        card = st.board[a.tier][a.index];
        assert(card, '该位置没有卡牌');
      }
      const pay = computePayment(card, p);
      assert(pay, '宝石不足,无法购买');
      for (const [c, n] of Object.entries(pay)) { p.tokens[c] -= n; st.bank[c] += n; }
      if (a.from === 'reserve') p.reserved.splice(a.index, 1);
      else st.board[a.tier][a.index] = st.decks[a.tier].pop() || null;
      delete card.fromDeck;
      p.cards.push(card);
      p.bonuses[card.bonus]++;
      p.points += card.points;
      break;
    }
    default:
      throw new ActionError('未知操作');
  }

  // 回合结算: 超过 10 枚需弃宝石 → 贵族拜访 → 换人
  if (sum(p.tokens) > 10) {
    st.pending = { type: 'discard', player: seat, count: sum(p.tokens) - 10 };
    return;
  }
  checkNobles(st);
}

function awardNoble(st, seat, idx) {
  const p = st.players[seat];
  const noble = st.nobles[idx];
  st.nobles[idx] = null;
  p.nobles.push(noble);
  p.points += noble.points;
}

function checkNobles(st) {
  const seat = st.current;
  const p = st.players[seat];
  const options = st.nobles.map((n, i) => n && meetsNoble(p, n) ? i : -1).filter(i => i >= 0);
  if (options.length === 1) awardNoble(st, seat, options[0]);
  else if (options.length > 1) {
    st.pending = { type: 'noble', player: seat, options };
    return;
  }
  finishTurn(st);
}

function finishTurn(st) {
  st.pending = null;
  const next = (st.current + 1) % st.players.length;
  // 有人达到 15 分后,本轮打完(回到先手玩家时)结束
  if (next === st.starter && st.players.some(pl => pl.points >= 15)) {
    st.gameOver = true;
    const [a, b] = st.players;
    if (a.points !== b.points) st.winner = a.points > b.points ? 0 : 1;
    else if (a.cards.length !== b.cards.length) st.winner = a.cards.length < b.cards.length ? 0 : 1;
    else st.winner = -1; // 平局
    return;
  }
  st.current = next;
}

/* ================= 房间管理 ================= */
const rooms = new Map(); // code -> {code, players:[{key,name,ws,connected}], state, rematch:Set, createdAt, lastActivityAt}

function genRoomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function viewFor(room, seat) {
  const st = room.state;
  if (!st) return null;
  return {
    bank: st.bank,
    board: st.board,
    deckCounts: { 1: st.decks[1].length, 2: st.decks[2].length, 3: st.decks[3].length },
    nobles: st.nobles,
    current: st.current, starter: st.starter,
    pending: st.pending, gameOver: st.gameOver, winner: st.winner,
    you: seat,
    rematch: [...room.rematch],
    players: st.players.map((p, i) => ({
      name: p.name, tokens: p.tokens, bonuses: p.bonuses, points: p.points,
      cardCount: p.cards.length, nobles: p.nobles,
      connected: !!(room.players[i] && room.players[i].connected),
      reserved: p.reserved.map(rc =>
        (i === seat || !rc.fromDeck) ? rc : { hidden: true, tier: rc.tier }),
    })),
  };
}

function broadcast(room) {
  room.players.forEach((pl, seat) => {
    if (pl && pl.ws && pl.ws.readyState === WebSocket.OPEN) {
      pl.ws.send(JSON.stringify({ type: 'state', room: room.code, state: viewFor(room, seat) }));
    }
  });
}

function roomExpiryReason(room, now = Date.now()) {
  if (!room.state) {
    return now - room.createdAt >= ROOM_TIMEOUT_MS ? 'invite_expired' : null;
  }
  return now - room.lastActivityAt >= ROOM_TIMEOUT_MS ? 'idle_timeout' : null;
}

function touchRoom(room) {
  if (room.state) room.lastActivityAt = Date.now();
}

function detachPlayer(room, seat, ws) {
  const player = room.players[seat];
  if (!player || player.ws !== ws) return;
  player.connected = false;
  player.ws = null;
  if (ws.ctx && ws.ctx.room === room) ws.ctx = null;
}

function closeRoom(room, reason) {
  if (rooms.get(room.code) !== room) return;
  rooms.delete(room.code);
  room.players.forEach(player => {
    const playerWs = player.ws;
    player.connected = false;
    player.ws = null;
    if (!playerWs) return;
    if (playerWs.ctx && playerWs.ctx.room === room) playerWs.ctx = null;
    if (playerWs.readyState === WebSocket.OPEN) {
      playerWs.send(JSON.stringify({ type: 'room_closed', room: room.code, reason }));
    }
  });
}

function activeRoom(code) {
  const room = rooms.get(code);
  if (!room) return null;
  const reason = roomExpiryReason(room);
  if (!reason) return room;
  closeRoom(room, reason);
  return null;
}

function sendErr(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', msg }));
}

/* ================= HTTP + WebSocket ================= */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  let file = req.url.split('?')[0];
  if (file === '/') file = '/index.html';
  const fp = path.join(PUBLIC_DIR, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  if (!fp.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    const { room, seat } = ws.ctx || {};
    if (room && room.players[seat] && room.players[seat].ws === ws) {
      const reason = roomExpiryReason(room);
      if (reason) {
        closeRoom(room, reason);
        return;
      }
      // 已认证玩家发来的任何应用消息都视为活动；WebSocket 心跳不会进入这里。
      touchRoom(room);
    }
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try { handleMessage(ws, msg); }
    catch (e) {
      if (e instanceof ActionError) sendErr(ws, e.message);
      else { console.error(e); sendErr(ws, '服务器内部错误'); }
    }
  });

  ws.on('close', () => {
    const { room, seat } = ws.ctx || {};
    if (room && room.players[seat] && room.players[seat].ws === ws) {
      detachPlayer(room, seat, ws);
      broadcast(room);
    }
  });
});

function cleanName(name) {
  name = String(name || '').trim().slice(0, 12);
  return name || '玩家';
}

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'create': {
      const code = genRoomCode();
      const key = crypto.randomBytes(8).toString('hex');
      const now = Date.now();
      const room = {
        code, state: null, rematch: new Set(), createdAt: now, lastActivityAt: now,
        players: [{ key, name: cleanName(msg.name), ws, connected: true }],
      };
      rooms.set(code, room);
      ws.ctx = { room, seat: 0 };
      ws.send(JSON.stringify({ type: 'joined', room: code, key, seat: 0, waiting: true }));
      break;
    }
    case 'join': {
      const room = activeRoom(String(msg.room || '').toUpperCase().trim());
      assert(room, '房间不存在或已过期');
      assert(room.players.length < 2, '房间已满');
      const key = crypto.randomBytes(8).toString('hex');
      room.players.push({ key, name: cleanName(msg.name), ws, connected: true });
      ws.ctx = { room, seat: 1 };
      room.state = newGame(room.players.map(p => p.name));
      room.lastActivityAt = Date.now();
      ws.send(JSON.stringify({ type: 'joined', room: room.code, key, seat: 1, waiting: false }));
      broadcast(room);
      break;
    }
    case 'rejoin': {
      const room = activeRoom(String(msg.room || '').toUpperCase().trim());
      assert(room, '房间不存在或已过期');
      const seat = room.players.findIndex(p => p.key === msg.key);
      assert(seat >= 0, '身份验证失败');
      if (room.players[seat].ws && room.players[seat].ws !== ws) {
        try { room.players[seat].ws.close(); } catch {}
      }
      room.players[seat].ws = ws;
      room.players[seat].connected = true;
      ws.ctx = { room, seat };
      touchRoom(room);
      ws.send(JSON.stringify({ type: 'joined', room: room.code, key: msg.key, seat, waiting: !room.state }));
      broadcast(room);
      break;
    }
    case 'action': {
      const { room, seat } = ws.ctx || {};
      assert(room && room.state, '尚未开始游戏');
      applyAction(room.state, seat, msg.action || {});
      broadcast(room);
      break;
    }
    case 'rematch': {
      const { room, seat } = ws.ctx || {};
      assert(room && room.state && room.state.gameOver, '当前不能重开');
      room.rematch.add(seat);
      if (room.rematch.size === room.players.length) {
        room.rematch.clear();
        room.state = newGame(room.players.map(p => p.name));
      }
      broadcast(room);
      break;
    }
    case 'leave': {
      const { room, seat } = ws.ctx || {};
      assert(room && room.players[seat] && room.players[seat].ws === ws, '当前不在房间中');
      const rejoinable = !!room.state;
      ws.send(JSON.stringify({ type: 'left', room: room.code, rejoinable }));
      detachPlayer(room, seat, ws);
      if (rejoinable) broadcast(room);
      else rooms.delete(room.code);
      break;
    }
    default:
      break;
  }
}

// 心跳保活(防止代理断开空闲连接)
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// 等待房间按创建时间过期；已开局房间按最后应用消息时间过期。
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const reason = roomExpiryReason(room, now);
    if (reason) closeRoom(room, reason);
  }
}, ROOM_SWEEP_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`璀璨宝石服务器已启动: http://0.0.0.0:${PORT}`);
});
