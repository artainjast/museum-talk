import { MAP_W, MAP_H, rooms, areas, doors, exhibits, props, ducks, tileAt, roomAt, doorRoomAt, passageAt, areaAt, blockRoomAt, isWalkable, exDist, SECRET_ROOM } from './map.js';
import { UI, EXTRA, AVATARS, AVATAR_SPRITES, REACTIONS, ROOM_TITLES, EXHIBITS, PUZZLE, HELP_KEYS, BOT_LINES, BOT_NAMES } from './content.js';

// ---------------------------------------------------------------- utils
const T = 32;               // world px per tile
const STEP_MS = 120;        // guide step repeat
const TW = 64, TH = 32, WALL_TALL = 104, WALL_SHORT = 12; // isometric tile + wall heights (world px)
const isoPt = (x, y) => [(x - y) * TW / 2, (x + y) * TH / 2];
const PUZZLE_MS = PUZZLE.seconds * 1000;
const nf = new Intl.NumberFormat('fa-IR');
const fa = n => nf.format(n);
const fmt = (s, o) => s.replace(/\{(\w+)\}/g, (_, k) => o[k]);
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const now = () => performance.now();

// ---------------------------------------------------------------- role
// /?solo=1 (or no Socket.IO script) -> local guide only; /?host=TOKEN -> guide synced to server; else visitor.
const params = new URLSearchParams(location.search);
const hasIO = typeof window.io === 'function';
const role = (params.get('solo') === '1' || !hasIO) ? 'solo' : params.has('host') ? 'host' : 'visitor';
const isGuide = role !== 'visitor';
const ISO = params.get('flat') !== '1'; // isometric by default, /?flat=1 for top-down
document.body.classList.add(role);

// ---------------------------------------------------------------- state
const S = {
  guide: { x: rooms[0].spawn.x, y: rooms[0].spawn.y, rx: 0, ry: 0, face: 1 },
  unlocked: 0,
  discovered: 0, // highest main room the guide has walked into (fog of war)
  secret: false, secretSeen: false, // hidden door in room 4 open / guide has been inside the secret hall
  spotlight: null,
  puzzle: { open: false, endsAt: 0, revealed: false, seq: 0 }, // room 3 overlay; endsAt in performance.now() ms
  players: new Map(),  // visitor avatars (phase B)
  me: null,
  room: -1,
};

if (isGuide) {
  const saved = store.get('museum.guide');
  if (saved && Number.isInteger(saved.x) && Number.isInteger(saved.unlocked) && isWalkable(saved.x, saved.y, saved.unlocked, saved.secret) && tileAt(saved.x, saved.y) !== 'L') {
    S.guide.x = saved.x; S.guide.y = saved.y; S.unlocked = saved.unlocked;
    S.discovered = Number.isInteger(saved.discovered) ? Math.min(saved.discovered, saved.unlocked) : 0;
    S.secret = !!saved.secret; S.secretSeen = !!saved.secretSeen;
  }
}
S.guide.rx = S.guide.x; S.guide.ry = S.guide.y;
const FOG_MAX = .62;   // undiscovered rooms are shadowed, not black
const PREV_LIGHT = .45; // rooms the guide already left are dimmer than the current one
const roomSeen = i => (i === SECRET_ROOM ? S.secretSeen : i <= S.discovered);
const light = rooms.map(r => (roomSeen(r.i) ? 1 : 0));
const saveGuide = () => store.set('museum.guide', { x: S.guide.x, y: S.guide.y, unlocked: S.unlocked, discovered: S.discovered, secret: S.secret, secretSeen: S.secretSeen });

// ---------------------------------------------------------------- sprites
// Single-frame sprites, plus optional walk sheets: 5 cols (idle + 4 walk frames) x 3 rows (down, up, side-right), 128px cells.
const SPR = {}, SHEET = {};
const loadImg = src => { const img = new Image(); img.onload = () => { img.ok = true; }; img.src = src; return img; };
for (const name of [...AVATAR_SPRITES, 'guide']) {
  SPR[name] = loadImg(`/sprites/${name}.png`);
  SHEET[name] = loadImg(`/sprites/${name}_walk.png`);
}
// Facing from a step: dir 0 = down, 1 = up, 2 = side (face: 1 right, -1 left).
function setFacing(a, dx, dy) {
  if (dx) { a.dir = 2; a.face = dx > 0 ? 1 : -1; }
  else if (dy) a.dir = dy > 0 ? 0 : 1;
  // isometric: +x = screen down-right, +y = down-left, -x = up-left, -y = up-right
  if (dx || dy) { a.isoRow = (dx > 0 || dy > 0) ? 0 : 1; a.isoFlip = dy > 0 || dx < 0; }
}
const AV_COLORS = ['#8e7cc3', '#4a7bd0', '#1f9e8f', '#d64545', '#d04f9a', '#5aa04a', '#5bb3e0', '#2f7a3f', '#e0735b', '#334'];

// ---------------------------------------------------------------- canvas
const ground = $('ground'), actors = $('actors'), world = $('world');
const gctx = ground.getContext('2d'), actx = actors.getContext('2d');
let vw = 0, vh = 0, dpr = 1, zoom = 2, zoomOut = false;
const cam = { x: 0, y: 0, init: false };

function computeZoom() {
  if (ISO) {
    const zr = rooms[Math.max(0, S.room)];
    if (zoomOut) zoom = Math.min(vw / ((zr.w + zr.h) * TW / 2 + 60), vh / ((zr.w + zr.h) * TH / 2 + 160));
    else zoom = Math.min(Math.max(vw, vh) / 1000, Math.min(vw, vh) / 440);
  } else if (zoomOut) zoom = Math.min(vw / ((rooms[Math.max(0, S.room)].w + 1) * T), vh / ((rooms[Math.max(0, S.room)].h + 1) * T));
  else zoom = Math.min(Math.max(vw, vh) / (20 * T), Math.min(vw, vh) / (9 * T));
}
function resize() {
  vw = innerWidth; vh = innerHeight; dpr = Math.min(devicePixelRatio || 1, 2);
  for (const c of [ground, actors]) {
    c.width = Math.round(vw * dpr); c.height = Math.round(vh * dpr);
    c.style.width = vw + 'px'; c.style.height = vh + 'px';
  }
  computeZoom();
}
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- world text (HTML, positioned in world px)
const worldTexts = [];
function addWorldText(room, x, y, w, h, cls, html, id) {
  const d = document.createElement('div');
  d.className = 'wt ' + cls;
  if (id) d.id = id;
  if (ISO) {
    const [cx, cy] = isoPt(x + w / 2, y + h / 2);
    Object.assign(d.style, { left: cx - w * T / 2 + 'px', top: cy - h * T / 2 + 'px', width: w * T + 'px', height: h * T + 'px' });
  } else {
    Object.assign(d.style, { left: x * T + 'px', top: y * T + 'px', width: w * T + 'px', height: h * T + 'px' });
  }
  d.innerHTML = html;
  world.appendChild(d);
  worldTexts.push({ el: d, room });
  return d;
}
{
  const r0 = rooms[0], r6 = rooms[6], sign = EXHIBITS['lobby.sign'];
  addWorldText(0, r0.x0 + 3, r0.y0 + 2, 16, 3, 'wt-title', `${esc(sign.title)}<small dir="ltr">${esc(sign.sub)}</small>`);
  addWorldText(6, r6.x0 + 1, r6.y0 + 3, 18, 3, 'wt-quote', esc(EXHIBITS['r6.quote'].text));
  const r7 = rooms[7];
  addWorldText(7, r7.x0 + 4, r7.y0 + 12, 18, 2, 'wt-qa', esc(EXHIBITS['r7.qa'].text));
}

// ---------------------------------------------------------------- drawing
const FLOOR = ['#efe8dc', '#e8e3ef', '#e3ebe4', '#f1e6e1', '#efe9d6', '#e3eaf0', '#ece5f0', '#d8d0c4'];
const hash = (x, y) => (((x * 73856093) ^ (y * 19349663)) >>> 0);

const FLOOR_TINT = { ',': '#b5434a', ':': '#bf9465', ';': '#86c070' }; // carpet, wood, grass
function floorColor(x, y) {
  let t = tileAt(x, y);
  if (t !== '.' && t !== 'S' && t !== '=' && !FLOOR_TINT[t]) { const a = areaAt(x, y); if (a >= 0) t = areas[a].floor; }
  if (FLOOR_TINT[t]) return FLOOR_TINT[t];
  const r = roomAt(x, y), dr = doorRoomAt(x, y);
  return FLOOR[r >= 0 ? r : dr >= 0 ? dr : Math.max(0, blockRoomAt(x, y))];
}
// Secret passages look like wall until this viewer walks through one.
const foundPass = new Set(store.get('museum.passages') || []);
const passageOpen = (x, y) => foundPass.has(passageAt(x, y));
const looksLikeWall = (x, y) => { const c = tileAt(x, y); return c === '#' || isHiddenDoor(x, y) || (c === 'f' && !passageOpen(x, y)); };

function setWorldTransform(ctx, canvas) {
  const s = zoom * dpr;
  ctx.setTransform(s, 0, 0, s, Math.round(canvas.width / 2 - cam.x * s), Math.round(canvas.height / 2 - cam.y * s));
}

function visibleRange() {
  const hw = vw / 2 / zoom, hh = vh / 2 / zoom;
  return {
    x0: Math.max(0, Math.floor((cam.x - hw) / T) - 1), x1: Math.min(MAP_W - 1, Math.ceil((cam.x + hw) / T) + 1),
    y0: Math.max(0, Math.floor((cam.y - hh) / T) - 1), y1: Math.min(MAP_H - 1, Math.ceil((cam.y + hh) / T) + 2),
  };
}

// Clickable exhibits: polygons (world px) recorded while drawing, so a tap opens what you see.
const hitAreas = new Map(); // exhibit id -> [[x, y], ...]
const seatHits = new Map(); // tile index -> polygon (Q&A benches & sofas)
const QA_ROOM = 7;
function inPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function exhibitAt(sx, sy) {
  const wx = (sx - vw / 2) / zoom + cam.x, wy = (sy - vh / 2) / zoom + cam.y;
  for (const [id, poly] of hitAreas) if (inPoly(wx, wy, poly)) return id;
  return null;
}
const exById = new Map(exhibits.map(e => [e.id, e]));
const eggPropId = new Map(exhibits.filter(e => e.prop).map(e => [e.y0 * MAP_W + e.x0, e.id]));

