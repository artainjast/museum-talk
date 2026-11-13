// Full tour: the guide walks every main room; visitors and robots must follow, never get ahead into
// undiscovered rooms, receive the room 3 puzzle, and tap-to-move / idle-return must work.
import { rooms, doors, roomAt, blockRoomAt, SECRET_ROOM } from '../public/map.js';
import { sleep, connectHost, joinVisitors, walkTo, roomCenter } from './helpers.mjs';

const N = Number(process.env.N || 20);
const S = { x: rooms[0].spawn.x, y: rooms[0].spawn.y, unlocked: 0, discovered: 0, secret: false, secretSeen: false,
  spotlight: null, puzzle: { open: false, remaining: 0, revealed: false, seq: 0 } };
const ctx = connectHost(S);
const vis = joinVisitors(N, 'tour');
let ok = true;
const fail = msg => { ok = false; console.log('  FAIL:', msg); };

await sleep(2500);
const humans = () => [...ctx.players.values()].filter(p => p.av !== 10);
function check(label, r) {
  const all = [...ctx.players.values()];
  const inRoom = all.filter(p => roomAt(p.x, p.y) === r || blockRoomAt(p.x, p.y) === r).length;
  const far = all.filter(p => Math.abs(p.x - S.x) + Math.abs(p.y - S.y) > 10).map(p => [p.x, p.y]);
  console.log(`${label}: players=${all.length} inRoom=${inRoom} far=${JSON.stringify(far.slice(0, 4))}`);
  if (inRoom !== all.length) fail(`${label}: ${all.length - inRoom} players not in room ${r}`);
}
check('lobby', 0);
for (let r = 1; r < SECRET_ROOM; r++) {
  S.unlocked = r; ctx.host.emit('host:state', S);
  const d = doors.find(dd => dd.room === r && !dd.open);
  // stand on the near side of the entrance (still outside room r) and make sure nobody runs ahead
  const near = [];
  for (let y = d.y0; y <= d.y1; y++) for (let x = d.x0; x <= d.x1; x++) if (blockRoomAt(x, y) !== r) near.push([x, y]);
  const [nx, ny] = near[Math.floor(near.length / 2)];
  await walkTo(ctx, S, nx, ny);
  await sleep(2500);
  const ahead = humans().filter(p => roomAt(p.x, p.y) === r).length;
  console.log(`  at entrance of room ${r} (${nx},${ny}): visitors already inside = ${ahead}`);
  if (ahead) fail(`visitors entered room ${r} before the guide`);
  const [cx, cy] = roomCenter(r, S);
  await walkTo(ctx, S, cx, cy);
  await sleep(4500);
  check(`room ${r}`, r);
  if (r === 3) { // puzzle overlay reaches every visitor
    const seen = vis.map(() => []);
    vis.forEach((v, i) => v.s.on('meta', m => seen[i].push(m.puzzle)));
    S.puzzle = { open: true, remaining: 60000, revealed: false, seq: 1 }; ctx.host.emit('host:state', S); await sleep(600);
    S.puzzle = { ...S.puzzle, remaining: 59000, revealed: true }; ctx.host.emit('host:state', S); await sleep(600);
    S.puzzle = { ...S.puzzle, open: false }; ctx.host.emit('host:state', S); await sleep(600);
    const all = seen.every(l => l.some(p => p?.open && !p.revealed && p.remaining > 55000) && l.some(p => p?.open && p.revealed) && !l.at(-1)?.open);
    console.log(`  puzzle sync to ${vis.length} visitors: ${all ? 'ok' : 'MISSING'}`);
    if (!all) fail('puzzle sync');
  }
}
// tap-to-move inside the current room, then idle-return to the guide
const g = vis[1], target = roomCenter(SECRET_ROOM - 1, S);
const tgt = [target[0] + 3, target[1]];
g.s.emit('goto', tgt);
await sleep(6000);
const me = ctx.players.get(g.id);
console.log(`goto ${tgt} -> ${me.x},${me.y}`);
await sleep(9000);
const back = ctx.players.get(g.id), dist = Math.abs(back.x - S.x) + Math.abs(back.y - S.y);
console.log(`after idle, distance to guide = ${dist}`);
if (dist > 8) fail('idle visitor did not return to the guide');
if (ctx.jumps.length) { console.log('server guide jumps:', JSON.stringify(ctx.jumps)); fail('server guide jumped'); }
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
