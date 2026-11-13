// Museum map. Shared by the browser (ES module) and the server (Node ESM import).
//
// The map is built from rectangular AREAS (each with a 1-tile wall). Several areas can belong to one
// talk room (corridors, alcoves, secret side rooms), so lighting / fog / discovery work per room.
//
// Tile legend:
//   #  wall (inside an area: low partition)    =  door tile (open only if its room is unlocked)
//   .  marble floor   ,  carpet   :  wood   ;  grass        S  spawn tile of a room
//   L  abyss (guide + robot agents can jump in and fall; visitors can't)
//   f  secret passage: looks like wall, but anyone can walk through it
//   props (solid, see PROP_KIND): pillars, benches, plants, desks, racks, trophies, ...
//   other characters: exhibit anchors (see EXHIBIT_KEYS; a prop listed there is an easter egg with a plaque)
//   hidden rubber ducks ('u' while building) become floor + an entry in `ducks`.
//
// Route (x to the right, y down) — a winding path with a turn at almost every step:
//   lobby -> corridor (right, then down) -> 2 AM -> evidence -> corridor (right, then up) -> puzzle -> gallery
//   -> corridor (down) -> workshop -> where to start -> Q&A
//   side areas: garden (lobby), server closet* (2 AM), trophy room* (where to start), abyss hall* (gallery)
//   (* secret / hidden)

export const SECRET_ROOM = 8;

export const PROP_KIND = {
  o: 'pillar', n: 'bench', p: 'plant', k: 'desk', d: 'duck', m: 'samovar', c: 'coffee',
  r: 'rack', R: 'rack', z: 'button', j: 'switch', e: 'fountain', T: 'trophy', U: 'trophy', V: 'trophy',
  v: 'vending', y: 'extinguisher', i: 'aquarium', g: 'mirror', D: 'case', K: 'shelf', M: 'mic', s: 'sofa',
};
const FLOORS = '.,:;S';

