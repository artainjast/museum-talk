import express from 'express';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { MAP_W, MAP_H, rooms, zones, isWalkable, blockRoomAt } from './public/map.js';
import { UI, EXHIBITS } from './public/content.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST_TOKEN = process.env.HOST_TOKEN || crypto.randomBytes(6).toString('hex');

const app = express();
app.disable('x-powered-by');
app.use('/fonts', express.static(path.join(__dirname, 'node_modules/vazirmatn/fonts/webfonts'), { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.send('ok'));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e4, pingInterval: 10000, pingTimeout: 20000 });

process.on('uncaughtException', err => console.error('uncaught', err));
const safe = fn => (...args) => { try { fn(...args); } catch (err) { console.error('handler error', err); } };

// ------------------------------------------------------------------ shared state
const N = MAP_W * MAP_H;
const ROOMS = rooms.length;
const MANUAL_MS = 8000; // a visitor who moved themselves resumes following the guide after this idle time
const st = {
  gx: rooms[0].spawn.x, gy: rooms[0].spawn.y,
  unlocked: 0,
  discovered: 0, // highest room the guide has walked into; visitors may not enter rooms beyond it
  spotlight: null,
  vote: { idx: -1, endsAt: 0, revealed: false, counts: [0, 0] }, // endsAt: Date.now() ms
};
let hostId = null;

const nf = new Intl.NumberFormat('fa-IR');
const players = new Map();   // id -> player
const bySession = new Map(); // sessionId -> player
const dirty = new Set();
let nextId = 1, visitorNo = 0;
let guideDirty = false, countsDirty = false, lastOnline = -1;

// ------------------------------------------------------------------ pathing
// Visitor walk mask: open tiles inside rooms the guide has already discovered.
const walk = new Uint8Array(N);
function rebuildWalk() {
  for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) {
    walk[y * MAP_W + x] = isWalkable(x, y, st.unlocked) && blockRoomAt(x, y) <= st.discovered ? 1 : 0;
  }
}
rebuildWalk();

const Q = new Int32Array(N);
function bfs(start, out) {
  out.fill(-1);
  out[start] = 0;
  let h = 0, t = 0;
  Q[t++] = start;
  while (h < t) {
    const i = Q[h++], d = out[i] + 1, x = i % MAP_W;
    if (x > 0 && walk[i - 1] && out[i - 1] < 0) { out[i - 1] = d; Q[t++] = i - 1; }
    if (x < MAP_W - 1 && walk[i + 1] && out[i + 1] < 0) { out[i + 1] = d; Q[t++] = i + 1; }
    if (i >= MAP_W && walk[i - MAP_W] && out[i - MAP_W] < 0) { out[i - MAP_W] = d; Q[t++] = i - MAP_W; }
    if (i + MAP_W < N && walk[i + MAP_W] && out[i + MAP_W] < 0) { out[i + MAP_W] = d; Q[t++] = i + MAP_W; }
  }
}

const field = new Int16Array(N);
let fieldDirty = true, nearCache = null;
const zoneFields = new Map(); // target tile -> Int16Array
function zoneField(i) {
  let f = zoneFields.get(i);
  if (!f) {
    if (zoneFields.size > 300) zoneFields.clear();
    f = new Int16Array(N); bfs(i, f); zoneFields.set(i, f);
  }
  return f;
}
function refreshField() {
  if (!fieldDirty) return;
  bfs(st.gy * MAP_W + st.gx, field);
  fieldDirty = false;
  nearCache = null;
}
function placeNear(p) {
  refreshField();
  if (!nearCache) { nearCache = []; for (let i = 0; i < N; i++) if (field[i] >= 2 && field[i] <= 5) nearCache.push(i); }
  const i = nearCache.length ? nearCache[(Math.random() * nearCache.length) | 0] : st.gy * MAP_W + st.gx;
  p.x = i % MAP_W; p.y = (i / MAP_W) | 0;
  dirty.add(p);
}

const NB = [-1, 1, -MAP_W, MAP_W];
function neighbours(i) {
  const x = i % MAP_W, out = [];
  for (const o of NB) {
    const n = i + o;
    if (n < 0 || n >= N || !walk[n]) continue;
    if ((o === -1 && x === 0) || (o === 1 && x === MAP_W - 1)) continue;
    out.push(n);
  }
  return out;
}

