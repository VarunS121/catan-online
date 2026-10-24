// Catan Online server: static files + WebSocket game rooms. Single dependency: ws.
const path = require('path');
const fs = require('fs');
const http = require('http');
const { WebSocketServer } = require('ws');
const { Game } = require('./src/game');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

const rooms = new Map(); // code -> { game, members: Set<conn>, chat: [], cleanup, pending }

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
  }
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) {
      // unknown paths fall back to the app (so /?room=CODE style links always work)
      return fs.readFile(path.join(PUBLIC, 'index.html'), (e2, html) => {
        res.writeHead(e2 ? 404 : 200, { 'content-type': MIME['.html'] });
        res.end(e2 ? 'Not found' : html);
      });
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
});

// ---------- helpers ----------
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  let code;
  do code = Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  while (rooms.has(code));
  return code;
}
const cleanName = n => String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16) || 'Player';

function send(conn, e, d) {
  if (conn.ws.readyState === 1) conn.ws.send(JSON.stringify({ e, d }));
}
function toRoom(room, e, d) {
  const msg = JSON.stringify({ e, d });
  for (const c of room.members) if (c.ws.readyState === 1) c.ws.send(msg);
}
function broadcast(room) {
  for (const c of room.members) send(c, 'state', room.game.view(c.playerId));
}
function pushChat(room, msg) {
  msg.ts = Date.now();
  room.chat.push(msg);
  if (room.chat.length > 80) room.chat.shift();
  toRoom(room, 'chat', msg);
}

function createRoom(settings) {
  const code = genCode();
  const room = { members: new Set(), chat: [], cleanup: null, pending: false };
  room.game = new Game(code, settings, {
    changed: () => {
      if (room.pending) return; // coalesce several changes in one tick
      room.pending = true;
      setImmediate(() => { room.pending = false; broadcast(room); });
    },
    fx: fx => toRoom(room, 'fx', fx),
  });
  rooms.set(code, room);
  return room;
}

function scheduleCleanup(room) {
  clearTimeout(room.cleanup);
  if (room.members.size > 0) return;
  // games can run long, so keep an empty room around for a while in case everyone reconnects
  room.cleanup = setTimeout(() => {
    if (room.members.size === 0) rooms.delete(room.game.code);
  }, 2 * 60 * 60 * 1000);
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

wss.on('connection', ws => {
  const conn = { ws, code: null, playerId: null, lastChat: 0 };
  ws.on('pong', () => (ws._dead = false));
  const room = () => rooms.get(conn.code);

  function joinRoom(r, name, playerId) {
    const res = r.game.addPlayer(playerId, name);
    if (res.error) return res;
    if (conn.code && conn.code !== r.game.code) leaveCurrent(false);
    conn.code = r.game.code;
    conn.playerId = playerId;
    r.members.add(conn);
    clearTimeout(r.cleanup);
    send(conn, 'chatHistory', r.chat);
    broadcast(r);
    return { ok: true, code: r.game.code, spectator: !!res.spectator };
  }

  function leaveCurrent(removeSeat) {
    const r = room();
    if (!r) return;
    r.members.delete(conn);
    const stillHere = [...r.members].some(c => c.playerId === conn.playerId);
    if (removeSeat) r.game.removePlayer(conn.playerId);
    else if (!stillHere) r.game.setConnected(conn.playerId, false);
    conn.code = null;
    scheduleCleanup(r);
  }

  const handlers = {
    create(data = {}) {
      const playerId = String(data.playerId || '').slice(0, 64);
      if (!playerId) return { error: 'Missing player id' };
      const s = data.settings || {};
      return joinRoom(createRoom({ size: s.size === 'extended' ? 'extended' : 'base' }), cleanName(data.name), playerId);
    },
    join(data = {}) {
      const r = rooms.get(String(data.code || '').toUpperCase().trim());
      if (!r) return { error: 'Game not found — check the code' };
      const playerId = String(data.playerId || '').slice(0, 64);
      if (!playerId) return { error: 'Missing player id' };
      return joinRoom(r, cleanName(data.name), playerId);
    },
    configure(data = {}) {
      const r = room(); if (!r) return { error: 'Not in a game' };
      const err = r.game.configure(conn.playerId, data);
      return err ? { error: err } : { ok: true };
    },
    color(c) {
      const r = room(); if (!r) return { error: 'Not in a game' };
      const err = r.game.pickColor(conn.playerId, String(c));
      return err ? { error: err } : { ok: true };
    },
    start() {
      const r = room(); if (!r) return { error: 'Not in a game' };
      const err = r.game.start(conn.playerId);
      return err ? { error: err } : { ok: true };
    },
    action(data = {}) {
      const r = room(); if (!r) return { error: 'Not in a game' };
      const err = r.game.act(conn.playerId, String(data.type), data.data);
      return err ? { error: err } : { ok: true };
    },
    leave() { leaveCurrent(true); return { ok: true }; },
    chat(text) {
      const r = room(); if (!r) return;
      const now = Date.now();
      if (now - conn.lastChat < 400) return;
      conn.lastChat = now;
      const p = r.game.findPlayer(conn.playerId);
      const name = p ? p.name : r.game.spectators.get(conn.playerId);
      const clean = String(text || '').trim().slice(0, 300);
      if (clean && name) pushChat(r, { name, color: p ? p.color : '#999', text: clean });
    },
  };

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const h = msg && handlers[msg.e];
    if (!h) return;
    let result;
    try { result = h(msg.d); } catch (err) { console.error(err); result = { error: 'Server error' }; }
    if (msg.id != null && ws.readyState === 1) ws.send(JSON.stringify({ ack: msg.id, d: result || { ok: true } }));
  });
  ws.on('close', () => leaveCurrent(false));
  ws.on('error', () => {});
});

// drop dead connections so players show as offline quickly
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws._dead) { ws.terminate(); continue; }
    ws._dead = true;
    try { ws.ping(); } catch {}
  }
}, 15000);

server.listen(PORT, () => console.log(`Catan Online running on http://localhost:${PORT}`));