function drawGround(nearId) {
  hitAreas.clear(); seatHits.clear();
  const c = gctx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, ground.width, ground.height);
  setWorldTransform(c, ground);
  const v = visibleRange();
  for (let y = v.y0; y <= v.y1; y++) for (let x = v.x0; x <= v.x1; x++) {
    const t = looksLikeWall(x, y) ? '#' : tileAt(x, y);
    if (t === ' ') continue;
    const px = x * T, py = y * T;
    if (t === 'L') { c.fillStyle = `hsl(${18 + 10 * Math.sin(performance.now() / 600 + x + y)}, 100%, 52%)`; c.fillRect(px, py, T + .5, T + .5); continue; }
    if (t === '#') {
      c.fillStyle = '#3a3350'; c.fillRect(px, py, T + .5, T + .5);
      const below = tileAt(x, y + 1);
      if (below !== '#' && below !== ' ') {
        c.fillStyle = '#28233a'; c.fillRect(px, py + T * .42, T + .5, T * .58 + .5);
        c.fillStyle = '#5a5078'; c.fillRect(px, py + T * .38, T + .5, 3);
      }
      continue;
    }
    c.fillStyle = floorColor(x, y); c.fillRect(px, py, T + .5, T + .5);
    if ((x + y) & 1) { c.fillStyle = 'rgba(0,0,0,.035)'; c.fillRect(px, py, T + .5, T + .5); }
    const h = hash(x, y);
    if (h % 5 === 0) {
      c.strokeStyle = 'rgba(120,105,90,.16)'; c.lineWidth = 1; c.beginPath();
      c.moveTo(px, py + (h >> 3) % T); c.quadraticCurveTo(px + T / 2, py + (h >> 9) % T, px + T, py + (h >> 15) % T); c.stroke();
    }
    if (t === '=') { c.fillStyle = 'rgba(110,80,50,.16)'; c.fillRect(px, py, T + .5, T + .5); }
    else if (FLAT_PROP[t]) {
      c.font = `${T * .7}px ${EMOJI_FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(FLAT_PROP[t], px + T / 2, py + T / 2);
      const egg = eggPropId.get(y * MAP_W + x);
      if (egg) hitAreas.set(egg, [[px, py], [px + T, py], [px + T, py + T], [px, py + T]]);
    }
  }
  // exhibits
  for (const e of exhibits) {
    if (e.x1 < v.x0 || e.x0 > v.x1 || e.y1 < v.y0 - 1 || e.y0 > v.y1) continue;
    if (!e.prop) drawFrame(c, e, e.id === nearId);
  }
  // velvet ropes on locked doors
  // fog of war over rooms the guide hasn't discovered yet
  for (const a of areas) {
    if (light[a.room] > .995) continue;
    c.fillStyle = `rgba(11,10,16,${(1 - light[a.room]) * FOG_MAX})`;
    c.fillRect(a.ox * T, a.oy * T, a.w * T + .5, a.h * T + .5);
  }
  for (const d of doors) if (!d.open && d.room > S.unlocked && d.room !== SECRET_ROOM) drawRope(c, d);
}

function drawFrame(c, e, glow) {
  const onWall = e.wall;
  const left = e.x0 * T + 3, right = (e.x1 + 1) * T - 3;
  const top = onWall ? e.y0 * T - T * .5 : e.y0 * T + 1;
  const bot = onWall ? (e.y1 + 1) * T - 4 : (e.y1 + 1) * T - 8;
  const w = right - left, h = bot - top;
  hitAreas.set(e.id, [[left, top], [right, top], [right, bot], [left, bot]]);
  if (!onWall) { c.fillStyle = '#4a2a12'; c.fillRect(left + 5, bot - 2, 3, 9); c.fillRect(right - 8, bot - 2, 3, 9); }
  c.fillStyle = 'rgba(0,0,0,.18)'; c.fillRect(left + 2, top + 4, w, h);
  c.fillStyle = '#6b3f1d'; c.fillRect(left, top, w, h);
  c.fillStyle = '#b07a3e'; c.fillRect(left + 2, top + 2, w - 4, h - 4);
  c.fillStyle = '#fbf6ea'; c.fillRect(left + 5, top + 5, w - 10, h - 10);
  const icon = EXHIBITS[e.id]?.icon || '🖼️';
  const fs = Math.min(w, h) * .55;
  c.font = `${fs}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(icon, (left + right) / 2, (top + bot) / 2 + 1);
  if (glow) {
    c.strokeStyle = '#ffcf33'; c.lineWidth = 3;
    c.strokeRect(left - 3, top - 3, w + 6, h + 6);
  }
}

function drawRope(c, d) {
  const post = (x, y) => {
    c.fillStyle = 'rgba(0,0,0,.25)'; c.beginPath(); c.ellipse(x, y + 4, 6, 3, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#c99a2e'; c.beginPath(); c.arc(x, y, 5, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#ffe08a'; c.beginPath(); c.arc(x - 1.5, y - 1.5, 2, 0, Math.PI * 2); c.fill();
  };
  c.strokeStyle = '#a3122a'; c.lineWidth = 5; c.lineCap = 'round';
  c.beginPath();
  if (d.vertical) {
    const x = (d.x0 + d.x1 + 1) / 2 * T, y0 = d.y0 * T + 6, y1 = (d.y1 + 1) * T - 6;
    c.moveTo(x, y0); c.quadraticCurveTo(x + 10, (y0 + y1) / 2, x, y1); c.stroke();
    post(x, y0); post(x, y1);
  } else {
    const y = (d.y0 + d.y1 + 1) / 2 * T, x0 = d.x0 * T + 6, x1 = (d.x1 + 1) * T - 6;
    c.moveTo(x0, y); c.quadraticCurveTo((x0 + x1) / 2, y + 12, x1, y); c.stroke();
    post(x0, y); post(x1, y);
  }
}

const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
const SPR_D = T * 1.8, GUIDE_D = T * 2.1;

function drawActor(c, a, t, opts) {
  const cx = a.rx * T + T / 2, feet = a.ry * T + T * .86 - jumpZ(a, t) * .6;
  const moving = Math.abs(a.rx - a.x) + Math.abs(a.ry - a.y) > .04;
  const bob = moving ? Math.abs(Math.sin(t / 70)) * 3 : 0;
  c.fillStyle = 'rgba(0,0,0,.22)';
  c.beginPath(); c.ellipse(cx, feet, T * .34, T * .12, 0, 0, Math.PI * 2); c.fill();
  if (opts.me) {
    c.strokeStyle = '#19d3f0'; c.lineWidth = 3;
    c.beginPath(); c.ellipse(cx, feet, T * .52 + Math.sin(t / 250) * 2, T * .2, 0, 0, Math.PI * 2); c.stroke();
  }
  const sname = opts.guide ? 'guide' : AVATAR_SPRITES[a.avatar];
  const img = SPR[sname], sheet = SHEET[sname];
  const D = opts.guide ? GUIDE_D : SPR_D;
  let headY;
  if (sheet && sheet.ok) {
    const row = a.dir || 0;
    const col = moving ? 1 + (Math.floor(t / 120 + (a.phase || 0)) % 4) : 0;
    c.save();
    if (row === 2 && a.face < 0) { c.translate(cx, 0); c.scale(-1, 1); c.translate(-cx, 0); }
    c.drawImage(sheet, col * 128, row * 128, 128, 128, cx - D / 2, feet - D * (124 / 128), D, D);
    c.restore();
    headY = feet - D * (opts.guide ? .93 : .78);
  } else if (img && img.ok) {
    c.save();
    if (a.face < 0) { c.translate(cx, 0); c.scale(-1, 1); c.translate(-cx, 0); }
    c.drawImage(img, cx - D / 2, feet - D * (124 / 128) - bob, D, D);
    c.restore();
    headY = feet - D * (opts.guide ? .93 : .78) - bob;
  } else {
    const r = opts.guide ? T * .55 : T * .42;
    const cy = feet - r - 2 - bob;
    c.fillStyle = opts.guide ? '#f2b61f' : AV_COLORS[a.avatar % AV_COLORS.length];
    c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fill();
    c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = 2; c.stroke();
    c.font = `${r * 1.15}px ${EMOJI_FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(opts.guide ? '🚩' : AVATARS[a.avatar], cx, cy + 1);
    headY = cy - r;
  }
  if (opts.label) drawLabel(c, opts.label, cx, headY - 8, opts.guide);
  if (a.react && a.react.until > t) drawReaction(c, a.react, cx, headY - (opts.label ? 30 : 8), t);
}

function drawLabel(c, text, x, y, gold) {
  c.font = `700 ${gold ? 13 : 11}px Vazirmatn, Tahoma, sans-serif`;
  c.direction = 'rtl'; c.textAlign = 'center'; c.textBaseline = 'middle';
  const w = c.measureText(text).width + 12, h = gold ? 20 : 17;
  c.fillStyle = gold ? 'rgba(242,182,31,.95)' : 'rgba(20,18,28,.72)';
  roundRect(c, x - w / 2, y - h / 2, w, h, h / 2); c.fill();
  c.fillStyle = gold ? '#1e1a2b' : '#fff';
  c.fillText(text, x, y + 1);
  c.direction = 'ltr';
}

function drawReaction(c, r, x, y, t) {
  const age = t - (r.until - 2000);
  const s = Math.min(1, age / 150), a = Math.min(1, (r.until - t) / 300);
  c.globalAlpha = a;
  c.fillStyle = '#fff';
  roundRect(c, x - 15 * s, y - 30 * s, 30 * s, 28 * s, 9 * s); c.fill();
  c.font = `${20 * s}px ${EMOJI_FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(r.e, x, y - 16 * s);
  c.globalAlpha = 1;
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}

function drawActors(t) {
  const c = actx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, actors.width, actors.height);
  setWorldTransform(c, actors);
  const v = visibleRange();
  const list = [];
  const me = S.me != null ? S.players.get(S.me) : null;
  for (const p of S.players.values()) {
    if (p.rx < v.x0 - 1 || p.rx > v.x1 + 1 || p.ry < v.y0 - 1 || p.ry > v.y1 + 1) continue;
    list.push(p);
  }
  list.push(S.guide);
  list.sort((a, b) => a.ry - b.ry);
  if (tapMark && tapMark.until > t) {
    const k = (tapMark.until - t) / 900;
    c.strokeStyle = `rgba(25,211,240,${k})`; c.lineWidth = 3;
    c.beginPath(); c.ellipse((tapMark.x + .5) * T, (tapMark.y + .6) * T, T * (.5 - k * .2), T * (.22 - k * .08), 0, 0, Math.PI * 2); c.stroke();
  }
  for (const a of list) {
    if (a === S.guide) { drawActor(c, a, t, { guide: true, label: UI.guide }); continue; }
    const isMe = a === me;
    let label = null;
    if (!isGuide && me && (isMe || Math.max(Math.abs(a.x - me.x), Math.abs(a.y - me.y)) <= 3)) label = a.name;
    drawActor(c, a, t, { me: isMe, label });
  }
}

// ---------------------------------------------------------------- isometric renderer (default; /?flat=1 = top-down)
const lowered = areas.map(() => 0);        // per room block: 1 = back walls lowered (block is in front of the focus room)
const EX_IMG = {};                          // exhibit pictures: /art/ex/<id>.webp (emoji fallback if missing)
for (const e of exhibits) EX_IMG[e.id] = loadImg(`/art/ex/${e.id}.webp`);

function isoTileOnScreen(x, y, pad) {
  const [px, py] = isoPt(x + .5, y + .5);
  const hw = vw / 2 / zoom + pad, hh = vh / 2 / zoom + pad;
  return Math.abs(px - cam.x) < hw && Math.abs(py - cam.y) < hh;
}
function diamond(c, x, y, lift = 0) {
  const [nx, ny] = isoPt(x, y), [ex, ey] = isoPt(x + 1, y), [sx, sy] = isoPt(x + 1, y + 1), [wx, wy] = isoPt(x, y + 1);
  c.beginPath(); c.moveTo(nx, ny - lift); c.lineTo(ex, ey - lift); c.lineTo(sx, sy - lift); c.lineTo(wx, wy - lift); c.closePath();
}
function quad(c, pts) { c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < 4; i++) c.lineTo(pts[i][0], pts[i][1]); c.closePath(); }

// The secret room's door looks like plain wall until it is unlocked (Konami code or N from room 6).
const isHiddenDoor = (x, y) => tileAt(x, y) === '=' && doorRoomAt(x, y) === SECRET_ROOM && !S.secret;
const FLAT_PROP = { o: '⚪', n: '🪑', p: '🪴', k: '💻', d: '🦆', m: '🫖', c: '☕', r: '🗄️', R: '🖥️', z: '🔴', j: '💡', e: '⛲', T: '🏆', U: '🥇', V: '🎖️', v: '🥤', y: '🧯', i: '🐠', g: '🪞', D: '🏺', K: '📚', M: '🎤', s: '🛋️' };
const LAVA_DEPTH = 14;   // how far below the floor a falling actor is clipped
const ABYSS_DEPTH = 90;  // visible cliff height of the abyss walls

const shadeCache = new Map();
function shade(hex, f) {
  const key = hex + f;
  let v = shadeCache.get(key);
  if (!v) {
    const n = parseInt(hex.slice(1), 16);
    const ch = k => Math.max(0, Math.min(255, Math.round(((n >> k) & 255) * f)));
    v = `rgb(${ch(16)},${ch(8)},${ch(0)})`;
    shadeCache.set(key, v);
  }
  return v;
}
let curFog = 0; // darkness overlay applied to every voxel face drawn while set
function fogFill(c, a) { if (a > .005) { c.fillStyle = `rgba(9,9,20,${a})`; c.fill(); } }
// Voxel box on tile (x,y): footprint [u0,u1] x [v0,v1] in tile units, from height z0 to z1 (world px).
function vbox(c, x, y, u0, v0, u1, v1, z0, z1, col) {
  const [ax, ay] = isoPt(x + u0, y + v1), [bx, by] = isoPt(x + u1, y + v1), [qx, qy] = isoPt(x + u1, y + v0), [dx, dy] = isoPt(x + u0, y + v0);
  quad(c, [[ax, ay - z0], [bx, by - z0], [bx, by - z1], [ax, ay - z1]]); c.fillStyle = shade(col, .8); c.fill(); fogFill(c, curFog);
  quad(c, [[bx, by - z0], [qx, qy - z0], [qx, qy - z1], [bx, by - z1]]); c.fillStyle = shade(col, .62); c.fill(); fogFill(c, curFog);
  quad(c, [[dx, dy - z1], [qx, qy - z1], [bx, by - z1], [ax, ay - z1]]); c.fillStyle = col; c.fill(); fogFill(c, curFog);
}
function steam(c, x, y, z, t) {
  const [sx, sy] = isoPt(x + .5, y + .5);
  c.fillStyle = '#ffffff';
  for (let i = 0; i < 3; i++) {
    const ph = (t / 1100 + i / 3) % 1;
    c.globalAlpha = .55 * (1 - ph);
    c.beginPath(); c.arc(sx + Math.sin(ph * 6 + i) * 3, sy - z - ph * 22, 2.5 + ph * 4, 0, Math.PI * 2); c.fill();
  }
  c.globalAlpha = 1;
}
const eggProps = new Set(exhibits.filter(e => e.prop).map(e => e.y0 * MAP_W + e.x0));
function drawProp(c, p, t) {
  const { x, y } = p;
  switch (p.kind) {
    case 'pillar':
      vbox(c, x, y, .14, .14, .86, .86, 0, 7, '#e6dfcf'); vbox(c, x, y, .27, .27, .73, .73, 7, 56, '#f1ebdf'); vbox(c, x, y, .14, .14, .86, .86, 56, 64, '#e6dfcf'); break;
    case 'bench':
      vbox(c, x, y, .1, .3, .2, .7, 0, 9, '#5b3a1c'); vbox(c, x, y, .8, .3, .9, .7, 0, 9, '#5b3a1c'); vbox(c, x, y, .04, .27, .96, .73, 9, 14, '#a06a36'); break;
    case 'plant':
      vbox(c, x, y, .3, .3, .7, .7, 0, 15, '#c0643b'); vbox(c, x, y, .2, .2, .8, .8, 15, 30, '#3f9a4a'); vbox(c, x, y, .32, .32, .68, .68, 30, 42, '#5cc06a'); vbox(c, x, y, .42, .42, .58, .58, 42, 48, '#7ad487'); break;
    case 'desk':
      vbox(c, x, y, .08, .08, .18, .18, 0, 17, '#5b3a1c'); vbox(c, x, y, .82, .82, .92, .92, 0, 17, '#5b3a1c');
      vbox(c, x, y, .02, .02, .98, .98, 17, 21, '#a8763f'); vbox(c, x, y, .28, .4, .72, .7, 21, 23, '#2b2b33'); vbox(c, x, y, .28, .32, .72, .38, 23, 36, '#4fa3ff'); break;
    case 'duck': {
      const b = Math.abs(Math.sin(t / 380)) * 2;
      vbox(c, x, y, .3, .34, .7, .66, b, b + 10, '#ffd23f'); vbox(c, x, y, .36, .36, .58, .56, b + 10, b + 19, '#ffd23f'); vbox(c, x, y, .58, .42, .7, .5, b + 13, b + 16, '#ff8c1a'); break;
    }
    case 'samovar':
      vbox(c, x, y, .24, .24, .76, .76, 0, 6, '#7a5526'); vbox(c, x, y, .28, .28, .72, .72, 6, 30, '#d9b45a'); vbox(c, x, y, .36, .36, .64, .64, 30, 35, '#b8933f'); vbox(c, x, y, .38, .38, .62, .62, 35, 44, '#2f6fb0'); steam(c, x, y, 50, t); break;
    case 'coffee':
      vbox(c, x, y, .2, .22, .8, .78, 0, 34, '#3a3a44'); vbox(c, x, y, .24, .26, .76, .74, 34, 37, '#5a5a66'); vbox(c, x, y, .42, .66, .58, .8, 6, 13, '#f4f1ea'); steam(c, x, y + .2, 20, t); break;
    case 'rack': { // server rack with blinking LEDs
      vbox(c, x, y, .12, .12, .88, .88, 0, 70, '#25262e');
      const [sx, sy] = isoPt(x + .5, y + .88);
      for (let i = 0; i < 6; i++) {
        const on = (Math.floor(t / (180 + i * 37) + x * 3 + i) % 3) !== 0;
        c.fillStyle = on ? (i % 3 === 0 ? '#ff5d5d' : '#4dff88') : '#1a3a24';
        c.fillRect(sx - 14 + (i % 2) * 8, sy - 60 + i * 9, 4, 3);
      }
      break;
    }
    case 'button': // the big red Friday-deploy button on a pedestal
      vbox(c, x, y, .3, .3, .7, .7, 0, 24, '#5a5a66'); vbox(c, x, y, .36, .36, .64, .64, 24, 30, '#e02424');
      if (Math.floor(t / 500) % 2) { const [sx, sy] = isoPt(x + .5, y + .5); c.fillStyle = 'rgba(255,60,60,.35)'; c.beginPath(); c.arc(sx, sy - 30, 12, 0, Math.PI * 2); c.fill(); }
      break;
    case 'switch':
      vbox(c, x, y, .4, .4, .6, .6, 0, 30, '#6b6370'); vbox(c, x, y, .32, .32, .68, .68, 30, 40, lightsOn ? '#ffe28a' : '#d8d2c4'); break;
    case 'fountain': {
      vbox(c, x, y, .05, .05, .95, .95, 0, 10, '#cfc8bc'); vbox(c, x, y, .15, .15, .85, .85, 8, 11, '#4aa8e8'); vbox(c, x, y, .42, .42, .58, .58, 10, 30, '#cfc8bc');
      const [sx, sy] = isoPt(x + .5, y + .5);
      c.fillStyle = 'rgba(160,215,255,.75)';
      for (let i = 0; i < 4; i++) { const ph = (t / 600 + i / 4) % 1; c.beginPath(); c.arc(sx + (i - 1.5) * 6 * ph, sy - 32 + ph * 20 - Math.sin(ph * Math.PI) * 10, 2.2, 0, Math.PI * 2); c.fill(); }
      break;
    }
    case 'trophy': {
      const col = p.ch === 'T' ? '#f2b61f' : p.ch === 'U' ? '#d9d9e3' : '#cd7f32';
      vbox(c, x, y, .25, .25, .75, .75, 0, 18, '#3b3350'); vbox(c, x, y, .36, .36, .64, .64, 18, 24, col); vbox(c, x, y, .3, .3, .7, .7, 24, 38, col); break;
    }
    case 'vending':
      vbox(c, x, y, .12, .18, .88, .82, 0, 64, '#c0392b'); vbox(c, x, y, .22, .76, .78, .84, 14, 56, '#9ad4ff'); break;
    case 'extinguisher':
      vbox(c, x, y, .38, .38, .62, .62, 0, 28, '#d62828'); vbox(c, x, y, .44, .44, .56, .56, 28, 34, '#2b2b33'); break;
    case 'aquarium': {
      vbox(c, x, y, .1, .1, .9, .9, 0, 16, '#3b3350'); vbox(c, x, y, .1, .1, .9, .9, 16, 40, '#5fb8e8');
      const [sx, sy] = isoPt(x + .5, y + .5);
      c.font = `10px ${EMOJI_FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('🐟', sx + Math.sin(t / 900) * 9, sy - 28);
      c.fillText('🐠', sx + Math.cos(t / 1100) * 8, sy - 22);
      break;
    }
    case 'mirror':
      vbox(c, x, y, .1, .4, .9, .6, 0, 6, '#6b3f1d'); vbox(c, x, y, .15, .44, .85, .56, 6, 56, '#cfe7f5'); break;
    case 'case': // glass display case
      vbox(c, x, y, .1, .1, .9, .9, 0, 18, '#6b3f1d'); vbox(c, x, y, .14, .14, .86, .86, 18, 40, '#bfe3f0'); vbox(c, x, y, .4, .4, .6, .6, 18, 28, '#f2b61f'); break;
    case 'mic': // microphone stand on the Q&A stage
      vbox(c, x, y, .35, .35, .65, .65, 0, 3, '#2b2b33'); vbox(c, x, y, .46, .46, .54, .54, 3, 44, '#55555f'); vbox(c, x, y, .4, .4, .6, .6, 44, 52, '#1e1e24'); break;
    case 'sofa':
      vbox(c, x, y, .05, .1, .95, .9, 0, 12, '#7a1fa2'); vbox(c, x, y, .05, .1, .3, .9, 12, 26, '#8e35b8'); break;
    case 'shelf':
      vbox(c, x, y, .02, .3, .98, .7, 0, 50, '#6b3f1d');
      for (let i = 0; i < 3; i++) vbox(c, x, y, .08 + i * .3, .26, .3 + i * .3, .34, 8 + (i % 2) * 18, 20 + (i % 2) * 18, ['#2f6fb0', '#c0392b', '#2e8b57'][i]);
      break;
  }
  if (p.room === QA_ROOM && (p.kind === 'bench' || p.kind === 'sofa')) {
    const [sx, sy] = isoPt(x + .5, y + .5);
    seatHits.set(y * MAP_W + x, [[sx - 30, sy - 24], [sx + 30, sy - 24], [sx + 30, sy + 14], [sx - 30, sy + 14]]);
  }
  if (eggProps.has(y * MAP_W + x)) { // twinkle: this prop has a story
    const [sx, sy] = isoPt(x + .5, y + .5);
    hitAreas.set(eggPropId.get(y * MAP_W + x), [[sx - 28, sy - 60], [sx + 28, sy - 60], [sx + 28, sy + 10], [sx - 28, sy + 10]]);
    c.globalAlpha = .5 + .5 * Math.sin(t / 300 + x);
    c.font = `14px ${EMOJI_FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('✨', sx + 14, sy - 52);
    c.globalAlpha = 1;
  }
}
// 2 AM room: dark, with a lamp-like pool of light around the guide.
function nightAlpha(x, y) {
  if (lightsOn || blockRoomAt(x, y) !== 1) return 0;
  const d = Math.hypot(x - S.guide.rx, y - S.guide.ry);
  return .55 * Math.max(0, Math.min(1, (d - 2) / 4));
}
function bricks(c, a, b, h, odd) {
  const rowH = 9;
  c.beginPath();
  for (let z = rowH; z < h - 3; z += rowH) { c.moveTo(a[0], a[1] - z); c.lineTo(b[0], b[1] - z); }
  for (let z = 0, r = 0; z < h - 3; z += rowH, r++) {
    const top = Math.min(z + rowH, h);
    for (const u of ((r + odd) % 2 ? [.25, .75] : [.5])) {
      const px = a[0] + (b[0] - a[0]) * u, py = a[1] + (b[1] - a[1]) * u;
      c.moveTo(px, py - z); c.lineTo(px, py - top);
    }
  }
  c.strokeStyle = 'rgba(12,8,28,.3)'; c.lineWidth = 1; c.stroke();
}
function drawBubble(c, text, x, y) {
  c.font = '700 12px Vazirmatn, Tahoma, sans-serif';
  c.direction = 'rtl'; c.textAlign = 'center'; c.textBaseline = 'middle';
  const w = c.measureText(text).width + 18, h = 22;
  c.fillStyle = 'rgba(255,255,255,.97)';
  roundRect(c, x - w / 2, y - h, w, h, 9); c.fill();
  c.beginPath(); c.moveTo(x - 5, y - 1); c.lineTo(x, y + 6); c.lineTo(x + 5, y - 1); c.fill();
  c.fillStyle = '#1e1a2b'; c.fillText(text, x, y - h / 2 + 1);
  c.direction = 'ltr';
}
const confetti = [];
const CONF_COLORS = ['#f2b61f', '#ff5d73', '#19d3f0', '#7bd88f', '#b388ff', '#ff8a3d'];
function burst(n = 180) {
  for (let i = 0; i < n; i++) {
    confetti.push({ x: Math.random() * vw, y: -20 - Math.random() * vh * .5, vx: (Math.random() - .5) * 140, vy: 40 + Math.random() * 160,
      r: Math.random() * 6, vr: (Math.random() - .5) * 10, c: CONF_COLORS[i % CONF_COLORS.length], s: 6 + Math.random() * 6 });
  }
}
function drawConfetti(dt) {
  if (!confetti.length) return;
  const c = actx;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (let i = confetti.length - 1; i >= 0; i--) {
    const p = confetti[i];
    p.vy += 160 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.r += p.vr * dt;
    if (p.y > vh + 30) { confetti.splice(i, 1); continue; }
    c.save(); c.translate(p.x, p.y); c.rotate(p.r); c.fillStyle = p.c; c.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); c.restore();
  }
}
let guideSay = null, guideClicks = 0, sitHinted = false;

// ---- easter eggs: toasts, hidden ducks, secret passages, bugs, interactive props (all local to this viewer)
let toastTimer = 0;
function toast(text, ms = 3600) {
  const h = $('hint');
  h.classList.remove('lesson');
  h.textContent = text;
  h.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => h.classList.remove('show'), ms);
}
let lightsOn = false;
const foundDucks = new Set(store.get('museum.ducks') || []);
function updateDuckPill() {
  const el = $('ducks');
  el.hidden = foundDucks.size === 0;
  el.textContent = `🦆 ${fa(foundDucks.size)}/${fa(ducks.length)}`;
}
function drawMiniDuck(c, dk, t) {
  const b = Math.abs(Math.sin(t / 300 + dk.i)) * 2;
  vbox(c, dk.x, dk.y, .38, .4, .62, .6, b, b + 6, '#ffd23f');
  vbox(c, dk.x, dk.y, .42, .42, .56, .54, b + 6, b + 11, '#ffd23f');
  vbox(c, dk.x, dk.y, .56, .45, .63, .5, b + 8, b + 10, '#ff8c1a');
}
function checkEggs(me) { // walking-based discoveries for this viewer's own character
  if (!me) return;
  const pi = passageAt(me.x, me.y);
  if (pi >= 0 && !foundPass.has(pi)) {
    foundPass.add(pi); store.set('museum.passages', [...foundPass]);
    toast(EXTRA.passageFound);
  }
  for (const dk of ducks) {
    if (foundDucks.has(dk.i) || Math.max(Math.abs(dk.x - me.x), Math.abs(dk.y - me.y)) > 1 || !roomSeen(blockRoomAt(dk.x, dk.y))) continue;
    foundDucks.add(dk.i); store.set('museum.ducks', [...foundDucks]);
    updateDuckPill();
    if (foundDucks.size === ducks.length) { burst(); toast(EXTRA.allDucks, 6000); if (!isGuide) react(5); }
    else toast(fmt(EXTRA.duckFound, { n: fa(foundDucks.size), total: fa(ducks.length) }));
  }
}
// bugs crawl around the 2 AM office and the server closet; click to squash
const bugAreas = areas.filter(a => a.name === 'office' || a.name === 'closet');
const bugs = Array.from({ length: 6 }, (_, i) => {
  const a = bugAreas[i % bugAreas.length];
  return { a, x: a.ox + 2 + (i * 3) % (a.w - 4), y: a.oy + 2 + (i * 2) % (a.h - 4), tx: 0, ty: 0, alive: true, i };
});
function moveBugs(dt) {
  for (const bg of bugs) {
    if (!bg.alive) continue;
    const dx = bg.tx - bg.x, dy = bg.ty - bg.y, d = Math.hypot(dx, dy);
    if (d < .1 || !bg.tx) {
      bg.tx = bg.a.ox + 1 + Math.random() * (bg.a.w - 3); bg.ty = bg.a.oy + 1 + Math.random() * (bg.a.h - 3);
      continue;
    }
    const sp = (lightsOn ? 2.4 : .9) * dt;
    bg.x += dx / d * Math.min(sp, d); bg.y += dy / d * Math.min(sp, d);
  }
}
function drawBug(c, bg, t) {
  const [sx, sy] = isoPt(bg.x, bg.y);
  c.font = `13px ${EMOJI_FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText('🐞', sx, sy - 4 + Math.sin(t / 60 + bg.i) * .8);
}
function bugAt(sx, sy) {
  const wx = (sx - vw / 2) / zoom + cam.x, wy = (sy - vh / 2) / zoom + cam.y;
  return bugs.find(bg => bg.alive && Math.hypot(isoPt(bg.x, bg.y)[0] - wx, isoPt(bg.x, bg.y)[1] - 4 - wy) < 14);
}
function squash(bg) {
  bg.alive = false;
  const left = bugs.filter(b => b.alive).length;
  toast(left ? fmt(EXTRA.bugSquash, { n: fa(left + 93) }) : EXTRA.allBugs);
}
const INTERACT = {
  'egg.button': () => {
    document.body.classList.remove('alarm'); void document.body.offsetWidth; document.body.classList.add('alarm');
    setTimeout(() => document.body.classList.remove('alarm'), 2600);
    toast(EXTRA.deploy, 4000);
  },
  'egg.switch': () => { lightsOn = !lightsOn; toast(lightsOn ? EXTRA.lightsOn : EXTRA.lightsOff); },
  'egg.fountain': () => { burst(40); toast(EXTRA.wish); },
  'egg.vending': () => toast(EXTRA.vending),
};
// Jumping: purely visual hop, synced to everyone (guide = id 0).
const JUMP_MS = 520, JUMP_H = 28;
const jumpZ = (a, t) => { const k = a.jumpAt ? (t - a.jumpAt) / JUMP_MS : 1; return k >= 0 && k < 1 ? Math.sin(Math.PI * k) * JUMP_H : 0; };
let lastJumpAt = 0;
function jump() {
  const t = now();
  if (t - lastJumpAt < 450) return;
  lastJumpAt = t;
  if (isGuide) { S.guide.jumpAt = t; if (role === 'host' && sock?.connected) sock.emit('host:jump'); return; }
  const meP = S.me != null ? S.players.get(S.me) : null;
  if (!meP || !sock) return;
  meP.jumpAt = t;
  sock.emit('jump');
}
// Robot agents wear a tiny name sticker in their company's colour (a name badge, not a logo).
const STICKER = new Map(BOT_NAMES.map(b => [b.name, b]));
function drawSticker(c, name, x, y) {
  const st = STICKER.get(name);
  if (!st) return;
  c.font = '800 8px Vazirmatn, system-ui, sans-serif';
  c.direction = 'ltr'; c.textAlign = 'center'; c.textBaseline = 'middle';
  const w = c.measureText(name).width + 7, h = 11;
  c.save();
  c.translate(x, y); c.rotate(-.08);
  c.fillStyle = 'rgba(0,0,0,.25)'; roundRect(c, -w / 2 + 1, -h / 2 + 1, w, h, 3); c.fill();
  c.fillStyle = st.bg; roundRect(c, -w / 2, -h / 2, w, h, 3); c.fill();
  c.strokeStyle = 'rgba(255,255,255,.85)'; c.lineWidth = 1; c.stroke();
  c.fillStyle = st.fg; c.fillText(name, 0, .5);
  c.restore();
}
let lessonTimer = 0;
function showLesson(text) {
  const h = $('hint');
  h.textContent = text;
  h.classList.add('show', 'lesson');
  clearTimeout(lessonTimer);
  lessonTimer = setTimeout(() => h.classList.remove('show', 'lesson'), 6000);
}

function isoGround(now) {
  hitAreas.clear(); seatHits.clear();
  const c = gctx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, ground.width, ground.height);
  setWorldTransform(c, ground);
  c.lineWidth = 1;
  // pass 1: the abyss (a bottomless pit with a faint fire glow far below)
  for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) {
    if (tileAt(x, y) !== 'L' || !isoTileOnScreen(x, y, 40)) continue;
    const h = hash(x, y), w = Math.sin(now / 900 + (h % 100) / 16);
    diamond(c, x, y);
    c.fillStyle = '#07040c'; c.strokeStyle = '#07040c'; c.fill(); c.stroke();
    c.fillStyle = `rgba(255,${80 + 30 * w | 0},25,${.1 + .06 * w})`; c.fill();
    if (h % 7 === 0) { // embers drifting up out of the dark
      const ph = (now / 1700 + (h % 100) / 100) % 1;
      const [bx, by] = isoPt(x + .5, y + .5);
      c.globalAlpha = 1 - ph;
      c.fillStyle = '#ff9a3c'; c.beginPath(); c.arc(bx + Math.sin(ph * 7 + h) * 5, by + 20 - ph * 40, 1.8, 0, Math.PI * 2); c.fill();
      c.globalAlpha = 1;
    }
    const lt = light[blockRoomAt(x, y)] ?? 1;
    if (lt < .995) { diamond(c, x, y); c.fillStyle = c.strokeStyle = `rgba(11,10,16,${(1 - lt) * FOG_MAX})`; c.fill(); c.stroke(); }
  }
  for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) {
    const t = tileAt(x, y);
    if (t === ' ' || t === 'L' || looksLikeWall(x, y)) continue;
    if (!isoTileOnScreen(x, y, 40)) continue;
    // cliff walls where the floor drops into the abyss (rock fading to black)
    if (tileAt(x, y + 1) === 'L' || tileAt(x + 1, y) === 'L') {
      const [ex, ey] = isoPt(x + 1, y), [sx, sy] = isoPt(x + 1, y + 1), [wx, wy] = isoPt(x, y + 1);
      const cliff = (a, b, col) => {
        const g = c.createLinearGradient(0, Math.min(a[1], b[1]), 0, Math.max(a[1], b[1]) + ABYSS_DEPTH);
        g.addColorStop(0, col); g.addColorStop(1, 'rgba(7,4,12,0)');
        quad(c, [a, b, [b[0], b[1] + ABYSS_DEPTH], [a[0], a[1] + ABYSS_DEPTH]]); c.fillStyle = g; c.fill();
        c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.strokeStyle = 'rgba(255,255,255,.12)'; c.lineWidth = 1.5; c.stroke();
      };
      if (tileAt(x, y + 1) === 'L') cliff([wx, wy], [sx, sy], '#4d4150');
      if (tileAt(x + 1, y) === 'L') cliff([sx, sy], [ex, ey], '#372e3c');
    }
    let col = floorColor(x, y);
    diamond(c, x, y);
    c.fillStyle = col; c.strokeStyle = col; c.fill(); c.stroke();
    if ((x + y) & 1) { c.fillStyle = 'rgba(0,0,0,.04)'; c.fill(); }
    if (t === '=') { c.fillStyle = 'rgba(110,80,50,.18)'; c.fill(); }
    const lt = light[blockRoomAt(x, y)] ?? 1;
    if (lt < .995) { c.fillStyle = c.strokeStyle = `rgba(11,10,16,${(1 - lt) * FOG_MAX})`; c.fill(); c.stroke(); }
    const na = nightAlpha(x, y);
    if (na > .01) { c.fillStyle = c.strokeStyle = `rgba(6,10,35,${na})`; c.fill(); c.stroke(); }
  }
  drawLampPools(c, now);
}

// Upright panel standing on the line (xa,ya)->(xb,yb) in tile space, from height z0 to z1 (world px).
function drawPanel(c, xa, ya, xb, yb, z0, z1, id, glow, legs) {
  if (EX_IMG[id] && EX_IMG[id].ok) { // shrink wide spans to a picture-shaped frame, centred
    const [pax, pay] = isoPt(xa, ya), [pbx, pby] = isoPt(xb, yb);
    const L = Math.hypot(pbx - pax, pby - pay), want = (z1 - z0) * 1.12;
    if (L > want) {
      const k = want / L / 2, mx = (xa + xb) / 2, my = (ya + yb) / 2, dx = xb - xa, dy = yb - ya;
      xa = mx - dx * k; xb = mx + dx * k; ya = my - dy * k; yb = my + dy * k;
    }
  }
  const [ax, ay] = isoPt(xa, ya), [bx, by] = isoPt(xb, yb);
  const P = (u, z) => [ax + (bx - ax) * u, ay + (by - ay) * u - z];
  hitAreas.set(id, [P(0, z1), P(1, z1), P(1, z0), P(0, z0)]);
  if (legs) {
    c.strokeStyle = '#4a2a12'; c.lineWidth = 3;
    for (const u of [.15, .85]) { const [lx, ly] = P(u, 0), [tx, ty] = P(u, z0 + 4); c.beginPath(); c.moveTo(lx, ly); c.lineTo(tx, ty); c.stroke(); }
  }
  quad(c, [P(0, z1), P(1, z1), P(1, z0), P(0, z0)]);
  c.fillStyle = '#6b3f1d'; c.fill();
  const bu = 4 / Math.hypot(bx - ax, by - ay), bz = 4, iu = 8 / Math.hypot(bx - ax, by - ay), iz = 7;
  quad(c, [P(bu, z1 - bz), P(1 - bu, z1 - bz), P(1 - bu, z0 + bz), P(bu, z0 + bz)]);
  c.fillStyle = '#b07a3e'; c.fill();
  const u0 = iu, u1 = 1 - iu, zt = z1 - iz, zb = z0 + iz;
  quad(c, [P(u0, zt), P(u1, zt), P(u1, zb), P(u0, zb)]);
  c.fillStyle = '#fbf6ea'; c.fill();
  const [ox, oy] = P(u0, zt), [rx2, ry2] = P(u1, zt);
  const ux = rx2 - ox, uy = ry2 - oy, hh = zt - zb;
  const img = EX_IMG[id];
  c.save();
  c.transform(ux, uy, 0, hh, ox, oy); // unit square -> panel face
  if (img && img.ok) {
    const w = Math.hypot(ux, uy), s = Math.min(1, hh / w); // keep the square picture's aspect
    c.drawImage(img, (1 - s) / 2, 0, s, 1);
  } else {
    c.scale(1 / Math.hypot(ux, uy), 1 / hh);
    const W = Math.hypot(ux, uy), fs = Math.min(W, hh) * .6;
    c.font = `${fs}px ${EMOJI_FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(EXHIBITS[id]?.icon || '🖼️', W / 2, hh / 2 + 1);
  }
  c.restore();
  if (glow) {
    quad(c, [P(-.02, z1 + 3), P(1.02, z1 + 3), P(1.02, z0 - 3), P(-.02, z0 - 3)]);
    c.strokeStyle = '#ffcf33'; c.lineWidth = 3; c.stroke();
  }
}

function drawWall(c, x, y, h, fog, frames, nearId) {
  const [nx, ny] = isoPt(x, y), [ex, ey] = isoPt(x + 1, y), [sx, sy] = isoPt(x + 1, y + 1), [wx, wy] = isoPt(x, y + 1);
  const v = .93 + (hash(x, y) % 8) * .02; // slight per-block tint so walls look built, not flat
  const faces = [
    [[wx, wy], [sx, sy], [sx, sy - h], [wx, wy - h], shade('#3d3756', v)],      // south face (down-left)
    [[sx, sy], [ex, ey], [ex, ey - h], [sx, sy - h], shade('#2c2740', v)],      // east face (down-right)
    [[nx, ny - h], [ex, ey - h], [sx, sy - h], [wx, wy - h], shade('#5c5479', v)], // top
  ];
  for (let i = 0; i < 3; i++) {
    const [a, b, cc, d, col] = faces[i];
    quad(c, [a, b, cc, d]);
    c.fillStyle = col; c.strokeStyle = col; c.lineWidth = 1; c.fill(); c.stroke();
    if (i === 0 && h > 16) bricks(c, a, b, h, (x + y) & 1);
    if (i === 1 && h > 16) bricks(c, a, b, h, (x + y + 1) & 1);
    if (i === 2) { quad(c, [a, b, cc, d]); c.strokeStyle = 'rgba(255,255,255,.08)'; c.stroke(); }
    if (fog > .005) { quad(c, [a, b, cc, d]); c.fillStyle = `rgba(11,10,16,${fog})`; c.fill(); }
  }
  // rounded rim on the exposed top edges (bullnose), so walls read curved instead of sharp
  const wallish = looksLikeWall;
  const openS = !wallish(x, y + 1), openE = !wallish(x + 1, y);
  if (openS || openE) {
    c.lineCap = 'round'; c.lineJoin = 'round';
    c.beginPath();
    if (openS) { c.moveTo(wx, wy - h); c.lineTo(sx, sy - h); }
    if (openE) { if (!openS) c.moveTo(sx, sy - h); c.lineTo(ex, ey - h); }
    c.strokeStyle = shade('#867cab', v); c.lineWidth = 4; c.stroke();
    if (fog > .005) { c.strokeStyle = `rgba(11,10,16,${fog})`; c.stroke(); }
    c.strokeStyle = `rgba(255,255,255,${.22 * (1 - fog)})`; c.lineWidth = 1.2; c.stroke();
    if (openS && openE) { // soft vertical highlight on the outer corner
      c.beginPath(); c.moveTo(sx, sy - h + 2); c.lineTo(sx, sy - 2);
      c.strokeStyle = `rgba(255,255,255,${.1 * (1 - fog)})`; c.lineWidth = 3; c.stroke();
    }
    c.lineCap = 'butt';
  }
  // baseboard on the south face
  if (h > 20) { quad(c, [[wx, wy], [sx, sy], [sx, sy - 4], [wx, wy - 4]]); c.fillStyle = '#251f36'; c.fill(); }
  if (frames && h > 30) {
    // each wall tile paints only its own slice of the frame, so neighbouring wall tiles never cover it
    c.save();
    quad(c, [[wx, wy], [sx, sy], [sx, sy - h - 6], [wx, wy - h - 6]]); c.clip();
    for (const e of frames) drawPanel(c, e.x0 + .08, y + 1, e.x1 + .92, y + 1, h * .14, h * .95, e.id, e.id === nearId, false);
    if (fog > .005) { quad(c, [[wx, wy], [sx, sy], [sx, sy - h], [wx, wy - h]]); c.fillStyle = `rgba(11,10,16,${fog})`; c.fill(); }
    c.restore();
  }
}

function drawIsoRope(c, d) {
  let a, b;
  if (d.vertical) { a = [d.x0 + 1, d.y0 + .15]; b = [d.x0 + 1, d.y1 + .85]; }
  else { a = [d.x0 + .15, d.y0 + 1]; b = [d.x1 + .85, d.y0 + 1]; }
  const [ax, ay] = isoPt(...a), [bx, by] = isoPt(...b);
  const post = (x, y) => {
    c.fillStyle = 'rgba(0,0,0,.25)'; c.beginPath(); c.ellipse(x, y, 7, 3.5, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#a77d22'; c.fillRect(x - 2.5, y - 22, 5, 22);
    c.fillStyle = '#e8c45a'; c.beginPath(); c.arc(x, y - 23, 4.5, 0, Math.PI * 2); c.fill();
  };
  post(ax, ay);
  c.strokeStyle = '#a3122a'; c.lineWidth = 5; c.lineCap = 'round';
  c.beginPath(); c.moveTo(ax, ay - 20); c.quadraticCurveTo((ax + bx) / 2, (ay + by) / 2 - 8, bx, by - 20); c.stroke();
  post(bx, by);
}

// Walls, frames, easels, ropes and actors, depth-sorted on one canvas.
const wallFrames = new Map(); // wall tile index -> exhibits hung on its south face
for (const e of exhibits) {
  if (!e.wall) continue;
  for (let x = e.x0; x <= e.x1; x++) {
    const k = (e.y0 - 1) * MAP_W + x;
    if (!wallFrames.has(k)) wallFrames.set(k, []);
    wallFrames.get(k).push(e);
  }
}
// Wall lamps on the tall back walls (skipping tiles that carry frames).
const lamps = [];
for (const a of areas) {
  for (let x = a.ox + 2; x < a.ox + a.w - 1; x += 5) {
    const y = a.oy, k = y * MAP_W + x;
    if (tileAt(x, y) === '#' && !wallFrames.has(k) && !wallFrames.has(k - 1) && !wallFrames.has(k + 1)) lamps.push({ x, y, face: 'S', room: a.room, area: a.i });
  }
  for (let y = a.oy + 2; y < a.oy + a.h - 1; y += 5) if (tileAt(a.ox, y) === '#') lamps.push({ x: a.ox, y, face: 'E', room: a.room, area: a.i });
}
const lampLevel = (l, t) => (light[l.room] ?? 0) * (l.room === 1 && !lightsOn ? .3 : 1) * (.94 + .06 * Math.sin(t / 140 + l.x * 3 + l.y));
function lampPoint(l, h) {
  const [ex, ey] = isoPt(l.x + 1, l.y), [sx, sy] = isoPt(l.x + 1, l.y + 1), [wx, wy] = isoPt(l.x, l.y + 1);
  const [a, b] = l.face === 'S' ? [[wx, wy], [sx, sy]] : [[sx, sy], [ex, ey]];
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - h * .72];
}
function drawLampPools(c, t) {
  for (const l of lamps) {
    const L = lampLevel(l, t);
    if (L < .03 || !isoTileOnScreen(l.x, l.y, 120)) continue;
    const [px, py] = l.face === 'S' ? isoPt(l.x + .5, l.y + 1.9) : isoPt(l.x + 1.9, l.y + .5);
    c.save(); c.translate(px, py); c.scale(1, .5);
    const g = c.createRadialGradient(0, 0, 4, 0, 0, 78);
    g.addColorStop(0, `rgba(255,214,130,${.2 * L})`); g.addColorStop(1, 'rgba(255,214,130,0)');
    c.fillStyle = g; c.beginPath(); c.arc(0, 0, 78, 0, Math.PI * 2); c.fill();
    c.restore();
  }
}
function drawLamp(c, l, h, t) {
  const [px, py] = lampPoint(l, h), L = lampLevel(l, t);
  if (L > .03) {
    const g = c.createRadialGradient(px, py + 3, 2, px, py + 3, 38);
    g.addColorStop(0, `rgba(255,222,140,${.5 * L})`); g.addColorStop(1, 'rgba(255,222,140,0)');
    c.fillStyle = g; c.beginPath(); c.arc(px, py + 3, 38, 0, Math.PI * 2); c.fill();
  }
  c.fillStyle = '#2a2233'; c.fillRect(px - 1.5, py - 9, 3, 7);                       // bracket
  c.fillStyle = '#b8903f';                                                              // brass shade
  c.beginPath(); c.moveTo(px - 7, py + 1); c.lineTo(px + 7, py + 1); c.lineTo(px + 3.5, py - 4); c.lineTo(px - 3.5, py - 4); c.closePath(); c.fill();
  c.fillStyle = L > .03 ? `rgba(255,246,190,${.35 + .65 * L})` : '#5d5566';             // bulb
  c.beginPath(); c.arc(px, py + 3.5, 3.4, 0, Math.PI * 2); c.fill();
}

function isoScene(t, focusArea) {
  const c = actx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, actors.width, actors.height);
  setWorldTransform(c, actors);
  const kl = 1 - Math.exp(-Math.min(.1, isoDt) * 5);
  const f = focusArea >= 0 ? areas[focusArea] : null;
  for (const a of areas) { // areas entirely in front of the focus area lower their back walls
    const target = f && (a.ox >= f.ox + f.w || a.oy >= f.oy + f.h) ? 1 : 0;
    lowered[a.i] += (target - lowered[a.i]) * kl;
  }
  const items = [];
  for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) {
    if (!looksLikeWall(x, y) || !isoTileOnScreen(x, y, 90)) continue;
    const ai = areaAt(x, y), r = areas[ai], b = r.room;
    const back = y === r.oy || x === r.ox;
    const h = back ? WALL_TALL + (WALL_SHORT - WALL_TALL) * lowered[ai] : WALL_SHORT;
    const fog = 1 - (1 - (1 - (light[b] ?? 1)) * FOG_MAX) * (1 - nightAlpha(x, y));
    // frames hang on the wall tile above an exhibit's first tile; draw them with that tile only
    const fr = wallFrames.get(y * MAP_W + x) && y === r.oy ? wallFrames.get(y * MAP_W + x) : null;
    items.push({ d: x + y + 1, k: 0, draw: () => drawWall(c, x, y, h, fog, fr, nearId) });
  }
  for (const l of lamps) {
    if (!isoTileOnScreen(l.x, l.y, 100)) continue;
    const h = WALL_TALL + (WALL_SHORT - WALL_TALL) * lowered[l.area];
    if (h < 40) continue;
    items.push({ d: l.x + l.y + 2.5, k: 0, draw: () => drawLamp(c, l, h, t) });
  }
  for (const dk of ducks) {
    if (foundDucks.has(dk.i) || !isoTileOnScreen(dk.x, dk.y, 60)) continue;
    const fog = (1 - (light[blockRoomAt(dk.x, dk.y)] ?? 1)) * FOG_MAX;
    items.push({ d: dk.x + dk.y + 1, k: 1, draw: () => { curFog = fog; drawMiniDuck(c, dk, t); curFog = 0; } });
  }
  for (const bg of bugs) {
    if (!bg.alive || !roomSeen(1)) continue;
    items.push({ d: bg.x + bg.y + 1, k: 1, draw: () => drawBug(c, bg, t) });
  }
  for (const pr of props) {
    if (!isoTileOnScreen(pr.x, pr.y, 90)) continue;
    const fog = 1 - (1 - (1 - (light[pr.room] ?? 1)) * FOG_MAX) * (1 - nightAlpha(pr.x, pr.y));
    items.push({ d: pr.x + pr.y + 1, k: 0, draw: () => { curFog = fog; drawProp(c, pr, t); curFog = 0; } });
  }
  for (const e of exhibits) {
    if (e.prop || e.wall) continue; // props draw themselves; wall-mounted frames draw with their wall
    if (!isoTileOnScreen(e.x0, e.y0, 120)) continue;
    const yy = e.y0 + .55;
    items.push({ d: (e.x0 + e.x1 + 1) / 2 + yy + .4, k: 1, draw: () => drawPanel(c, e.x0 + .05, yy, e.x1 + .95, yy, 10, 80, e.id, e.id === nearId, true) });
  }
  for (const d of doors) {
    if (d.open || d.room <= S.unlocked || d.room === SECRET_ROOM) continue;
    items.push({ d: (d.x0 + d.x1 + 1) / 2 + (d.y0 + d.y1 + 1) / 2, k: 1, draw: () => drawIsoRope(c, d) });
  }
  const me = S.me != null ? S.players.get(S.me) : null;
  const labels = [];
  const addActor = (a, opts) => items.push({ d: a.rx + a.ry + 1, k: 2, draw: () => drawIsoActor(c, a, t, opts, labels) });
  for (const p of S.players.values()) {
    if (!isoTileOnScreen(p.rx, p.ry, 80)) continue;
    const isMe = p === me;
    let label = null;
    if (p.avatar !== 10 && !isGuide && me && (isMe || Math.max(Math.abs(p.x - me.x), Math.abs(p.y - me.y)) <= 3)) label = p.name;
    addActor(p, { me: isMe, label });
  }
  addActor(S.guide, { guide: true, label: UI.guide });
  items.sort((a, b) => a.d - b.d || a.k - b.k);
  if (tapMark && tapMark.until > t) {
    const k = (tapMark.until - t) / 900;
    const [mx, my] = isoPt(tapMark.x + .5, tapMark.y + .5);
    c.strokeStyle = `rgba(25,211,240,${k})`; c.lineWidth = 3;
    c.beginPath(); c.ellipse(mx, my, TW * (.42 - k * .15), TH * (.42 - k * .15), 0, 0, Math.PI * 2); c.stroke();
  }
  for (const it of items) it.draw();
  for (const l of labels) l();
}
let isoDt = 0;

