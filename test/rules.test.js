// Targeted rule checks on hand-built positions.
const assert = require('assert');
const { Game, total } = require('../src/game');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
}

// A started game with setup skipped and an empty board; p0 is to move in 'main'.
function fresh(n = 4, size = 'base') {
  const g = new Game('T', { size });
  for (let i = 0; i < n; i++) g.addPlayer('p' + i, 'P' + i);
  g.start('p0');
  g.players.sort((a, b) => a.id.localeCompare(b.id));
  g.setup = null;
  g.beginTurn(0);
  g.phase = 'main';
  return g;
}
const P = (g, i) => g.findPlayer('p' + i);
const give = (g, id, hand) => { const p = g.findPlayer(id); for (const r in hand) { p.hand[r] += hand[r]; g.bank[r] -= hand[r]; } };

// Walk a simple path of `len` edges starting at vertex v, avoiding `avoid` vertices.
function walk(g, v, len, avoid = new Set()) {
  const seen = new Set([v, ...avoid]);
  const verts = [v], edges = [];
  const go = (cur) => {
    if (edges.length === len) return true;
    for (const e of g.board.vertices[cur].edges) {
      const ed = g.board.edges[e];
      const nxt = ed.a === cur ? ed.b : ed.a;
      if (seen.has(nxt) || g.edgeRoad[e] !== null) continue;
      seen.add(nxt); verts.push(nxt); edges.push(e);
      if (go(nxt)) return true;
      seen.delete(nxt); verts.pop(); edges.pop();
    }
    return false;
  };
  assert(go(v), 'no path');
  return { verts, edges };
}
const placeRoads = (g, id, edges) => edges.forEach(e => { g.edgeRoad[e] = id; g.findPlayer(id).pieces.road--; });

test('setup: snake order, road touches settlement, second settlement pays out', () => {
  const g = new Game('T', { size: 'base' });
  ['a', 'b', 'c'].forEach(id => g.addPlayer(id, id));
  g.start('a');
  const order = g.setup.order.map(i => g.players[i].id);
  assert.deepStrictEqual(order.slice(3), order.slice(0, 3).reverse());
  const placed = [];
  for (let k = 0; k < 6; k++) {
    const id = g.actorId();
    const v = g.view(id).legal.settlement[0];
    assert.strictEqual(g.act(id, 'build', { kind: 'road', at: 0 }), 'Place a settlement now');
    const before = total(g.findPlayer(id).hand);
    assert.strictEqual(g.act(id, 'build', { kind: 'settlement', at: v }), null);
    const gained = total(g.findPlayer(id).hand) - before;
    const land = g.board.vertices[v].hexes.filter(h => g.board.hexes[h].resource !== 'desert').length;
    assert.strictEqual(gained, k < 3 ? 0 : land);
    const far = g.board.edges.find(e => e.a !== v && e.b !== v && g.edgeRoad[e.id] === null);
    assert(g.act(id, 'build', { kind: 'road', at: far.id }));
    assert.strictEqual(g.act(id, 'build', { kind: 'road', at: g.view(id).legal.road[0] }), null);
    placed.push(v);
  }
  assert.strictEqual(g.phase, 'roll');
  assert.strictEqual(g.cur().id, order[0]);
});

test('distance rule and road connection for settlements', () => {
  const g = fresh();
  const v = 10;
  g.vertexBuilding[v] = { owner: 'p0', type: 'settlement' };
  give(g, 'p0', { wood: 5, brick: 5, sheep: 5, wheat: 5 });
  const nb = g.board.vertices[v].adj[0];
  assert(g.act('p0', 'build', { kind: 'settlement', at: nb }), 'adjacent settlement must fail');
  const { verts, edges } = walk(g, v, 2);
  assert(g.act('p0', 'build', { kind: 'settlement', at: verts[2] }), 'unconnected settlement must fail');
  assert.strictEqual(g.act('p0', 'build', { kind: 'road', at: edges[0] }), null);
  assert.strictEqual(g.act('p0', 'build', { kind: 'road', at: edges[1] }), null);
  assert.strictEqual(g.act('p0', 'build', { kind: 'settlement', at: verts[2] }), null);
});

