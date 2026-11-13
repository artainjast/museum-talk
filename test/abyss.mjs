// Abyss: the guide jumps in; robots follow and fall, then respawn; human visitors never step in.
import { rooms, tileAt, SECRET_ROOM } from '../public/map.js';
import { sleep, connectHost, joinVisitors } from './helpers.mjs';

const r = rooms[SECRET_ROOM];
const S = { x: r.spawn.x, y: r.spawn.y, unlocked: 7, discovered: 7, secret: true, secretSeen: true,
  spotlight: null, puzzle: { open: false, remaining: 0, revealed: false, seq: 0 } };
const ctx = connectHost(S);
joinVisitors(6, 'abyss');
await sleep(4000);
const robots = () => [...ctx.players.values()].filter(p => p.av === 10);
const humans = () => [...ctx.players.values()].filter(p => p.av !== 10);
let maxIn = 0, humanIn = 0;
const watch = setInterval(() => {
  maxIn = Math.max(maxIn, robots().filter(p => tileAt(p.x, p.y) === 'L').length);
  humanIn += humans().filter(p => tileAt(p.x, p.y) === 'L').length;
}, 50);
while (tileAt(S.x, S.y) !== 'L') { S.x++; ctx.host.emit('host:state', S); await sleep(120); }
console.log('guide jumped at', S.x, S.y);
await sleep(1500);
S.x = r.spawn.x; S.y = r.spawn.y; ctx.host.emit('host:state', S);
await sleep(3500);
clearInterval(watch);
const still = robots().filter(p => tileAt(p.x, p.y) === 'L').length;
console.log(`robots ${robots().length}; max in pit ${maxIn}; still in pit ${still}; human-in-pit samples ${humanIn}`);
const ok = maxIn >= 3 && still === 0 && humanIn === 0;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