const ISO_D = 76, ISO_GUIDE_D = 86;
function drawIsoActor(c, a, t, opts, labels) {
  const [cx, feet0] = isoPt(a.rx + .5, a.ry + .5);
  const moving = !a.sit && Math.abs(a.rx - a.x) + Math.abs(a.ry - a.y) > .04;
  // abyss: fall down past the edge and vanish into the dark
  if (tileAt(a.x, a.y) === 'L') { if (!a.lavaAt) a.lavaAt = t; } else a.lavaAt = 0;
  const sink = a.lavaAt ? Math.min(1, (t - a.lavaAt) / 1100) : 0;
  const Dsz = opts.guide ? ISO_GUIDE_D : ISO_D;
  const jz = jumpZ(a, t);
  const seated = a.sit && !sink;
  const feet = feet0 + (sink ? sink * sink * 150 : 0) - jz + (seated ? 10 : 0);
  if (sink) {
    if (sink < .6) labels.push(() => {
      c.globalAlpha = 1 - sink / .6;
      c.font = `22px ${EMOJI_FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('😱', cx, feet0 - Dsz - 6);
      c.globalAlpha = 1;
    });
    c.save();
    c.beginPath(); c.rect(cx - Dsz, feet0 + 6 - Dsz * 2, Dsz * 2, Dsz * 2); c.clip();
    c.globalAlpha = 1 - sink * .7;
  }
  if (seated) { c.save(); c.beginPath(); c.rect(cx - Dsz, feet0 - 13 - Dsz * 2, Dsz * 2, Dsz * 2); c.clip(); }
  c.fillStyle = 'rgba(0,0,0,.22)';
  if (!sink && !a.sit) { const sh = 1 - jz / (JUMP_H * 2.2); c.beginPath(); c.ellipse(cx, feet0, TW * .26 * sh, TH * .26 * sh, 0, 0, Math.PI * 2); c.fill(); }
  if (opts.me) {
    c.strokeStyle = '#19d3f0'; c.lineWidth = 3;
    c.beginPath(); c.ellipse(cx, feet0, TW * .36 + Math.sin(t / 250) * 2, TH * .36 + Math.sin(t / 250), 0, 0, Math.PI * 2); c.stroke();
  }
  const sname = opts.guide ? 'guide' : AVATAR_SPRITES[a.avatar];
  const img = SPR[sname], sheet = SHEET[sname];
  const D = opts.guide ? ISO_GUIDE_D : ISO_D;
  const flip = a.isoFlip;
  let headY;
  const bob = moving ? Math.abs(Math.sin(t / 70)) * 3 : 0;
  c.save();
  if (flip) { c.translate(cx, 0); c.scale(-1, 1); c.translate(-cx, 0); }
  if (sheet && sheet.ok) {
    const col = moving ? 1 + (Math.floor(t / 120 + (a.phase || 0)) % 4) : 0;
    c.drawImage(sheet, col * 128, (a.isoRow || 0) * 128, 128, 128, cx - D / 2, feet - D * (124 / 128), D, D);
    headY = feet - D * (opts.guide ? .93 : .78);
  } else if (img && img.ok) {
    c.drawImage(img, cx - D / 2, feet - D * (124 / 128) - bob, D, D);
    headY = feet - D * (opts.guide ? .93 : .78) - bob;
  } else {
    const r = opts.guide ? 20 : 15, cy = feet - r - 2 - bob;
    c.fillStyle = opts.guide ? '#f2b61f' : AV_COLORS[a.avatar % AV_COLORS.length];
    c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fill();
    c.font = `${r * 1.15}px ${EMOJI_FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(opts.guide ? '🚩' : AVATARS[a.avatar], cx, cy + 1);
    headY = cy - r;
  }
  c.restore();
  if (seated) c.restore();
  if (a.avatar === 10 && !sink) drawSticker(c, a.name, cx, feet - Dsz * .34);
  if (sink) { c.globalAlpha = 1; c.restore(); return; }
  if (opts.label) labels.push(() => drawLabel(c, opts.label, cx, headY - 8, opts.guide));
  if (a.react && a.react.until > t) labels.push(() => drawReaction(c, a.react, cx, headY - (opts.label ? 30 : 8), t));
  if (a.avatar === 10 && !a.react?.until) { // robot agents mumble agent clichés now and then
    const ph = t / 1000 + a.id * 2.3, cyc = Math.floor(ph / 9);
    if (ph % 9 < 3.2 && (cyc + a.id) % 2 === 0) labels.push(() => drawBubble(c, BOT_LINES[(cyc * 3 + a.id) % BOT_LINES.length], cx, headY - (opts.label ? 32 : 10)));
  }
  if (opts.guide && guideSay && guideSay.until > t) labels.push(() => drawBubble(c, guideSay.text, cx, headY - 32));
}

// screen px -> tile
function screenToTile(sx, sy) {
  const wx = (sx - vw / 2) / zoom + cam.x, wy = (sy - vh / 2) / zoom + cam.y;
  if (!ISO) return [Math.floor(wx / T), Math.floor(wy / T)];
  const a = wx / (TW / 2), b = wy / (TH / 2);
  return [Math.floor((a + b) / 2), Math.floor((b - a) / 2)];
}

// ---------------------------------------------------------------- overlays
function exhibitHTML(id, big) {
  const e = EXHIBITS[id];
  if (!e) return '';
  let h = EX_IMG[id] && EX_IMG[id].ok ? `<img class="ex-img" src="/art/ex/${id}.webp" alt="">` : `<div class="ex-icon">${e.icon}</div>`;
  if (e.title) h += `<h2>${esc(e.title)}</h2>`;
  if (e.sub) h += `<p class="sub" dir="ltr">${esc(e.sub)}</p>`;
  const text = isGuide && e.textGuide ? e.textGuide : e.text;
  if (text) h += `<p class="text${id === 'r6.quote' ? ' quote' : ''}">${esc(text)}</p>`;
  if (e.chart) {
    const max = Math.max(...e.chart.bars.map(b => b[1]));
    h += `<div class="chart"><p class="cap">${esc(e.chart.caption)}</p>` + e.chart.bars.map(([l, v]) =>
      `<div class="row"><span class="lbl">${esc(l)}</span><div class="track"><div class="fill" style="width:${v / max * 100}%"></div></div><span class="val"><bdi dir="ltr">+${fa(v)}</bdi></span></div>`).join('') + '</div>';
  }
  if (e.list) h += `<ul>${e.list.map(li => `<li>${esc(li)}</li>`).join('')}</ul>`;
  if (e.tech) h += `<p class="line"><b>${EXTRA.tech}</b>${esc(e.tech)}</p><p class="line"><b>${EXTRA.life}</b>${esc(e.life)}</p>`;
  if (e.first) {
    h += `<div class="brief-first">${esc(e.first)}</div><div class="slots">${e.slots.map(s => `<div class="slot"><span>${esc(s)}</span></div>`).join('')}</div><p class="after">${esc(e.after)}</p>`;
  }
  if (e.caption) h += `<p class="caption">${esc(e.caption)}</p>`;
  if (e.source) h += `<p class="source" dir="ltr">${esc(e.source)}</p>`;
  return h;
}

function showBanner(r) {
  const b = $('banner');
  b.textContent = r === SECRET_ROOM ? '🕳️ ' + ROOM_TITLES[r] : fmt(UI.roomBanner, { n: fa(r), title: ROOM_TITLES[r] });
  b.classList.remove('show'); void b.offsetWidth; b.classList.add('show');
}

let nearId = null;
function nearestExhibit(x, y) {
  let best = null, bd = 99, be = 1e9;
  for (const e of exhibits) {
    const d = exDist(e, x, y);
    if (d > 2) continue;
    const eu = Math.hypot((e.x0 + e.x1) / 2 - x, (e.y0 + e.y1) / 2 - y);
    if (d < bd || (d === bd && eu < be)) { best = e; bd = d; be = eu; }
  }
  return best;
}
function nearestInRoom() {
  const g = S.guide, r = roomAt(g.x, g.y) >= 0 ? roomAt(g.x, g.y) : S.room;
  let best = null, bd = 1e9;
  for (const e of exhibits) {
    if (e.room !== r || e.egg) continue;
    const d = exDist(e, g.x, g.y) + Math.hypot((e.x0 + e.x1) / 2 - g.x, (e.y0 + e.y1) / 2 - g.y) * .01;
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}
function updatePlaque(t) {
  const meP = S.me != null ? S.players.get(S.me) : null;
  const f = (meP && t < manualUntil) ? meP : S.guide;
  const e = nearestExhibit(f.x, f.y);
  const id = e ? e.id : null;
  if (id === nearId) return;
  nearId = id;
  const p = $('plaque');
  if (!id) { p.hidden = true; return; }
  const ex = EXHIBITS[id];
  p.innerHTML = `<span class="pi">${ex.icon}</span><span class="pt">${esc(ex.title || (isGuide && ex.textGuide) || ex.text)}</span>` + (isGuide ? '<kbd>E</kbd>' : '');
  p.hidden = false;
}
$('plaque').addEventListener('click', () => nearId && openCard(nearId));

let cardId = null;
function openCard(id) { cardId = id; $('cardBody').innerHTML = exhibitHTML(id, false); $('card').hidden = false; }
function closeCard() { cardId = null; $('card').hidden = true; }

let spotDismissed = null; // visitors can close the spotlight locally
function renderSpot() {
  const show = S.spotlight && S.spotlight !== spotDismissed;
  $('spot').hidden = !show;
  if (show && $('spotBody').dataset.id !== S.spotlight) {
    $('spotBody').innerHTML = exhibitHTML(S.spotlight, true);
    $('spotBody').dataset.id = S.spotlight;
  }
  if (!show) $('spotBody').dataset.id = '';
}

function toggleHelp(force) {
  const h = $('help');
  h.hidden = force !== undefined ? !force : !h.hidden;
  if (!h.hidden && !h.dataset.ready) {
    $('helpBody').innerHTML = `<table>${HELP_KEYS.map(([k, d]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(d)}</td></tr>`).join('')}</table>`;
    h.dataset.ready = 1;
  }
}

for (const el of document.querySelectorAll('[data-close]')) {
  el.addEventListener('click', () => closeOverlay(el.dataset.close));
}
for (const m of document.querySelectorAll('.modal')) {
  m.addEventListener('click', ev => { if (ev.target === m) closeOverlay(m.id); });
}
function closeOverlay(which) {
  if (which === 'card') closeCard();
  else if (which === 'help') toggleHelp(false);
  else if (which === 'spot') {
    if (isGuide) setSpotlight(null);
    else { spotDismissed = S.spotlight; renderSpot(); }
  }
}

// ---------------------------------------------------------------- room 3 puzzle: "is it really done?"
const PAIR = { 1: '۱', 2: '۲' };
function pzMarkup(line) { // `code` -> LTR monospace; [[n:...]] -> contradiction highlight n
  return esc(line)
    .replace(/`([^`]+)`/g, '<bdi dir="ltr" class="code">$1</bdi>')
    .replace(/\[\[(\d):(.+?)\]\]/g, (_, n, inner) => `<mark class="ct" data-n="${PAIR[n] || n}">${inner}</mark>`);
}
function setupPuzzle() {
  const el = $('puzzle');
  el.querySelector('.pz-intro').textContent = PUZZLE.intro;
  el.querySelector('.pz-body').innerHTML = PUZZLE.report.map((l, i) => {
    const cls = i === 0 ? 'pz-done' : l.startsWith('`') || l.startsWith('[[2:`') ? 'pz-file' : l.startsWith('-') ? 'pz-item' : 'pz-line';
    return `<div class="${cls}">${pzMarkup(l)}</div>`;
  }).join('');
  el.querySelector('.pz-answers').innerHTML = PUZZLE.answers.map(a => `<p>${pzMarkup(a)}</p>`).join('') +
    `<p class="pz-moral"><b>${esc(PUZZLE.moral)}</b></p>`;
}
setupPuzzle();
let pzKey = '';
function renderPuzzle(t) {
  const pz = S.puzzle, el = $('puzzle');
  el.hidden = !pz.open;
  document.body.classList.toggle('puzzle', pz.open);
  if (!pz.open) { pzKey = ''; return; }
  const left = Math.max(0, Math.ceil((pz.endsAt - t) / 1000));
  const key = `${left}|${pz.revealed}`;
  if (key === pzKey) return;
  pzKey = key;
  const timer = el.querySelector('.pz-timer');
  timer.textContent = left > 0 ? '⏱ ' + fa(left) : PUZZLE.timeUp;
  timer.classList.toggle('done', left === 0);
  timer.hidden = pz.revealed;
  el.classList.toggle('revealed', pz.revealed);
  el.querySelector('.pz-answers').hidden = !pz.revealed;
}

// ---------------------------------------------------------------- guide actions
let sock = null;
const hostState = () => ({
  x: S.guide.x, y: S.guide.y, unlocked: S.unlocked, discovered: S.discovered, secret: S.secret, secretSeen: S.secretSeen, spotlight: S.spotlight,
  puzzle: { open: S.puzzle.open, remaining: Math.max(0, Math.round(S.puzzle.endsAt - now())), revealed: S.puzzle.revealed, seq: S.puzzle.seq },
});
let replaced = false; // another guide window took over: this one stops steering
function hostSend() {
  if (role === 'host' && !replaced && sock && sock.connected) sock.emit('host:state', hostState());
}

function moveGuide(dx, dy) {
  const g = S.guide;
  if (g.fallAt) return; // sinking in lava
  setFacing(g, dx, dy);
  const nx = g.x + dx, ny = g.y + dy;
  if (!isWalkable(nx, ny, S.unlocked, S.secret)) return;
  g.x = nx; g.y = ny;
  if (tileAt(nx, ny) === 'L') g.fallAt = now();
  saveGuide();
  hostSend('move');
}
function teleport(i) {
  if (!rooms[i]) return;
  const e = rooms[i].entry;
  if (i === SECRET_ROOM) { S.secret = true; S.unlocked = Math.max(S.unlocked, 4); }
  else S.unlocked = Math.max(S.unlocked, i);
  S.guide.x = S.guide.rx = e.x; S.guide.y = S.guide.ry = e.y;
  saveGuide();
  hostSend('move'); hostSend('unlock');
}
function setUnlocked(n) {
  S.unlocked = Math.max(0, Math.min(SECRET_ROOM - 1, n)); // N/B walk the main rooms; the secret door has its own switch
  const gr = roomAt(S.guide.x, S.guide.y);
  S.discovered = Math.max(Math.min(S.discovered, S.unlocked), gr < SECRET_ROOM ? gr : 0);
  saveGuide();
  hostSend('unlock');
}
// Join overlay: QR code + link to the public visitor page (server knows the public URL).
async function toggleJoin() {
  const el = $('joinQR');
  if (!el.hidden) { el.hidden = true; return; }
  el.querySelector('.jq-title').textContent = EXTRA.joinTitle;
  try {
    const { url } = await fetch('/join.json', { cache: 'no-store' }).then(r => r.json());
    el.querySelector('.jq-url').textContent = url;
    el.querySelector('img').src = '/qr.svg?t=' + Date.now();
  } catch { el.querySelector('.jq-url').textContent = location.origin + '/'; }
  el.hidden = false;
}
function setSecret(on) {
  S.secret = on;
  if (!on && S.room !== SECRET_ROOM) S.secretSeen = false;
  saveGuide();
  hostSend();
}
function setSpotlight(id) {
  S.spotlight = id;
  spotDismissed = null;
  renderSpot();
  hostSend('spotlight');
}
function setPuzzle(v) {
  S.puzzle = { ...S.puzzle, ...v };
  hostSend('puzzle');
}
// Local easter-egg progress (ducks, passages, bugs, lights) back to the start.
function clearEggs() {
  foundDucks.clear(); store.set('museum.ducks', []);
  foundPass.clear(); store.set('museum.passages', []);
  for (const bg of bugs) bg.alive = true;
  lightsOn = false;
  updateDuckPill();
}
// Code 0910: the whole game back to the start — tour state, everyone (visitors + robots) in the lobby, eggs hidden again.
function gameReset() {
  fullReset(true);
  clearEggs();
  if (role === 'host' && !replaced && sock?.connected) sock.emit('host:resetAll', hostState());
  toast(EXTRA.gameReset, 4000);
}
// Code 0912: guide back to the lobby, tour state reset; robots follow, visitors stay where they are.
function fullReset(localOnly) {
  S.puzzle = { ...S.puzzle, open: false, revealed: false };
  S.spotlight = null; spotDismissed = null; renderSpot();
  S.unlocked = 0; S.discovered = 0; S.secret = false; S.secretSeen = false;
  const sp = rooms[0].spawn;
  Object.assign(S.guide, { x: sp.x, y: sp.y, rx: sp.x, ry: sp.y, fallAt: 0, lavaAt: 0 });
  saveGuide();
  if (localOnly) return;
  if (role === 'host' && !replaced && sock?.connected) sock.emit('host:reset', hostState()); // one atomic message
  toast(EXTRA.resetDone, 4000);
}
let codeBuf = '', codeAt = 0;
function guideCode(digit) { // typed digit codes (guide only)
  const t = now();
  codeBuf = (t - codeAt > 3000 ? '' : codeBuf) + digit;
  codeAt = t;
  if (codeBuf.endsWith('0912')) { codeBuf = ''; fullReset(); }
  else if (codeBuf.endsWith('0910')) { codeBuf = ''; gameReset(); }
}
function resetAll() {
  setPuzzle({ open: false, revealed: false });
  setSpotlight(null);
  S.unlocked = 0;
  S.discovered = 0;
  S.secret = false; S.secretSeen = false;
  teleport(0);
  setUnlocked(0);
}

// ---------------------------------------------------------------- input
const DIRS = {
  ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1],
  ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0],
};
let held = [];
let nextStep = 0;

const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'KeyB', 'KeyA'];
let konamiPos = 0;
// Returns true when the key was eaten by the code (its final B and A), so they don't re-lock / walk.
function konamiStep(code) {
  if (code === KONAMI[konamiPos]) konamiPos++;
  else { konamiPos = code === KONAMI[0] ? 1 : 0; return false; }
  if (konamiPos === KONAMI.length) { konamiPos = 0; onKonami(); return true; }
  return konamiPos > 8;
}
function onKonami() {
  burst();
  if (isGuide) { if (S.unlocked >= 4 && !S.secret) setSecret(true); }
  else if (joined) react(5);
}

addEventListener('keydown', ev => {
  const code = ev.code;
  if (ev.target instanceof HTMLInputElement) return;
  if (code.startsWith('Arrow') || code === 'Space') ev.preventDefault();
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (!ev.repeat && konamiStep(code)) { ev.preventDefault(); return; }
  if (isGuide) {
    if (DIRS[code]) {
      if (!ev.repeat && !held.includes(code)) {
        held.push(code);
        if (!S.spotlight) { const [dx, dy] = DIRS[code]; moveGuide(dx, dy); }
        nextStep = now() + STEP_MS * 1.6; // short delay before auto-repeat
      }
      return;
    }
    if (ev.repeat) return;
    const t = now();
    switch (code) {
      case 'KeyZ': zoomOut = !zoomOut; computeZoom(); break;
      case 'KeyN': setUnlocked(S.unlocked + 1); break;
      case 'KeyB': setUnlocked(S.unlocked - 1); break;
      case 'KeyE': if (cardId) closeCard(); else if (nearId) openCard(nearId); break;
      case 'Enter': case 'NumpadEnter': {
        ev.preventDefault();
        const e = nearestInRoom();
        if (e) setSpotlight(S.spotlight === e.id ? null : e.id);
        break;
      }
      case 'Escape':
        if (!$('joinQR').hidden) $('joinQR').hidden = true;
        else if (cardId) closeCard();
        else if (!$('help').hidden) toggleHelp(false);
        else if (S.spotlight) setSpotlight(null);
        else if (S.puzzle.open) setPuzzle({ open: false });
        break;
      case 'KeyV': // open the puzzle for everyone (restarts the countdown)
        setPuzzle({ open: true, endsAt: t + PUZZLE_MS, revealed: false, seq: S.puzzle.seq + 1 });
        break;
      case 'KeyR':
        if (S.puzzle.open && !S.puzzle.revealed) setPuzzle({ revealed: true });
        break;
      case 'KeyK': toggleHelp(); break;
      case 'KeyO': setSecret(!S.secret); break;
      case 'KeyJ': toggleJoin(); break;
      case 'Space': jump(); break;
      case 'Home': if (ev.shiftKey) fullReset(); break;
      default:
        if (ev.shiftKey && /^Digit[0-8]$/.test(code)) teleport(Number(code[5]));
        else if (/^(?:Digit|Numpad)[0-9]$/.test(code)) guideCode(code.slice(-1));
    }
  } else {
    if (DIRS[code]) {
      if (!ev.repeat && !held.includes(code) && joined) {
        held.push(code);
        visitorStep(...DIRS[code]);
        nextStep = now() + STEP_MS * 1.6;
      }
      return;
    }
    if (ev.repeat) return;
    const m = /^(?:Digit|Numpad)([1-5])$/.exec(code);
    if (m && joined) react(Number(m[1]) - 1);
    else if (code === 'KeyZ') { zoomOut = !zoomOut; computeZoom(); }
    else if (code === 'Space') jump();
    else if (code === 'Escape') { if (cardId) closeCard(); else if (S.spotlight) closeOverlay('spot'); }
  }
});

// ---------------------------------------------------------------- networking (phase B)
let joined = false, lastReactAt = 0, metaSeen = false;
let manualUntil = 0, tapMark = null;
const MANUAL_MS = 8000; // must match server: after this idle time the avatar follows the guide again
function visitorStep(dx, dy) {
  if (!sock || !joined) return;
  manualUntil = now() + MANUAL_MS;
  sock.emit('step', [dx, dy]);
}
function visitorGoto(x, y) {
  if (!sock || !joined) return;
  manualUntil = now() + MANUAL_MS + 4000;
  tapMark = { x, y, until: now() + 900 };
  sock.emit('goto', [x, y]);
}
const SESSION_KEY = 'museum.session';
let session = store.get(SESSION_KEY);

function setOnline(n) {
  const el = $('online');
  el.textContent = fmt(UI.online, { n: fa(n) });
  el.hidden = role === 'solo';
}
function upsertPlayer([id, x, y, avatar, name, sit]) {
  const old = S.players.get(id);
  if (old) Object.assign(old, { avatar, name, sit: !!sit });
  else S.players.set(id, { id, x, y, rx: x, ry: y, avatar, name, sit: !!sit, face: 1, dir: 0, phase: Math.random() * 4, react: null });
}
function applyMeta(m) {
  if (role === 'visitor') {
    if (m.secret && !S.secret && metaSeen) burst();
    metaSeen = true;
    S.unlocked = m.unlocked;
    S.secret = !!m.secret; S.secretSeen = !!m.secretSeen;
    S.discovered = m.discovered ?? S.discovered;
    if (m.spotlight !== S.spotlight) { S.spotlight = m.spotlight; spotDismissed = null; renderSpot(); }
    const pz = m.puzzle;
    if (pz) S.puzzle = { open: !!pz.open, endsAt: now() + pz.remaining, revealed: !!pz.revealed, seq: pz.seq };
  }
}
function applySnap(m) {
  S.players.clear();
  for (const row of m.players) upsertPlayer(row);
  if (role === 'visitor') { S.guide.x = S.guide.rx = m.g[0]; S.guide.y = S.guide.ry = m.g[1]; cam.init = false; }
  applyMeta(m.meta);
  for (const rm of rooms) light[rm.i] = roomSeen(rm.i) ? PREV_LIGHT : 0;
  setOnline(m.n);
}
function react(i) {
  const t = now();
  if (!sock || t - lastReactAt < 1000) return;
  lastReactAt = t;
  sock.emit('react', i);
}
const newSessionId = () => 's' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);