test('opponent settlement blocks road extension through it', () => {
  const g = fresh();
  const { verts, edges } = walk(g, 20, 2);
  placeRoads(g, 'p0', [edges[0]]);
  g.vertexBuilding[verts[1]] = { owner: 'p1', type: 'settlement' };
  give(g, 'p0', { wood: 1, brick: 1 });
  assert(g.act('p0', 'build', { kind: 'road', at: edges[1] }));
});

test('longest road: needs 5, passes on longer, broken by settlement, ties set aside', () => {
  const g = fresh();
  const a = walk(g, 0, 7);
  placeRoads(g, 'p0', a.edges.slice(0, 4));
  g.updateLongestRoad();
  assert.strictEqual(g.longestRoad, null);
  placeRoads(g, 'p0', [a.edges[4]]);
  g.updateLongestRoad();
  assert.strictEqual(g.longestRoad, 'p0');
  // p1 builds a separate 6-road
  const far = g.board.vertices.slice().reverse().find(v => !a.verts.includes(v.id) && v.adj.every(x => !a.verts.includes(x)));
  const b = walk(g, far.id, 6, new Set(a.verts));
  placeRoads(g, 'p1', b.edges.slice(0, 5));
  g.updateLongestRoad();
  assert.strictEqual(g.longestRoad, 'p0', 'tie keeps holder');
  placeRoads(g, 'p1', [b.edges[5]]);
  g.updateLongestRoad();
  assert.strictEqual(g.longestRoad, 'p1');
  assert.strictEqual(g.roadLength('p1'), 6);
  // p2 settles in the middle of p1's road: 6 -> 3+3 (or 2+4); p0 has 5 and takes it back
  g.vertexBuilding[b.verts[3]] = { owner: 'p2', type: 'settlement' };
  g.updateLongestRoad();
  assert.strictEqual(g.roadLength('p1'), 3);
  assert.strictEqual(g.longestRoad, 'p0');
  // break p0 too, to 2+3 → nobody has 5
  g.vertexBuilding[a.verts[2]] = { owner: 'p2', type: 'settlement' };
  g.updateLongestRoad();
  assert.strictEqual(g.longestRoad, null);
});

test('longest road counts branches correctly (fork = longest single path)', () => {
  const g = fresh();
  const a = walk(g, 30, 4);
  placeRoads(g, 'p0', a.edges);
  // branch off the middle vertex
  const mid = a.verts[2];
  const branch = g.board.vertices[mid].edges.find(e => g.edgeRoad[e] === null);
  placeRoads(g, 'p0', [branch]);
  assert.strictEqual(g.roadLength('p0'), 4);
});

test('production: cities give 2, robber blocks, bank shortage rules', () => {
  const g = fresh();
  const hex = g.board.hexes.find(h => h.resource === 'wheat');
  g.board.robber = g.board.hexes.find(h => h.resource === 'desert').id;
  const [v1, , v3] = hex.vertices;
  g.vertexBuilding[v1] = { owner: 'p1', type: 'city' };
  g.vertexBuilding[v3] = { owner: 'p2', type: 'settlement' };
  const others = g.board.hexes.filter(h => h.number === hex.number && h !== hex);
  for (const h of others) h.number = 99; // isolate
  g.produce(hex.number);
  assert.strictEqual(P(g, 1).hand.wheat, 2);
  assert.strictEqual(P(g, 2).hand.wheat, 1);
  g.board.robber = hex.id;
  g.produce(hex.number);
  assert.strictEqual(P(g, 1).hand.wheat, 2);
  g.board.robber = g.board.hexes.find(h => h.resource === 'desert').id;
  // shortage with two players owed: nobody gets
  const spare = g.bank.wheat - 2;
  g.bank.wheat = 2; P(g, 3).hand.wheat += spare;
  g.produce(hex.number);
  assert.strictEqual(P(g, 1).hand.wheat, 2);
  assert.strictEqual(P(g, 2).hand.wheat, 1);
  // shortage with one player owed: they take what is left
  g.vertexBuilding[v3] = null;
  g.produce(hex.number);
  assert.strictEqual(P(g, 1).hand.wheat, 4);
  assert.strictEqual(g.bank.wheat, 0);
});

