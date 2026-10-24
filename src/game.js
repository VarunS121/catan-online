// Catan rules engine. The server is authoritative: every action is validated here,
// and view(playerId) hides other players' hands and the development deck.
const crypto = require('crypto');
const { generateBoard, RESOURCES, shuffle } = require('./board');

const COSTS = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city: { wheat: 2, ore: 3 },
  dev: { sheep: 1, wheat: 1, ore: 1 },
};
const COLORS = ['#e23b3b', '#2f6fde', '#f2f2f2', '#f08a24', '#3aa655', '#8b5a2b'];
const LIMITS = { base: { min: 2, max: 4 }, extended: { min: 3, max: 6 } };
const DEV_NAMES = { knight: 'Knight', roadBuilding: 'Road Building', yearOfPlenty: 'Year of Plenty', monopoly: 'Monopoly', vp: 'Victory Point' };

const emptyHand = () => ({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });
const total = hand => RESOURCES.reduce((s, r) => s + (hand[r] || 0), 0);
const isRes = r => RESOURCES.includes(r);

// Turns untrusted input into a clean {resource: nonNegativeInt} map.
function cleanHand(obj) {
  const h = emptyHand();
  if (obj && typeof obj === 'object') {
    for (const r of RESOURCES) {
      const n = Math.floor(Number(obj[r]));
      if (Number.isFinite(n) && n > 0 && n <= 99) h[r] = n;
    }
  }
  return h;
}
const has = (hand, need) => RESOURCES.every(r => (hand[r] || 0) >= (need[r] || 0));
const handText = h => RESOURCES.filter(r => h[r]).map(r => `${h[r]} ${r}`).join(', ') || 'nothing';

class Game {
  constructor(code, settings, hooks = {}) {
    this.code = code;
    this.settings = { size: settings.size === 'extended' ? 'extended' : 'base', vpTarget: settings.vpTarget || 10 };
    this.hooks = { changed() {}, fx() {}, ...hooks };
    this.players = [];   // seat order (randomised at start)
    this.spectators = new Map();
    this.phase = 'lobby';
    this.log = [];
    this.logId = 0;
    this.offers = [];
    this.offerId = 0;
    this.rollCounts = Array(13).fill(0);
  }

  // ---------- lobby ----------
  findPlayer(id) { return this.players.find(p => p.id === id); }
  get hostId() { return this.players[0] && this.players[0].id; }
  get limits() { return LIMITS[this.settings.size]; }

  addPlayer(id, name) {
    const existing = this.findPlayer(id);
    if (existing) { existing.connected = true; existing.name = name || existing.name; this.hooks.changed(); return { ok: true }; }
    if (this.phase !== 'lobby') {
      this.spectators.set(id, name);
      this.hooks.changed();
      return { ok: true, spectator: true };
    }
    if (this.players.length >= 6) return { error: 'This game is full (6 players max)' };
    const used = new Set(this.players.map(p => p.color));
    this.players.push({ id, name, color: COLORS.find(c => !used.has(c)), connected: true });
    this.hooks.changed();
    return { ok: true };
  }

  removePlayer(id) {
    this.spectators.delete(id);
    if (this.phase !== 'lobby') { this.setConnected(id, false); return; }
    this.players = this.players.filter(p => p.id !== id);
    this.hooks.changed();
  }

  setConnected(id, value) {
    const p = this.findPlayer(id);
    if (p) { p.connected = value; this.hooks.changed(); }
  }

  configure(id, s = {}) {
    if (this.phase !== 'lobby') return 'The game has already started';
    if (id !== this.hostId) return 'Only the host can change settings';
    if (s.size === 'base' || s.size === 'extended') this.settings.size = s.size;
    const vp = Math.floor(Number(s.vpTarget));
    if (vp >= 5 && vp <= 20) this.settings.vpTarget = vp;
    if (s.color && COLORS.includes(s.color)) {
      const me = this.findPlayer(id);
      if (!this.players.some(p => p.color === s.color && p !== me)) me.color = s.color;
    }
    this.hooks.changed();
    return null;
  }

