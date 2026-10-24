// End-to-end over real WebSockets: create, join, configure, start, setup placements, hidden hands.
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 3999;
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT } });

function client(pid) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const c = { ws, state: null, acks: {}, id: 1 };
  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.ack != null) { c.acks[m.ack](m.d); delete c.acks[m.ack]; } else if (m.e === 'state') c.state = m.d;
  });
  c.emit = (e, d) => new Promise(res => { const id = c.id++; c.acks[id] = res; ws.send(JSON.stringify({ e, d, id })); });
  c.ready = new Promise(res => ws.on('open', res));
  c.pid = pid;
  return c;
}
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await new Promise(res => srv.stdout.on('data', res));
  const cs = ['a', 'b', 'c', 'd', 'e'].map(client);
  await Promise.all(cs.map(c => c.ready));
  const created = await cs[0].emit('create', { name: 'Ann', playerId: 'a', settings: { size: 'base' } });
  assert(created.ok);
  for (const [i, c] of cs.slice(1).entries()) assert((await c.emit('join', { name: 'P' + i, playerId: c.pid, code: created.code })).ok);
  assert((await cs[1].emit('configure', { size: 'extended' })).error, 'non-host cannot configure');
  assert((await cs[0].emit('start')).error, '5 players do not fit the base board');
  assert((await cs[0].emit('configure', { size: 'extended' })).ok);
  assert((await cs[0].emit('start')).ok);
  await wait(50);

  // play the whole setup through the socket API
  for (let k = 0; k < 10; k++) {
    await wait(20);
    const actorId = cs[0].state.actor;
    const c = cs.find(x => x.pid === actorId);
    assert.strictEqual(c.state.phase, 'setup');
    assert((await c.emit('action', { type: 'build', data: { kind: 'settlement', at: c.state.legal.settlement[0] } })).ok);
    await wait(20);
    assert((await c.emit('action', { type: 'build', data: { kind: 'road', at: c.state.legal.road[0] } })).ok);
  }
  await wait(50);
  const s = cs[0].state;
  assert.strictEqual(s.phase, 'roll');
  assert.strictEqual(s.board.hexes.length, 30);
  assert(s.hand && !('hand' in s.players[1] && s.players[1].hand), 'other hands are hidden');
  assert(!JSON.stringify(s).includes('devDeck'), 'deck is hidden');
  // reconnect keeps the seat
  cs[2].ws.close();
  const again = client('c'); await again.ready;
  assert((await again.emit('join', { name: 'P1', playerId: 'c', code: created.code })).ok);
  await wait(30);
  assert.strictEqual(again.state.players.length, 5);
  assert(!again.state.spectator);
  // latecomers watch
  const late = client('z'); await late.ready;
  assert((await late.emit('join', { name: 'Zed', playerId: 'z', code: created.code })).spectator);
  console.log('socket: create/join/configure/start/setup/reconnect/spectate all OK');
  srv.kill();
  process.exit(0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
