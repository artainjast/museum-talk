// Museum map. Shared by the browser (ES module) and the server (Node ESM import).
//
// Legend:
//   #  wall (inside a room: low partition)   .  floor        =  door tile (open only if its room is unlocked)
//   h  vote zone "human"                     a  vote zone "agent"
//   S  spawn tile of a room                  L  lava (guide + robot agents can step in and fall; visitors can't)
//   props (solid): o pillar, n bench, p plant, k desk, d rubber duck, m samovar, c coffee machine
//   other digits / letters: exhibit anchors (see EXHIBIT_KEYS; a prop listed there is an easter egg with a plaque)
//
// Each room is RW x RH tiles including its 1-tile wall. Rooms are laid out as a snake:
//   [0][1][2][3]
//   [7][6][5][4]      7 = secret lava hall (hidden door, opened by the Konami code or N)
// Doorways are 3 tiles wide and 2 tiles deep (both rooms' walls).

export const RW = 24, RH = 14;
const ROOM_GRID = [[0, 0], [1, 0], [2, 0], [3, 0], [3, 1], [2, 1], [1, 1], [0, 1]];
export const PROPS = 'onpkdmc';

const E = '......................'; // empty 22-wide interior row
const INTERIORS = [
  [ // 0 lobby
    '..22..l..1111.....33..',
    E,
    '.o..................o.',
    E, E,
    '.S....................',
    E, E,
    '.o..................o.',
    E,
    '..m...nnn....nnn...p..',
    E,
  ],
  [ // 1 the 2 AM room (dim)
    '...11....2222....33...',
    E, E,
    '...kk.............kk..',
    '...kk..d..........kk..',
    E, E, E,
    '..........o...........',
    E, E,
    '...............44.....',
  ],
  [ // 2 evidence
    '....1111..xx..2222....',
    E,
    '.o..................o.',
    E, E,
    '..........nn..........',
    E, E, E,
    '.o..................o.',
    E, E,
  ],
  [ // 3 human or agent?
    '.........1111.........',
    E, E, E,
    '...hhhhhh....aaaaaa...',
    '...hhhhhh....aaaaaa...',
    '...hhhhhh....aaaaaa...',
    '...hhhhhh....aaaaaa...',
    '...hhhhhh....aaaaaa...',
    E,
    '.o..................o.',
    E,
  ],
  [ // 4 gallery of 7 skills (walk order: 1 2 3 4 along the top, 5 6 7 back along the bottom)
    '..11.22.......33..44..',
    E, E, E,
    '...######....######...',
    E,
    '..........p...........',
    '...######....######...',
    E, E, E,
    '.....77....66....55...',
  ],
  [ // 5 brief workshop
    '.........1111.........',
    E, E,
    '...nn............nn...',
    E, E, E, E,
    '...nn............nn...',
    E,
    '....................c.',
    '..........22..........',
  ],
  [ // 6 where to start
    '..11...22...33...44...',
    E,
    '.o..................o.',
    E, E, E, E, E, E,
    '.o..................o.',
    E,
    '....qqqqqq....bbbb....',
  ],
  [ // 7 secret lava hall
    'LLLLLLLLLLL....1111...',
    'LLLLLLLLLL............',
    'LLLLLLLLLL............',
    'LLLLLLLLL.....o.......',
    'LLLLLLLLL.............',
    'LLLLL.................',
    'LLLLL............S....',
    'LLLLLLLLL.............',
    'LLLLLLLLL.....o.......',
    'LLLLLLLLLL............',
    'LLLLLLLLLL............',
    'LLLLLLLLLLL...........',
  ],
];

const EXHIBIT_KEYS = [
  { 1: 'lobby.sign', 2: 'lobby.guide', 3: 'lobby.help', l: 'egg.loading', m: 'egg.samovar' },
  { 1: 'r1.message', 2: 'r1.ticket', 3: 'r1.clock', 4: 'r1.lesson', d: 'egg.duck' },
  { 1: 'r2.wef', 2: 'r2.aristotle', x: 'egg.404' },
  { 1: 'r3.rules' },
  { 1: 'r4.brief', 2: 'r4.delegate', 3: 'r4.empathy', 4: 'r4.feedback', 5: 'r4.verify', 6: 'r4.influence', 7: 'r4.learning', p: 'egg.plant' },
  { 1: 'r5.board', 2: 'r5.meta', c: 'egg.coffee' },
  { 1: 'r6.t1', 2: 'r6.t2', 3: 'r6.t3', 4: 'r6.t4', q: 'r6.quote', b: 'r6.qa' },
  { 1: 'egg.edge' },
];
export const SECRET_ROOM = 7;

const GW = 4, GH = 2;
export const MAP_W = GW * RW, MAP_H = GH * RH;

const g = Array.from({ length: MAP_H }, () => Array(MAP_W).fill(' '));