test('seven: discard half rounded down, robber must move, steal from adjacent', () => {
  const g = fresh();
  g.phase = 'roll';
  give(g, 'p1', { wood: 9 });          // 9 → discard 4
  give(g, 'p2', { ore: 7 });           // 7 → safe
  g.startSeven();
  assert.strictEqual(g.phase, 'discard');
  assert.deepStrictEqual(g.discards, { p1: 4 });
  assert(g.act('p1', 'discard', { cards: { wood: 3 } }));
  assert.strictEqual(g.act('p1', 'discard', { cards: { wood: 4 } }), null);
  assert.strictEqual(g.phase, 'robber');
  assert(g.act('p0', 'moveRobber', { hex: g.board.robber }), 'must move');
  const hex = g.board.hexes.find(h => h.id !== g.board.robber);
  g.vertexBuilding[hex.vertices[0]] = { owner: 'p1', type: 'settlement' };
  g.vertexBuilding[hex.vertices[3]] = { owner: 'p2', type: 'settlement' };
  assert.strictEqual(g.act('p0', 'moveRobber', { hex: hex.id }), null);
  assert.strictEqual(g.phase, 'steal');
  assert(g.act('p0', 'steal', { victim: 'p3' }));
  assert.strictEqual(g.act('p0', 'steal', { victim: 'p2' }), null);
  assert.strictEqual(P(g, 0).hand.ore, 1);
  assert.strictEqual(g.phase, 'main');
});

test('development cards: not on purchase turn, one per turn, knight before roll, largest army', () => {
  const g = fresh();
  const p = P(g, 0);
  give(g, 'p0', { sheep: 1, wheat: 1, ore: 1 });
  g.devDeck.push('knight');
  assert.strictEqual(g.act('p0', 'buyDev'), null);
  assert(g.act('p0', 'playDev', { card: 'knight' }), 'cannot play on purchase turn');
  p.dev.push({ type: 'knight', turn: 0 }, { type: 'knight', turn: 0 }, { type: 'monopoly', turn: 0 });
  // play knight before rolling
  g.phase = 'roll';
  assert.strictEqual(g.act('p0', 'playDev', { card: 'knight' }), null);
  assert.strictEqual(g.phase, 'robber');
  g.act('p0', 'moveRobber', { hex: g.view('p0').legal.robber[0] });
  assert.strictEqual(g.phase, 'roll');
  assert(g.act('p0', 'playDev', { card: 'monopoly', res: 'wood' }), 'only one per turn');
  // largest army needs 3, and strictly more to take over
  p.knights = 2; P(g, 1).knights = 3; g.largestArmy = 'p1';
  g.devPlayed = false; g.phase = 'main';
  g.act('p0', 'playDev', { card: 'knight' });
  assert.strictEqual(g.largestArmy, 'p1', 'tie does not steal largest army');
});

test('monopoly and year of plenty', () => {
  const g = fresh();
  give(g, 'p1', { sheep: 3 }); give(g, 'p2', { sheep: 2 });
  P(g, 0).dev.push({ type: 'monopoly', turn: 0 }, { type: 'yearOfPlenty', turn: 0 });
  assert.strictEqual(g.act('p0', 'playDev', { card: 'monopoly', res: 'sheep' }), null);
  assert.strictEqual(P(g, 0).hand.sheep, 5);
  assert.strictEqual(P(g, 1).hand.sheep, 0);
  g.devPlayed = false;
  assert.strictEqual(g.act('p0', 'playDev', { card: 'yearOfPlenty', res: ['ore', 'ore'] }), null);
  assert.strictEqual(P(g, 0).hand.ore, 2);
});

test('road building places two free roads', () => {
  const g = fresh();
  g.vertexBuilding[5] = { owner: 'p0', type: 'settlement' };
  P(g, 0).dev.push({ type: 'roadBuilding', turn: 0 });
  assert.strictEqual(g.act('p0', 'playDev', { card: 'roadBuilding' }), null);
  assert(g.act('p0', 'endTurn'));
  assert.strictEqual(g.act('p0', 'build', { kind: 'road', at: g.legalRoads('p0')[0] }), null);
  assert.strictEqual(g.act('p0', 'build', { kind: 'road', at: g.legalRoads('p0')[0] }), null);
  assert.strictEqual(g.phase, 'main');
  assert.strictEqual(total(P(g, 0).hand), 0);
});