// Stamps use interior coordinates (0,0 = first tile inside the wall):
//   [ch, ix, iy]  [ch, ix0, ix1, iy]  (horizontal run)  [ch, ix0, iy0, ix1, iy1, 'rect']
const AREAS = [
  { room: 0, main: true, name: 'lobby', x: 0, y: 0, w: 26, h: 18, floor: '.', stamps: [
    ['2', 2, 3, 0], ['l', 6, 0], ['1', 10, 13, 0], ['3', 18, 19, 0],
    [',', 3, 6, 23, 8, 'rect'], ['S', 2, 7],
    ['o', 1, 2], ['o', 22, 2], ['o', 1, 13], ['o', 22, 13], ['o', 7, 11], ['o', 16, 11],
    ['h', 1, 2, 10],
    ['m', 3, 14], ['n', 11, 13, 14], ['i', 20, 14], ['p', 0, 15], ['p', 23, 15],
  ] },
  { room: 0, name: 'garden', x: 4, y: 18, w: 12, h: 8, floor: ';', stamps: [
    ['e', 4, 3], ['p', 0, 0], ['p', 9, 0], ['p', 0, 5], ['p', 9, 5], ['n', 2, 3, 5], ['u', 8, 4],
  ] },
  { room: 1, name: 'corridor', x: 26, y: 6, w: 12, h: 5, floor: ',', stamps: [] },
  { room: 1, name: 'corridor', x: 33, y: 11, w: 5, h: 10, floor: ',', stamps: [] },
  { room: 1, main: true, name: 'office', x: 28, y: 21, w: 20, h: 13, floor: ':', stamps: [
    ['1', 1, 2, 0], ['2', 9, 12, 0], ['3', 14, 15, 0],
    ['k', 2, 3, 3, 4, 'rect'], ['k', 12, 3, 13, 4, 'rect'], ['d', 8, 3], ['o', 8, 7], ['j', 17, 9],
    ['4', 12, 13, 10],
  ] },
  { room: 1, name: 'closet', x: 18, y: 24, w: 10, h: 8, floor: '.', stamps: [
    ['r', 0, 0], ['r', 0, 1], ['r', 0, 2], ['R', 0, 3], ['r', 3, 0], ['r', 4, 0], ['z', 4, 4], ['u', 0, 5],
  ] },
  { room: 2, main: true, name: 'evidence', x: 48, y: 20, w: 24, h: 16, floor: '.', stamps: [
    ['1', 3, 6, 0], ['x', 10, 11, 0], ['2', 15, 18, 0],
    ['o', 1, 2], ['o', 20, 2], [',', 7, 3, 14, 7, 'rect'], ['n', 9, 12, 5],
    ['K', 1, 6, 9], ['K', 15, 20, 9], ['u', 1, 12],
  ] },
  { room: 3, name: 'corridor', x: 72, y: 24, w: 10, h: 5, floor: ',', stamps: [] },
  { room: 3, name: 'corridor', x: 77, y: 16, w: 5, h: 8, floor: ',', stamps: [] },
  { room: 3, main: true, name: 'puzzle', x: 72, y: 2, w: 22, h: 14, floor: '.', stamps: [
    ['1', 8, 11, 0], ['y', 19, 0],
    ['n', 3, 4, 4], ['n', 14, 15, 4], ['n', 3, 4, 7], ['n', 14, 15, 7], ['o', 1, 10], ['o', 18, 10],
  ] },
  { room: 4, main: true, name: 'gallery', x: 94, y: 0, w: 30, h: 17, floor: '.', stamps: [
    ['1', 1, 2, 0], ['2', 5, 6, 0], ['3', 14, 15, 0], ['4', 19, 20, 0],
    ['5', 22, 23, 14], ['6', 15, 16, 14], ['7', 4, 5, 14],
    ['#', 4, 9, 4], ['#', 16, 22, 4], ['#', 4, 9, 10], ['#', 16, 22, 10],
    [',', 11, 5, 15, 9, 'rect'], ['p', 13, 7], ['D', 2, 9], ['D', 25, 4], ['u', 27, 1],
  ] },
  { room: SECRET_ROOM, main: true, name: 'abyss', x: 124, y: 2, w: 22, h: 14, floor: '.', stamps: [
    ['1', 2, 5, 0], ['S', 3, 5], ['o', 7, 2], ['o', 7, 9], ['u', 10, 0],
    ...[11, 12, 12, 11, 12, 13, 12, 12, 11, 12, 12, 11].map((s, iy) => ['L', s, 19, iy]),
  ] },
  { room: 5, name: 'corridor', x: 104, y: 17, w: 5, h: 10, floor: ',', stamps: [] },
  { room: 5, main: true, name: 'workshop', x: 96, y: 27, w: 22, h: 14, floor: '.', stamps: [
    ['1', 13, 16, 0], ['2', 9, 10, 11], [',', 5, 3, 12, 8, 'rect'],
    ['n', 2, 3, 3], ['n', 14, 15, 3], ['n', 2, 3, 9], ['n', 14, 15, 9], ['v', 19, 0], ['c', 19, 10],
  ] },
  { room: 6, main: true, name: 'start', x: 74, y: 30, w: 22, h: 14, floor: '.', stamps: [
    ['1', 2, 3, 0], ['2', 7, 8, 0], ['3', 12, 13, 0], ['4', 16, 17, 0],
    ['q', 11, 16, 11], ['o', 1, 1], ['o', 18, 1], ['o', 1, 5], ['o', 18, 9],
  ] },
  { room: 6, name: 'trophy', x: 78, y: 44, w: 12, h: 8, floor: ',', stamps: [
    ['T', 0, 1], ['U', 0, 3], ['V', 0, 5], ['g', 9, 2], ['n', 4, 6, 3], ['u', 9, 5],
  ] },
  { room: 7, main: true, name: 'qa', x: 46, y: 38, w: 28, h: 16, floor: '.', stamps: [ // free discussion & Q&A
    ['Q', 6, 11, 0], ['F', 14, 17, 0],
    [',', 8, 2, 17, 4, 'rect'], ['M', 12, 3],
    ['n', 5, 10, 7], ['n', 15, 20, 7], ['n', 5, 10, 9], ['n', 15, 20, 9], ['n', 5, 10, 11], ['n', 15, 20, 11],
    ['s', 1, 5], ['s', 1, 6], ['s', 1, 7], ['s', 24, 8], ['s', 24, 9], ['s', 24, 10],
    ['p', 0, 0], ['p', 0, 13], ['p', 25, 13], ['m', 22, 13],
  ] },
];