  pickColor(id, color) {
    if (this.phase !== 'lobby') return 'The game has already started';
    const me = this.findPlayer(id);
    if (!me || !COLORS.includes(color)) return 'Invalid colour';
    if (this.players.some(p => p.color === color && p !== me)) return 'That colour is taken';
    me.color = color;
    this.hooks.changed();
    return null;
  }

  start(id) {
    if (this.phase !== 'lobby') return 'The game has already started';
    if (id !== this.hostId) return 'Only the host can start the game';
    const { min, max } = this.limits;
    if (this.players.length < min || this.players.length > max) {
      return this.settings.size === 'base' ? 'The base board needs 2–4 players' : 'The 5–6 player board needs 3–6 players';
    }
    const big = this.settings.size === 'extended';
    this.board = generateBoard(this.settings.size);
    this.vertexBuilding = Array(this.board.vertices.length).fill(null); // {owner, type}
    this.edgeRoad = Array(this.board.edges.length).fill(null);          // owner id
    const bankEach = big ? 24 : 19;
    this.bank = { wood: bankEach, brick: bankEach, sheep: bankEach, wheat: bankEach, ore: bankEach };
    const counts = big
      ? { knight: 20, vp: 5, roadBuilding: 3, yearOfPlenty: 3, monopoly: 3 }
      : { knight: 14, vp: 5, roadBuilding: 2, yearOfPlenty: 2, monopoly: 2 };
    this.devDeck = shuffle(Object.entries(counts).flatMap(([t, n]) => Array(n).fill(t)));

    shuffle(this.players);
    for (const p of this.players) {
      Object.assign(p, {
        hand: emptyHand(), dev: [], knights: 0, roadLen: 0,
        pieces: { road: 15, settlement: 5, city: 4 },
      });
    }
    this.longestRoad = null;
    this.largestArmy = null;
    this.turnNumber = 0;
    this.current = 0;
    this.setup = { order: [...this.players.keys(), ...[...this.players.keys()].reverse()], idx: 0, step: 'settlement', last: null };
    this.phase = 'setup';
    this.addLog(`Game started on the ${big ? '5–6 player' : 'base'} board. ${this.players[0].name} places first.`);
    this.hooks.changed();
    return null;
  }

  // ---------- helpers ----------
  addLog(text, to) {
    this.log.push({ id: ++this.logId, text, to: to || null });
    if (this.log.length > 120) this.log.shift();
  }
  cur() { return this.players[this.current]; }
  idx(id) { return this.players.findIndex(p => p.id === id); }
  pay(p, cost) { for (const r of RESOURCES) { p.hand[r] -= cost[r] || 0; this.bank[r] += cost[r] || 0; } }

  // who may act right now (for setup / turn phases)
  actorId() {
    if (this.phase === 'setup') return this.players[this.setup.order[this.setup.idx]].id;
    if (this.phase === 'special') return this.players[this.special.queue[0]].id;
    return this.cur() && this.cur().id;
  }

  ownsAt(v, id) { const b = this.vertexBuilding[v]; return b && b.owner === id; }

  canSettle(v, id, needRoad) {
    if (this.vertexBuilding[v]) return false;
    const vert = this.board.vertices[v];
    if (vert.adj.some(a => this.vertexBuilding[a])) return false; // distance rule
    if (!needRoad) return true;
    return vert.edges.some(e => this.edgeRoad[e] === id);
  }

  canRoad(e, id) {
    if (this.edgeRoad[e] !== null) return false;
    const edge = this.board.edges[e];
    return [edge.a, edge.b].some(v => {
      if (this.ownsAt(v, id)) return true;
      const b = this.vertexBuilding[v];
      if (b && b.owner !== id) return false; // opponent building blocks the connection
      return this.board.vertices[v].edges.some(o => o !== e && this.edgeRoad[o] === id);
    });
  }

  legalSettlements(id, needRoad = true) {
    return this.board.vertices.filter(v => this.canSettle(v.id, id, needRoad)).map(v => v.id);
  }
  legalRoads(id) {
    if (this.phase === 'setup') {
      const v = this.board.vertices[this.setup.last];
      return v.edges.filter(e => this.edgeRoad[e] === null);
    }
    return this.board.edges.filter(e => this.canRoad(e.id, id)).map(e => e.id);
  }
  legalCities(id) {
    return this.vertexBuilding.map((b, v) => (b && b.owner === id && b.type === 'settlement' ? v : -1)).filter(v => v >= 0);
  }