test('trading: rates, no gifts, only with the active player', () => {
  const g = fresh();
  give(g, 'p0', { wood: 4, brick: 1 });
  give(g, 'p1', { ore: 2 });
  give(g, 'p2', { wheat: 2 });
  assert(g.act('p0', 'bankTrade', { give: { wood: 3 }, get: { ore: 1 } }), '4:1 without port');
  assert.strictEqual(g.act('p0', 'bankTrade', { give: { wood: 4 }, get: { ore: 1 } }), null);
  assert(g.act('p0', 'offer', { give: { brick: 1 }, get: {} }), 'no gifts');
  assert.strictEqual(g.act('p0', 'offer', { give: { brick: 1 }, get: { ore: 1 } }), null);
  const o = g.offers[0];
  assert.strictEqual(g.act('p1', 'respond', { offerId: o.id, accept: true }), null);
  assert(g.act('p0', 'confirmTrade', { offerId: o.id, with: 'p2' }), 'p2 did not accept');
  assert.strictEqual(g.act('p0', 'confirmTrade', { offerId: o.id, with: 'p1' }), null);
  assert.strictEqual(P(g, 0).hand.ore, 2);
  assert.strictEqual(P(g, 1).hand.brick, 1);
  // a non-active player's offer always goes to the active player
  assert.strictEqual(g.act('p2', 'offer', { give: { wheat: 1 }, get: { ore: 1 }, to: 'p1' }), null);
  const o2 = g.offers.find(x => x.from === 'p2');
  assert.strictEqual(o2.to, 'p0');
  assert(g.act('p1', 'respond', { offerId: o2.id, accept: true }));
  assert.strictEqual(g.act('p0', 'respond', { offerId: o2.id, accept: true }), null);
  assert.strictEqual(P(g, 0).hand.wheat, 1);
  // ports
  const port = g.board.ports.find(pt => pt.type !== 'any');
  g.vertexBuilding[port.vertices[0]] = { owner: 'p3', type: 'settlement' };
  assert.strictEqual(g.tradeRates('p3')[port.type], 2);
});

test('win only on your own turn; points from others\' turns count at turn start', () => {
  const g = fresh(3);
  const verts = [0, 8, 16, 24, 40].filter((v, i, arr) => true);
  // give p1 9 public points via cities without triggering win (not their turn)
  let placed = 0;
  for (const v of g.board.vertices) {
    if (placed === 4) break;
    if (g.canSettle(v.id, 'p1', false)) { g.vertexBuilding[v.id] = { owner: 'p1', type: 'city' }; placed++; }
  }
  P(g, 1).dev.push({ type: 'vp', turn: 0 }, { type: 'vp', turn: 0 });
  assert.strictEqual(g.totalVP(P(g, 1)), 10);
  assert.strictEqual(g.checkWin(), false, 'p0 is active');
  assert.strictEqual(g.act('p0', 'endTurn'), null);
  assert.strictEqual(g.phase, 'over');
  assert.strictEqual(g.winner, 'p1');
});

test('5-6 player board: sizes, bank, deck, special building phase', () => {
  const g = fresh(5, 'extended');
  assert.strictEqual(g.board.hexes.length, 30);
  assert.strictEqual(g.board.ports.length, 11);
  assert.strictEqual(g.board.hexes.filter(h => h.resource === 'desert').length, 2);
  assert.strictEqual(g.devDeck.length, 34);
  assert.strictEqual(g.bank.ore, 24);
  assert.strictEqual(g.act('p0', 'endTurn'), null);
  assert.strictEqual(g.phase, 'special');
  assert.strictEqual(g.actorId(), 'p1');
  give(g, 'p1', { wood: 1, brick: 1, sheep: 1, wheat: 1, ore: 1 });
  assert(g.act('p1', 'offer', { give: { wood: 1 }, get: { ore: 1 } }), 'no trading in SBP');
  assert.strictEqual(g.act('p1', 'buyDev'), null);
  for (const id of ['p1', 'p2', 'p3', 'p4']) assert.strictEqual(g.act(id, 'endTurn'), null);
  assert.strictEqual(g.phase, 'roll');
  assert.strictEqual(g.cur().id, 'p1');
});

