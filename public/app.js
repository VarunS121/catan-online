// Catan Online client: renders server state, sends actions. All rules live on the server.
(function () {
  const $ = id => document.getElementById(id);
  const RES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
  const ICON = { wood: '🌲', brick: '🧱', sheep: '🐑', wheat: '🌾', ore: '⛰️', desert: '🏜️', any: '❓' };
  const HEX_COLOR = { wood: '#2f7d3b', brick: '#c45a32', sheep: '#8fc95a', wheat: '#e9bf3c', ore: '#8b95a1', desert: '#dcc79a' };
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
  const handTotal = h => RES.reduce((s, r) => s + (h[r] || 0), 0);
  const canAfford = cost => state.hand && RES.every(r => (state.hand[r] || 0) >= (cost[r] || 0));
  const cardsHtml = h => RES.filter(r => h[r]).map(r => `<span class="mini">${ICON[r]}${h[r] > 1 ? '×' + h[r] : ''}</span>`).join(' ');

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

  function settlementPath(x, y, color, city) {
    if (city) {
      return `<path d="M${x - 14} ${y + 10} V${y - 4} L${x - 7} ${y - 11} L${x} ${y - 4} H${x + 14} V${y + 10} Z" fill="${color}" stroke="#1b1b1b" stroke-width="2.2" stroke-linejoin="round"/>`;
    }
    return `<path d="M${x - 9} ${y + 8} V${y - 2} L${x} ${y - 11} L${x + 9} ${y - 2} V${y + 8} Z" fill="${color}" stroke="#1b1b1b" stroke-width="2.2" stroke-linejoin="round"/>`;
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
    const pad = 0.6;
    const minX = (Math.min(...xs) - pad) * S, minY = (Math.min(...ys) - pad) * S;
    const w = (Math.max(...xs) - Math.min(...xs) + 2 * pad) * S, h = (Math.max(...ys) - Math.min(...ys) + 2 * pad) * S;
    svg.setAttribute('viewBox', `${minX} ${minY} ${w} ${h}`);
    const m = currentMode();
    const legal = s.legal || {};
    let out = '';

    // sand coast under the land
    out += b.hexes.map(hx => `<polygon points="${hexPoints(hx, 1.12)}" fill="#e8d7a8" stroke="#e8d7a8" stroke-width="10" stroke-linejoin="round"/>`).join('');
    // ports
    for (const p of b.ports) {
      const px = p.x * S, py = p.y * S;
      for (const vid of p.vertices) {
        const v = b.vertices[vid];
        out += `<line x1="${px}" y1="${py}" x2="${v.x * S}" y2="${v.y * S}" stroke="#7a5532" stroke-width="5" stroke-linecap="round"/>`;
      }
      const label = p.type === 'any' ? '3:1' : '2:1';
      out += `<g class="port"><circle cx="${px}" cy="${py}" r="17" fill="#f7eed6" stroke="#7a5532" stroke-width="2.5"/>`
        + `<text x="${px}" y="${py - 2}" class="port-icon">${p.type === 'any' ? '⚓' : ICON[p.type]}</text>`
        + `<text x="${px}" y="${py + 11}" class="port-text">${label}</text><title>${p.type === 'any' ? 'Any 3 identical for 1' : '2 ' + p.type + ' for 1'}</title></g>`;
    }
    // hexes
    for (const hx of b.hexes) {
      const cx = hx.x * S, cy = hx.y * S;
      const clickable = m === 'robber' && legal.robber && legal.robber.includes(hx.id);
      out += `<g class="hex${clickable ? ' pick' : ''}" data-hex="${hx.id}">`
        + `<polygon points="${hexPoints(hx, 0.97)}" fill="${HEX_COLOR[hx.resource]}" stroke="#00000033" stroke-width="2"/>`
        + `<text x="${cx}" y="${cy - 22}" class="hex-icon">${ICON[hx.resource]}</text>`;
      if (hx.number) {
        const red = hx.number === 6 || hx.number === 8;
        out += `<circle cx="${cx}" cy="${cy + 6}" r="17" fill="#f7eed6" stroke="#00000055" stroke-width="1.5"/>`
          + `<text x="${cx}" y="${cy + 9}" class="num${red ? ' red' : ''}">${hx.number}</text>`;
        const n = pips(hx.number);
        for (let i = 0; i < n; i++) out += `<circle cx="${cx + (i - (n - 1) / 2) * 4.2}" cy="${cy + 16}" r="1.6" fill="${red ? '#c62828' : '#333'}"/>`;
      }
      if (s.dice && hx.number === s.dice[0] + s.dice[1] && hx.id !== b.robber) out += `<polygon points="${hexPoints(hx, 0.97)}" class="hit"/>`;
      out += `</g>`;
    }
    // robber
    const rh = b.hexes[b.robber];
    out += `<g class="robber" transform="translate(${rh.x * S + 20},${rh.y * S - 2})"><ellipse cx="0" cy="14" rx="9" ry="3.5" fill="#0006"/><path d="M-8 13 Q-9 -2 -5 -6 A6 6 0 1 1 5 -6 Q9 -2 8 13 Z" fill="#2b2b2b" stroke="#000" stroke-width="1.5"/></g>`;
    // roads
    s.roads.forEach((owner, eid) => {
      if (!owner) return;
      const e = b.edges[eid], a = b.vertices[e.a], c = b.vertices[e.b];
      const x1 = a.x + (c.x - a.x) * 0.12, y1 = a.y + (c.y - a.y) * 0.12, x2 = a.x + (c.x - a.x) * 0.88, y2 = a.y + (c.y - a.y) * 0.88;
      out += `<line x1="${x1 * S}" y1="${y1 * S}" x2="${x2 * S}" y2="${y2 * S}" stroke="#1b1b1b" stroke-width="10" stroke-linecap="round"/>`
        + `<line x1="${x1 * S}" y1="${y1 * S}" x2="${x2 * S}" y2="${y2 * S}" stroke="${player(owner).color}" stroke-width="6" stroke-linecap="round"/>`;
    });
    // legal road spots
    if (m === 'road' && legal.road) {
      for (const eid of legal.road) {
        const e = b.edges[eid], a = b.vertices[e.a], c = b.vertices[e.b];
        out += `<line class="spot-road" data-edge="${eid}" x1="${a.x * S}" y1="${a.y * S}" x2="${c.x * S}" y2="${c.y * S}"/>`;
      }
    }
    // buildings
    s.buildings.forEach((bd, vid) => {
      if (!bd) return;
      const v = b.vertices[vid];
      out += settlementPath(v.x * S, v.y * S, player(bd.owner).color, bd.type === 'city');
    });
    // legal vertex spots
    const vSpots = m === 'settlement' ? legal.settlement : m === 'city' ? legal.city : null;
    if (vSpots) {
      for (const vid of vSpots) {
        const v = b.vertices[vid];
        out += `<circle class="spot-vertex" data-vertex="${vid}" cx="${v.x * S}" cy="${v.y * S}" r="11"/>`;
      }
    }
    svg.innerHTML = out;
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
      return `<div class="pl${turn ? ' turn' : ''}${p.connected ? '' : ' off'}" style="--c:${p.color}">
        <div class="pl-top"><span class="dot" style="background:${p.color}"></span><b>${esc(p.name)}</b>${p.id === s.you ? ' <em>you</em>' : ''}${p.connected ? '' : ' <em>offline</em>'}
        <span class="vp" title="Victory points${p.id === s.you ? ' (including your hidden VP cards)' : ''}">${vp} VP</span></div>
        <div class="pl-stats"><span title="Resource cards">🂠 ${p.cards}</span><span title="Development cards">📜 ${p.devCount}</span><span title="Knights played">⚔️ ${p.knights}</span><span title="Longest road">🛣️ ${p.roadLen}</span>${badges}</div>
        ${s.phase === 'over' && p.devCards ? `<div class="pl-stats">${p.devCards.map(c => DEV[c].icon).join(' ')}</div>` : ''}
      </div>`;
    }).join('');
  }

  function renderHand() {
    const s = state;
    if (s.spectator) { $('me').innerHTML = '<p class="sub">You are watching this game.</p>'; return; }
    const rates = s.rates;
    $('hand').innerHTML = RES.map(r => `<div class="card res-${r}" title="${r} — bank rate ${rates[r]}:1"><span class="ic">${ICON[r]}</span><span class="n">${s.hand[r]}</span><span class="rate">${rates[r]}:1</span></div>`).join('');
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
    const btn = (id, label, enabled, cls = '', title = '') => `<button id="${id}" class="${cls}${mode && id === 'b-' + mode ? ' on' : ''}" ${enabled ? '' : 'disabled'} title="${title}">${label}</button>`;
    let html = '';
    if (s.phase === 'roll' && mine) html += btn('b-roll', '🎲 Roll dice', true, 'primary big');
    if (s.phase !== 'roll' && s.phase !== 'setup' || !mine) {
      html += btn('b-road', '🛣️ Road', canBuild && canAfford(s.costs.road) && L.road && L.road.length && player(s.you).pieces.road > 0, '', '🌲🧱');
      html += btn('b-settlement', '🏠 Settlement', canBuild && canAfford(s.costs.settlement) && L.settlement && L.settlement.length && player(s.you).pieces.settlement > 0, '', '🌲🧱🐑🌾');
      html += btn('b-city', '🏰 City', canBuild && canAfford(s.costs.city) && L.city && L.city.length && player(s.you).pieces.city > 0, '', '🌾🌾⛰️⛰️⛰️');
      html += btn('b-dev', '📜 Dev card', canBuild && canAfford(s.costs.dev) && s.devLeft > 0, '', '🐑🌾⛰️');
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
    const row = side => RES.map(r => `<div class="step"><span>${ICON[r]}</span><button data-side="${side}" data-r="${r}" data-d="-1">−</button><b>${trade[side][r] || 0}</b><button data-side="${side}" data-r="${r}" data-d="1">+</button></div>`).join('');
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
      ${active ? `<p class="sub">Bank rates: ${RES.map(r => `${ICON[r]} ${s.rates[r]}:1`).join(' · ')}</p>` : ''}`;
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
    const face = n => `<div class="die">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => `<i class="${PIPS[n].includes(i) ? 'p' : ''}"></i>`).join('')}</div>`;
    el.innerHTML = face(s.dice[0]) + face(s.dice[1]) + `<span class="sum${s.dice[0] + s.dice[1] === 7 ? ' seven' : ''}">${s.dice[0] + s.dice[1]}</span>`;
  }
  const PIPS = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };

  function renderBank() {
    const s = state;
    $('bank').innerHTML = `<span title="Bank">🏦</span>` + RES.map(r => `<span title="${r} left in the bank">${ICON[r]}${s.bank[r]}</span>`).join('') + `<span title="Development cards left">📜${s.devLeft}</span><span title="Points to win">🏆${s.settings.vpTarget}</span>`;
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
      return `<div class="step big"><span>${ICON[r]}</span><button data-pr="${r}" data-d="-1" ${n ? '' : 'disabled'}>−</button><b>${n}</b><button data-pr="${r}" data-d="1" ${n < lim && handTotal(selected) < max ? '' : 'disabled'}>+</button>${limitByHand ? `<small>of ${state.hand[r]}</small>` : ''}</div>`;
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
      html = `<h3>💰 Monopoly — which resource?</h3><div class="choices">${RES.map(r => `<button data-mono="${r}">${ICON[r]} ${r}</button>`).join('')}</div><button class="ghost" id="m-cancel">Cancel</button>`;
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
    if (fx.type === 'roll') { sounds.dice(); $('dice').classList.remove('roll'); void $('dice').offsetWidth; $('dice').classList.add('roll'); }
    else if (fx.type === 'build') sounds.build();
    else if (fx.type === 'win') sounds.win();
    else if (fx.type === 'steal' && fx.from === state.you) toast(`${nameOf(fx.to)} robbed you!`);
  });

  // ---------- main render ----------
  function render() {
    if (!state) return;
    if (state.phase === 'lobby') { show('lobby'); renderLobby(); return; }
    show('game');
    if (state.phase !== 'main' && state.phase !== 'special') mode = null;
    if (state.phase !== 'main') tradeOpen = false;
    $('banner').innerHTML = bannerText();
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

  net.on('state', s => {
    const prevActor = lastActor;
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