function sendJoin() { if (sock && sock.connected && joined) sock.emit('join', session); }

function setupJoin() {
  $('joinTitle').textContent = EXHIBITS['lobby.sign'].title;
  $('avatarLabel').textContent = UI.avatarLabel;
  $('nameLabel').textContent = UI.nameLabel;
  $('joinBtn').textContent = UI.join;
  let avatar = session && Number.isInteger(session.avatar) ? session.avatar : (Math.random() * 10) | 0;
  const box = $('avatars');
  AVATARS.slice(0, 10).forEach((e, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.i = i;
    const img = new Image();
    img.alt = e;
    img.src = `/sprites/${AVATAR_SPRITES[i]}.png`;
    img.onerror = () => { b.textContent = e; };
    b.appendChild(img);
    b.addEventListener('click', () => { avatar = i; for (const x of box.children) x.classList.toggle('on', x === b); });
    if (i === avatar) b.classList.add('on');
    box.appendChild(b);
  });
  if (session?.name) $('nameInput').value = session.name;
  $('join').addEventListener('submit', ev => {
    ev.preventDefault();
    session = { sessionId: session?.sessionId || newSessionId(), name: $('nameInput').value.trim().slice(0, 16), avatar };
    store.set(SESSION_KEY, session);
    $('join').hidden = true;
    startVisitor();
  });
  $('join').hidden = false;
}