  tradeRates(id) {
    const rates = { wood: 4, brick: 4, sheep: 4, wheat: 4, ore: 4 };
    for (const port of this.board.ports) {
      if (!port.vertices.some(v => this.ownsAt(v, id))) continue;
      if (port.type === 'any') { for (const r of RESOURCES) rates[r] = Math.min(rates[r], 3); }
      else rates[port.type] = 2;
    }
    return rates;
  }

  publicVP(p) {
    let vp = 0;
    this.vertexBuilding.forEach(b => { if (b && b.owner === p.id) vp += b.type === 'city' ? 2 : 1; });
    if (this.longestRoad === p.id) vp += 2;
    if (this.largestArmy === p.id) vp += 2;
    return vp;
  }
  totalVP(p) { return this.publicVP(p) + p.dev.filter(c => c.type === 'vp').length; }

  // Longest single continuous road for a player; opponents' buildings break it.
  roadLength(id) {
    const { vertices, edges } = this.board;
    const used = new Set();
    let best = 0;
    const dfs = (v, arrived) => {
      const b = this.vertexBuilding[v];
      if (arrived && b && b.owner !== id) return 0;
      let max = 0;
      for (const e of vertices[v].edges) {
        if (this.edgeRoad[e] !== id || used.has(e)) continue;
        used.add(e);
        const edge = edges[e];
        max = Math.max(max, 1 + dfs(edge.a === v ? edge.b : edge.a, true));
        used.delete(e);
      }
      return max;
    };
    const starts = new Set();
    this.edgeRoad.forEach((o, e) => { if (o === id) { starts.add(edges[e].a); starts.add(edges[e].b); } });
    for (const v of starts) best = Math.max(best, dfs(v, false));
    return best;
  }

  updateLongestRoad() {
    for (const p of this.players) p.roadLen = this.roadLength(p.id);
    const prev = this.longestRoad;
    const holder = prev && this.findPlayer(prev);
    const max = Math.max(...this.players.map(p => p.roadLen));
    if (holder && holder.roadLen >= 5 && holder.roadLen >= max) return;
    const leaders = this.players.filter(p => p.roadLen === max);
    let next = null;
    if (max >= 5 && leaders.length === 1) next = leaders[0].id;
    if (next !== prev) {
      this.longestRoad = next;
      if (next) this.addLog(`🛣️ ${this.findPlayer(next).name} takes Longest Road (${max}).`);
      else this.addLog('🛣️ Longest Road is set aside — nobody holds it.');
      this.hooks.fx({ type: 'award', what: 'road', id: next });
    }
  }

  updateLargestArmy(p) {
    if (p.knights < 3 || this.largestArmy === p.id) return;
    const holder = this.largestArmy && this.findPlayer(this.largestArmy);
    if (!holder || p.knights > holder.knights) {
      this.largestArmy = p.id;
      this.addLog(`⚔️ ${p.name} takes Largest Army (${p.knights} knights).`);
      this.hooks.fx({ type: 'award', what: 'army', id: p.id });
    }
  }

  // You can only win on your own turn.
  checkWin() {
    if (this.phase === 'over' || this.phase === 'setup') return false;
    const p = this.cur();
    if (this.totalVP(p) < this.settings.vpTarget) return false;
    this.phase = 'over';
    this.winner = p.id;
    this.offers = [];
    this.addLog(`🏆 ${p.name} wins with ${this.totalVP(p)} victory points!`);
    this.hooks.fx({ type: 'win', id: p.id });
    return true;
  }

  // ---------- actions ----------
  act(id, type, d = {}) {
    if (!this.findPlayer(id)) return 'You are not a player in this game';
    if (this.phase === 'lobby') return 'The game has not started';
    if (this.phase === 'over') return 'The game is over';
    if (d === null || typeof d !== 'object') d = {};
    const handler = {
      build: this.doBuild, roll: this.doRoll, endTurn: this.doEndTurn, buyDev: this.doBuyDev,
      playDev: this.doPlayDev, moveRobber: this.doMoveRobber, steal: this.doSteal, discard: this.doDiscard,
      bankTrade: this.doBankTrade, offer: this.doOffer, respond: this.doRespond, confirmTrade: this.doConfirmTrade,
      cancelOffer: this.doCancelOffer,
    }[type];
    if (!handler) return 'Unknown action';
    const err = handler.call(this, this.findPlayer(id), d);
    if (!err) this.hooks.changed();
    return err || null;
  }