// Doors: tile rectangles through two touching walls; `room` = the room the door leads into.
// `open: true` = passage inside one room's wing (no rope, never locked).
const DOOR_RECTS = [
  { room: 1, x0: 25, x1: 26, y0: 7, y1: 9 },                   // lobby -> corridor
  { room: 1, x0: 34, x1: 36, y0: 10, y1: 11, open: true },      // corridor turns down
  { room: 1, x0: 34, x1: 36, y0: 20, y1: 21, open: true },      // -> 2 AM office
  { room: 2, x0: 47, x1: 48, y0: 26, y1: 28 },                  // 2 AM -> evidence
  { room: 3, x0: 71, x1: 72, y0: 25, y1: 27 },                  // evidence -> corridor
  { room: 3, x0: 78, x1: 80, y0: 23, y1: 24, open: true },      // corridor turns up
  { room: 3, x0: 78, x1: 80, y0: 15, y1: 16, open: true },      // -> puzzle room
  { room: 4, x0: 93, x1: 94, y0: 6, y1: 8 },                    // puzzle -> gallery
  { room: SECRET_ROOM, x0: 123, x1: 124, y0: 7, y1: 9 },        // hidden door: gallery -> abyss hall
  { room: 5, x0: 105, x1: 107, y0: 16, y1: 17 },                // gallery -> corridor (down)
  { room: 5, x0: 105, x1: 107, y0: 26, y1: 27, open: true },    // -> workshop
  { room: 6, x0: 95, x1: 96, y0: 34, y1: 36 },                  // workshop -> where to start
  { room: 7, x0: 73, x1: 74, y0: 39, y1: 41 },                  // where to start -> Q&A
  { room: 0, x0: 8, x1: 10, y0: 17, y1: 18, open: true },       // lobby <-> garden
];
// Secret passages (look like wall).
const PASSAGE_RECTS = [
  { x0: 27, x1: 28, y0: 27, y1: 29 }, // 2 AM office <-> server closet
  { x0: 82, x1: 84, y0: 43, y1: 44 }, // where to start <-> trophy room
];

const EXHIBIT_KEYS = [
  { 1: 'lobby.sign', 2: 'lobby.guide', 3: 'lobby.help', l: 'egg.loading', m: 'egg.samovar', h: 'egg.hunt', i: 'egg.aquarium', e: 'egg.fountain' },
  { 1: 'r1.message', 2: 'r1.ticket', 3: 'r1.clock', 4: 'r1.lesson', d: 'egg.duck', j: 'egg.switch', R: 'egg.prod', z: 'egg.button' },
  { 1: 'r2.wef', 2: 'r2.aristotle', x: 'egg.404' },
  { 1: 'r3.report', y: 'egg.extinguisher' },
  { 1: 'r4.brief', 2: 'r4.delegate', 3: 'r4.empathy', 4: 'r4.feedback', 5: 'r4.verify', 6: 'r4.influence', 7: 'r4.learning', p: 'egg.plant' },
  { 1: 'r5.board', 2: 'r5.meta', c: 'egg.coffee', v: 'egg.vending' },
  { 1: 'r6.t1', 2: 'r6.t2', 3: 'r6.t3', 4: 'r6.t4', q: 'r6.quote', T: 'egg.trophy1', U: 'egg.trophy2', V: 'egg.trophy3', g: 'egg.mirror' },
  { Q: 'r7.qa', F: 'r7.free' },
  { 1: 'egg.edge' },
];
const ROOM_COUNT = EXHIBIT_KEYS.length;