const TOUCH = matchMedia('(pointer: coarse)').matches;
let joyDir = null, joyNext = 0;
function setupJoystick() {
  const joy = $('joy'), knob = joy.firstElementChild;
  const move = e => {
    const r = joy.getBoundingClientRect();
    let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy), max = r.width * .34;
    if (d > max) { dx *= max / d; dy *= max / d; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    if (d < 12) { joyDir = null; return; }
    let gx = 0, gy = 0;
    if (ISO) { // screen direction -> isometric grid axis
      const a = dx + 2 * dy, b = 2 * dy - dx;
      if (Math.abs(a) > Math.abs(b)) gx = Math.sign(a); else gy = Math.sign(b);
    } else if (Math.abs(dx) > Math.abs(dy)) gx = Math.sign(dx); else gy = Math.sign(dy);
    const key = gx + ',' + gy;
    if (!joyDir || joyDir.key !== key) { joyDir = { dx: gx, dy: gy, key }; visitorStep(gx, gy); joyNext = now() + STEP_MS * 1.4; }
  };
  const end = () => { joyDir = null; knob.style.transform = ''; };
  joy.addEventListener('pointerdown', e => { joy.setPointerCapture(e.pointerId); move(e); });
  joy.addEventListener('pointermove', e => { if (joy.hasPointerCapture(e.pointerId)) move(e); });
  joy.addEventListener('pointerup', end);
  joy.addEventListener('pointercancel', end);
  $('jumpBtn').addEventListener('pointerdown', e => { e.preventDefault(); jump(); });
  joy.hidden = false; $('jumpBtn').hidden = false;
  document.body.classList.add('touch');
}