  doBuild(p, d) {
    const kind = d.kind, at = Math.floor(Number(d.at));
    if (this.phase === 'setup') return this.setupBuild(p, kind, at);
    const free = this.phase === 'roadBuilding';
    if (this.actorId() !== p.id) return 'It is not your turn';
    if (!['main', 'special', 'roadBuilding'].includes(this.phase)) return this.phase === 'roll' ? 'Roll the dice first' : 'You cannot build right now';
    if (free && kind !== 'road') return 'Place your free roads first';
    if (!free && !has(p.hand, COSTS[kind] || { x: 1 })) return 'Not enough resources';
    if (kind === 'road') {
      if (!this.board.edges[at] || !this.canRoad(at, p.id)) return 'You cannot build a road there';
      if (p.pieces.road <= 0) return 'You have no roads left';
      if (!free) this.pay(p, COSTS.road);
      this.edgeRoad[at] = p.id;
      p.pieces.road--;
      this.addLog(`${p.name} built a road${free ? ' (Road Building)' : ''}.`);
      this.hooks.fx({ type: 'build', kind, at, id: p.id });
      this.updateLongestRoad();
      if (free) {
        this.roadBuilding--;
        if (this.roadBuilding <= 0 || p.pieces.road <= 0 || this.legalRoads(p.id).length === 0) {
          this.phase = this.roadBuildingReturn;
          this.roadBuilding = 0;
        }
      }
    } else if (kind === 'settlement') {
      if (!this.board.vertices[at] || !this.canSettle(at, p.id, true)) return 'You cannot build a settlement there';
      if (p.pieces.settlement <= 0) return 'You have no settlements left';
      this.pay(p, COSTS.settlement);
      this.vertexBuilding[at] = { owner: p.id, type: 'settlement' };
      p.pieces.settlement--;
      this.addLog(`${p.name} built a settlement.`);
      this.hooks.fx({ type: 'build', kind, at, id: p.id });
      this.updateLongestRoad(); // may cut an opponent's road
    } else if (kind === 'city') {
      const b = this.vertexBuilding[at];
      if (!b || b.owner !== p.id || b.type !== 'settlement') return 'Cities must upgrade one of your settlements';
      if (p.pieces.city <= 0) return 'You have no cities left';
      this.pay(p, COSTS.city);
      b.type = 'city';
      p.pieces.city--;
      p.pieces.settlement++;
      this.addLog(`${p.name} built a city.`);
      this.hooks.fx({ type: 'build', kind, at, id: p.id });
    } else return 'Unknown building';
    this.checkWin();
    return null;
  }

  setupBuild(p, kind, at) {
    const s = this.setup;
    if (this.actorId() !== p.id) return 'It is not your turn to place';
    if (kind !== s.step) return `Place a ${s.step} now`;
    if (kind === 'settlement') {
      if (!this.board.vertices[at] || !this.canSettle(at, p.id, false)) return 'You cannot place a settlement there';
      this.vertexBuilding[at] = { owner: p.id, type: 'settlement' };
      p.pieces.settlement--;
      s.last = at;
      s.step = 'road';
      const second = s.idx >= this.players.length;
      if (second) {
        const gain = emptyHand();
        for (const h of this.board.vertices[at].hexes) {
          const r = this.board.hexes[h].resource;
          if (isRes(r) && this.bank[r] > 0) { gain[r]++; this.bank[r]--; p.hand[r]++; }
        }
        this.addLog(`${p.name} placed their second settlement and collected ${handText(gain)}.`);
      } else this.addLog(`${p.name} placed a settlement.`);
      this.hooks.fx({ type: 'build', kind, at, id: p.id });
    } else {
      const edge = this.board.edges[at];
      if (!edge || this.edgeRoad[at] !== null || (edge.a !== s.last && edge.b !== s.last)) return 'The road must touch the settlement you just placed';
      this.edgeRoad[at] = p.id;
      p.pieces.road--;
      this.hooks.fx({ type: 'build', kind, at, id: p.id });
      s.idx++;
      s.step = 'settlement';
      s.last = null;
      if (s.idx >= s.order.length) {
        this.setup = null;
        this.addLog('Setup complete — let the game begin!');
        this.beginTurn(0);
      }
    }
    return null;
  }