// ---------------------------------------------------------------- build the grid
export const MAP_W = Math.max(...AREAS.map(a => a.x + a.w));
export const MAP_H = Math.max(...AREAS.map(a => a.y + a.h));
const g = Array.from({ length: MAP_H }, () => Array(MAP_W).fill(' '));
const areaIdx = new Int16Array(MAP_W * MAP_H).fill(-1);

export const areas = AREAS.map((a, ai) => {
  for (let y = a.y; y < a.y + a.h; y++) for (let x = a.x; x < a.x + a.w; x++) {
    if (areaIdx[y * MAP_W + x] >= 0) throw new Error(`areas ${areaIdx[y * MAP_W + x]} and ${ai} overlap at ${x},${y}`);
    areaIdx[y * MAP_W + x] = ai;
    g[y][x] = (x === a.x || y === a.y || x === a.x + a.w - 1 || y === a.y + a.h - 1) ? '#' : a.floor;
  }
  const put = (ix, iy, ch) => {
    if (ix < 0 || iy < 0 || ix > a.w - 3 || iy > a.h - 3) throw new Error(`stamp ${ch} at ${ix},${iy} outside area ${ai}`);
    g[a.y + 1 + iy][a.x + 1 + ix] = ch;
  };
  for (const s of a.stamps) {
    if (s[s.length - 1] === 'rect') { const [ch, x0, y0, x1, y1] = s; for (let iy = y0; iy <= y1; iy++) for (let ix = x0; ix <= x1; ix++) put(ix, iy, ch); }
    else if (s.length === 4) { const [ch, x0, x1, iy] = s; for (let ix = x0; ix <= x1; ix++) put(ix, iy, ch); }
    else put(s[1], s[2], s[0]);
  }
  return { i: ai, room: a.room, main: !!a.main, name: a.name, ox: a.x, oy: a.y, w: a.w, h: a.h, floor: a.floor };
});

export const doors = [];
const doorIdx = new Map();
const openDoor = new Set();
for (const d of DOOR_RECTS) {
  for (let y = d.y0; y <= d.y1; y++) for (let x = d.x0; x <= d.x1; x++) {
    if (g[y][x] !== '#') throw new Error(`door tile ${x},${y} is not a wall`);
    g[y][x] = '='; doorIdx.set(y * MAP_W + x, d.room);
    if (d.open) openDoor.add(y * MAP_W + x);
  }
  doors.push({ ...d, open: !!d.open, vertical: d.x1 - d.x0 === 1 });
}
const passageIdx = new Map();
export const passages = PASSAGE_RECTS.map((p, pi) => {
  for (let y = p.y0; y <= p.y1; y++) for (let x = p.x0; x <= p.x1; x++) {
    if (g[y][x] !== '#') throw new Error(`passage tile ${x},${y} is not a wall`);
    g[y][x] = 'f'; passageIdx.set(y * MAP_W + x, pi);
  }
  return { ...p, i: pi };
});

// ducks: remember, then turn back into floor
export const ducks = [];
for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) {
  if (g[y][x] !== 'u') continue;
  ducks.push({ x, y, i: ducks.length });
  g[y][x] = AREAS[areaIdx[y * MAP_W + x]].floor;
}

export const MAP = g.map(r => r.join(''));

// ---------------------------------------------------------------- rooms, exhibits, props
const roomIdx = new Int8Array(MAP_W * MAP_H).fill(-1);
export const rooms = [];
for (let i = 0; i < ROOM_COUNT; i++) {
  const a = areas.find(ar => ar.room === i && ar.main);
  rooms.push({ i, ox: a.ox, oy: a.oy, w: a.w, h: a.h, x0: a.ox + 1, y0: a.oy + 1, x1: a.ox + a.w - 2, y1: a.oy + a.h - 2,
    cx: a.ox + a.w / 2, cy: a.oy + a.h / 2, spawn: null, entry: null });
}