function stepPlayer(p, t) {
  if (t < p.nextAt) return;
  p.nextAt = t + 150 + Math.random() * 50;
  const i = p.y * MAP_W + p.x;
  const voting = p.choice && p.target != null;
  if (!voting && p.goal >= 0) { // tap-to-move
    const gf = zoneField(p.goal), gd = gf[i];
    if (gd <= 0) { p.goal = -1; p.manualUntil = t + MANUAL_MS; return; }
    const c = neighbours(i).filter(n => gf[n] === gd - 1);
    if (c.length) { const n = c[(Math.random() * c.length) | 0]; p.x = n % MAP_W; p.y = (n / MAP_W) | 0; dirty.add(p); }
    return;
  }
  if (!voting && t < p.manualUntil) return; // moved by themselves recently: stay put
  const f = voting ? zoneField(p.target) : field;
  const d = f[i];
  if (d < 0 || (!voting && d > 60)) { if (!voting) placeNear(p); return; } // stuck or far behind: rejoin the group
  const stopAt = voting ? 0 : p.space;
  let next = -1;
  if (d > stopAt) {
    const c = neighbours(i).filter(n => f[n] === d - 1 && f[n] >= 0);
    if (c.length) next = c[(Math.random() * c.length) | 0];
  } else if (!voting && Math.random() < 0.04) {
    const c = neighbours(i).filter(n => f[n] >= 2 && f[n] <= p.space + 1);
    if (c.length) next = c[(Math.random() * c.length) | 0];
  }
  if (next >= 0) { p.x = next % MAP_W; p.y = (next / MAP_W) | 0; dirty.add(p); }
}

// ------------------------------------------------------------------ voting
const zoneUse = new Map();
function voteIsOpen(t = Date.now()) { return st.vote.idx >= 0 && !st.vote.revealed && t < st.vote.endsAt; }
function releaseTarget(p) {
  if (p.target != null) zoneUse.set(p.target, Math.max(0, (zoneUse.get(p.target) || 1) - 1));
  p.target = null;
}
function pickTarget(k) {
  let best = [], bu = Infinity;
  for (const z of zones[k]) {
    const i = z.y * MAP_W + z.x, u = zoneUse.get(i) || 0;
    if (u < bu) { bu = u; best = [i]; } else if (u === bu) best.push(i);
  }
  const i = best[(Math.random() * best.length) | 0];
  zoneUse.set(i, (zoneUse.get(i) || 0) + 1);
  return i;
}
function recount() {
  if (st.vote.idx < 0 || st.vote.revealed) return; // keep final counts after reveal
  let h = 0, a = 0;
  for (const p of players.values()) { if (p.choice === 'h') h++; else if (p.choice === 'a') a++; }
  if (h !== st.vote.counts[0] || a !== st.vote.counts[1]) { st.vote.counts = [h, a]; countsDirty = true; }
}
function clearChoices() {
  for (const p of players.values()) { p.choice = null; p.target = null; }
  zoneUse.clear();
}

// ------------------------------------------------------------------ messages
const metaMsg = () => ({
  unlocked: st.unlocked,
  discovered: st.discovered,
  spotlight: st.spotlight,
  vote: { idx: st.vote.idx, remaining: Math.max(0, st.vote.endsAt - Date.now()), revealed: st.vote.revealed, counts: st.vote.counts },
});
const playerRow = p => [p.id, p.x, p.y, p.avatar, p.name];
const onlineCount = () => { let n = 0; for (const p of players.values()) if (p.connected) n++; return n; };
const snapshot = () => ({ g: [st.gx, st.gy], meta: metaMsg(), players: [...players.values()].map(playerRow), n: onlineCount() });