  beginTurn(i) {
    this.current = i;
    this.turnNumber++;
    this.devPlayed = false;
    this.dice = null;
    this.offers = [];
    this.phase = 'roll';
    this.addLog(`— ${this.cur().name}'s turn —`);
    this.checkWin(); // points gained on other players' turns count now
  }

  doRoll(p) {
    if (this.actorId() !== p.id || this.phase !== 'roll') return 'You cannot roll now';
    const d1 = crypto.randomInt(1, 7), d2 = crypto.randomInt(1, 7), sum = d1 + d2;
    this.dice = [d1, d2];
    this.rollCounts[sum]++;
    this.addLog(`🎲 ${p.name} rolled ${sum}.`);
    this.hooks.fx({ type: 'roll', dice: this.dice, id: p.id });
    if (sum === 7) this.startSeven();
    else { this.produce(sum); this.phase = 'main'; }
    return null;
  }

  produce(sum) {
    const owed = {}; // resource -> {playerId: n}
    for (const hex of this.board.hexes) {
      if (hex.number !== sum || hex.id === this.board.robber) continue;
      for (const v of hex.vertices) {
        const b = this.vertexBuilding[v];
        if (!b) continue;
        owed[hex.resource] = owed[hex.resource] || {};
        owed[hex.resource][b.owner] = (owed[hex.resource][b.owner] || 0) + (b.type === 'city' ? 2 : 1);
      }
    }
    const gains = {};
    for (const [r, by] of Object.entries(owed)) {
      const ids = Object.keys(by);
      const need = ids.reduce((s, id) => s + by[id], 0);
      if (need > this.bank[r]) {
        // Bank shortage: if only one player is owed they take what is left, otherwise nobody gets any.
        if (ids.length > 1) { this.addLog(`The bank ran short of ${r} — nobody receives it.`); continue; }
        by[ids[0]] = this.bank[r];
      }
      for (const id of ids) {
        const n = by[id];
        if (!n) continue;
        this.findPlayer(id).hand[r] += n;
        this.bank[r] -= n;
        (gains[id] = gains[id] || emptyHand())[r] += n;
      }
    }
    for (const [id, g] of Object.entries(gains)) this.addLog(`${this.findPlayer(id).name} received ${handText(g)}.`);
    if (!Object.keys(gains).length) this.addLog('Nobody produced anything.');
    this.hooks.fx({ type: 'produce', gains });
  }

  startSeven() {
    this.discards = {};
    for (const q of this.players) {
      const n = total(q.hand);
      if (n > 7) this.discards[q.id] = Math.floor(n / 2);
    }
    this.robberReturn = 'main';
    if (Object.keys(this.discards).length) {
      this.phase = 'discard';
      this.addLog(`Players with more than 7 cards must discard half: ${Object.keys(this.discards).map(id => this.findPlayer(id).name).join(', ')}.`);
    } else this.phase = 'robber';
  }

  doDiscard(p, d) {
    if (this.phase !== 'discard' || !this.discards[p.id]) return 'You do not need to discard';
    const h = cleanHand(d.cards);
    if (total(h) !== this.discards[p.id]) return `Choose exactly ${this.discards[p.id]} cards`;
    if (!has(p.hand, h)) return 'You do not have those cards';
    this.pay(p, h);
    delete this.discards[p.id];
    this.addLog(`${p.name} discarded ${total(h)} cards.`);
    this.addLog(`You discarded ${handText(h)}.`, [p.id]);
    if (!Object.keys(this.discards).length) this.phase = 'robber';
    return null;
  }