function startVisitor() {
  joined = true;
  $('bar').hidden = false;
  if (TOUCH) setupJoystick();
  sendJoin();
  const h = $('hint');
  h.textContent = EXTRA.moveHint;
  h.classList.add('show');
  setTimeout(() => h.classList.remove('show'), 9000);
}
const openableAt = (sx, sy) => {
  const id = exhibitAt(sx, sy);
  return id && roomSeen(exById.get(id).room) ? id : null;
};
$('stage').addEventListener('pointermove', ev => {
  if (ev.pointerType === 'mouse') $('stage').style.cursor = openableAt(ev.clientX, ev.clientY) ? 'pointer' : '';
});
$('stage').addEventListener('pointerup', ev => {
  if (role === 'visitor' && joined && roomSeen(QA_ROOM)) { // tap a Q&A bench / sofa to sit on it
    const wx = (ev.clientX - vw / 2) / zoom + cam.x, wy = (ev.clientY - vh / 2) / zoom + cam.y;
    for (const [k, poly] of seatHits) if (inPoly(wx, wy, poly)) { sock.emit('sit', [k % MAP_W, Math.floor(k / MAP_W)]); manualUntil = now() + 60000; return; }
  }
  const bg = ISO && roomSeen(1) ? bugAt(ev.clientX, ev.clientY) : null;
  if (bg) { squash(bg); return; }
  const exId = openableAt(ev.clientX, ev.clientY);
  if (exId) { if (INTERACT[exId]) INTERACT[exId](); else openCard(exId); return; } // everyone can open what they see
  if (role !== 'visitor' || !joined) return;
  // easter egg: poke the guide 5 times
  const [gx, gy] = ISO ? isoPt(S.guide.rx + .5, S.guide.ry + .5) : [(S.guide.rx + .5) * T, (S.guide.ry + .86) * T];
  const gsx = (gx - cam.x) * zoom + vw / 2, gsy = (gy - cam.y) * zoom + vh / 2, gd = (ISO ? ISO_GUIDE_D : GUIDE_D) * zoom;
  if (Math.abs(ev.clientX - gsx) < gd * .3 && ev.clientY < gsy + 6 && ev.clientY > gsy - gd * .95) {
    if (++guideClicks >= 5) { guideClicks = 0; guideSay = { text: EXTRA.guideEgg, until: now() + 3500 }; }
    return;
  }
  const [x, y] = screenToTile(ev.clientX, ev.clientY);
  if (isWalkable(x, y, S.unlocked, S.secret) && tileAt(x, y) !== 'L' && roomSeen(blockRoomAt(x, y))) visitorGoto(x, y);
});

