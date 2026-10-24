// Plays many full games with random-but-legal agents and checks invariants after every action.
const assert = require('assert');
const { Game, total } = require('../src/game');
const { RESOURCES } = require('../src/board');

const pick = a => a[Math.floor(Math.random() * a.length)];

function checkInvariants(g, bankEach) {
  for (const r of RESOURCES) {
    const sum = g.bank[r] + g.players.reduce((s, p) => s + p.hand[r], 0);
    assert.strictEqual(sum, bankEach, `resource ${r} not conserved`);
    assert(g.bank[r] >= 0);
    for (const p of g.players) assert(p.hand[r] >= 0, 'negative hand');
  }
  // distance rule
  g.vertexBuilding.forEach((b, v) => {
    if (b) for (const a of g.board.vertices[v].adj) assert(!g.vertexBuilding[a], 'distance rule broken');
  });
  for (const p of g.players) {
    const roads = g.edgeRoad.filter(o => o === p.id).length;
    assert.strictEqual(roads + p.pieces.road, 15);
    const s = g.vertexBuilding.filter(b => b && b.owner === p.id && b.type === 'settlement').length;
    const c = g.vertexBuilding.filter(b => b && b.owner === p.id && b.type === 'city').length;
    assert.strictEqual(s + p.pieces.settlement, 5);
    assert.strictEqual(c + p.pieces.city, 4);
  }
}

function step(g) {
  const actor = g.findPlayer(g.actorId());
  const ok = (id, type, d) => { const e = g.act(id, type, d); return !e; };
  if (g.phase === 'setup') {
    const v = g.view(actor.id);
    const kind = g.setup.step;
    assert(ok(actor.id, 'build', { kind, at: pick(v.legal[kind]) }), 'setup build failed');
    return;
  }
  if (g.phase === 'discard') {
    for (const [id, n] of Object.entries(g.discards)) {
      const p = g.findPlayer(id);
      const pool = RESOURCES.flatMap(r => Array(p.hand[r]).fill(r));
      const cards = {};
      for (let i = 0; i < n; i++) { const r = pool.splice(Math.floor(Math.random() * pool.length), 1)[0]; cards[r] = (cards[r] || 0) + 1; }
      assert(ok(id, 'discard', { cards }), 'discard failed');
    }
    return;
  }
  if (g.phase === 'robber') {
    assert(ok(actor.id, 'moveRobber', { hex: pick(g.view(actor.id).legal.robber) }));
    return;
  }
  if (g.phase === 'steal') { assert(ok(actor.id, 'steal', { victim: pick(g.stealCandidates) })); return; }
  if (g.phase === 'roadBuilding') {
    assert(ok(actor.id, 'build', { kind: 'road', at: pick(g.legalRoads(actor.id)) }), 'free road failed');
    return;
  }
  if (g.phase === 'roll') {
    const playable = actor.dev.filter(c => c.type === 'knight' && c.turn < g.turnNumber);
    if (playable.length && Math.random() < 0.5) ok(actor.id, 'playDev', { card: 'knight' });
    else assert(ok(actor.id, 'roll'));
    return;
  }
  // main / special: try to build things, sometimes trade, then end turn
  const v = g.view(actor.id);
  for (let i = 0; i < 6; i++) {
    if (v.legal.city.length) ok(actor.id, 'build', { kind: 'city', at: pick(v.legal.city) });
    if (v.legal.settlement.length) ok(actor.id, 'build', { kind: 'settlement', at: pick(v.legal.settlement) });
    const roads = g.legalRoads(actor.id);
    if (roads.length && Math.random() < 0.6) ok(actor.id, 'build', { kind: 'road', at: pick(roads) });
    if (Math.random() < 0.4) ok(actor.id, 'buyDev');
    if (g.phase === 'over') return;
  }
  if (g.phase === 'main') {
    const card = actor.dev.find(c => c.type !== 'vp' && c.turn < g.turnNumber);
    if (card && !g.devPlayed) {
      ok(actor.id, 'playDev', { card: card.type, res: card.type === 'yearOfPlenty' ? [pick(RESOURCES), pick(RESOURCES)] : pick(RESOURCES) });
      if (g.phase !== 'main') return;
    }
    // bank trade surplus
    const rates = g.tradeRates(actor.id);
    for (const r of RESOURCES) {
      if (actor.hand[r] >= rates[r] + 1) { ok(actor.id, 'bankTrade', { give: { [r]: rates[r] }, get: { [pick(RESOURCES.filter(x => x !== r))]: 1 } }); }
    }
    // domestic trade: offer 1 of most for 1 of least, someone accepts
    const most = RESOURCES.reduce((a, b) => (actor.hand[a] >= actor.hand[b] ? a : b));
    const least = RESOURCES.reduce((a, b) => (actor.hand[a] <= actor.hand[b] ? a : b));
    if (most !== least && actor.hand[most] > 0 && ok(actor.id, 'offer', { give: { [most]: 1 }, get: { [least]: 1 } })) {
      const o = g.offers[g.offers.length - 1];
      const partner = g.players.find(p => p !== actor && p.hand[least] > 0);
      if (partner && ok(partner.id, 'respond', { offerId: o.id, accept: true })) assert(ok(actor.id, 'confirmTrade', { offerId: o.id, with: partner.id }), 'confirm failed');
    }
  }
  if (g.phase === 'main' || g.phase === 'special') assert(ok(actor.id, 'endTurn'), 'end turn failed: ' + g.phase);
}

function playGame(size, n) {
  const g = new Game('TEST', { size });
  for (let i = 0; i < n; i++) g.addPlayer('p' + i, 'P' + i);
  assert.strictEqual(g.start('p0'), null);
  const bankEach = size === 'extended' ? 24 : 19;
  let steps = 0;
  while (g.phase !== 'over' && steps < 20000) {
    step(g);
    checkInvariants(g, bankEach);
    JSON.stringify(g.view('p0')); // views must always serialise
    steps++;
  }
  assert.strictEqual(g.phase, 'over', `game did not finish (${size}, ${n} players)`);
  const w = g.findPlayer(g.winner);
  assert(g.totalVP(w) >= 10);
  return g.turnNumber;
}

let games = 0, turns = 0;
for (const [size, counts] of [['base', [2, 3, 4]], ['extended', [5, 6]]]) {
  for (const n of counts) for (let k = 0; k < 12; k++) { turns += playGame(size, n); games++; }
}
console.log(`sim: ${games} random games finished, avg ${Math.round(turns / games)} turns — all invariants held`);