  doMoveRobber(p, d) {
    if (this.phase !== 'robber' || this.cur().id !== p.id) return 'You cannot move the robber now';
    const hex = Math.floor(Number(d.hex));
    if (!this.board.hexes[hex]) return 'Invalid hex';
    if (hex === this.board.robber) return 'The robber must move to a different hex';
    this.board.robber = hex;
    this.hooks.fx({ type: 'robber', hex });
    const victims = this.robberVictims();
    this.addLog(`${p.name} moved the robber.`);
    if (victims.length === 0) this.phase = this.robberReturn;
    else if (victims.length === 1) this.stealFrom(p, this.findPlayer(victims[0]));
    else { this.phase = 'steal'; this.stealCandidates = victims; }
    return null;
  }

  robberVictims() {
    const me = this.cur().id;
    const ids = new Set();
    for (const v of this.board.hexes[this.board.robber].vertices) {
      const b = this.vertexBuilding[v];
      if (b && b.owner !== me && total(this.findPlayer(b.owner).hand) > 0) ids.add(b.owner);
    }
    return [...ids];
  }

  doSteal(p, d) {
    if (this.phase !== 'steal' || this.cur().id !== p.id) return 'You cannot steal now';
    if (!this.stealCandidates.includes(d.victim)) return 'You cannot steal from that player';
    this.stealFrom(p, this.findPlayer(d.victim));
    return null;
  }

  stealFrom(p, victim) {
    const pool = RESOURCES.flatMap(r => Array(victim.hand[r]).fill(r));
    if (pool.length) {
      const r = pool[crypto.randomInt(pool.length)];
      victim.hand[r]--;
      p.hand[r]++;
      this.addLog(`${p.name} stole a card from ${victim.name}.`);
      this.addLog(`You stole 1 ${r} from ${victim.name}.`, [p.id]);
      this.addLog(`${p.name} stole your ${r}.`, [victim.id]);
      this.hooks.fx({ type: 'steal', from: victim.id, to: p.id });
    }
    this.stealCandidates = null;
    this.phase = this.robberReturn;
  }

  doBuyDev(p) {
    if (this.actorId() !== p.id || !['main', 'special'].includes(this.phase)) return 'You cannot buy a development card now';
    if (!this.devDeck.length) return 'The development deck is empty';
    if (!has(p.hand, COSTS.dev)) return 'Not enough resources';
    this.pay(p, COSTS.dev);
    const type = this.devDeck.pop();
    p.dev.push({ type, turn: this.turnNumber });
    this.addLog(`${p.name} bought a development card.`);
    this.addLog(`You drew: ${DEV_NAMES[type]}.`, [p.id]);
    if (this.phase === 'main') this.checkWin();
    return null;
  }

  doPlayDev(p, d) {
    if (this.cur().id !== p.id || !['roll', 'main'].includes(this.phase)) return 'You can only play development cards on your turn';
    if (this.devPlayed) return 'You already played a development card this turn';
    const card = p.dev.find(c => c.type === d.card && c.turn < this.turnNumber);
    if (d.card === 'vp' || !DEV_NAMES[d.card]) return 'That card cannot be played';
    if (!card) return p.dev.some(c => c.type === d.card) ? 'You cannot play a card on the turn you bought it' : 'You do not have that card';

    if (d.card === 'yearOfPlenty') {
      const picks = Array.isArray(d.res) ? d.res.slice(0, 2) : [];
      if (picks.length !== 2 || !picks.every(isRes)) return 'Choose two resources';
      const need = emptyHand(); picks.forEach(r => need[r]++);
      if (!has(this.bank, need)) return 'The bank does not have those resources';
      for (const r of picks) { this.bank[r]--; p.hand[r]++; }
      this.addLog(`${p.name} played Year of Plenty and took ${handText(need)}.`);
    } else if (d.card === 'monopoly') {
      if (!isRes(d.res)) return 'Choose a resource';
      let n = 0;
      for (const q of this.players) if (q !== p) { n += q.hand[d.res]; p.hand[d.res] += q.hand[d.res]; q.hand[d.res] = 0; }
      this.addLog(`${p.name} played Monopoly on ${d.res} and collected ${n}.`);
      this.hooks.fx({ type: 'monopoly', id: p.id, res: d.res, n });
    } else if (d.card === 'roadBuilding') {
      if (p.pieces.road <= 0 || this.legalRoads(p.id).length === 0) return 'You have nowhere to build a road';
      this.roadBuilding = 2;
      this.roadBuildingReturn = this.phase;
      this.phase = 'roadBuilding';
      this.addLog(`${p.name} played Road Building.`);
    } else if (d.card === 'knight') {
      p.knights++;
      this.addLog(`${p.name} played a Knight.`);
      this.updateLargestArmy(p);
      this.robberReturn = this.phase;
      this.phase = 'robber';
    }
    p.dev.splice(p.dev.indexOf(card), 1);
    this.devPlayed = true;
    this.checkWin();
    return null;
  }

