// Catan Online client: renders server state, sends actions. All rules live on the server.
(function () {
  const $ = id => document.getElementById(id);
  const RES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
  const ri = r => ART.icon(r);
  const RES_NAME = { wood: 'Lumber', brick: 'Brick', sheep: 'Wool', wheat: 'Grain', ore: 'Ore' };
  const DEV = {
    knight: { name: 'Knight', icon: '⚔️', text: 'Move the robber and steal a card.' },
    roadBuilding: { name: 'Road Building', icon: '🛣️', text: 'Build 2 roads for free.' },
    yearOfPlenty: { name: 'Year of Plenty', icon: '🎁', text: 'Take any 2 resources from the bank.' },
    monopoly: { name: 'Monopoly', icon: '💰', text: 'Take every card of one resource from all players.' },
    vp: { name: 'Victory Point', icon: '⭐', text: 'Worth 1 point. Kept hidden until the end.' },
  };
  const S = 56; // pixels per board unit

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  let playerId = store.get('catan.pid');
  if (!playerId) { playerId = Math.random().toString(36).slice(2) + Date.now().toString(36); store.set('catan.pid', playerId); }
  $('name').value = store.get('catan.name') || '';

  const net = new Net('/ws');
  window.__net = net;
  let state = null;
  let mode = null;          // 'road' | 'settlement' | 'city' while choosing a spot
  let tradeOpen = false;
  let trade = { give: {}, get: {} };
  let modalKey = null;      // which modal is open, so re-renders don't reset choices
  let modalSel = {};
  let createSize = 'base';
  let tab = 'log';
  let unreadChat = 0;
  let lastLogId = 0;
  let lastActor = null;

  // ---------- small utils ----------
  function toast(msg, ok) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (ok ? ' ok' : '');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.add('hidden'), 2600);
  }
  function emit(e, d, cb) {
    net.emit(e, d, res => { if (res && res.error) toast(res.error); if (cb) cb(res || {}); });
  }
  function act(type, data, cb) { emit('action', { type, data }, cb); }
  function show(screen) {
    for (const s of ['home', 'lobby', 'game']) $(s).classList.toggle('hidden', s !== screen);
  }
  const player = id => state.players.find(p => p.id === id);
  const nameOf = id => { const p = player(id); return p ? esc(p.name) : '?'; };
  const dot = id => { const p = player(id); return `<span class="dot" style="background:${p ? p.color : '#999'}"></span>`; };
  // light player colours (white) need dark text on top
  const light = hex => { const n = parseInt(hex.slice(1), 16); return ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 > 180; };
  const handTotal = h => RES.reduce((s, r) => s + (h[r] || 0), 0);
  const canAfford = cost => state.hand && RES.every(r => (state.hand[r] || 0) >= (cost[r] || 0));
  const cardsHtml = h => RES.filter(r => h[r]).map(r => `<span class="mini">${ri(r)}${h[r] > 1 ? '×' + h[r] : ''}</span>`).join(' ');

  // ---------- sound (synthesised, no files) ----------
  let actx = null;
  function beep(freq, dur, type = 'sine', vol = 0.08, delay = 0) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(vol, actx.currentTime + delay);
      g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + delay + dur);
      o.connect(g).connect(actx.destination);
      o.start(actx.currentTime + delay); o.stop(actx.currentTime + delay + dur);
    } catch {}
  }
  const sounds = {
    dice() { for (let i = 0; i < 6; i++) beep(180 + Math.random() * 220, 0.05, 'square', 0.03, i * 0.05); },
    turn() { beep(660, 0.15, 'sine', 0.08); beep(880, 0.2, 'sine', 0.08, 0.15); },
    build() { beep(320, 0.08, 'triangle', 0.08); beep(480, 0.1, 'triangle', 0.06, 0.07); },
    win() { [523, 659, 784, 1046].forEach((f, i) => beep(f, 0.3, 'triangle', 0.08, i * 0.15)); },
  };

  // ---------- home ----------
  $('size-pick').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    createSize = b.dataset.size;
    for (const x of $('size-pick').children) x.classList.toggle('on', x === b);
  };
  function myName() {
    const n = $('name').value.trim();
    if (!n) { toast('Enter your name first'); $('name').focus(); return null; }
    store.set('catan.name', n);
    return n;
  }
  $('create').onclick = () => {
    const name = myName(); if (!name) return;
    emit('create', { name, playerId, settings: { size: createSize } }, res => { if (res.ok) enterRoom(res.code); });
  };
  $('join').onclick = () => {
    const name = myName(); if (!name) return;
    const code = $('code').value.trim().toUpperCase();
    if (!code) return toast('Enter a game code');
    emit('join', { name, playerId, code }, res => { if (res.ok) enterRoom(res.code); });
  };
  // a little island on the home screen, drawn with the same tiles as the board
  (function homeArt() {
    const q = Math.sqrt(3), L = 40;
    const tiles = [[0, 0, 'desert'], [q, 0, 'wheat', 6], [-q, 0, 'sheep', 9], [q / 2, -1.5, 'wood', 8], [-q / 2, -1.5, 'ore', 5], [q / 2, 1.5, 'brick', 10], [-q / 2, 1.5, 'sheep', 4]];
    let out = `<g filter="url(#f-shadow)"><circle r="${L * 2.75}" fill="#d9c38a"/></g><circle r="${L * 2.6}" fill="#efdfb0"/>`;
    for (const [x, y, t, n] of tiles) {
      const cx = x * L, cy = y * L;
      out += `<use href="#t-${t}" x="${cx - L}" y="${cy - L}" width="${2 * L}" height="${2 * L}"/>`;
      if (n) out += `<circle cx="${cx}" cy="${cy}" r="11" fill="url(#g-token)"/><text x="${cx}" y="${cy + 4}" class="num small${n === 6 || n === 8 ? ' red' : ''}">${n}</text>`;
    }
    out += `<use href="#p-robber" x="-12" y="-22" width="24" height="36"/>`
      + `<use href="#p-settlement" x="${(q / 2) * L - 14}" y="${-0.5 * L - 16}" width="28" height="30" color="#e23b3b"/>`
      + `<use href="#p-city" x="${(-q / 2) * L - 18}" y="${0.5 * L - 21}" width="36" height="34" color="#2f6fde"/>`;
    $('home-art').innerHTML = out;
  })();
  $('code').addEventListener('keydown', e => { if (e.key === 'Enter') $('join').click(); });
  function enterRoom(code) {
    store.set('catan.room', code);
    history.replaceState(null, '', '?room=' + code);
  }

  net.on('connect', () => {
    const url = new URLSearchParams(location.search).get('room');
    const code = (url || store.get('catan.room') || '').toUpperCase();
    if (url) $('code').value = url.toUpperCase();
    const name = store.get('catan.name');
    if (code && name) {
      net.emit('join', { name, playerId, code }, res => {
        if (res && res.ok) enterRoom(res.code);
        else { store.del('catan.room'); if (url) toast(res.error || 'Could not join'); show('home'); }
      });
    }
  });
  net.on('disconnect', () => toast('Connection lost — reconnecting…'));

  // ---------- lobby ----------
  $('invite').onclick = () => {
    const link = location.origin + '/?room=' + state.code;
    (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject()).then(() => toast('Invite link copied', true), () => prompt('Copy this link:', link));
  };
  $('lobby-size').onclick = e => { const b = e.target.closest('button'); if (b) emit('configure', { size: b.dataset.size }); };
  $('lobby-vp').onclick = e => { const b = e.target.closest('button'); if (b) emit('configure', { vpTarget: +b.dataset.vp }); };
  $('lobby-time').onclick = e => { const b = e.target.closest('button'); if (b) emit('configure', { turnTime: +b.dataset.time }); };
  $('lobby-discard').onclick = e => { const b = e.target.closest('button'); if (b) emit('configure', { discardLimit: +b.dataset.limit }); };
  $('lobby-bank').onclick = e => { const b = e.target.closest('button'); if (b) emit('configure', { hideBank: b.dataset.hide === '1' }); };
  $('color-pick').onclick = e => { const b = e.target.closest('button'); if (b) emit('color', b.dataset.color); };
  $('start').onclick = () => emit('start');
  $('leave-lobby').onclick = () => { emit('leave'); store.del('catan.room'); history.replaceState(null, '', '/'); state = null; show('home'); };

  function renderLobby() {
    const s = state, host = s.hostId === s.you;
    $('lobby-code').textContent = s.code;
    $('lobby-players').innerHTML = s.players.map(p => `<li>${dot(p.id)} ${esc(p.name)}${p.id === s.hostId ? ' <em>host</em>' : ''}${p.id === s.you ? ' <em>you</em>' : ''}${p.connected ? '' : ' <em>offline</em>'}</li>`).join('');
    const taken = new Set(s.players.filter(p => p.id !== s.you).map(p => p.color));
    const mine = player(s.you);
    $('color-pick').innerHTML = s.colors.map(c => `<button data-color="${c}" style="background:${c}" class="${mine && mine.color === c ? 'on' : ''}" ${taken.has(c) ? 'disabled' : ''}></button>`).join('');
    $('host-settings').classList.toggle('locked', !host);
    for (const b of $('lobby-size').children) { b.classList.toggle('on', b.dataset.size === s.settings.size); b.disabled = !host; }
    for (const b of $('lobby-vp').children) { b.classList.toggle('on', +b.dataset.vp === s.settings.vpTarget); b.disabled = !host; }
    for (const b of $('lobby-time').children) { b.classList.toggle('on', +b.dataset.time === s.settings.turnTime); b.disabled = !host; }
    for (const b of $('lobby-discard').children) { b.classList.toggle('on', +b.dataset.limit === s.settings.discardLimit); b.disabled = !host; }
    for (const b of $('lobby-bank').children) { b.classList.toggle('on', (b.dataset.hide === '1') === s.settings.hideBank); b.disabled = !host; }
    const [min, max] = s.settings.size === 'base' ? [2, 4] : [3, 6];
    const n = s.players.length;
    $('lobby-note').textContent = n < min ? `Waiting for players… (${n}/${min} needed)` : n > max ? `Too many players for this board (max ${max}).` : host ? 'Ready when you are! Share the invite link.' : 'Waiting for the host to start…';
    $('start').classList.toggle('hidden', !host);
    $('start').disabled = n < min || n > max;
  }

  // ---------- board ----------
  function hexPoints(h, shrink) {
    return h.vertices.map(vid => {
      const v = state.board.vertices[vid];
      return `${(h.x + (v.x - h.x) * shrink) * S},${(h.y + (v.y - h.y) * shrink) * S}`;
    }).join(' ');
  }
  const pips = n => (n ? 6 - Math.abs(7 - n) : 0);

  // what was on the board last render, so only new pieces animate in
  let prevPieces = null, prevRobber = null, prevHand = null;

  function pieceUse(x, y, color, city, cls) {
    return city
      ? `<use href="#p-city" class="piece ${cls}" x="${x - 18}" y="${y - 21}" width="36" height="34" color="${color}"/>`
      : `<use href="#p-settlement" class="piece ${cls}" x="${x - 14}" y="${y - 16}" width="28" height="30" color="${color}"/>`;
  }

  function currentMode() {
    const s = state;
    if (s.phase === 'over' || s.spectator) return null;
    if (s.phase === 'robber' && s.legal && s.legal.robber) return 'robber';
    if (s.actor !== s.you) return null;
    if (s.phase === 'setup') return s.setup.step;
    if (s.phase === 'roadBuilding') return 'road';
    return mode;
  }

  function renderBoard() {
    const s = state, b = s.board, svg = $('board');
    const xs = b.vertices.map(v => v.x).concat(b.ports.map(p => p.x)), ys = b.vertices.map(v => v.y).concat(b.ports.map(p => p.y));
    const pad = 0.75;
    const minX = (Math.min(...xs) - pad) * S, minY = (Math.min(...ys) - pad) * S;
    const w = (Math.max(...xs) - Math.min(...xs) + 2 * pad) * S, h = (Math.max(...ys) - Math.min(...ys) + 2 * pad) * S;
    const viewBox = `${minX} ${minY} ${w} ${h}`;
    svg.setAttribute('viewBox', viewBox);
    $('fx-layer').setAttribute('viewBox', viewBox);
    const m = currentMode();
    const legal = s.legal || {};
    const animate = prevPieces && prevPieces.code === s.code;
    let out = '';

    // sea, then the sand island with a soft shadow
    out += `<rect x="${minX - w}" y="${minY - h}" width="${w * 3}" height="${h * 3}" fill="url(#waves)"/>`;
    out += `<g filter="url(#f-shadow)">${b.hexes.map(hx => `<polygon points="${hexPoints(hx, 1.16)}" fill="#d9c38a" stroke="#d9c38a" stroke-width="14" stroke-linejoin="round"/>`).join('')}</g>`;
    out += b.hexes.map(hx => `<polygon points="${hexPoints(hx, 1.08)}" fill="#efdfb0" stroke="#efdfb0" stroke-width="8" stroke-linejoin="round"/>`).join('');
    // harbors: wooden piers out to a badge
    for (const p of b.ports) {
      const px = p.x * S, py = p.y * S;
      for (const vid of p.vertices) {
        const v = b.vertices[vid];
        const x1 = v.x * S, y1 = v.y * S;
        out += `<line x1="${px}" y1="${py}" x2="${x1}" y2="${y1}" stroke="#4a2f14" stroke-width="8" stroke-linecap="round"/>`
          + `<line x1="${px}" y1="${py}" x2="${x1}" y2="${y1}" stroke="#a7744a" stroke-width="5" stroke-linecap="round" stroke-dasharray="5 2"/>`;
      }
      const label = p.type === 'any' ? '3:1' : '2:1';
      out += `<g class="port" filter="url(#f-soft)"><circle cx="${px}" cy="${py}" r="16" fill="url(#g-token)" stroke="#7a5532" stroke-width="2.5"/>`
        + `<use href="#i-${p.type === 'any' ? 'anchor' : p.type}" x="${px - 7.5}" y="${py - 13}" width="15" height="15"/>`
        + `<text x="${px}" y="${py + 11}" class="port-text">${label}</text><title>${p.type === 'any' ? 'Any 3 identical for 1' : '2 ' + p.type + ' for 1'}</title></g>`;
    }
    // terrain tiles and number tokens
    const R = S * 0.985;
    const rolled = s.dice ? s.dice[0] + s.dice[1] : null;
    for (const hx of b.hexes) {
      const cx = hx.x * S, cy = hx.y * S;
      const clickable = m === 'robber' && legal.robber && legal.robber.includes(hx.id);
      out += `<g class="hex${clickable ? ' pick' : ''}" data-hex="${hx.id}">`
        + `<use href="#t-${hx.resource}" x="${cx - R}" y="${cy - R}" width="${2 * R}" height="${2 * R}"/>`;
      if (hx.number) {
        const red = hx.number === 6 || hx.number === 8;
        const hot = rolled === hx.number && hx.id !== b.robber;
        out += `<g filter="url(#f-soft)" class="token${hot ? ' hot' : ''}"><circle cx="${cx}" cy="${cy}" r="15.5" fill="url(#g-token)" stroke="#8a7650" stroke-width="1.2"/></g>`
          + `<text x="${cx}" y="${cy + 4}" class="num${red ? ' red' : ''}">${hx.number}</text>`;
        const n = pips(hx.number);
        for (let i = 0; i < n; i++) out += `<circle cx="${cx + (i - (n - 1) / 2) * 3.6}" cy="${cy + 9.5}" r="1.3" fill="${red ? '#c62828' : '#3a3a3a'}"/>`;
        if (hot) out += `<polygon points="${hexPoints(hx, 0.97)}" class="hit"/>`;
      }
      if (clickable) out += `<polygon points="${hexPoints(hx, 0.9)}" class="pick-ring"/>`;
      out += `</g>`;
    }
    // roads (new ones draw themselves in)
    const roadLen = Math.round(0.76 * S);
    s.roads.forEach((owner, eid) => {
      if (!owner) return;
      const e = b.edges[eid], a = b.vertices[e.a], c = b.vertices[e.b];
      const x1 = (a.x + (c.x - a.x) * 0.12) * S, y1 = (a.y + (c.y - a.y) * 0.12) * S, x2 = (a.x + (c.x - a.x) * 0.88) * S, y2 = (a.y + (c.y - a.y) * 0.88) * S;
      const fresh = animate && prevPieces.roads[eid] !== owner;
      const style = fresh ? ` class="road-new" style="--len:${roadLen}"` : '';
      out += `<g${style}><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#141414" stroke-width="10.5" stroke-linecap="round"/>`
        + `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${player(owner).color}" stroke-width="6.5" stroke-linecap="round"/>`
        + `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#fff" stroke-opacity=".3" stroke-width="1.6" stroke-linecap="round" transform="translate(-.8 -1.2)"/></g>`;
    });
    // legal road spots
    if (m === 'road' && legal.road) {
      for (const eid of legal.road) {
        const e = b.edges[eid], a = b.vertices[e.a], c = b.vertices[e.b];
        out += `<line class="spot-road" data-edge="${eid}" x1="${a.x * S}" y1="${a.y * S}" x2="${c.x * S}" y2="${c.y * S}"/>`;
      }
    }
    // buildings (new ones drop in)
    s.buildings.forEach((bd, vid) => {
      if (!bd) return;
      const v = b.vertices[vid];
      const before = animate && prevPieces.buildings[vid];
      const fresh = animate && (!before || before.type !== bd.type);
      out += pieceUse(v.x * S, v.y * S, player(bd.owner).color, bd.type === 'city', fresh ? 'pop' : '');
    });
    // robber, sliding from where it was
    const rh = b.hexes[b.robber];
    const rx = rh.x * S + 21, ry = rh.y * S - 4;
    const from = animate && prevRobber && prevRobber !== `${rx},${ry}` ? prevRobber : `${rx},${ry}`;
    out += `<g class="robber" data-to="${rx},${ry}" style="transform:translate(${from.replace(',', 'px,')}px)"><use href="#p-robber" x="-12" y="-20" width="24" height="36"/></g>`;
    // legal vertex spots
    const vSpots = m === 'settlement' ? legal.settlement : m === 'city' ? legal.city : null;
    if (vSpots) {
      for (const vid of vSpots) {
        const v = b.vertices[vid];
        out += `<circle class="spot-vertex" data-vertex="${vid}" cx="${v.x * S}" cy="${v.y * S}" r="11"/>`;
      }
    }
    svg.innerHTML = out;
    const robber = svg.querySelector('.robber');
    if (from !== `${rx},${ry}`) {
      // flush the start position so the change below transitions (no rAF: it stalls in background tabs)
      robber.getBoundingClientRect();
      robber.style.transform = `translate(${rx}px,${ry}px)`;
    }
    prevRobber = `${rx},${ry}`;
    prevPieces = { code: s.code, roads: s.roads.slice(), buildings: s.buildings.map(x => x && { ...x }) };
  }

  // resources fly from the producing hexes to each building after a roll
  function flyProduction(sum) {
    const s = state, b = s.board, layer = $('fx-layer');
    if (!b || sum === 7) return;
    let html = '';
    for (const hx of b.hexes) {
      if (hx.number !== sum || hx.id === b.robber) continue;
      for (const vid of hx.vertices) {
        const bd = s.buildings[vid];
        if (!bd) continue;
        const v = b.vertices[vid];
        const n = bd.type === 'city' ? 2 : 1;
        for (let k = 0; k < n; k++) {
          html += `<use href="#i-${hx.resource}" class="fly" x="${hx.x * S - 11}" y="${hx.y * S - 11}" width="22" height="22"
            style="--dx:${(v.x - hx.x) * S}px;--dy:${(v.y - hx.y) * S - 14}px;animation-delay:${k * 0.18}s"/>`;
        }
      }
    }
    layer.innerHTML = html;
    clearTimeout(flyProduction.t);
    flyProduction.t = setTimeout(() => (layer.innerHTML = ''), 2000);
  }

  function rollFlash(sum) {
    const el = $('roll-flash');
    el.textContent = sum;
    el.className = 'roll-flash' + (sum === 7 ? ' seven' : '');
    void el.offsetWidth;
    el.classList.add('go');
  }

  function confetti() {
    const box = document.createElement('div');
    box.className = 'confetti';
    const colors = state.players.map(p => p.color).concat(['#f2b544', '#ffffff']);
    for (let i = 0; i < 140; i++) {
      const c = document.createElement('i');
      c.style.cssText = `left:${Math.random() * 100}%;background:${colors[i % colors.length]};animation-delay:${Math.random() * 1.2}s;animation-duration:${2.4 + Math.random() * 2}s;transform:rotate(${Math.random() * 360}deg)`;
      box.appendChild(c);
    }
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 5500);
  }

  $('board').addEventListener('click', e => {
    const m = currentMode();
    const t = e.target;
    if (t.dataset.edge != null) act('build', { kind: 'road', at: +t.dataset.edge }, r => { if (r.ok && state.phase !== 'roadBuilding') mode = null; });
    else if (t.dataset.vertex != null) act('build', { kind: m, at: +t.dataset.vertex }, r => { if (r.ok) mode = null; });
    else if (m === 'robber') {
      const g = t.closest('.hex.pick');
      if (g) act('moveRobber', { hex: +g.dataset.hex });
    }
  });

  // ---------- side panels ----------
  function bannerText() {
    const s = state, mine = s.actor === s.you, who = nameOf(s.actor);
    switch (s.phase) {
      case 'setup': return mine ? `Place your ${s.setup.round === 1 ? 'first' : 'second'} ${s.setup.step} — tap a glowing spot` : `${who} is placing a ${s.setup.step}…`;
      case 'roll': return mine ? 'Your turn — roll the dice (or play a card first)' : `${who}'s turn — waiting for the roll`;
      case 'main': return mine ? (mode ? `Tap a glowing spot to build a ${mode}` : 'Build, trade, or end your turn') : `${who} is taking their turn`;
      case 'discard': {
        const need = s.discards[s.you];
        const waiting = Object.keys(s.discards).map(nameOf).join(', ');
        return need ? `Discard ${need} cards` : `Waiting for ${waiting} to discard…`;
      }
      case 'robber': return s.current === s.you ? 'Move the robber — tap a hex' : `${nameOf(s.current)} is moving the robber…`;
      case 'steal': return s.current === s.you ? 'Choose who to steal from' : `${nameOf(s.current)} is choosing who to rob…`;
      case 'roadBuilding': return mine ? `Place ${s.roadBuilding} free road${s.roadBuilding > 1 ? 's' : ''}` : `${who} is building roads…`;
      case 'special': return mine ? 'Special building phase — build or buy, then pass' : `Special building phase: ${who} may build…`;
      case 'over': return `🏆 ${nameOf(s.winner)} wins!`;
    }
    return '';
  }

  function renderPlayers() {
    const s = state;
    $('players').innerHTML = s.players.map(p => {
      const turn = p.id === s.current && s.phase !== 'setup' || p.id === s.actor;
      const badges = (s.longestRoad === p.id ? '<span class="award" title="Longest Road">🛣️ +2</span>' : '')
        + (s.largestArmy === p.id ? '<span class="award" title="Largest Army">⚔️ +2</span>' : '');
      const vp = p.id === s.you && s.myVP != null ? s.myVP : p.vp;
      const pct = Math.min(100, (vp / s.settings.vpTarget) * 100);
      return `<div class="pl${turn ? ' turn' : ''}${p.connected ? '' : ' off'}${p.id === s.winner ? ' won' : ''}" style="--c:${p.color}">
        <div class="avatar${light(p.color) ? ' light' : ''}">${esc(p.name.slice(0, 1).toUpperCase())}</div>
        <div class="pl-body">
          <div class="pl-top"><b>${esc(p.name)}</b>${p.id === s.you ? ' <em>you</em>' : ''}${p.connected ? '' : ' <em class="offline">offline</em>'}
            <span class="vp" title="Victory points${p.id === s.you ? ' (including your hidden VP cards)' : ''}">${vp}<small>/${s.settings.vpTarget}</small></span></div>
          <div class="vp-bar"><i style="width:${pct}%"></i></div>
          <div class="pl-stats"><span class="cardback" title="Resource cards">${p.cards}</span><span class="cardback dev" title="Development cards">${p.devCount}</span><span title="Knights played">⚔️ ${p.knights}</span><span title="Longest road">🛣️ ${p.roadLen}</span>${badges}</div>
          ${s.phase === 'over' && p.devCards ? `<div class="pl-stats">${p.devCards.map(c => DEV[c].icon).join(' ')}</div>` : ''}
        </div>
      </div>`;
    }).join('');
  }

  function renderHand() {
    const s = state;
    if (s.spectator) { $('me').innerHTML = '<p class="sub">You are watching this game.</p>'; return; }
    const rates = s.rates;
    const gained = r => prevHand && prevHand.code === s.code && s.hand[r] > prevHand.hand[r];
    $('hand').innerHTML = RES.map(r => `<div class="card res-${r}${s.hand[r] ? '' : ' empty'}${gained(r) ? ' gain' : ''}" title="${RES_NAME[r]} — bank rate ${rates[r]}:1">
      <span class="ic">${ri(r)}</span><span class="n">${s.hand[r]}</span><span class="rate${rates[r] < 4 ? ' port' : ''}">${rates[r]}:1</span><span class="nm">${RES_NAME[r]}</span></div>`).join('');
    prevHand = { code: s.code, hand: { ...s.hand } };
    const counts = {};
    for (const c of s.dev) {
      counts[c.type] = counts[c.type] || { n: 0, playable: false };
      counts[c.type].n++;
      if (c.playable) counts[c.type].playable = true;
    }
    const myTurn = s.current === s.you && (s.phase === 'roll' || s.phase === 'main');
    $('devcards').innerHTML = Object.entries(counts).map(([t, c]) => {
      const can = myTurn && c.playable && !s.devPlayed && t !== 'vp';
      return `<button class="dev${can ? ' can' : ''}" data-dev="${t}" ${can ? '' : 'disabled'} title="${DEV[t].text}${t !== 'vp' && !c.playable ? ' (bought this turn)' : ''}">${DEV[t].icon} ${DEV[t].name}${c.n > 1 ? ' ×' + c.n : ''}</button>`;
    }).join('');

    const mine = s.actor === s.you;
    const canBuild = mine && (s.phase === 'main' || s.phase === 'special');
    const L = s.legal || {};
    const costOf = c => `<span class="cost">${RES.flatMap(r => Array(c[r] || 0).fill(ri(r))).join('')}</span>`;
    const btn = (id, label, enabled, cls = '', cost = null) => `<button id="${id}" class="${cls}${cost ? ' build' : ''}${mode && id === 'b-' + mode ? ' on' : ''}" ${enabled ? '' : 'disabled'}><span>${label}</span>${cost ? costOf(cost) : ''}</button>`;
    let html = '';
    if (s.phase === 'roll' && mine) html += btn('b-roll', '🎲 Roll dice', true, 'primary big');
    if (s.phase !== 'roll' && s.phase !== 'setup' || !mine) {
      html += btn('b-road', '🛣️ Road', canBuild && canAfford(s.costs.road) && L.road && L.road.length && player(s.you).pieces.road > 0, '', s.costs.road);
      html += btn('b-settlement', '🏠 Settlement', canBuild && canAfford(s.costs.settlement) && L.settlement && L.settlement.length && player(s.you).pieces.settlement > 0, '', s.costs.settlement);
      html += btn('b-city', '🏰 City', canBuild && canAfford(s.costs.city) && L.city && L.city.length && player(s.you).pieces.city > 0, '', s.costs.city);
      html += btn('b-dev', '📜 Dev card', canBuild && canAfford(s.costs.dev) && s.devLeft > 0, '', s.costs.dev);
      if (s.phase === 'main') html += btn('b-trade', tradeOpen ? '✖ Close trade' : '🤝 Trade', !s.spectator, tradeOpen ? 'on' : '');
      if (canBuild) html += btn('b-end', s.phase === 'special' ? '⏭ Pass' : '⏭ End turn', true, 'primary');
    }
    $('actions').innerHTML = html;
  }

  $('actions').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    const id = b.id;
    if (id === 'b-roll') act('roll');
    else if (id === 'b-end') { mode = null; tradeOpen = false; act('endTurn'); }
    else if (id === 'b-dev') act('buyDev');
    else if (id === 'b-trade') { tradeOpen = !tradeOpen; render(); }
    else { const k = id.slice(2); mode = mode === k ? null : k; render(); }
  });
  $('devcards').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    const t = b.dataset.dev;
    if (t === 'yearOfPlenty') openModal('yop');
    else if (t === 'monopoly') openModal('monopoly');
    else if (confirm(`Play ${DEV[t].name}? ${DEV[t].text}`)) act('playDev', { card: t });
  });

  // trade composer
  function renderTrade() {
    const s = state, panel = $('trade');
    const show = tradeOpen && s.phase === 'main' && !s.spectator;
    panel.classList.toggle('hidden', !show);
    if (!show) return;
    const active = s.current === s.you;
    const row = side => RES.map(r => `<div class="step">${ri(r)}<button data-side="${side}" data-r="${r}" data-d="-1">−</button><b>${trade[side][r] || 0}</b><button data-side="${side}" data-r="${r}" data-d="1">+</button></div>`).join('');
    const others = s.players.filter(p => p.id !== s.you);
    panel.innerHTML = `<h4>Trade ${active ? '' : 'with ' + nameOf(s.current)}</h4>
      <div class="trade-row"><span class="lbl">You give</span>${row('give')}</div>
      <div class="trade-row"><span class="lbl">You get</span>${row('get')}</div>
      <div class="trade-btns">
        ${active ? `<select id="trade-to"><option value="">Offer to everyone</option>${others.map(p => `<option value="${p.id}">Offer to ${esc(p.name)}</option>`).join('')}</select>` : ''}
        <button id="t-offer" class="primary">${active ? 'Send offer' : 'Propose to ' + nameOf(s.current)}</button>
        ${active ? '<button id="t-bank">Trade with bank</button>' : ''}
        <button id="t-clear" class="ghost">Clear</button>
      </div>
      ${active ? `<p class="sub">Bank rates: ${RES.map(r => `<span class="rate-chip">${ri(r)} ${s.rates[r]}:1</span>`).join('')}</p>` : ''}`;
  }
  $('trade').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.side) {
      const side = b.dataset.side, r = b.dataset.r;
      let v = (trade[side][r] || 0) + +b.dataset.d;
      if (side === 'give') v = Math.min(v, state.hand[r]);
      trade[side][r] = Math.max(0, Math.min(19, v));
      renderTrade();
    } else if (b.id === 't-clear') { trade = { give: {}, get: {} }; renderTrade(); }
    else if (b.id === 't-offer') {
      const to = $('trade-to') ? $('trade-to').value : '';
      act('offer', { give: trade.give, get: trade.get, to: to || null }, r => { if (r.ok) toast('Offer sent', true); });
    } else if (b.id === 't-bank') {
      act('bankTrade', { give: trade.give, get: trade.get }, r => { if (r.ok) { trade = { give: {}, get: {} }; render(); } });
    }
  });

  function renderOffers() {
    const s = state;
    if (s.phase !== 'main' || !s.offers.length) { $('offers').innerHTML = ''; return; }
    $('offers').innerHTML = s.offers.map(o => {
      const fromMe = o.from === s.you;
      const forMe = !fromMe && (o.to ? o.to === s.you : o.from === s.current);
      const target = o.to ? nameOf(o.to) : 'everyone';
      let btns = '';
      if (fromMe) {
        const accepted = Object.entries(o.responses).filter(([, v]) => v === 'accept').map(([id]) => id);
        const rejected = Object.entries(o.responses).filter(([, v]) => v === 'reject').map(([id]) => nameOf(id));
        btns = accepted.map(id => `<button class="primary" data-confirm="${o.id}" data-with="${id}">Trade with ${nameOf(id)}</button>`).join('')
          + `<button class="ghost" data-cancel="${o.id}">Cancel</button>`
          + (rejected.length ? `<div class="sub">Declined: ${rejected.join(', ')}</div>` : '')
          + (!accepted.length ? '<div class="sub">Waiting for responses…</div>' : '');
      } else if (forMe) {
        const r = o.responses[s.you];
        btns = `<button class="primary" data-accept="${o.id}">Accept</button><button class="ghost" data-reject="${o.id}">Decline</button>`
          + (r ? `<div class="sub">You ${r === 'accept' ? 'accepted — waiting for ' + nameOf(o.from) : 'declined'}</div>` : '');
      } else {
        const resp = Object.entries(o.responses).map(([id, v]) => `${nameOf(id)} ${v === 'accept' ? '✔' : '✖'}`).join(', ');
        btns = resp ? `<div class="sub">${resp}</div>` : '';
      }
      return `<div class="offer${forMe ? ' for-me' : ''}">
        <div>${dot(o.from)} <b>${fromMe ? 'You' : nameOf(o.from)}</b> → ${fromMe ? target : (o.to === s.you ? 'you' : target)}</div>
        <div class="offer-cards"><span>gives</span> ${cardsHtml(o.give)} <span>for</span> ${cardsHtml(o.get)}</div>
        <div class="offer-btns">${btns}</div></div>`;
    }).join('');
  }
  $('offers').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const d = b.dataset;
    if (d.accept) act('respond', { offerId: +d.accept, accept: true });
    else if (d.reject) act('respond', { offerId: +d.reject, accept: false });
    else if (d.confirm) act('confirmTrade', { offerId: +d.confirm, with: d.with }, r => { if (r.ok) trade = { give: {}, get: {} }; });
    else if (d.cancel) act('cancelOffer', { offerId: +d.cancel });
  });

  function renderDice() {
    const s = state, el = $('dice');
    if (!s.dice) { el.innerHTML = ''; return; }
    const face = (n, cls) => `<div class="die ${cls}">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => `<i class="${PIPS[n].includes(i) ? 'p' : ''}"></i>`).join('')}</div>`;
    el.innerHTML = face(s.dice[0], 'ivory') + face(s.dice[1], 'red') + `<span class="sum${s.dice[0] + s.dice[1] === 7 ? ' seven' : ''}">${s.dice[0] + s.dice[1]}</span>`;
  }
  const PIPS = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };

  function renderBank() {
    const s = state;
    const bank = s.bank ? RES.map(r => `<span title="${RES_NAME[r]} left in the bank">${ri(r)}${s.bank[r]}</span>`).join('') : '<span title="Bank card counts are hidden in this game">hidden</span>';
    $('bank').innerHTML = `<span title="Bank">🏦</span>` + bank + `<span title="Development cards left">📜${s.devLeft}</span><span title="Points to win">🏆${s.settings.vpTarget}</span>`;
    $('help-limit').textContent = s.settings.discardLimit;
  }

  function renderLog() {
    const s = state, el = $('tab-log');
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.innerHTML = s.log.map(l => `<div class="${l.to ? 'private' : ''}">${esc(l.text)}</div>`).join('');
    if (atBottom || s.log.length && s.log[s.log.length - 1].id !== lastLogId) el.scrollTop = el.scrollHeight;
    if (s.log.length) lastLogId = s.log[s.log.length - 1].id;
  }

  function renderStats() {
    const c = state.rollCounts, max = Math.max(1, ...c.slice(2));
    const rolls = c.reduce((a, b) => a + b, 0);
    let html = '<div class="hist">';
    for (let n = 2; n <= 12; n++) {
      const expected = rolls * (6 - Math.abs(7 - n)) / 36;
      html += `<div class="bar-col" title="${n}: rolled ${c[n]}× (expected ≈ ${expected.toFixed(1)})"><span class="cnt">${c[n]}</span><div class="bar${n === 7 ? ' seven' : ''}" style="height:${(c[n] / max) * 100}%"></div><span>${n}</span></div>`;
    }
    $('tab-stats').innerHTML = html + `</div><p class="sub">${rolls} rolls so far.</p>`;
  }

  // ---------- modals ----------
  function openModal(key) { modalKey = key; modalSel = {}; renderModal(); }
  function closeModal() { modalKey = null; modalSel = {}; $('modal').classList.add('hidden'); }

  function neededModal() {
    const s = state;
    if (s.phase === 'over') return modalKey === 'over-dismissed' ? 'over-dismissed' : 'over';
    if (s.phase === 'discard' && s.discards && s.discards[s.you]) return 'discard';
    if (s.phase === 'steal' && s.current === s.you) return 'steal';
    if (modalKey === 'yop' || modalKey === 'monopoly') return modalKey;
    return null;
  }

  function resPicker(selected, max, limitByHand) {
    return `<div class="picker">${RES.map(r => {
      const n = selected[r] || 0;
      const lim = limitByHand ? state.hand[r] : 9;
      return `<div class="step big">${ri(r)}<span class="rn">${RES_NAME[r]}</span><button data-pr="${r}" data-d="-1" ${n ? '' : 'disabled'}>−</button><b>${n}</b><button data-pr="${r}" data-d="1" ${n < lim && handTotal(selected) < max ? '' : 'disabled'}>+</button>${limitByHand ? `<small>of ${state.hand[r]}</small>` : ''}</div>`;
    }).join('')}</div>`;
  }

  function renderModal() {
    const want = neededModal();
    if (want === 'over-dismissed') { $('modal').classList.add('hidden'); return; }
    if (want !== modalKey) { modalKey = want; modalSel = {}; }
    if (!want) { $('modal').classList.add('hidden'); return; }
    const s = state, card = $('modal-card');
    let html = '';
    if (want === 'discard') {
      const need = s.discards[s.you];
      html = `<h3>The robber strikes! Discard ${need} cards</h3>${resPicker(modalSel, need, true)}
        <button class="primary" id="m-ok" ${handTotal(modalSel) === need ? '' : 'disabled'}>Discard ${handTotal(modalSel)}/${need}</button>`;
    } else if (want === 'yop') {
      html = `<h3>🎁 Year of Plenty — pick 2 resources</h3>${resPicker(modalSel, 2, false)}
        <button class="primary" id="m-ok" ${handTotal(modalSel) === 2 ? '' : 'disabled'}>Take them</button><button class="ghost" id="m-cancel">Cancel</button>`;
    } else if (want === 'monopoly') {
      html = `<h3>💰 Monopoly — which resource?</h3><div class="choices">${RES.map(r => `<button data-mono="${r}">${ri(r)} ${RES_NAME[r]}</button>`).join('')}</div><button class="ghost" id="m-cancel">Cancel</button>`;
    } else if (want === 'steal') {
      html = `<h3>Steal from…</h3><div class="choices">${s.stealCandidates.map(id => `<button data-steal="${id}">${dot(id)} ${nameOf(id)} (${player(id).cards} cards)</button>`).join('')}</div>`;
    } else if (want === 'over') {
      const ranked = s.players.slice().sort((a, b) => b.vp - a.vp);
      html = `<h3>🏆 ${nameOf(s.winner)} wins!</h3><table class="final">${ranked.map(p => `<tr><td>${dot(p.id)} ${esc(p.name)}</td><td><b>${p.vp} VP</b></td><td>${(p.devCards || []).filter(c => c === 'vp').map(() => '⭐').join('')}</td></tr>`).join('')}</table>
        <button class="primary" id="m-close">View board</button><button class="ghost" id="m-home">New game</button>`;
    }
    card.innerHTML = html;
    $('modal').classList.remove('hidden');
  }

  $('modal-card').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    const d = b.dataset;
    if (d.pr) { modalSel[d.pr] = Math.max(0, (modalSel[d.pr] || 0) + +d.d); renderModal(); }
    else if (d.mono) { act('playDev', { card: 'monopoly', res: d.mono }); closeModal(); }
    else if (d.steal) act('steal', { victim: d.steal });
    else if (b.id === 'm-cancel') closeModal();
    else if (b.id === 'm-close') { modalKey = 'over-dismissed'; $('modal').classList.add('hidden'); }
    else if (b.id === 'm-home') { emit('leave'); store.del('catan.room'); location.href = '/'; }
    else if (b.id === 'm-ok') {
      if (modalKey === 'discard') act('discard', { cards: modalSel }, r => { if (r.ok) modalSel = {}; });
      else if (modalKey === 'yop') {
        const picks = RES.flatMap(r => Array(modalSel[r] || 0).fill(r));
        act('playDev', { card: 'yearOfPlenty', res: picks }, r => { if (r.ok) closeModal(); });
      }
    }
  });

  // ---------- tabs & chat ----------
  document.querySelector('.tabs').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    tab = b.dataset.tab;
    for (const x of document.querySelectorAll('.tabs button')) x.classList.toggle('on', x === b);
    for (const t of ['log', 'chat', 'stats', 'help']) $('tab-' + t).classList.toggle('hidden', t !== tab);
    if (tab === 'chat') { unreadChat = 0; updateBadge(); $('chat-list').scrollTop = 1e9; }
  };
  function updateBadge() { $('chat-badge').textContent = unreadChat; $('chat-badge').classList.toggle('hidden', !unreadChat); }
  function addChat(m) {
    const div = document.createElement('div');
    div.innerHTML = `<b style="color:${m.color}">${esc(m.name)}</b> ${esc(m.text)}`;
    $('chat-list').appendChild(div);
    $('chat-list').scrollTop = 1e9;
  }
  net.on('chatHistory', list => { $('chat-list').innerHTML = ''; list.forEach(addChat); });
  net.on('chat', m => { addChat(m); if (tab !== 'chat') { unreadChat++; updateBadge(); } });
  $('chat-form').onsubmit = e => {
    e.preventDefault();
    const t = $('chat-input').value.trim();
    if (t) emit('chat', t);
    $('chat-input').value = '';
  };

  // ---------- effects ----------
  net.on('fx', fx => {
    if (!state) return;
    if (fx.type === 'roll') {
      sounds.dice();
      $('dice').classList.remove('roll'); void $('dice').offsetWidth; $('dice').classList.add('roll');
      const sum = fx.dice[0] + fx.dice[1];
      rollFlash(sum);
      setTimeout(() => flyProduction(sum), 500);
    }
    else if (fx.type === 'build') sounds.build();
    else if (fx.type === 'win') { sounds.win(); confetti(); }
    else if (fx.type === 'steal' && fx.from === state.you) toast(`${nameOf(fx.to)} robbed you!`);
  });

  // ---------- main render ----------
  function render() {
    if (!state) return;
    if (state.phase === 'lobby') { show('lobby'); renderLobby(); return; }
    show('game');
    if (state.phase !== 'main' && state.phase !== 'special') mode = null;
    if (state.phase !== 'main') tradeOpen = false;
    $('banner').innerHTML = bannerText() + '<span id="timer"></span>';
    updateTimer();
    $('banner').className = state.actor === state.you || (state.phase === 'discard' && state.discards[state.you]) ? 'mine' : '';
    renderBoard();
    renderPlayers();
    renderHand();
    renderTrade();
    renderOffers();
    renderDice();
    renderBank();
    renderLog();
    renderStats();
    renderModal();
  }

  // turn countdown: the server sends time left, so client clock skew doesn't matter
  let timerEnd = null, lastTick = null;
  function updateTimer() {
    const el = $('timer');
    if (!el) return;
    if (!timerEnd || !state || state.phase === 'over') { el.textContent = ''; return; }
    const secs = Math.max(0, Math.ceil((timerEnd - Date.now()) / 1000));
    el.textContent = ` ⏱ ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    el.className = secs <= 10 ? 'low' : '';
    const waitingOnMe = state.actor === state.you || (state.phase === 'discard' && state.discards[state.you]) || (['robber', 'steal'].includes(state.phase) && state.current === state.you);
    if (waitingOnMe && secs <= 5 && secs > 0 && secs !== lastTick) { lastTick = secs; beep(1000, 0.05, 'square', 0.04); }
  }
  setInterval(updateTimer, 250);

  net.on('state', s => {
    const prevActor = lastActor;
    timerEnd = s.timeLeft != null ? Date.now() + s.timeLeft : null;
    state = s;
    lastActor = s.actor;
    if (s.phase !== 'lobby' && s.actor === s.you && prevActor !== s.you && s.phase !== 'over') {
      sounds.turn();
      if (document.hidden) document.title = '🔔 Your turn — Catan';
    }
    render();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) document.title = 'Catan Online'; });

  // keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (!state || state.phase === 'lobby' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === 'Escape') { mode = null; render(); }
    const map = { r: 'b-roll', e: 'b-end', t: 'b-trade' };
    const b = map[e.key.toLowerCase()] && $(map[e.key.toLowerCase()]);
    if (b && !b.disabled) b.click();
  });
})();
