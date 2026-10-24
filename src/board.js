// Board generation: hex layout, vertex/edge graph, terrain, number tokens and harbors.
// Base game (3-4 players) uses 19 hexes; the 5-6 player extension uses 30.
const crypto = require('crypto');

const RESOURCES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];
const SQ3 = Math.sqrt(3);

const CONFIG = {
  base: {
    rows: [3, 4, 5, 4, 3],
    terrain: { wood: 4, sheep: 4, wheat: 4, brick: 3, ore: 3, desert: 1 },
    numbers: [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12],
    ports: ['any', 'any', 'any', 'any', 'wood', 'brick', 'sheep', 'wheat', 'ore'],
  },
  extended: {
    rows: [3, 4, 5, 6, 5, 4, 3],
    terrain: { wood: 6, sheep: 6, wheat: 6, brick: 5, ore: 5, desert: 2 },
    numbers: [2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 8, 8, 8, 9, 9, 9, 10, 10, 10, 11, 11, 11, 12, 12],
    ports: ['any', 'any', 'any', 'any', 'any', 'wood', 'brick', 'sheep', 'sheep', 'wheat', 'ore'],
  },
};

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const r2 = n => Math.round(n * 1000) / 1000;
const keyOf = (x, y) => `${Math.round(x * 100)},${Math.round(y * 100)}`;

// Build the static geometry: hexes, vertices (intersections) and edges (paths).
function buildGeometry(rows) {
  const hexes = [];
  const vertices = [];
  const edges = [];
  const vByKey = new Map();
  const eByKey = new Map();
  const R = rows.length;

  rows.forEach((n, r) => {
    for (let i = 0; i < n; i++) {
      const hex = { id: hexes.length, x: r2((i - (n - 1) / 2) * SQ3), y: r2((r - (R - 1) / 2) * 1.5), vertices: [], edges: [], neighbors: [] };
      hexes.push(hex);
    }
  });

  for (const hex of hexes) {
    // pointy-top corners, clockwise starting at the top
    const corners = [];
    for (let k = 0; k < 6; k++) {
      const a = (Math.PI / 180) * (60 * k - 90);
      const x = hex.x + Math.cos(a), y = hex.y + Math.sin(a);
      const key = keyOf(x, y);
      let v = vByKey.get(key);
      if (!v) {
        v = { id: vertices.length, x: r2(x), y: r2(y), hexes: [], edges: [], adj: [] };
        vertices.push(v);
        vByKey.set(key, v);
      }
      v.hexes.push(hex.id);
      hex.vertices.push(v.id);
      corners.push(v);
    }
    for (let k = 0; k < 6; k++) {
      const a = corners[k], b = corners[(k + 1) % 6];
      const key = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
      let e = eByKey.get(key);
      if (!e) {
        e = { id: edges.length, a: Math.min(a.id, b.id), b: Math.max(a.id, b.id), hexes: [] };
        edges.push(e);
        eByKey.set(key, e);
        a.edges.push(e.id); b.edges.push(e.id);
        a.adj.push(b.id); b.adj.push(a.id);
      }
      e.hexes.push(hex.id);
      hex.edges.push(e.id);
    }
  }
  for (const h of hexes) {
    for (const o of hexes) {
      if (o !== h && Math.hypot(o.x - h.x, o.y - h.y) < SQ3 + 0.01) h.neighbors.push(o.id);
    }
  }
  return { hexes, vertices, edges };
}

// Place tokens so no two red numbers (6/8) touch, and no identical numbers touch.
function placeNumbers(hexes, numbers) {
  const land = hexes.filter(h => h.resource !== 'desert');
  for (let attempt = 0; attempt < 5000; attempt++) {
    const nums = shuffle(numbers.slice());
    land.forEach((h, i) => (h.number = nums[i]));
    const ok = land.every(h => h.neighbors.every(nid => {
      const n = hexes[nid];
      if (!n.number) return true;
      if ((h.number === 6 || h.number === 8) && (n.number === 6 || n.number === 8)) return false;
      return n.number !== h.number;
    }));
    if (ok) return;
  }
  // fall back to just the red-number constraint (always satisfiable in practice)
  for (;;) {
    const nums = shuffle(numbers.slice());
    land.forEach((h, i) => (h.number = nums[i]));
    const red = n => n === 6 || n === 8;
    if (land.every(h => !red(h.number) || h.neighbors.every(nid => !red(hexes[nid].number)))) return;
  }
}

function placePorts(geo, types) {
  const coastal = geo.edges.filter(e => e.hexes.length === 1);
  const angle = e => {
    const a = geo.vertices[e.a], b = geo.vertices[e.b];
    return Math.atan2((a.y + b.y) / 2, (a.x + b.x) / 2);
  };
  coastal.sort((p, q) => angle(p) - angle(q));
  const portTypes = shuffle(types.slice());
  const step = coastal.length / portTypes.length;
  const offset = crypto.randomInt(coastal.length);
  const ports = [];
  portTypes.forEach((type, i) => {
    const e = coastal[(offset + Math.round(i * step)) % coastal.length];
    const a = geo.vertices[e.a], b = geo.vertices[e.b];
    const hex = geo.hexes[e.hexes[0]];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const dx = mx - hex.x, dy = my - hex.y, len = Math.hypot(dx, dy);
    ports.push({ type, edge: e.id, vertices: [e.a, e.b], x: r2(mx + (dx / len) * 0.75), y: r2(my + (dy / len) * 0.75) });
  });
  return ports;
}

function generateBoard(size) {
  const cfg = CONFIG[size] || CONFIG.base;
  const geo = buildGeometry(cfg.rows);
  const terrain = [];
  for (const [t, n] of Object.entries(cfg.terrain)) for (let i = 0; i < n; i++) terrain.push(t);
  shuffle(terrain);
  geo.hexes.forEach((h, i) => { h.resource = terrain[i]; h.number = null; });
  placeNumbers(geo.hexes, cfg.numbers);
  const ports = placePorts(geo, cfg.ports);
  const robber = geo.hexes.find(h => h.resource === 'desert').id;
  return { size, hexes: geo.hexes, vertices: geo.vertices, edges: geo.edges, ports, robber };
}

module.exports = { generateBoard, RESOURCES, shuffle, CONFIG };