  doBankTrade(p, d) {
    if (this.cur().id !== p.id || this.phase !== 'main') return 'You can only trade during your turn after rolling';
    const give = cleanHand(d.give), get = cleanHand(d.get);
    const rates = this.tradeRates(p.id);
    let units = 0;
    for (const r of RESOURCES) {
      if (!give[r]) continue;
      if (give[r] % rates[r]) return `Give ${r} in multiples of ${rates[r]}`;
      if (get[r]) return 'You cannot trade a resource for itself';
      units += give[r] / rates[r];
    }
    if (!units || units !== total(get)) return 'That trade does not match your rates';
    if (!has(p.hand, give)) return 'You do not have those cards';
    if (!has(this.bank, get)) return 'The bank does not have enough of that resource';
    for (const r of RESOURCES) { p.hand[r] += get[r] - give[r]; this.bank[r] += give[r] - get[r]; }
    this.addLog(`${p.name} traded ${handText(give)} with the bank for ${handText(get)}.`);
    this.offers = this.offers.filter(o => this.offerStillValid(o));
    return null;
  }

  // Domestic trade: the active player offers to everyone (or one player); others may
  // also propose an offer to the active player. Gifts are not allowed.
  doOffer(p, d) {
    if (this.phase !== 'main') return 'Trading happens after the roll, on the active player\'s turn';
    const give = cleanHand(d.give), get = cleanHand(d.get);
    if (!total(give) || !total(get)) return 'A trade must have cards on both sides';
    if (RESOURCES.some(r => give[r] && get[r])) return 'You cannot trade a resource for the same resource';
    if (!has(p.hand, give)) return 'You do not have those cards';
    const active = this.cur().id;
    let to = null;
    if (p.id !== active) to = active;
    else if (d.to && d.to !== p.id && this.findPlayer(d.to)) to = d.to;
    // one open offer per player keeps things tidy
    this.offers = this.offers.filter(o => o.from !== p.id);
    const offer = { id: ++this.offerId, from: p.id, to, give, get, responses: {} };
    this.offers.push(offer);
    if (this.offers.length > 12) this.offers.shift();
    return null;
  }

  offerStillValid(o) { return has(this.findPlayer(o.from).hand, o.give); }

  doRespond(p, d) {
    const o = this.offers.find(x => x.id === d.offerId);
    if (!o) return 'That offer is gone';
    const active = this.cur().id;
    if (o.from === p.id) return 'That is your own offer';
    if (o.to ? o.to !== p.id : o.from !== active) return 'That offer is not for you';
    if (d.accept && !has(p.hand, o.get)) return 'You do not have the cards they want';
    o.responses[p.id] = d.accept ? 'accept' : 'reject';
    // an offer made to the active player is completed as soon as they accept it
    if (d.accept && p.id === active) return this.executeTrade(o, this.findPlayer(o.from), p);
    return null;
  }

  doConfirmTrade(p, d) {
    const o = this.offers.find(x => x.id === d.offerId);
    if (!o || o.from !== p.id) return 'That offer is gone';
    if (o.responses[d.with] !== 'accept') return 'That player has not accepted';
    return this.executeTrade(o, p, this.findPlayer(d.with));
  }

  executeTrade(o, from, to) {
    if (this.phase !== 'main') return 'Trading is closed right now';
    if (!has(from.hand, o.give)) return `${from.name} no longer has the cards`;
    if (!has(to.hand, o.get)) return `${to.name} no longer has the cards`;
    for (const r of RESOURCES) {
      from.hand[r] += o.get[r] - o.give[r];
      to.hand[r] += o.give[r] - o.get[r];
    }
    this.addLog(`🤝 ${from.name} gave ${handText(o.give)} to ${to.name} for ${handText(o.get)}.`);
    this.hooks.fx({ type: 'trade', a: from.id, b: to.id });
    this.offers = this.offers.filter(x => x !== o && this.offerStillValid(x));
    return null;
  }