export const rooms = ROOM_GRID.map(([gx, gy], i) => {
  const ox = gx * RW, oy = gy * RH, rows = INTERIORS[i];
  if (rows.length !== RH - 2 || rows.some(r => r.length !== RW - 2)) throw new Error('bad room size ' + i);
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
    g[oy + y][ox + x] = (x === 0 || y === 0 || x === RW - 1 || y === RH - 1) ? '#' : rows[y - 1][x - 1];
  }
  return { i, ox, oy, x0: ox + 1, y0: oy + 1, x1: ox + RW - 2, y1: oy + RH - 2, cx: ox + RW / 2, cy: oy + RH / 2, spawn: null, entry: null };
});

// Room whose RW x RH block (walls included) contains the tile; -1 for empty blocks.
const blockIdx = new Int8Array(MAP_W * MAP_H).fill(-1);
rooms.forEach(r => { for (let y = r.oy; y < r.oy + RH; y++) for (let x = r.ox; x < r.ox + RW; x++) blockIdx[y * MAP_W + x] = r.i; });
export const blockRoomAt = (x, y) => (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) ? -1 : blockIdx[y * MAP_W + x];

// Doors between consecutive rooms. `room` = the room the door leads into.
export const doors = [];
const doorIdx = new Map();
for (let i = 1; i < ROOM_GRID.length; i++) {
  const [ax, ay] = ROOM_GRID[i - 1], [bx, by] = ROOM_GRID[i];
  let d;
  if (ay === by) {
    const x = Math.max(ax, bx) * RW;
    d = { room: i, x0: x - 1, x1: x, y0: ay * RH + 6, y1: ay * RH + 8, vertical: true };
  } else {
    const y = Math.max(ay, by) * RH;
    d = { room: i, x0: ax * RW + 10, x1: ax * RW + 12, y0: y - 1, y1: y, vertical: false };
  }
  doors.push(d);
  for (let y = d.y0; y <= d.y1; y++) for (let x = d.x0; x <= d.x1; x++) { g[y][x] = '='; doorIdx.set(y * MAP_W + x, i); }
}

export const MAP = g.map(r => r.join(''));

const roomIdx = new Int8Array(MAP_W * MAP_H).fill(-1);
export const exhibits = [];
export const zones = { h: [], a: [] };
const SPECIAL = '.#Sha= L';
export const props = []; // { x, y, kind, room }

rooms.forEach((r, i) => {
  const found = {};
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) {
    roomIdx[y * MAP_W + x] = i;
    const c = MAP[y][x];
    if (c === 'S') r.spawn = { x, y };
    else if (c === 'h' || c === 'a') zones[c].push({ x, y });
    else if (!SPECIAL.includes(c)) {
      const id = EXHIBIT_KEYS[i][c];
      if (PROPS.includes(c)) props.push({ x, y, kind: c, room: i });
      if (!id) { if (PROPS.includes(c)) continue; throw new Error(`unknown exhibit '${c}' in room ${i}`); }
      const e = found[c] ||= { id, room: i, x0: x, y0: y, x1: x, y1: y, egg: id.startsWith('egg.'), prop: PROPS.includes(c) ? c : null };
      e.x0 = Math.min(e.x0, x); e.y0 = Math.min(e.y0, y);
      e.x1 = Math.max(e.x1, x); e.y1 = Math.max(e.y1, y);
    }
  }
  if (!r.spawn) r.spawn = { x: Math.floor(r.cx), y: Math.floor(r.cy) };
  exhibits.push(...Object.values(found));
});

export const zoneRect = {};
for (const k of ['h', 'a']) {
  const xs = zones[k].map(t => t.x), ys = zones[k].map(t => t.y);
  zoneRect[k] = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

export const tileAt = (x, y) => (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) ? ' ' : MAP[y][x];
export const roomAt = (x, y) => (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) ? -1 : roomIdx[y * MAP_W + x];
export const doorRoomAt = (x, y) => doorIdx.get(y * MAP_W + x) ?? -1;

export function isWalkable(x, y, unlocked) {
  const c = tileAt(x, y);
  if (c === '.' || c === 'S' || c === 'h' || c === 'a' || c === 'L') return true;
  return c === '=' && doorRoomAt(x, y) <= unlocked;
}

// Chebyshev distance from tile (x, y) to an exhibit's rectangle.
export function exDist(e, x, y) {
  const dx = x < e.x0 ? e.x0 - x : x > e.x1 ? x - e.x1 : 0;
  const dy = y < e.y0 ? e.y0 - y : y > e.y1 ? y - e.y1 : 0;
  return Math.max(dx, dy);
}

// First interior tile behind each room's entrance door (room 0: its spawn).
rooms.forEach((r, i) => {
  if (i === 0) { r.entry = r.spawn; return; }
  const d = doors[i - 1];
  const mx = Math.floor((d.x0 + d.x1) / 2), my = Math.floor((d.y0 + d.y1) / 2);
  const cands = d.vertical ? [[d.x1 + 1, my], [d.x0 - 1, my]] : [[mx, d.y1 + 1], [mx, d.y0 - 1]];
  const [x, y] = cands.find(([x, y]) => roomAt(x, y) === i);
  r.entry = { x, y };
});
