// Shared helpers for the headless multiplayer tests (run against a server started with HOST_TOKEN=dev).
import { io } from 'socket.io-client';
import { MAP_W, rooms, isWalkable, roomAt } from '../public/map.js';

export const URL = process.env.URL || 'http://localhost:3917';
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function connectHost(S) {
  const host = io(URL, { transports: ['websocket'] });
  const players = new Map();
  const ctx = { host, players, serverG: null, jumps: [] };
  host.on('connect', () => host.emit('host:hello', { token: 'dev', state: S }));
  host.on('host:denied', () => { console.error('host denied'); process.exit(1); });
  host.on('host:ok', m => { ctx.serverG = m.g; for (const [id, x, y, av, name] of m.players) players.set(id, { x, y, av, name }); });
  host.on('pjoin', ([id, x, y, av, name]) => players.set(id, { x, y, av, name }));
  host.on('pleave', id => players.delete(id));
  host.on('t', m => {
    if (m.g) {
      const g = ctx.serverG;
      if (g && Math.abs(m.g[0] - g[0]) + Math.abs(m.g[1] - g[1]) > 3) ctx.jumps.push([g, m.g, [S.x, S.y]]);
      ctx.serverG = m.g;
    }
    if (m.p) for (let i = 0; i < m.p.length; i += 3) { const p = players.get(m.p[i]); if (p) { p.x = m.p[i + 1]; p.y = m.p[i + 2]; } }
  });
  return ctx;
}

export function joinVisitors(n, prefix) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = io(URL, { transports: i % 4 === 0 ? ['polling'] : ['websocket'] });
    const v = { s, id: null };
    s.on('connect', () => s.emit('join', { sessionId: `${prefix}-${i}`, name: 'bot' + i, avatar: i % 10 }));
    s.on('welcome', m => { v.id = m.me; });
    out.push(v);
  }
  return out;
}

// BFS path over the same walkability the server uses for the guide.
export function path(S, tx, ty) {
  const key = (x, y) => y * MAP_W + x, prev = new Map([[key(S.x, S.y), null]]), q = [[S.x, S.y]];
  while (q.length) {
    const [x, y] = q.shift();
    if (x === tx && y === ty) break;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (!isWalkable(nx, ny, S.unlocked, S.secret) || prev.has(key(nx, ny))) continue;
      prev.set(key(nx, ny), [x, y]); q.push([nx, ny]);
    }
  }
  if (!prev.has(key(tx, ty))) throw new Error(`no path from ${S.x},${S.y} to ${tx},${ty}`);
  const out = [];
  for (let cur = [tx, ty]; cur && !(cur[0] === S.x && cur[1] === S.y); cur = prev.get(key(...cur))) out.unshift(cur);
  return out;
}

export async function walkTo(ctx, S, tx, ty, stepMs = 120) {
  for (const [x, y] of path(S, tx, ty)) {
    S.x = x; S.y = y;
    const r = roomAt(x, y);
    if (r >= 0 && r < 8 && r > S.discovered) S.discovered = r;
    if (r === 8) S.secretSeen = true;
    ctx.host.emit('host:state', S);
    await sleep(stepMs);
  }
}

// Walkable tile nearest to a room's centre (centres can land on props).
export function roomCenter(i, S) {
  const r = rooms[i];
  let best = null, bd = 1e9;
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) {
    if (!isWalkable(x, y, S.unlocked, S.secret) || roomAt(x, y) !== i) continue;
    const d = Math.abs(x - r.cx) + Math.abs(y - r.cy);
    if (d < bd) { bd = d; best = [x, y]; }
  }
  return best;
}
