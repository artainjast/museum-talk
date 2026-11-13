// Q&A seats + guide reset (code 0912): sit on a bench, seat can't be shared, standing up when the guide
// leaves; reset sends guide + robots to the lobby while visitors stay where they are.
import { rooms, props, blockRoomAt, roomAt } from '../public/map.js';
import { sleep, connectHost, joinVisitors, walkTo, roomCenter } from './helpers.mjs';

const QA = 7;
const S = { x: 0, y: 0, unlocked: 7, discovered: 7, secret: false, secretSeen: false, spotlight: null,
  puzzle: { open: false, remaining: 0, revealed: false, seq: 0 } };
[S.x, S.y] = roomCenter(QA, S);
const ctx = connectHost(S);
const vis = joinVisitors(3, 'seat');
let ok = true;
const fail = m => { ok = false; console.log('  FAIL:', m); };
const sits = new Map();
ctx.host.on('sit', ([id, v]) => sits.set(id, v));
await sleep(3500);

const seat = props.find(p => p.room === QA && p.kind === 'bench');
vis[0].s.emit('sit', [seat.x, seat.y]);
await sleep(5000);
const p0 = ctx.players.get(vis[0].id);
console.log(`visitor 0 at ${p0.x},${p0.y} (seat ${seat.x},${seat.y}) sit=${sits.get(vis[0].id)}`);
if (p0.x !== seat.x || p0.y !== seat.y || sits.get(vis[0].id) !== 1) fail('visitor did not sit on the seat');

vis[1].s.emit('sit', [seat.x, seat.y]);
await sleep(3000);
const p1 = ctx.players.get(vis[1].id);
if (p1.x === seat.x && p1.y === seat.y) fail('two visitors on one seat');
else console.log('second visitor kept off the taken seat: ok');

const [ox, oy] = roomCenter(6, S); // guide leaves the Q&A room
await walkTo(ctx, S, ox, oy);
await sleep(3000);
console.log(`after guide left: sit=${sits.get(vis[0].id)} visitor 0 in room ${roomAt(ctx.players.get(vis[0].id).x, ctx.players.get(vis[0].id).y)}`);
if (sits.get(vis[0].id) !== 0) fail('seated visitor did not stand up when the guide left');

// reset (what the 0912 code sends): guide to the lobby, tour state back to the start, then host:reset
await sleep(2000);
const where = () => new Map(vis.map(v => [v.id, { ...ctx.players.get(v.id) }]));
const pre = where();
Object.assign(S, { x: rooms[0].spawn.x, y: rooms[0].spawn.y, unlocked: 0, discovered: 0 });
ctx.host.emit('host:reset', S);
await sleep(400); // let any in-flight position update land
const before = where();
const teleported = vis.filter(v => Math.abs(pre.get(v.id).x - before.get(v.id).x) + Math.abs(pre.get(v.id).y - before.get(v.id).y) > 2).length;
if (teleported) fail(`${teleported} visitors were moved by the reset`);
await sleep(3000);
const robots = [...ctx.players.values()].filter(p => p.av === 10);
const robotsHome = robots.filter(p => blockRoomAt(p.x, p.y) === 0).length;
const moved = vis.filter(v => { const a = before.get(v.id), b = ctx.players.get(v.id); return a.x !== b.x || a.y !== b.y; }).length;
console.log(`after reset: robots in lobby ${robotsHome}/${robots.length}; visitors that moved ${moved}/${vis.length}`);
if (robotsHome !== robots.length) fail('robots did not return to the lobby');
if (moved) fail('visitors moved after reset');
// full game reset (code 0910): everyone back in the lobby, and every visitor is told
const told = new Set();
vis.forEach(v => v.s.on('gameReset', () => told.add(v.id)));
const [qx, qy] = [rooms[0].spawn.x + 1, rooms[0].spawn.y];
Object.assign(S, { x: qx, y: qy });
ctx.host.emit('host:resetAll', S);
await sleep(2500);
const inLobby = [...ctx.players.values()].filter(p => blockRoomAt(p.x, p.y) === 0).length;
console.log(`after full reset: ${inLobby}/${ctx.players.size} in the lobby, ${told.size}/${vis.length} visitors notified`);
if (inLobby !== ctx.players.size || told.size !== vis.length) fail('full reset did not bring everyone back');
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