function setupBar() {
  REACTIONS.slice(0, 5).forEach((e, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = e;
    b.addEventListener('click', () => react(i));
    $('reacts').appendChild(b);
  });
}

if (role !== 'solo') {
  sock = window.io({ reconnectionDelayMax: 4000 });
  let everConnected = false;
  const rc = $('reconnect');
  rc.textContent = UI.reconnecting;
  setTimeout(() => { if (!sock.connected) rc.hidden = false; }, 2500);

  sock.on('connect', () => {
    everConnected = true;
    rc.hidden = true;
    if (role === 'host') { if (!replaced) sock.emit('host:hello', { token: params.get('host'), state: hostState() }); }
    else sendJoin();
  });
  sock.on('disconnect', () => { rc.hidden = false; });
  sock.on('host:denied', () => { rc.textContent = 'HOST TOKEN ✗'; rc.hidden = false; });
  sock.on('host:replaced', () => { replaced = true; rc.textContent = EXTRA.hostReplaced; rc.hidden = false; });
  sock.on('host:ok', m => { applySnap(m); });
  sock.on('welcome', m => {
    S.me = m.me;
    session = { ...session, sessionId: m.sessionId, name: m.name };
    store.set(SESSION_KEY, session);
    applySnap(m);
  });
  sock.on('snap', applySnap);
  sock.on('meta', applyMeta);
  sock.on('pjoin', upsertPlayer);
  sock.on('gameReset', () => {
    if (isGuide) return; // the guide already reset itself
    clearEggs(); closeCard(); manualUntil = 0; spotDismissed = null;
    toast(EXTRA.gameReset, 4000);
  });
  sock.on('sit', ([id, v]) => { const p = S.players.get(id); if (p) { p.sit = !!v; p.isoRow = 0; p.isoFlip = false; } });
  sock.on('j', id => {
    if (id === 0) { if (role === 'visitor') S.guide.jumpAt = now(); return; }
    const p = S.players.get(id);
    if (p && !(id === S.me && now() - (p.jumpAt || 0) < 400)) p.jumpAt = now();
  });
  sock.on('pleave', id => { S.players.delete(id); });
  sock.on('r', ([id, i]) => {
    const p = S.players.get(id);
    if (p) p.react = { e: REACTIONS[i], until: now() + 2000 };
  });
  sock.on('t', m => {
    if (m.g && role === 'visitor') {
      const [x, y] = m.g;
      setFacing(S.guide, Math.sign(x - S.guide.x), Math.sign(y - S.guide.y));
      S.guide.x = x; S.guide.y = y;
    }
    if (m.p) {
      for (let i = 0; i < m.p.length; i += 3) {
        const p = S.players.get(m.p[i]);
        if (!p) continue;
        const x = m.p[i + 1], y = m.p[i + 2];
        setFacing(p, Math.sign(x - p.x), Math.sign(y - p.y));
        p.x = x; p.y = y;
      }
    }
    if (m.n !== undefined) setOnline(m.n);
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && sock.connected) {
      if (role === 'host') hostSend();
      sock.emit('sync');
    }
  });

  if (role === 'visitor') {
    setupBar();
    if (session?.sessionId) startVisitor();
    else setupJoin();
  }
}
addEventListener('keyup', ev => { held = held.filter(c => c !== ev.code); });
addEventListener('blur', () => { held = []; });