export const exhibits = [];
export const props = [];
const found = rooms.map(() => ({}));
for (const a of areas) {
  for (let y = a.oy + 1; y < a.oy + a.h - 1; y++) for (let x = a.ox + 1; x < a.ox + a.w - 1; x++) {
    roomIdx[y * MAP_W + x] = a.room;
    const c = MAP[y][x];
    if (c === 'S') { if (!rooms[a.room].spawn) rooms[a.room].spawn = { x, y }; continue; }
    if (FLOORS.includes(c) || c === '#' || c === 'L') continue;
    if (PROP_KIND[c]) props.push({ x, y, kind: PROP_KIND[c], ch: c, room: a.room });
    const id = EXHIBIT_KEYS[a.room][c];
    if (!id) { if (PROP_KIND[c]) continue; throw new Error(`unknown tile '${c}' in room ${a.room}`); }
    const e = found[a.room][c] ||= { id, room: a.room, x0: x, y0: y, x1: x, y1: y, egg: id.startsWith('egg.'), prop: PROP_KIND[c] || null };
    e.x0 = Math.min(e.x0, x); e.y0 = Math.min(e.y0, y); e.x1 = Math.max(e.x1, x); e.y1 = Math.max(e.y1, y);
  }
}
for (const f of found) exhibits.push(...Object.values(f));
for (const e of exhibits) e.wall = !e.prop && MAP[e.y0 - 1][e.x0] === '#'; // hung on the wall above vs. standing easel
for (const r of rooms) if (!r.spawn) r.spawn = { x: Math.floor(r.cx), y: Math.floor(r.cy) };

export const tileAt = (x, y) => (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) ? ' ' : MAP[y][x];
export const roomAt = (x, y) => (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) ? -1 : roomIdx[y * MAP_W + x];
export const doorRoomAt = (x, y) => doorIdx.get(y * MAP_W + x) ?? -1;
export const passageAt = (x, y) => passageIdx.get(y * MAP_W + x) ?? -1;
export const areaAt = (x, y) => (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) ? -1 : areaIdx[y * MAP_W + x];
// Room whose area (walls included) contains the tile; -1 outside every area.
export const blockRoomAt = (x, y) => { const a = areaAt(x, y); return a < 0 ? -1 : areas[a].room; };

// unlocked: main rooms 0..6 open in order; secret: the hidden door to room 7 is open.
export function isWalkable(x, y, unlocked, secret = false) {
  const c = tileAt(x, y);
  if (c !== ' ' && FLOORS.includes(c)) return true;
  if (c === 'L' || c === 'f') return true;
  if (c !== '=') return false;
  if (openDoor.has(y * MAP_W + x)) return true;
  const r = doorRoomAt(x, y);
  return r === SECRET_ROOM ? !!secret : r <= unlocked;
}

// Chebyshev distance from tile (x, y) to an exhibit's rectangle.
export function exDist(e, x, y) {
  const dx = x < e.x0 ? e.x0 - x : x > e.x1 ? x - e.x1 : 0;
  const dy = y < e.y0 ? e.y0 - y : y > e.y1 ? y - e.y1 : 0;
  return Math.max(dx, dy);
}

// First tile inside each room behind its (first) entrance door; room 0: its spawn.
rooms.forEach((r, i) => {
  if (i === 0) { r.entry = r.spawn; return; }
  const d = doors.find(dd => dd.room === i && !dd.open);
  const mx = Math.floor((d.x0 + d.x1) / 2), my = Math.floor((d.y0 + d.y1) / 2);
  const cands = d.vertical ? [[d.x1 + 1, my], [d.x0 - 1, my]] : [[mx, d.y1 + 1], [mx, d.y0 - 1]];
  const [x, y] = cands.find(([x, y]) => roomAt(x, y) === i);
  r.entry = { x, y };
});
