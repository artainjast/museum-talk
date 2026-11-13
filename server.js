import express from 'express';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import QRCode from 'qrcode';
import { MAP_W, MAP_H, rooms, props, isWalkable, blockRoomAt, tileAt, SECRET_ROOM } from './public/map.js';
import { UI, EXHIBITS, BOT_NAMES } from './public/content.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST_TOKEN = process.env.HOST_TOKEN || crypto.randomBytes(6).toString('hex');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // behind Cloudflare Tunnel / nginx: honour X-Forwarded-Proto/Host
app.use('/fonts', express.static(path.join(__dirname, 'node_modules/vazirmatn/fonts/webfonts'), { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.send('ok'));
// Public visitor link (PUBLIC_URL if set, else the address this request came in on) + its QR code.
const publicUrl = req => process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}/`;
app.get('/join.json', (req, res) => res.json({ url: publicUrl(req) }));
app.get('/qr.svg', async (req, res) => {
  try {
    const svg = await QRCode.toString(publicUrl(req), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
  } catch (err) { res.status(500).send('qr error'); }
});

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e4, pingInterval: 10000, pingTimeout: 20000, perMessageDeflate: { threshold: 256 } });

process.on('uncaughtException', err => console.error('uncaught', err));
const safe = fn => (...args) => { try { fn(...args); } catch (err) { console.error('handler error', err); } };

// ------------------------------------------------------------------ shared state
const N = MAP_W * MAP_H;
const ROOMS = rooms.length;
const BOTS = Math.min(BOT_NAMES.length, Number(process.env.BOTS ?? BOT_NAMES.length)); // robot agents that blindly follow the guide (even into the abyss)
const LAVA_RESPAWN_MS = 1500;
const MANUAL_MS = 8000; // a visitor who moved themselves resumes following the guide after this idle time
const st = {
  gx: rooms[0].spawn.x, gy: rooms[0].spawn.y,
  unlocked: 0,
  discovered: 0, // highest main room the guide has walked into; visitors may not enter rooms beyond it
  secret: false,     // hidden door (room 4 -> secret abyss hall) open
  secretSeen: false, // guide has walked into the secret hall
  spotlight: null,
  puzzle: { open: false, endsAt: 0, revealed: false, seq: 0 }, // room 3 "is it really done?" overlay; endsAt: Date.now() ms
};
let hostId = null;

const nf = new Intl.NumberFormat('fa-IR');
const players = new Map();   // id -> player
const bySession = new Map(); // sessionId -> player
const dirty = new Set();
let nextId = 1, visitorNo = 0;
let guideDirty = false, lastOnline = -1;

// ------------------------------------------------------------------ pathing
// pass: open tiles inside rooms the guide has discovered (incl. lava; robots path through it)
// walk: same minus lava (where visitors may stand)
const walk = new Uint8Array(N), pass = new Uint8Array(N), lava = new Uint8Array(N);
for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) lava[y * MAP_W + x] = tileAt(x, y) === 'L' ? 1 : 0;
function rebuildWalk() {
  for (let i = 0; i < N; i++) {
    const x = i % MAP_W, y = (i / MAP_W) | 0;
    const b = blockRoomAt(x, y);
    const open = b === SECRET_ROOM ? st.secretSeen : b <= st.discovered;
    pass[i] = isWalkable(x, y, st.unlocked, st.secret) && open ? 1 : 0;
    walk[i] = pass[i] && !lava[i] ? 1 : 0;
  }
}
rebuildWalk();

const Q = new Int32Array(N);
function bfs(start, out, m = walk) {
  out.fill(-1);
  out[start] = 0;
  let h = 0, t = 0;
  Q[t++] = start;
  while (h < t) {
    const i = Q[h++], d = out[i] + 1, x = i % MAP_W;
    if (x > 0 && m[i - 1] && out[i - 1] < 0) { out[i - 1] = d; Q[t++] = i - 1; }
    if (x < MAP_W - 1 && m[i + 1] && out[i + 1] < 0) { out[i + 1] = d; Q[t++] = i + 1; }
    if (i >= MAP_W && m[i - MAP_W] && out[i - MAP_W] < 0) { out[i - MAP_W] = d; Q[t++] = i - MAP_W; }
    if (i + MAP_W < N && m[i + MAP_W] && out[i + MAP_W] < 0) { out[i + MAP_W] = d; Q[t++] = i + MAP_W; }
  }
}

const field = new Int16Array(N);
let fieldDirty = true, nearCache = null;
const goalFields = new Map(); // tap-to-move target tile -> Int16Array
function goalField(i) {
  let f = goalFields.get(i);
  if (!f) {
    if (goalFields.size > 300) goalFields.clear();
    f = new Int16Array(N); bfs(i, f); goalFields.set(i, f);
  }
  return f;
}
function refreshField() {
  if (!fieldDirty) return;
  bfs(st.gy * MAP_W + st.gx, field, pass);
  fieldDirty = false;
  nearCache = null;
}
function placeNear(p) {
  refreshField();
  if (!nearCache) { nearCache = []; for (let i = 0; i < N; i++) if (walk[i] && field[i] >= 2 && field[i] <= 5) nearCache.push(i); }
  const i = nearCache.length ? nearCache[(Math.random() * nearCache.length) | 0] : st.gy * MAP_W + st.gx;
  p.x = i % MAP_W; p.y = (i / MAP_W) | 0;
  dirty.add(p);
}

const QA_ROOM = 7;
const seats = new Set(props.filter(pr => pr.room === QA_ROOM && (pr.kind === 'bench' || pr.kind === 'sofa')).map(pr => pr.y * MAP_W + pr.x));

const NB = [-1, 1, -MAP_W, MAP_W];
function neighbours(i, m = walk) {
  const x = i % MAP_W, out = [];
  for (const o of NB) {
    const n = i + o;
    if (n < 0 || n >= N || !m[n]) continue;
    if ((o === -1 && x === 0) || (o === 1 && x === MAP_W - 1)) continue;
    out.push(n);
  }
  return out;
}

function standUp(p) {
  if (p.seat < 0) return;
  const was = p.sitting;
  const adj = [...NB.map(o => p.seat + o)].find(n => n >= 0 && n < N && walk[n]);
  if (was && adj !== undefined) { p.x = adj % MAP_W; p.y = (adj / MAP_W) | 0; dirty.add(p); }
  p.sitting = false; p.seat = -1;
  if (was) io.emit('sit', [p.id, 0]);
}

function stepPlayer(p, t) {
  if (t < p.nextAt) return;
  if (p.fallAt) { // fell into lava: respawn next to the guide
    if (t - p.fallAt < LAVA_RESPAWN_MS) return;
    p.fallAt = 0; placeNear(p); return;
  }
  p.nextAt = t + (p.bot ? 110 + Math.random() * 60 : 150 + Math.random() * 50);
  const i = p.y * MAP_W + p.x;
  if (p.bot) { // dummy agents: follow the guide's exact path, lava included
    const d = field[i];
    if (d < 0 || d > 60) { placeNear(p); return; }
    const stopAt = lava[st.gy * MAP_W + st.gx] ? 0 : p.space;
    let next = -1;
    if (d > stopAt) {
      const c = neighbours(i, pass).filter(n => field[n] === d - 1);
      if (c.length) next = c[(Math.random() * c.length) | 0];
    } else if (Math.random() < 0.05) {
      const c = neighbours(i).filter(n => field[n] >= 1 && field[n] <= p.space + 1);
      if (c.length) next = c[(Math.random() * c.length) | 0];
    }
    if (next >= 0) {
      p.x = next % MAP_W; p.y = (next / MAP_W) | 0; dirty.add(p);
      if (lava[next]) p.fallAt = t;
    }
    return;
  }
  if (p.sitting) { // seated in the Q&A room: stay, unless the guide has left it (a reset leaves them seated)
    if (!p.parked && blockRoomAt(st.gx, st.gy) !== QA_ROOM) { standUp(p); p.manualUntil = 0; }
    return;
  }
  if (p.goal >= 0) { // tap-to-move (or walking to a seat)
    const gf = goalField(p.goal), gd = gf[i];
    if (gd === 0 && p.seat >= 0) { // reached the seat: sit down on it
      p.goal = -1; p.sitting = true;
      p.x = p.seat % MAP_W; p.y = (p.seat / MAP_W) | 0; dirty.add(p);
      io.emit('sit', [p.id, 1]);
      return;
    }
    if (gd <= 0) { p.goal = -1; p.seat = -1; p.manualUntil = t + MANUAL_MS; return; }
    const c = neighbours(i).filter(n => gf[n] === gd - 1);
    if (c.length) { const n = c[(Math.random() * c.length) | 0]; p.x = n % MAP_W; p.y = (n / MAP_W) | 0; dirty.add(p); }
    return;
  }
  if (p.parked) { // left where they were by a guide reset; rejoin once the guide comes near
    const d0 = field[i];
    if (d0 >= 0 && d0 <= 8) p.parked = false; else return;
  }
  if (t < p.manualUntil) return; // moved by themselves recently: stay put
  const f = field;
  const d = f[i];
  if (d < 0 || d > 60) { placeNear(p); return; } // stuck or far behind: rejoin the group
  let next = -1;
  if (d > p.space) {
    const c = neighbours(i).filter(n => f[n] === d - 1 && f[n] >= 0);
    if (c.length) next = c[(Math.random() * c.length) | 0];
  } else if (Math.random() < 0.04) {
    const c = neighbours(i).filter(n => f[n] >= 2 && f[n] <= p.space + 1);
    if (c.length) next = c[(Math.random() * c.length) | 0];
  }
  if (next >= 0) { p.x = next % MAP_W; p.y = (next / MAP_W) | 0; dirty.add(p); }
}

// ------------------------------------------------------------------ messages
const metaMsg = () => ({
  unlocked: st.unlocked,
  discovered: st.discovered,
  secret: st.secret,
  secretSeen: st.secretSeen,
  spotlight: st.spotlight,
  puzzle: { open: st.puzzle.open, remaining: Math.max(0, st.puzzle.endsAt - Date.now()), revealed: st.puzzle.revealed, seq: st.puzzle.seq },
});
const playerRow = p => [p.id, p.x, p.y, p.avatar, p.name, p.sitting ? 1 : 0];
const onlineCount = () => { let n = 0; for (const p of players.values()) if (p.connected && !p.bot) n++; return n; };
const snapshot = () => ({ g: [st.gx, st.gy], meta: metaMsg(), players: [...players.values()].map(playerRow), n: onlineCount() });

function applyHostState(s) {
  if (!s || typeof s !== 'object') return;
  let meta = false, walkChanged = false;
  const un = Number(s.unlocked);
  if (Number.isInteger(un) && un >= 0 && un < ROOMS && un !== st.unlocked) { st.unlocked = un; walkChanged = true; }
  const dv = Number(s.discovered);
  if (Number.isInteger(dv) && dv >= 0 && dv < ROOMS && dv !== st.discovered) { st.discovered = dv; walkChanged = true; }
  if (typeof s.secret === 'boolean' && s.secret !== st.secret) { st.secret = s.secret; walkChanged = true; }
  if (typeof s.secretSeen === 'boolean' && s.secretSeen !== st.secretSeen) { st.secretSeen = s.secretSeen; walkChanged = true; }
  if (walkChanged) { rebuildWalk(); goalFields.clear(); fieldDirty = true; meta = true; }
  const x = Number(s.x), y = Number(s.y);
  if (Number.isInteger(x) && Number.isInteger(y) && (x !== st.gx || y !== st.gy) && isWalkable(x, y, st.unlocked, st.secret)) {
    st.gx = x; st.gy = y; fieldDirty = true; guideDirty = true;
  }
  const sp = s.spotlight === null || (typeof s.spotlight === 'string' && EXHIBITS[s.spotlight]) ? s.spotlight : st.spotlight;
  if (sp !== st.spotlight) { st.spotlight = sp; meta = true; }
  const pz = s.puzzle;
  if (pz && typeof pz === 'object') {
    const open = !!pz.open, revealed = !!pz.revealed, seq = Number.isInteger(pz.seq) ? pz.seq : st.puzzle.seq;
    if (seq !== st.puzzle.seq) { // V pressed: (re)start the countdown
      const remaining = Math.max(0, Math.min(120000, Number(pz.remaining) || 0));
      st.puzzle = { open, endsAt: Date.now() + remaining, revealed, seq };
      meta = true;
    } else if (open !== st.puzzle.open || revealed !== st.puzzle.revealed) {
      st.puzzle.open = open; st.puzzle.revealed = revealed;
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
    // only one guide window at a time: the previous one is told to stand down instead of fighting over the guide
    if (hostId && hostId !== socket.id) io.sockets.sockets.get(hostId)?.emit('host:replaced');
    hostId = socket.id;
    applyHostState(msg.state);
    socket.emit('host:ok', snapshot());
  }));

  socket.on('host:state', safe((s) => {
    if (socket.id !== hostId) return;
    applyHostState(s);
  }));

  // guide reset (code 0912) in one message: park visitors first, then apply the new state, then bring the robots
  socket.on('host:reset', safe((state) => {
    if (socket.id !== hostId) return;
    for (const p of players.values()) if (!p.bot) { p.parked = true; p.goal = -1; }
    applyHostState(state);
    refreshField();
    for (const p of players.values()) if (p.bot) { p.fallAt = 0; placeNear(p); }
  }));

  // jumps are cosmetic: just relay them (guide = id 0)
  let lastJump = 0;
  socket.on('host:jump', safe(() => { if (socket.id === hostId) io.emit('j', 0); }));
  socket.on('jump', safe(() => {
    const p = players.get(socket.data.pid), t = Date.now();
    if (!p || t - lastJump < 450) return;
    lastJump = t;
    io.emit('j', p.id);
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
        name, avatar, x: st.gx, y: st.gy, space: 2 + ((Math.random() * 4) | 0), nextAt: 0, seat: -1, sitting: false, parked: false,
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
    standUp(p); p.parked = false;
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
    standUp(p); p.parked = false;
    p.goal = y * MAP_W + x;
    p.manualUntil = t + MANUAL_MS;
  }));

  // sit on a free bench / sofa seat in the Q&A room (walk next to it first)
  socket.on('sit', safe((pos) => {
    const p = players.get(socket.data.pid);
    if (!p || !Array.isArray(pos)) return;
    const [x, y] = pos;
    if (!Number.isInteger(x) || !Number.isInteger(y)) return;
    const k = y * MAP_W + x;
    if (!seats.has(k) || !(QA_ROOM <= st.discovered)) return;
    for (const q of players.values()) if (q !== p && q.seat === k) return; // taken
    const adj = NB.map(o => k + o).filter(n => n >= 0 && n < N && walk[n]);
    if (!adj.length) return;
    standUp(p); p.parked = false;
    const here = p.y * MAP_W + p.x;
    p.seat = k;
    p.goal = adj.sort((a, b) => Math.abs(a - here) - Math.abs(b - here))[0];
    p.manualUntil = Infinity;
  }));


  socket.on('react', safe((idx) => {
    const p = players.get(socket.data.pid);
    const t = Date.now();
    if (!p || !Number.isInteger(idx) || idx < 0 || idx > 5 || t - lastReact < 1000) return;
    lastReact = t;
    io.emit('r', [p.id, idx]);
  }));

  socket.on('disconnect', safe(() => {
    if (socket.id === hostId) hostId = null;
    const p = players.get(socket.data.pid);
    if (p && p.socketId === socket.id) { p.connected = false; p.goneAt = Date.now(); }
  }));
});

// ------------------------------------------------------------------ robot dummy agents
for (let k = 1; k <= BOTS; k++) {
  const p = {
    id: nextId++, sessionId: 'bot-' + k, socketId: null, connected: true, goneAt: 0, bot: true,
    name: BOT_NAMES[k - 1].name, avatar: 10, x: st.gx, y: st.gy, space: 1 + (k % 3), nextAt: 0,
    goal: -1, manualUntil: 0, lastStep: 0, lastGoto: 0, fallAt: 0, seat: -1, sitting: false, parked: false,
  };
  placeNear(p);
  players.set(p.id, p);
  bySession.set(p.sessionId, p);
}

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
  const t = Date.now();
  for (const p of players.values()) {
    if (!p.bot && !p.connected && t - p.goneAt > 60000) {
      players.delete(p.id); bySession.delete(p.sessionId); dirty.delete(p);
      io.emit('pleave', p.id);
    }
  }
}), 2000);

server.listen(PORT, () => {
  console.log(`museum on http://localhost:${PORT}/`);
  console.log(`guide:   http://localhost:${PORT}/?host=${HOST_TOKEN}`);
  console.log(`solo:    http://localhost:${PORT}/?solo=1`);
});
