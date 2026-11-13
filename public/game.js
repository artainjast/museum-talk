import { MAP_W, MAP_H, RW, RH, rooms, doors, exhibits, zoneRect, tileAt, roomAt, doorRoomAt, blockRoomAt, isWalkable, exDist } from './map.js';
import { UI, EXTRA, AVATARS, AVATAR_SPRITES, REACTIONS, ROOM_TITLES, EXHIBITS, SCENARIOS, VOTE_FINAL, HELP_KEYS } from './content.js';

// ---------------------------------------------------------------- utils
const T = 32;               // world px per tile
const STEP_MS = 120;        // guide step repeat
const TW = 64, TH = 32, WALL_TALL = 62, WALL_SHORT = 12; // isometric tile + wall heights (world px)
const isoPt = (x, y) => [(x - y) * TW / 2, (x + y) * TH / 2];
const VOTE_MS = 20000;
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
  discovered: 0, // highest room the guide has walked into (fog of war)
  spotlight: null,
  vote: { idx: -1, endsAt: 0, revealed: false, counts: [0, 0] }, // endsAt in performance.now() ms
  players: new Map(),  // visitor avatars (phase B)
  me: null,
  room: -1,
};

if (isGuide) {
  const saved = store.get('museum.guide');
  if (saved && Number.isInteger(saved.x) && Number.isInteger(saved.unlocked) && isWalkable(saved.x, saved.y, saved.unlocked)) {
    S.guide.x = saved.x; S.guide.y = saved.y; S.unlocked = saved.unlocked;
    S.discovered = Number.isInteger(saved.discovered) ? Math.min(saved.discovered, saved.unlocked) : 0;
  }
}
S.guide.rx = S.guide.x; S.guide.ry = S.guide.y;
const FOG_MAX = .62; // undiscovered rooms are shadowed, not black
const light = rooms.map(r => (r.i <= S.discovered ? 1 : 0));
const saveGuide = () => store.set('museum.guide', { x: S.guide.x, y: S.guide.y, unlocked: S.unlocked, discovered: S.discovered });

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
    if (zoomOut) zoom = Math.min(vw / ((RW + RH) * TW / 2 + 60), vh / ((RW + RH) * TH / 2 + 140));
    else zoom = Math.min(Math.max(vw, vh) / 1000, Math.min(vw, vh) / 440);
  } else if (zoomOut) zoom = Math.min(vw / ((RW + 1) * T), vh / ((RH + 1) * T));
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
  for (const k of ['h', 'a']) {
    const z = zoneRect[k];
    const [emoji, ...rest] = (k === 'h' ? UI.voteHuman : UI.voteAgent).split(' ');
    addWorldText(3, z.x0, z.y0, z.x1 - z.x0 + 1, z.y1 - z.y0 + 1, 'wt-zone', `<b>${emoji}</b><span>${esc(rest.join(' '))}</span><span class="zc"></span>`, 'zone-' + k);
  }
  addWorldText(6, r6.x0 + 1, r6.y0 + 3, 20, 3, 'wt-quote', esc(EXHIBITS['r6.quote'].text));
  addWorldText(6, r6.x0 + 3, r6.y0 + 7, 16, 2, 'wt-qa', esc(EXHIBITS['r6.qa'].text));
}

// ---------------------------------------------------------------- drawing
const FLOOR = ['#efe8dc', '#e8e3ef', '#e3ebe4', '#f1e6e1', '#efe9d6', '#e3eaf0', '#ece5f0'];
const hash = (x, y) => (((x * 73856093) ^ (y * 19349663)) >>> 0);

function floorColor(x, y) {
  const r = roomAt(x, y);
  return FLOOR[r >= 0 ? r : Math.max(0, doorRoomAt(x, y))];
}

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