function applyHostState(s) {
  if (!s || typeof s !== 'object') return;
  let meta = false, walkChanged = false;
  const un = Number(s.unlocked);
  if (Number.isInteger(un) && un >= 0 && un < ROOMS && un !== st.unlocked) { st.unlocked = un; walkChanged = true; }
  const dv = Number(s.discovered);
  if (Number.isInteger(dv) && dv >= 0 && dv < ROOMS && dv !== st.discovered) { st.discovered = dv; walkChanged = true; }
  if (walkChanged) { rebuildWalk(); zoneFields.clear(); fieldDirty = true; meta = true; }
  const x = Number(s.x), y = Number(s.y);
  if (Number.isInteger(x) && Number.isInteger(y) && (x !== st.gx || y !== st.gy) && isWalkable(x, y, st.unlocked)) {
    st.gx = x; st.gy = y; fieldDirty = true; guideDirty = true;
  }
  const sp = s.spotlight === null || (typeof s.spotlight === 'string' && EXHIBITS[s.spotlight]) ? s.spotlight : st.spotlight;
  if (sp !== st.spotlight) { st.spotlight = sp; meta = true; }
  const v = s.vote;
  if (v && typeof v === 'object' && Number.isInteger(v.idx) && v.idx >= -1 && v.idx < 10) {
    const remaining = Math.max(0, Math.min(60000, Number(v.remaining) || 0));
    const revealed = !!v.revealed;
    if (v.idx !== st.vote.idx) {
      st.vote = { idx: v.idx, endsAt: Date.now() + remaining, revealed, counts: [0, 0] };
      clearChoices(); countsDirty = true; meta = true;
    } else if (revealed !== st.vote.revealed) {
      st.vote.revealed = revealed;
      if (revealed) { st.vote.endsAt = Math.min(st.vote.endsAt, Date.now()); for (const p of players.values()) releaseTarget(p); for (const p of players.values()) p.choice = null; zoneUse.clear(); }
      meta = true;
    }
  }
  if (meta) io.emit('meta', metaMsg());
}

function cleanName(raw) {
  let s = String(raw ?? '').normalize('NFC');
  s = s.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '');
  s = s.replace(/(https?:\/\/|www\.)\S*/gi, '');
  s = s.replace(/\S+\.(com|net|org|ir|io|me|xyz|info|co|app|dev|link|site|online|top|ru|tk|ly|gg|tv|to)\b\S*/gi, '');
  s = s.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, 16).join('').trim();
}

