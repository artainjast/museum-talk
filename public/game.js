import { MAP_W, MAP_H, RW, RH, rooms, doors, exhibits, zoneRect, tileAt, roomAt, doorRoomAt, isWalkable, exDist } from './map.js';
import { UI, EXTRA, AVATARS, AVATAR_SPRITES, REACTIONS, ROOM_TITLES, EXHIBITS, SCENARIOS, VOTE_FINAL, HELP_KEYS } from './content.js';

// ---------------------------------------------------------------- utils
const T = 32;               // world px per tile
const STEP_MS = 120;        // guide step repeat
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
// Phase A: the page is always the guide (solo).
const role = 'solo';
const isGuide = true;
document.body.classList.add(role);

// ---------------------------------------------------------------- state
const S = {
  guide: { x: rooms[0].spawn.x, y: rooms[0].spawn.y, rx: 0, ry: 0, face: 1 },
  unlocked: 0,
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
  }
}
S.guide.rx = S.guide.x; S.guide.ry = S.guide.y;
const saveGuide = () => store.set('museum.guide', { x: S.guide.x, y: S.guide.y, unlocked: S.unlocked });

// ---------------------------------------------------------------- sprites
const SPR = {};
for (const name of [...AVATAR_SPRITES, 'guide']) {
  const img = new Image();
  img.onload = () => { img.ok = true; };
  img.src = `/sprites/${name}.png`;
  SPR[name] = img;
}
const AV_COLORS = ['#8e7cc3', '#4a7bd0', '#1f9e8f', '#d64545', '#d04f9a', '#5aa04a', '#5bb3e0', '#2f7a3f', '#e0735b', '#334'];

// ---------------------------------------------------------------- canvas
const ground = $('ground'), actors = $('actors'), world = $('world');
const gctx = ground.getContext('2d'), actx = actors.getContext('2d');
let vw = 0, vh = 0, dpr = 1, zoom = 2, zoomOut = false;
const cam = { x: 0, y: 0, init: false };

function computeZoom() {
  if (zoomOut) zoom = Math.min(vw / ((RW + 1) * T), vh / ((RH + 1) * T));
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
function addWorldText(x, y, w, h, cls, html, id) {
  const d = document.createElement('div');
  d.className = 'wt ' + cls;
  if (id) d.id = id;
  Object.assign(d.style, { left: x * T + 'px', top: y * T + 'px', width: w * T + 'px', height: h * T + 'px' });
  d.innerHTML = html;
  world.appendChild(d);
  return d;
}
{
  const r0 = rooms[0], r6 = rooms[6], sign = EXHIBITS['lobby.sign'];
  addWorldText(r0.x0 + 3, r0.y0 + 2, 16, 3, 'wt-title', `${esc(sign.title)}<small dir="ltr">${esc(sign.sub)}</small>`);
  for (const k of ['h', 'a']) {
    const z = zoneRect[k];
    const [emoji, ...rest] = (k === 'h' ? UI.voteHuman : UI.voteAgent).split(' ');
    addWorldText(z.x0, z.y0, z.x1 - z.x0 + 1, z.y1 - z.y0 + 1, 'wt-zone', `<b>${emoji}</b><span>${esc(rest.join(' '))}</span><span class="zc"></span>`, 'zone-' + k);
  }
  addWorldText(r6.x0 + 1, r6.y0 + 3, 20, 3, 'wt-quote', esc(EXHIBITS['r6.quote'].text));
  addWorldText(r6.x0 + 3, r6.y0 + 7, 16, 2, 'wt-qa', esc(EXHIBITS['r6.qa'].text));
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
  const img = opts.guide ? SPR.guide : SPR[AVATAR_SPRITES[a.avatar]];
  const D = opts.guide ? GUIDE_D : SPR_D;
  let headY;
  if (img && img.ok) {
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
  for (const a of list) {
    if (a === S.guide) { drawActor(c, a, t, { guide: true, label: UI.guide }); continue; }
    const isMe = a === me;
    let label = null;
    if (!isGuide && me && (isMe || Math.max(Math.abs(a.x - me.x), Math.abs(a.y - me.y)) <= 3)) label = a.name;
    drawActor(c, a, t, { me: isMe, label });
  }
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
function updatePlaque() {
  const e = nearestExhibit(S.guide.x, S.guide.y);
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
  document.body.classList.toggle('voting', show && voteOpen(t));
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
function hostSend() { /* phase B: sync to server */ }

function moveGuide(dx, dy) {
  const g = S.guide;
  if (dx) g.face = dx;
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
  }
});
addEventListener('keyup', ev => { held = held.filter(c => c !== ev.code); });
addEventListener('blur', () => { held = []; });

// ---------------------------------------------------------------- loop
let last = now();
function frame() {
  const t = now();
  const dt = Math.min(.1, (t - last) / 1000);
  last = t;

  // guide stepping (local guide only)
  if (isGuide && held.length && t >= nextStep && !S.spotlight) {
    const [dx, dy] = DIRS[held[held.length - 1]];
    moveGuide(dx, dy);
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

  // camera
  let tx, ty;
  if (zoomOut && S.room >= 0) { tx = rooms[S.room].cx * T; ty = rooms[S.room].cy * T; }
  else { tx = (S.guide.rx + .5) * T; ty = (S.guide.ry + .5) * T; }
  if (!cam.init) { cam.x = tx; cam.y = ty; cam.init = true; }
  const kc = 1 - Math.exp(-dt * 7);
  cam.x += (tx - cam.x) * kc; cam.y += (ty - cam.y) * kc;
  world.style.transform = `translate(${vw / 2 - cam.x * zoom}px, ${vh / 2 - cam.y * zoom}px) scale(${zoom})`;

  updatePlaque();
  renderVote(t);
  drawGround(nearId);
  drawActors(t);
  requestAnimationFrame(frame);
}

window.__museum = { S };
renderSpot();
document.fonts?.load('700 13px Vazirmatn').catch(() => {});
requestAnimationFrame(frame);
