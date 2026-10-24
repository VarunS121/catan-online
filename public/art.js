// Hand-drawn SVG art: terrain tiles, pieces, robber and resource icons, shared through one sprite.
// Symbols use a 100×100 box centred on the hex (pointy-top, radius 50). Pieces take the player's
// colour from `color` on the <use> element via currentColor.
(function () {
  const HEX = '0,-50 43.3,-25 43.3,25 0,50 -43.3,25 -43.3,-25';
  // art sits in a ring so the number token in the middle stays clear
  const RING = [[-22, -27], [0, -34], [22, -27], [-32, -2], [32, -2], [-22, 26], [22, 26], [0, 35]];

  const tree = (x, y, s = 1) => `<g transform="translate(${x} ${y}) scale(${s})">
    <rect x="-1.6" y="5" width="3.2" height="6" fill="#5b3a1e"/>
    <path d="M0 -13 L8 -1 H4 L10 7 H-10 L-4 -1 H-8 Z" fill="#1d5a28"/>
    <path d="M0 -13 L8 -1 H4 L10 7 H0 Z" fill="#000" opacity=".2"/>
    <path d="M0 -13 L-3 -8" stroke="#8fd18a" stroke-width="1" opacity=".6"/></g>`;
  const bricks = (x, y, s = 1) => `<g transform="translate(${x} ${y}) scale(${s})" stroke="#6e2612" stroke-width=".7">
    <rect x="-9" y="2" width="8" height="4.5" fill="#b8492a"/><rect x="1" y="2" width="8" height="4.5" fill="#a8401f"/>
    <rect x="-4" y="-2.5" width="8" height="4.5" fill="#c4552f"/></g>`;
  const mound = (x, y, w) => `<path d="M${x - w} ${y} Q${x} ${y - w * 1.1} ${x + w} ${y} Z" fill="#a84a25"/><path d="M${x} ${y - w * 0.55} Q${x + w * 0.6} ${y - w * 0.45} ${x + w} ${y} H${x} Z" fill="#000" opacity=".15"/>`;
  const sheep = (x, y, flip) => `<g transform="translate(${x} ${y}) scale(${flip ? -1 : 1} 1)">
    <path d="M-4 3 V7 M3 3 V7" stroke="#333" stroke-width="1.4"/>
    <g fill="#fbfbf6" stroke="#cfcfc4" stroke-width=".6"><circle cx="-4" cy="0" r="3.6"/><circle cx="0" cy="-2" r="3.8"/><circle cx="3.5" cy="0" r="3.6"/><circle cx="0" cy="2" r="3.6"/></g>
    <ellipse cx="6.8" cy="-1" rx="2.6" ry="2" fill="#2f2f2f"/></g>`;
  const tuft = (x, y) => `<path d="M${x - 3} ${y} l1.2 -4 l1 4 l1.4 -5 l1 5 l1.3 -3.5 l.8 3.5" fill="none" stroke="#4d8a2a" stroke-width="1" stroke-linejoin="round"/>`;
  const stalk = (x, y, r) => `<g transform="translate(${x} ${y}) rotate(${r})"><path d="M0 9 V-6" stroke="#a5761b" stroke-width="1"/>
    ${[-5, -2, 1].map(k => `<ellipse cx="-1.4" cy="${k}" rx="1.2" ry="2.2" transform="rotate(-25 -1.4 ${k})" fill="#c48d20"/><ellipse cx="1.4" cy="${k}" rx="1.2" ry="2.2" transform="rotate(25 1.4 ${k})" fill="#d49b26"/>`).join('')}
    <ellipse cx="0" cy="-8" rx="1.1" ry="2.2" fill="#d49b26"/></g>`;
  const sheaf = (x, y, s = 1) => `<g transform="translate(${x} ${y}) scale(${s})">${stalk(-3, 0, -12)}${stalk(0, -1, 0)}${stalk(3, 0, 12)}</g>`;
  const peak = (x, y, s = 1) => `<g transform="translate(${x} ${y}) scale(${s})">
    <path d="M-14 8 L0 -14 L14 8 Z" fill="#7d8792"/><path d="M0 -14 L14 8 H2 Z" fill="#000" opacity=".22"/>
    <path d="M-5.2 -6 L0 -14 L5.2 -6 L2.2 -7.5 L0 -5 L-2.4 -7.6 Z" fill="#fafcff"/></g>`;
  const cactus = (x, y, s = 1) => `<g transform="translate(${x} ${y}) scale(${s})" fill="#5d8f3b">
    <rect x="-2.6" y="-11" width="5.2" height="20" rx="2.6"/><path d="M-2.6 0 H-6 a2 2 0 0 1 -2 -2 V-6" stroke="#5d8f3b" stroke-width="3.4" fill="none" stroke-linecap="round"/>
    <path d="M2.6 -3 H5.5 a2 2 0 0 0 2 -2 V-8" stroke="#5d8f3b" stroke-width="3.4" fill="none" stroke-linecap="round"/>
    <rect x="0.6" y="-10" width="1" height="18" fill="#000" opacity=".15"/></g>`;

  const tile = (id, top, bottom, art) => `
    <linearGradient id="g-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient>
    <symbol id="t-${id}" viewBox="-50 -50 100 100" overflow="visible">
      <polygon points="${HEX}" fill="url(#g-${id})"/>
      <g clip-path="url(#hexclip)">${art}</g>
      <polygon points="${HEX}" fill="none" stroke="#fff" stroke-opacity=".25" stroke-width="2.5" transform="scale(.96)"/>
      <polygon points="${HEX}" fill="none" stroke="#00000055" stroke-width="2"/>
    </symbol>`;

  const terrain = {
    wood: tile('wood', '#4c9a4f', '#236029', RING.map(([x, y], i) => tree(x, y, i % 2 ? 1.05 : 1.2)).join('') + tree(-11, -19, 0.75) + tree(11, -19, 0.75)),
    brick: tile('brick', '#d6784a', '#9c4423',
      mound(-30, -10, 13) + mound(28, 16, 14) + mound(0, 44, 16) + mound(14, -38, 12)
      + [[-20, -30], [20, -26], [-30, 12], [30, -6], [-14, 32], [18, 34]].map(([x, y]) => bricks(x, y, 1.1)).join('')),
    sheep: tile('sheep', '#a7d86f', '#69a43e',
      [[-30, -20], [-8, -36], [30, -18], [-36, 14], [8, 28], [34, 24], [-12, 40], [14, -26], [-22, 30]].map(([x, y]) => tuft(x, y)).join('')
      + sheep(-20, -24) + sheep(18, -30, true) + sheep(-30, 6) + sheep(28, 6, true) + sheep(-6, 30) + sheep(20, 30, true)),
    wheat: tile('wheat', '#f3d468', '#d29f25',
      [-40, -28, -16, -4, 8, 20, 32, 44].map(o => `<path d="M-50 ${o} Q0 ${o - 14} 50 ${o}" fill="none" stroke="#b9841c" stroke-opacity=".35" stroke-width="2"/>`).join('')
      + RING.map(([x, y]) => sheaf(x, y, 1.1)).join('')),
    ore: tile('ore', '#aab4bf', '#66717d',
      peak(-20, -24, 1.25) + peak(16, -28, 1.05) + peak(0, -34, 0.8) + peak(-31, 8, 0.95) + peak(31, 6, 1) + peak(-14, 32, 1.1) + peak(16, 34, 1.2)),
    desert: tile('desert', '#efdca5', '#d1b373',
      `<path d="M-50 -14 Q-20 -30 10 -14 T60 -16 V-50 H-50 Z" fill="#f6e7b9" opacity=".7"/><path d="M-50 22 Q-15 6 18 22 T60 18 V60 H-50 Z" fill="#c9a764" opacity=".55"/>`
      + cactus(-4, -28, 1.2) + cactus(-26, 20, 0.9) + cactus(26, 18, 1) + `<circle cx="22" cy="-26" r="2" fill="#b8975a"/><circle cx="-26" cy="-6" r="1.5" fill="#b8975a"/>`),
  };

  // pieces
  const pieces = `
    <symbol id="p-settlement" viewBox="-14 -16 28 30" overflow="visible">
      <ellipse cx="1" cy="10.5" rx="11" ry="3" fill="#000" opacity=".35"/>
      <path d="M-9 9.5 V-1 L0 -10 L9 -1 V9.5 Z" fill="currentColor" stroke="#141414" stroke-width="1.8" stroke-linejoin="round"/>
      <path d="M0 -10 L9 -1 V9.5 H0 Z" fill="#000" opacity=".22"/>
      <path d="M-10.5 0.3 L0 -11 L10.5 0.3" fill="none" stroke="#141414" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
      <path d="M-6 -1 L0 -7" stroke="#fff" stroke-opacity=".45" stroke-width="1.4" stroke-linecap="round"/>
      <rect x="-2.6" y="3" width="5.2" height="6.5" rx="1" fill="#000" opacity=".35"/>
    </symbol>
    <symbol id="p-city" viewBox="-18 -21 36 34" overflow="visible">
      <ellipse cx="1" cy="10.5" rx="16" ry="3.4" fill="#000" opacity=".35"/>
      <path d="M-14 10 V-10 L-8 -17 L-2 -10 V-2 L6 -10 L14 -2 V10 Z" fill="currentColor" stroke="#141414" stroke-width="1.8" stroke-linejoin="round"/>
      <path d="M6 -10 L14 -2 V10 H6 Z" fill="#000" opacity=".22"/><path d="M-8 -17 L-2 -10 V10 H-8 Z" fill="#000" opacity=".16"/>
      <path d="M-11 -9 L-8 -13" stroke="#fff" stroke-opacity=".45" stroke-width="1.4" stroke-linecap="round"/>
      <rect x="-10.5" y="-6" width="5" height="5" rx="1" fill="#000" opacity=".35"/><rect x="2" y="2" width="6" height="8" rx="1" fill="#000" opacity=".35"/>
    </symbol>
    <radialGradient id="g-robber" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#6b6b6b"/><stop offset="1" stop-color="#151515"/></radialGradient>
    <symbol id="p-robber" viewBox="-12 -20 24 36" overflow="visible">
      <ellipse cx="1" cy="14" rx="10" ry="3.5" fill="#000" opacity=".45"/>
      <path d="M-8.5 13.5 Q-10 1 -5 -4 A7 7 0 1 1 5 -4 Q10 1 8.5 13.5 Z" fill="url(#g-robber)" stroke="#000" stroke-width="1.2"/>
      <path d="M-5 9 Q-6.5 1 -2.5 -2" stroke="#fff" stroke-opacity=".25" stroke-width="1.6" fill="none" stroke-linecap="round"/>
      <circle cx="-2.8" cy="-11" r="1.8" fill="#fff" opacity=".3"/>
    </symbol>`;

  // small resource icons for the UI (24×24)
  const icons = `
    <symbol id="i-wood" viewBox="0 0 24 24"><rect x="10.6" y="17" width="2.8" height="5" fill="#6b4524"/><path d="M12 2 L19 12 H15.5 L20.5 18.5 H3.5 L8.5 12 H5 Z" fill="#2f8a3a"/><path d="M12 2 L19 12 H15.5 L20.5 18.5 H12 Z" fill="#000" opacity=".2"/></symbol>
    <symbol id="i-brick" viewBox="0 0 24 24" stroke="#6e2612" stroke-width=".9"><rect x="2" y="14" width="9.5" height="6" rx=".8" fill="#c4552f"/><rect x="12.5" y="14" width="9.5" height="6" rx=".8" fill="#b34724"/><rect x="7.2" y="7" width="9.5" height="6" rx=".8" fill="#d0643a"/></symbol>
    <symbol id="i-sheep" viewBox="0 0 24 24"><path d="M7 15 V20 M14 15 V20" stroke="#333" stroke-width="2"/><g fill="#fff" stroke="#bbb" stroke-width=".8"><circle cx="7" cy="11" r="4.6"/><circle cx="11.5" cy="8.5" r="4.8"/><circle cx="15.5" cy="11.5" r="4.4"/><circle cx="10.5" cy="13.5" r="4.4"/></g><ellipse cx="19.5" cy="9.5" rx="3.2" ry="2.5" fill="#2f2f2f"/></symbol>
    <symbol id="i-wheat" viewBox="0 0 24 24"><g transform="translate(12 13) scale(1.25)">${stalk(-3.2, 0, -14)}${stalk(0, -1, 0)}${stalk(3.2, 0, 14)}</g></symbol>
    <symbol id="i-ore" viewBox="0 0 24 24"><path d="M3 19 L6 10 L11 5 L17 7 L21 14 L18 20 Z" fill="#8c96a2" stroke="#4d555e" stroke-width="1"/><path d="M11 5 L13 12 L21 14 M13 12 L9 20 M13 12 L6 10" stroke="#4d555e" stroke-width=".8" fill="none"/><path d="M11 5 L17 7 L13 12 Z" fill="#c3ccd6"/></symbol>
    <symbol id="i-anchor" viewBox="0 0 24 24" fill="none" stroke="#4a2f14" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="5" r="2.3"/><path d="M12 7.5 V21 M7 11 H17 M4.5 14 Q5 21 12 21 Q19 21 19.5 14"/></symbol>`;

  const sprite = `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden"><defs>
    <clipPath id="hexclip"><polygon points="${HEX}"/></clipPath>
    <pattern id="waves" width="46" height="22" patternUnits="userSpaceOnUse"><path d="M0 11 Q11.5 4 23 11 T46 11" fill="none" stroke="#fff" stroke-opacity=".13" stroke-width="1.6"/></pattern>
    <radialGradient id="g-sea" cx=".5" cy=".5" r=".7"><stop offset="0" stop-color="#3f9ad0"/><stop offset=".65" stop-color="#21679a"/><stop offset="1" stop-color="#143f62"/></radialGradient>
    <radialGradient id="g-token" cx=".4" cy=".35" r=".75"><stop offset="0" stop-color="#fffaf0"/><stop offset="1" stop-color="#e9dcbc"/></radialGradient>
    <filter id="f-shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="#00142a" flood-opacity=".55"/></filter>
    <filter id="f-soft" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="1.5" stdDeviation="1.2" flood-color="#000" flood-opacity=".45"/></filter>
    ${Object.values(terrain).join('')}${pieces}${icons}</defs></svg>`;
  document.body.insertAdjacentHTML('afterbegin', sprite);

  window.ART = {
    icon: (r, cls = '') => `<svg class="ri ${cls}" viewBox="0 0 24 24"><use href="#i-${r}"/></svg>`,
  };
})();