// ---------------------------------------------------------------- loop
let last = now();
function frame() {
  const t = now();
  const dt = Math.min(.1, (t - last) / 1000);
  last = t;

  // guide stepping (local guide only)
  if (joyDir && t >= joyNext) { visitorStep(joyDir.dx, joyDir.dy); joyNext = t + STEP_MS; }
  if (held.length && t >= nextStep) {
    const [dx, dy] = DIRS[held[held.length - 1]];
    if (isGuide) { if (!S.spotlight) moveGuide(dx, dy); }
    else visitorStep(dx, dy);
    nextStep = t + STEP_MS;
  }

  moveBugs(dt);
  checkEggs(isGuide ? S.guide : (S.me != null ? S.players.get(S.me) : null));

  // jumped into the abyss: the lesson appears for everyone shortly after
  const onPit = tileAt(S.guide.x, S.guide.y) === 'L';
  if (onPit && !S.guide.pitSeen) { S.guide.pitSeen = true; setTimeout(() => showLesson(EXTRA.abyssLesson), 2200); }
  if (!onPit) S.guide.pitSeen = false;

  // fell into the abyss: respawn at this room's spawn tile
  if (isGuide && S.guide.fallAt && t - S.guide.fallAt > 1500) {
    const rr = rooms[blockRoomAt(S.guide.x, S.guide.y)] || rooms[0];
    S.guide.fallAt = 0; S.guide.lavaAt = 0;
    S.guide.x = S.guide.rx = rr.spawn.x; S.guide.y = S.guide.ry = rr.spawn.y;
    saveGuide(); hostSend();
  }

  // interpolate
  const k = 1 - Math.exp(-dt * 16);
  const lerp = a => {
    if (Math.abs(a.x - a.rx) + Math.abs(a.y - a.ry) > 4) { a.rx = a.x; a.ry = a.y; }
    a.rx += (a.x - a.rx) * k; a.ry += (a.y - a.ry) * k;
  };
  lerp(S.guide);
  for (const p of S.players.values()) lerp(p);

  // room change
  const r = roomAt(S.guide.x, S.guide.y);
  if (r >= 0 && r !== S.room) {
    S.room = r; showBanner(r); if (zoomOut) computeZoom();
    if (r === QA_ROOM && role === 'visitor' && joined && !sitHinted) { sitHinted = true; setTimeout(() => toast(EXTRA.sitHint, 5000), 3500); }
  }
  if (isGuide && r === SECRET_ROOM && !S.secretSeen) { S.secretSeen = true; saveGuide(); hostSend(); }
  else if (isGuide && r >= 0 && r < SECRET_ROOM && r > S.discovered) { S.discovered = r; saveGuide(); hostSend(); }

  // fog of war fade
  const kl = 1 - Math.exp(-dt * 2.5);
  for (const rm of rooms) {
    const target = !roomSeen(rm.i) ? 0 : rm.i === S.room ? 1 : PREV_LIGHT;
    light[rm.i] += (target - light[rm.i]) * kl;
    if (Math.abs(target - light[rm.i]) < .003) light[rm.i] = target;
  }
  for (const w of worldTexts) w.el.style.opacity = (1 - (1 - light[w.room]) * FOG_MAX).toFixed(3);

  // camera
  let tx, ty;
  const meP = S.me != null ? S.players.get(S.me) : null;
  const focus = (meP && t < manualUntil) ? meP : S.guide;
  if (zoomOut && S.room >= 0 && focus === S.guide) {
    if (ISO) [tx, ty] = isoPt(rooms[S.room].cx, rooms[S.room].cy), ty -= 30;
    else { tx = rooms[S.room].cx * T; ty = rooms[S.room].cy * T; }
  } else if (ISO) { [tx, ty] = isoPt(focus.rx + .5, focus.ry + .5); ty -= 44; }
  else { tx = (focus.rx + .5) * T; ty = (focus.ry + .5) * T; }
  if (!cam.init) { cam.x = tx; cam.y = ty; cam.init = true; }
  const kc = 1 - Math.exp(-dt * 7);
  cam.x += (tx - cam.x) * kc; cam.y += (ty - cam.y) * kc;
  world.style.transform = `translate(${vw / 2 - cam.x * zoom}px, ${vh / 2 - cam.y * zoom}px) scale(${zoom})`;

  updatePlaque(t);
  renderPuzzle(t);
  if (ISO) {
    isoDt = dt;
    isoGround(t);
    isoScene(t, areaAt(focus.x, focus.y));
  } else {
    drawGround(nearId);
    drawActors(t);
  }
  drawConfetti(dt);
  requestAnimationFrame(frame);
}

window.__museum = { S };
updateDuckPill();
renderSpot();
document.fonts?.load('700 13px Vazirmatn').catch(() => {});
requestAnimationFrame(frame);