function drawGround(nearId) {
  const c = gctx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, ground.width, ground.height);
  setWorldTransform(c, ground);
  const v = visibleRange();
  for (let y = v.y0; y <= v.y1; y++) for (let x = v.x0; x <= v.x1; x++) {
    const t = tileAt(x, y);
    if (t === ' ') continue;
    const px = x * T, py = y * T;
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
    if (t === 'h') { c.fillStyle = 'rgba(255,138,61,.28)'; c.fillRect(px, py, T + .5, T + .5); }
    else if (t === 'a') { c.fillStyle = 'rgba(34,184,200,.28)'; c.fillRect(px, py, T + .5, T + .5); }
    else if (t === '=') { c.fillStyle = 'rgba(110,80,50,.16)'; c.fillRect(px, py, T + .5, T + .5); }
  }
  // vote zone borders
  c.setLineDash([6, 5]); c.lineWidth = 2;
  for (const k of ['h', 'a']) {
    const z = zoneRect[k];
    c.strokeStyle = k === 'h' ? 'rgba(220,100,30,.7)' : 'rgba(20,140,160,.7)';
    c.strokeRect(z.x0 * T + 2, z.y0 * T + 2, (z.x1 - z.x0 + 1) * T - 4, (z.y1 - z.y0 + 1) * T - 4);
  }
  c.setLineDash([]);
  // exhibits
  for (const e of exhibits) {
    if (e.x1 < v.x0 || e.x0 > v.x1 || e.y1 < v.y0 - 1 || e.y0 > v.y1) continue;
    drawFrame(c, e, e.id === nearId);
  }
  // velvet ropes on locked doors
  // fog of war over rooms the guide hasn't discovered yet
  for (const r of rooms) {
    if (light[r.i] > .995) continue;
    c.fillStyle = `rgba(11,10,16,${(1 - light[r.i]) * FOG_MAX})`;
    c.fillRect(r.ox * T, r.oy * T, RW * T + .5, RH * T + .5);
  }
  for (const d of doors) if (d.room > S.unlocked) drawRope(c, d);
}

function drawFrame(c, e, glow) {
  const r = rooms[e.room];
  const onWall = e.y0 === r.y0;
  const left = e.x0 * T + 3, right = (e.x1 + 1) * T - 3;
  const top = onWall ? e.y0 * T - T * .5 : e.y0 * T + 1;
  const bot = onWall ? (e.y1 + 1) * T - 4 : (e.y1 + 1) * T - 8;
  const w = right - left, h = bot - top;
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
  const cx = a.rx * T + T / 2, feet = a.ry * T + T * .86;
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
const lowered = rooms.map(() => 0);        // per room block: 1 = back walls lowered (block is in front of the focus room)
const EX_IMG = {};                          // optional exhibit pictures: /art/ex/<id>.png
for (const e of exhibits) EX_IMG[e.id] = loadImg(`/art/ex/${e.id}.png`);

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

function isoGround() {
  const c = gctx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, ground.width, ground.height);
  setWorldTransform(c, ground);
  c.lineWidth = 1;
  for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) {
    const t = tileAt(x, y);
    if (t === ' ' || t === '#') continue;
    if (!isoTileOnScreen(x, y, 40)) continue;
    let col = floorColor(x, y);
    diamond(c, x, y);
    c.fillStyle = col; c.strokeStyle = col; c.fill(); c.stroke();
    if ((x + y) & 1) { c.fillStyle = 'rgba(0,0,0,.04)'; c.fill(); }
    if (t === 'h') { c.fillStyle = 'rgba(255,138,61,.3)'; c.fill(); }
    else if (t === 'a') { c.fillStyle = 'rgba(34,184,200,.3)'; c.fill(); }
    else if (t === '=') { c.fillStyle = 'rgba(110,80,50,.18)'; c.fill(); }
    const lt = light[blockRoomAt(x, y)] ?? 1;
    if (lt < .995) { c.fillStyle = `rgba(11,10,16,${(1 - lt) * FOG_MAX})`; c.fill(); }
  }
  // vote zone borders
  c.setLineDash([8, 6]); c.lineWidth = 2;
  for (const k of ['h', 'a']) {
    const z = zoneRect[k];
    quad(c, [isoPt(z.x0, z.y0), isoPt(z.x1 + 1, z.y0), isoPt(z.x1 + 1, z.y1 + 1), isoPt(z.x0, z.y1 + 1)]);
    c.strokeStyle = k === 'h' ? 'rgba(220,100,30,.75)' : 'rgba(20,140,160,.75)'; c.stroke();
  }
  c.setLineDash([]);
}