  doCancelOffer(p, d) {
    this.offers = this.offers.filter(o => !(o.id === d.offerId && o.from === p.id));
    return null;
  }

  doEndTurn(p) {
    if (this.actorId() !== p.id) return 'It is not your turn';
    if (this.phase === 'special') {
      this.special.queue.shift();
      if (!this.special.queue.length) { this.special = null; this.beginTurn((this.current + 1) % this.players.length); }
      return null;
    }
    if (this.phase !== 'main') return this.phase === 'roll' ? 'Roll the dice first' : 'Finish your current action first';
    this.offers = [];
    const n = this.players.length;
    if (this.settings.size === 'extended') {
      // 5–6 player rule: everyone else gets a Special Building Phase, in turn order
      this.special = { queue: Array.from({ length: n - 1 }, (_, k) => (this.current + 1 + k) % n) };
      this.phase = 'special';
      this.addLog('Special Building Phase — others may build or buy cards.');
    } else this.beginTurn((this.current + 1) % n);
    return null;
  }

  // ---------- views ----------
  view(viewerId) {
    const me = this.findPlayer(viewerId);
    const base = {
      code: this.code, phase: this.phase, settings: this.settings, hostId: this.hostId, you: viewerId,
      spectator: !me,
      colors: COLORS,
      players: this.players.map(p => ({
        id: p.id, name: p.name, color: p.color, connected: p.connected,
        ...(this.phase === 'lobby' ? {} : {
          cards: total(p.hand), devCount: p.dev.length, knights: p.knights, roadLen: p.roadLen,
          vp: this.phase === 'over' ? this.totalVP(p) : this.publicVP(p), pieces: p.pieces,
          hand: this.phase === 'over' ? p.hand : undefined,
          devCards: this.phase === 'over' ? p.dev.map(c => c.type) : undefined,
        }),
      })),
      spectators: [...this.spectators.values()],
    };
    if (this.phase === 'lobby') return base;

    const actor = this.actorId();
    Object.assign(base, {
      board: this.board,
      buildings: this.vertexBuilding,
      roads: this.edgeRoad,
      bank: this.bank,
      devLeft: this.devDeck.length,
      current: this.cur().id,
      actor,
      turnNumber: this.turnNumber,
      dice: this.dice,
      longestRoad: this.longestRoad,
      largestArmy: this.largestArmy,
      setup: this.setup && { step: this.setup.step, round: this.setup.idx < this.players.length ? 1 : 2 },
      discards: this.phase === 'discard' ? this.discards : null,
      stealCandidates: this.phase === 'steal' ? this.stealCandidates : null,
      roadBuilding: this.phase === 'roadBuilding' ? this.roadBuilding : 0,
      devPlayed: this.devPlayed,
      offers: this.offers,
      winner: this.winner || null,
      rollCounts: this.rollCounts,
      log: this.log.filter(l => !l.to || l.to.includes(viewerId)).slice(-60),
    });
    if (me) {
      base.hand = me.hand;
      base.dev = me.dev.map(c => ({ type: c.type, playable: c.type !== 'vp' && c.turn < this.turnNumber }));
      base.rates = this.tradeRates(me.id);
      base.myVP = this.totalVP(me);
      base.costs = COSTS;
      if (actor === me.id) {
        if (this.phase === 'setup') {
          base.legal = this.setup.step === 'settlement' ? { settlement: this.legalSettlements(me.id, false) } : { road: this.legalRoads(me.id) };
        } else if (['main', 'special', 'roadBuilding'].includes(this.phase)) {
          base.legal = { road: this.legalRoads(me.id), settlement: this.legalSettlements(me.id), city: this.legalCities(me.id) };
        }
      }
      if (this.phase === 'robber' && this.cur().id === me.id) {
        base.legal = { robber: this.board.hexes.filter(h => h.id !== this.board.robber).map(h => h.id) };
      }
    }
    return base;
  }

  destroy() {}
}

module.exports = { Game, COSTS, total, emptyHand };