// ------------------------------------------------------------------ sockets
io.on('connection', socket => {
  let lastReact = 0, lastJoin = 0;

  socket.on('host:hello', safe((msg) => {
    if (!msg || typeof msg.token !== 'string' || msg.token !== HOST_TOKEN) { socket.emit('host:denied'); return; }
    hostId = socket.id;
    applyHostState(msg.state);
    socket.emit('host:ok', snapshot());
  }));

  socket.on('host:state', safe((s) => {
    if (socket.id !== hostId) return;
    applyHostState(s);
  }));

  socket.on('join', safe((msg) => {
    const t = Date.now();
    if (t - lastJoin < 1000 || !msg || typeof msg !== 'object') return;
    lastJoin = t;
    const sid = typeof msg.sessionId === 'string' && /^[\w-]{6,40}$/.test(msg.sessionId) ? msg.sessionId : null;
    let avatar = Number(msg.avatar);
    if (!Number.isInteger(avatar) || avatar < 0 || avatar > 9) avatar = (Math.random() * 10) | 0;
    let name = cleanName(msg.name);
    let p = sid && bySession.get(sid);
    if (p) {
      if (p.socketId && p.socketId !== socket.id) io.sockets.sockets.get(p.socketId)?.disconnect(true);
      p.socketId = socket.id; p.connected = true; p.goneAt = 0;
      if (name && name !== p.name) { p.name = name; io.emit('pjoin', playerRow(p)); }
      if (avatar !== p.avatar) { p.avatar = avatar; io.emit('pjoin', playerRow(p)); }
    } else {
      if (players.size >= 400) { socket.emit('full'); return; }
      if (!name) name = UI.defaultName.replace('{n}', nf.format(++visitorNo));
      p = {
        id: nextId++, sessionId: sid || crypto.randomBytes(8).toString('hex'), socketId: socket.id, connected: true, goneAt: 0,
        name, avatar, x: st.gx, y: st.gy, space: 2 + ((Math.random() * 4) | 0), nextAt: 0, choice: null, target: null,
        goal: -1, manualUntil: 0, lastStep: 0, lastGoto: 0,
      };
      placeNear(p);
      dirty.delete(p);
      players.set(p.id, p);
      bySession.set(p.sessionId, p);
      socket.broadcast.emit('pjoin', playerRow(p));
    }
    socket.data.pid = p.id;
    socket.emit('welcome', { me: p.id, name: p.name, sessionId: p.sessionId, ...snapshot() });
  }));

  socket.on('sync', safe(() => socket.emit('snap', snapshot())));

  // Visitors may also walk by themselves (keyboard step, or tap-to-move goal). Same fog/door rules apply.
  socket.on('step', safe((dir) => {
    const p = players.get(socket.data.pid);
    const t = Date.now();
    if (!p || !Array.isArray(dir)) return;
    const [dx, dy] = dir;
    if (!Number.isInteger(dx) || !Number.isInteger(dy) || Math.abs(dx) + Math.abs(dy) !== 1) return;
    if (t - p.lastStep < 100) return;
    p.lastStep = t;
    p.goal = -1;
    p.manualUntil = t + MANUAL_MS;
    const x = p.x + dx, y = p.y + dy;
    if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H || !walk[y * MAP_W + x]) return;
    p.x = x; p.y = y; dirty.add(p);
  }));

  socket.on('goto', safe((pos) => {
    const p = players.get(socket.data.pid);
    const t = Date.now();
    if (!p || !Array.isArray(pos) || t - p.lastGoto < 200) return;
    const [x, y] = pos;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= MAP_W || y >= MAP_H || !walk[y * MAP_W + x]) return;
    p.lastGoto = t;
    p.goal = y * MAP_W + x;
    p.manualUntil = t + MANUAL_MS;
  }));

  socket.on('vote', safe((choice) => {
    const p = players.get(socket.data.pid);
    if (!p || (choice !== 'h' && choice !== 'a') || !voteIsOpen()) return;
    if (p.choice === choice) return;
    releaseTarget(p);
    p.choice = choice;
    p.target = pickTarget(choice);
    recount();
  }));

  socket.on('react', safe((idx) => {
    const p = players.get(socket.data.pid);
    const t = Date.now();
    if (!p || !Number.isInteger(idx) || idx < 0 || idx > 4 || t - lastReact < 1000) return;
    lastReact = t;
    io.emit('r', [p.id, idx]);
  }));

  socket.on('disconnect', safe(() => {
    if (socket.id === hostId) hostId = null;
    const p = players.get(socket.data.pid);
    if (p && p.socketId === socket.id) { p.connected = false; p.goneAt = Date.now(); }
  }));
});

// ------------------------------------------------------------------ loops
setInterval(safe(() => {
  const t = Date.now();
  refreshField();
  for (const p of players.values()) stepPlayer(p, t);
}), 50);

setInterval(safe(() => {
  const msg = {};
  if (guideDirty) { msg.g = [st.gx, st.gy]; guideDirty = false; }
  if (dirty.size) {
    const arr = [];
    for (const p of dirty) if (players.has(p.id)) arr.push(p.id, p.x, p.y);
    dirty.clear();
    if (arr.length) msg.p = arr;
  }
  const n = onlineCount();
  if (n !== lastOnline) { msg.n = n; lastOnline = n; }
  if (msg.g || msg.p || msg.n !== undefined) io.emit('t', msg);
}), 100);

setInterval(safe(() => {
  if (countsDirty) { countsDirty = false; io.emit('c', st.vote.counts); }
}), 500);

setInterval(safe(() => {
  const t = Date.now();
  for (const p of players.values()) {
    if (!p.connected && t - p.goneAt > 60000) {
      releaseTarget(p);
      players.delete(p.id); bySession.delete(p.sessionId); dirty.delete(p);
      io.emit('pleave', p.id);
      recount();
    }
  }
}), 2000);

server.listen(PORT, () => {
  console.log(`museum on http://localhost:${PORT}/`);
  console.log(`guide:   http://localhost:${PORT}/?host=${HOST_TOKEN}`);
  console.log(`solo:    http://localhost:${PORT}/?solo=1`);
});