test('base board geometry', () => {
  const g = fresh(4);
  assert.strictEqual(g.board.hexes.length, 19);
  assert.strictEqual(g.board.vertices.length, 54);
  assert.strictEqual(g.board.edges.length, 72);
  assert.strictEqual(g.board.ports.length, 9);
  const portVerts = g.board.ports.flatMap(p => p.vertices);
  assert.strictEqual(new Set(portVerts).size, portVerts.length, 'ports must not share corners');
  const red = h => h.number === 6 || h.number === 8;
  for (const h of g.board.hexes) if (red(h)) assert(h.neighbors.every(n => !red(g.board.hexes[n])));
});

test('discard limit setting', () => {
  const g = fresh();
  g.settings.discardLimit = 9;
  give(g, 'p1', { wood: 9 });   // 9 is not more than 9 → safe
  give(g, 'p2', { ore: 10 });   // 10 → discard 5
  g.phase = 'roll';
  g.startSeven();
  assert.deepStrictEqual(g.discards, { p2: 5 });
});

test('host settings are validated; hidden bank is not sent to players', () => {
  const g = new Game('T', { size: 'base' });
  g.addPlayer('a', 'A'); g.addPlayer('b', 'B');
  assert(g.configure('b', { turnTime: 60 }), 'only host');
  assert.strictEqual(g.configure('a', { turnTime: 90, discardLimit: 10, hideBank: true }), null);
  g.configure('a', { turnTime: 45, discardLimit: 3 }); // not allowed values are ignored
  assert.deepStrictEqual([g.settings.turnTime, g.settings.discardLimit, g.settings.hideBank], [90, 10, true]);
  g.start('a');
  const v = g.view('a');
  assert.strictEqual(v.bank, null);
  assert(v.timeLeft > 89000 && v.timeLeft <= 90000);
  g.destroy();
});

test('main-phase countdown is not reset by playing a card', () => {
  const g = fresh();
  g.settings.turnTime = 60;
  g.syncTimer();
  const first = g.timer.deadline;
  P(g, 0).dev.push({ type: 'roadBuilding', turn: 0 });
  g.vertexBuilding[5] = { owner: 'p0', type: 'settlement' };
  g.act('p0', 'playDev', { card: 'roadBuilding' });
  g.act('p0', 'build', { kind: 'road', at: g.legalRoads('p0')[0] });
  g.act('p0', 'build', { kind: 'road', at: g.legalRoads('p0')[0] });
  assert.strictEqual(g.phase, 'main');
  assert(g.timer.deadline <= first + 50, 'same deadline as before the card');
  g.destroy();
});

test('timeouts resolve every phase: with nobody acting, each timeout moves the game on', () => {
  for (const [size, n] of [['base', 4], ['extended', 6]]) {
    const g = new Game('T', { size, turnTime: 60 });
    for (let i = 0; i < n; i++) g.addPlayer('p' + i, 'P' + i);
    g.start('p0');
    const seen = new Set();
    for (let step = 0; step < 3000; step++) {
      seen.add(g.phase);
      // hand out cards now and then so discards, steals and free roads all come up
      if (g.phase === 'roll' && step % 7 === 0) {
        const p = g.players[step % n];
        for (const r of ['wood', 'brick', 'sheep', 'wheat', 'ore']) if (g.bank[r] >= 2) { g.bank[r] -= 2; p.hand[r] += 2; }
        if (step % 21 === 0) g.cur().dev.push({ type: 'roadBuilding', turn: 0 });
      }
      if (g.phase === 'roll' && g.cur().dev.some(c => c.type === 'roadBuilding') && !g.devPlayed) g.act(g.cur().id, 'playDev', { card: 'roadBuilding' });
      seen.add(g.phase);
      const before = g.timerKey();
      g.onTimeout();
      assert.notStrictEqual(g.timerKey(), before, 'timeout in ' + before + ' did not move the game on');
      assert(g.timer.deadline || g.phase === 'over', 'a new countdown starts');
      if (g.phase === 'over') break;
    }
    g.destroy();
    for (const ph of ['setup', 'roll', 'robber', 'discard', 'roadBuilding']) assert(seen.has(ph), size + ': never saw ' + ph);
    if (size === 'extended') assert(seen.has('special'));
  }
});

console.log(`rules: ${passed} tests passed`);