// Upright panel standing on the line (xa,ya)->(xb,yb) in tile space, from height z0 to z1 (world px).
function drawPanel(c, xa, ya, xb, yb, z0, z1, id, glow, legs) {
  const [ax, ay] = isoPt(xa, ya), [bx, by] = isoPt(xb, yb);
  const P = (u, z) => [ax + (bx - ax) * u, ay + (by - ay) * u - z];
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
  const faces = [
    [[wx, wy], [sx, sy], [sx, sy - h], [wx, wy - h], '#3d3756'],      // south face (down-left)
    [[sx, sy], [ex, ey], [ex, ey - h], [sx, sy - h], '#2c2740'],      // east face (down-right)
    [[nx, ny - h], [ex, ey - h], [sx, sy - h], [wx, wy - h], '#5c5479'], // top
  ];
  for (const [a, b, cc, d, col] of faces) {
    quad(c, [a, b, cc, d]);
    c.fillStyle = col; c.strokeStyle = col; c.lineWidth = 1; c.fill(); c.stroke();
    if (fog > .005) { c.fillStyle = `rgba(11,10,16,${fog})`; c.fill(); }
  }
  // baseboard on the south face
  if (h > 20) { quad(c, [[wx, wy], [sx, sy], [sx, sy - 4], [wx, wy - 4]]); c.fillStyle = '#251f36'; c.fill(); }
  if (frames && h > 30) {
    // each wall tile paints only its own slice of the frame, so neighbouring wall tiles never cover it
    c.save();
    quad(c, [[wx, wy], [sx, sy], [sx, sy - h - 6], [wx, wy - h - 6]]); c.clip();
    for (const e of frames) drawPanel(c, e.x0 + .08, y + 1, e.x1 + .92, y + 1, h * .22, h * .92, e.id, e.id === nearId, false);
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
  if (e.y0 !== rooms[e.room].y0) continue;
  for (let x = e.x0; x <= e.x1; x++) {
    const k = (e.y0 - 1) * MAP_W + x;
    if (!wallFrames.has(k)) wallFrames.set(k, []);
    wallFrames.get(k).push(e);
  }
}
function isoScene(t, focusRoom) {
  const c = actx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, actors.width, actors.height);
  setWorldTransform(c, actors);
  const kl = 1 - Math.exp(-Math.min(.1, isoDt) * 5);
  const f = focusRoom >= 0 ? rooms[focusRoom] : null;
  for (const r of rooms) {
    const target = f && (r.ox > f.ox || r.oy > f.oy) ? 1 : 0;
    lowered[r.i] += (target - lowered[r.i]) * kl;
  }
  const items = [];
  for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) {
    if (tileAt(x, y) !== '#' || !isoTileOnScreen(x, y, 90)) continue;
    const b = blockRoomAt(x, y), r = rooms[b];
    const back = y === r.oy || x === r.ox;
    const h = back ? WALL_TALL + (WALL_SHORT - WALL_TALL) * lowered[b] : WALL_SHORT;
    const fog = (1 - (light[b] ?? 1)) * FOG_MAX;
    // frames hang on the wall tile above an exhibit's first tile; draw them with that tile only
    const fr = wallFrames.get(y * MAP_W + x) && y === r.oy ? wallFrames.get(y * MAP_W + x) : null;
    items.push({ d: x + y + 1, k: 0, draw: () => drawWall(c, x, y, h, fog, fr, nearId) });
  }
  for (const e of exhibits) {
    if (e.y0 === rooms[e.room].y0) continue; // wall-mounted
    if (!isoTileOnScreen(e.x0, e.y0, 120)) continue;
    const yy = e.y0 + .55;
    items.push({ d: (e.x0 + e.x1 + 1) / 2 + yy + .4, k: 1, draw: () => drawPanel(c, e.x0 + .05, yy, e.x1 + .95, yy, 10, 52, e.id, e.id === nearId, true) });
  }
  for (const d of doors) {
    if (d.room <= S.unlocked) continue;
    items.push({ d: (d.x0 + d.x1 + 1) / 2 + (d.y0 + d.y1 + 1) / 2, k: 1, draw: () => drawIsoRope(c, d) });
  }
  const me = S.me != null ? S.players.get(S.me) : null;
  const labels = [];
  const addActor = (a, opts) => items.push({ d: a.rx + a.ry + 1, k: 2, draw: () => drawIsoActor(c, a, t, opts, labels) });
  for (const p of S.players.values()) {
    if (!isoTileOnScreen(p.rx, p.ry, 80)) continue;
    const isMe = p === me;
    let label = null;
    if (!isGuide && me && (isMe || Math.max(Math.abs(p.x - me.x), Math.abs(p.y - me.y)) <= 3)) label = p.name;
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
  const [cx, feet] = isoPt(a.rx + .5, a.ry + .5);
  const moving = Math.abs(a.rx - a.x) + Math.abs(a.ry - a.y) > .04;
  c.fillStyle = 'rgba(0,0,0,.22)';
  c.beginPath(); c.ellipse(cx, feet, TW * .26, TH * .26, 0, 0, Math.PI * 2); c.fill();
  if (opts.me) {
    c.strokeStyle = '#19d3f0'; c.lineWidth = 3;
    c.beginPath(); c.ellipse(cx, feet, TW * .36 + Math.sin(t / 250) * 2, TH * .36 + Math.sin(t / 250), 0, 0, Math.PI * 2); c.stroke();
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
  if (opts.label) labels.push(() => drawLabel(c, opts.label, cx, headY - 8, opts.guide));
  if (a.react && a.react.until > t) labels.push(() => drawReaction(c, a.react, cx, headY - (opts.label ? 30 : 8), t));
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
  let h = `<div class="ex-icon">${e.icon}</div>`;
  if (e.title) h += `<h2>${esc(e.title)}</h2>`;
  if (e.sub) h += `<p class="sub" dir="ltr">${esc(e.sub)}</p>`;
  if (e.text) h += `<p class="text${id === 'r6.quote' ? ' quote' : ''}">${esc(e.text)}</p>`;
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
  b.textContent = fmt(UI.roomBanner, { n: fa(r), title: ROOM_TITLES[r] });
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
    if (e.room !== r) continue;
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
  p.innerHTML = `<span class="pi">${ex.icon}</span><span class="pt">${esc(ex.title || ex.text)}</span>` + (isGuide ? '<kbd>E</kbd>' : '');
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

let lastVoteKey = '';
function renderVote(t) {
  const v = S.vote, p = $('vote');
  const show = v.idx >= 0 && S.room === 3;
  p.hidden = !show;
  const open = show && voteOpen(t);
  document.body.classList.toggle('voting', open);
  if (role === 'visitor') {
    const vb = $('voteBtns');
    vb.hidden = !(open && joined);
    for (const b of vb.children) b.classList.toggle('on', b.dataset.v === myVote);
  }
  if (!show) { lastVoteKey = ''; return; }
  const left = Math.max(0, Math.ceil((v.endsAt - t) / 1000));
  const key = `${v.idx}|${left}|${v.revealed}|${v.counts}`;
  if (key === lastVoteKey) return;
  lastVoteKey = key;
  const sc = SCENARIOS[v.idx];
  let h = `<div class="vp-head"><span>${fmt(EXTRA.scenario, { n: fa(v.idx + 1), total: fa(SCENARIOS.length) })}</span>` +
    `<span class="vp-timer${left === 0 ? ' done' : ''}">${left === 0 ? EXTRA.voteClosed : '⏱ ' + fa(left)}</span></div>` +
    `<p class="vp-text">${esc(sc.text)}</p>`;
  if (role !== 'solo') {
    const [hc, ac] = v.counts;
    h += `<div class="vp-counts"><span class="h" style="flex-grow:${hc + .5}">${UI.voteHuman} ${fa(hc)}</span><span class="a" style="flex-grow:${ac + .5}">${UI.voteAgent} ${fa(ac)}</span></div>`;
  }
  if (v.revealed) {
    h += `<p class="vp-reveal">${esc(sc.reveal)}</p>`;
    if (v.idx === SCENARIOS.length - 1) h += `<p class="vp-final">${esc(VOTE_FINAL)}</p>`;
  }
  p.innerHTML = h;
}
const voteOpen = t => S.vote.idx >= 0 && !S.vote.revealed && S.vote.endsAt > t;

// ---------------------------------------------------------------- guide actions
let sock = null;
const hostState = () => ({
  x: S.guide.x, y: S.guide.y, unlocked: S.unlocked, discovered: S.discovered, spotlight: S.spotlight,
  vote: { idx: S.vote.idx, remaining: Math.max(0, Math.round(S.vote.endsAt - now())), revealed: S.vote.revealed },
});
function hostSend() {
  if (role === 'host' && sock && sock.connected) sock.emit('host:state', hostState());
}

function moveGuide(dx, dy) {
  const g = S.guide;
  setFacing(g, dx, dy);
  const nx = g.x + dx, ny = g.y + dy;
  if (!isWalkable(nx, ny, S.unlocked)) return;
  g.x = nx; g.y = ny;
  saveGuide();
  hostSend('move');
}
function teleport(i) {
  if (!rooms[i]) return;
  const e = rooms[i].entry;
  S.unlocked = Math.max(S.unlocked, i);
  S.guide.x = S.guide.rx = e.x; S.guide.y = S.guide.ry = e.y;
  saveGuide();
  hostSend('move'); hostSend('unlock');
}
function setUnlocked(n) {
  S.unlocked = Math.max(0, Math.min(rooms.length - 1, n));
  S.discovered = Math.max(Math.min(S.discovered, S.unlocked), roomAt(S.guide.x, S.guide.y));
  saveGuide();
  hostSend('unlock');
}
function setSpotlight(id) {
  S.spotlight = id;
  spotDismissed = null;
  renderSpot();
  hostSend('spotlight');
}
function setVote(v) {
  S.vote = { ...S.vote, ...v };
  if (v.idx !== undefined && v.revealed === false) S.vote.counts = [0, 0];
  hostSend('vote');
}
function resetAll() {
  setVote({ idx: -1, endsAt: 0, revealed: false });
  setSpotlight(null);
  S.unlocked = 0;
  S.discovered = 0;
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

addEventListener('keydown', ev => {
  const code = ev.code;
  if (ev.target instanceof HTMLInputElement) return;
  if (code.startsWith('Arrow') || code === 'Space') ev.preventDefault();
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
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
        if (cardId) closeCard();
        else if (!$('help').hidden) toggleHelp(false);
        else if (S.spotlight) setSpotlight(null);
        break;
      case 'KeyV':
        if (ev.shiftKey) setVote({ idx: -1, endsAt: 0, revealed: false });
        else if (S.room === 3 && S.vote.idx < SCENARIOS.length - 1) setVote({ idx: S.vote.idx + 1, endsAt: t + VOTE_MS, revealed: false });
        break;
      case 'KeyR':
        if (S.vote.idx >= 0 && !S.vote.revealed) setVote({ revealed: true, endsAt: Math.min(S.vote.endsAt, t) });
        break;
      case 'KeyK': toggleHelp(); break;
      case 'Home': if (ev.shiftKey) resetAll(); break;
      default:
        if (ev.shiftKey && /^Digit[0-6]$/.test(code)) teleport(Number(code[5]));
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
    else if (code === 'Escape') { if (cardId) closeCard(); else if (S.spotlight) closeOverlay('spot'); }
  }
});

// ---------------------------------------------------------------- networking (phase B)
let joined = false, myVote = null, lastReactAt = 0;
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
function upsertPlayer([id, x, y, avatar, name]) {
  const old = S.players.get(id);
  if (old) Object.assign(old, { avatar, name });
  else S.players.set(id, { id, x, y, rx: x, ry: y, avatar, name, face: 1, dir: 0, phase: Math.random() * 4, react: null });
}
function applyMeta(m) {
  if (role === 'visitor') {
    S.unlocked = m.unlocked;
    S.discovered = m.discovered ?? S.discovered;
    if (m.spotlight !== S.spotlight) { S.spotlight = m.spotlight; spotDismissed = null; renderSpot(); }
    if (m.vote.idx !== S.vote.idx) myVote = null;
    S.vote = { idx: m.vote.idx, endsAt: now() + m.vote.remaining, revealed: m.vote.revealed, counts: m.vote.counts };
  } else if (m.vote.idx === S.vote.idx) {
    S.vote.counts = m.vote.counts;
  }
}
function applySnap(m) {
  S.players.clear();
  for (const row of m.players) upsertPlayer(row);
  if (role === 'visitor') { S.guide.x = S.guide.rx = m.g[0]; S.guide.y = S.guide.ry = m.g[1]; cam.init = false; }
  applyMeta(m.meta);
  for (const rm of rooms) light[rm.i] = rm.i <= S.discovered ? 1 : 0;
  setOnline(m.n);
}
function react(i) {
  const t = now();
  if (!sock || t - lastReactAt < 1000) return;
  lastReactAt = t;
  sock.emit('react', i);
}
function castVote(v) {
  if (!sock || !voteOpen(now())) return;
  myVote = v;
  sock.emit('vote', v);
  lastVoteKey = '';
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
  AVATARS.forEach((e, i) => {
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

function startVisitor() {
  joined = true;
  $('bar').hidden = false;
  sendJoin();
  const h = $('hint');
  h.textContent = EXTRA.moveHint;
  h.classList.add('show');
  setTimeout(() => h.classList.remove('show'), 9000);
}
$('stage').addEventListener('pointerup', ev => {
  if (role !== 'visitor' || !joined) return;
  const [x, y] = screenToTile(ev.clientX, ev.clientY);
  if (isWalkable(x, y, S.unlocked) && blockRoomAt(x, y) <= S.discovered) visitorGoto(x, y);
});

function setupBar() {
  REACTIONS.forEach((e, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = e;
    b.addEventListener('click', () => react(i));
    $('reacts').appendChild(b);
  });
  const [bh, ba] = $('voteBtns').children;
  bh.textContent = UI.voteHuman; ba.textContent = UI.voteAgent;
  bh.addEventListener('click', () => castVote('h'));
  ba.addEventListener('click', () => castVote('a'));
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
    if (role === 'host') sock.emit('host:hello', { token: params.get('host'), state: hostState() });
    else sendJoin();
  });
  sock.on('disconnect', () => { rc.hidden = false; });
  sock.on('host:denied', () => { rc.textContent = 'HOST TOKEN ✗'; rc.hidden = false; });
  sock.on('host:ok', m => { applySnap(m); });
  sock.on('welcome', m => {
    S.me = m.me;
    session = { ...session, sessionId: m.sessionId, name: m.name };
    store.set(SESSION_KEY, session);
    applySnap(m);
  });
  sock.on('snap', applySnap);
  sock.on('meta', applyMeta);
  sock.on('c', counts => { S.vote.counts = counts; });
  sock.on('pjoin', upsertPlayer);
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
      if (role === 'host') sock.emit('host:state', hostState());
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
  if (held.length && t >= nextStep) {
    const [dx, dy] = DIRS[held[held.length - 1]];
    if (isGuide) { if (!S.spotlight) moveGuide(dx, dy); }
    else visitorStep(dx, dy);
    nextStep = t + STEP_MS;
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
  if (r >= 0 && r !== S.room) { S.room = r; showBanner(r); }
  if (isGuide && r > S.discovered) { S.discovered = r; saveGuide(); hostSend(); }

  // fog of war fade
  const kl = 1 - Math.exp(-dt * 2.5);
  for (const rm of rooms) {
    const target = rm.i <= S.discovered ? 1 : 0;
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
  } else if (ISO) { [tx, ty] = isoPt(focus.rx + .5, focus.ry + .5); ty -= 30; }
  else { tx = (focus.rx + .5) * T; ty = (focus.ry + .5) * T; }
  if (!cam.init) { cam.x = tx; cam.y = ty; cam.init = true; }
  const kc = 1 - Math.exp(-dt * 7);
  cam.x += (tx - cam.x) * kc; cam.y += (ty - cam.y) * kc;
  world.style.transform = `translate(${vw / 2 - cam.x * zoom}px, ${vh / 2 - cam.y * zoom}px) scale(${zoom})`;

  updatePlaque(t);
  renderVote(t);
  if (ISO) {
    isoDt = dt;
    isoGround();
    isoScene(t, blockRoomAt(focus.x, focus.y));
  } else {
    drawGround(nearId);
    drawActors(t);
  }
  requestAnimationFrame(frame);
}

window.__museum = { S };
renderSpot();
document.fonts?.load('700 13px Vazirmatn').catch(() => {});
requestAnimationFrame(frame);
