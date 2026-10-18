const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createGame, addPlayer, roll, snapshot } = require('./game');
function full(n=4) {
  const game = createGame('ABCDEF',n);
  for(let i=0;i<n;i++) addPlayer(game, `socket${i}`);
  return game;
}
test('capacities, unique admission and waiting phase', () => {
  assert.throws(() => createGame('A',9));
  const g = createGame('A',3); addPlayer(g,'a');
  assert.throws(() => addPlayer(g,'a'));
  assert.throws(() => roll(g,'a',g.version));
  addPlayer(g,'b'); addPlayer(g,'c');
  assert.equal(g.phase,'playing'); assert.throws(() => addPlayer(g,'d'));
});
test('eight players rotate and snapshots hide socket identities', () => {
  const g=full(8);
  for(let i=0;i<8;i++) { roll(g,`socket${i}`,g.version,()=>1); assert.equal(g.turn,(i+1)%8); }
  assert.ok(snapshot(g).players.every(p => !('socketId' in p)));
});
test('membership, turns and repeated requests are enforced without mutation', () => {
  const g=full(); const before=JSON.stringify(g);
  assert.throws(() => roll(g,'intruder',g.version));
  assert.throws(() => roll(g,'socket1',g.version));
  assert.equal(JSON.stringify(g),before);
  const version=g.version; roll(g,'socket0',version,()=>2);
  assert.throws(() => roll(g,'socket0',version,()=>2));
});
test('snake and ladder apply to rolling player before turn advances', () => {
  const g=full(); roll(g,'socket0',g.version,()=>5);
  assert.equal(g.players[0].position,24); assert.equal(g.players[1].position,1);
  g.players[1].position=18; roll(g,'socket1',g.version,()=>1);
  assert.equal(g.players[1].position,4); assert.equal(g.turn,2);
});
test('overshoot stays put, six advances turn, exact finish ends play', () => {
  const g=full(); g.players[0].position=99;
  roll(g,'socket0',g.version,()=>6); assert.equal(g.players[0].position,99); assert.equal(g.turn,1);
  g.players[1].position=99; roll(g,'socket1',g.version,()=>1);
  assert.equal(g.winnerId,g.players[1].id); assert.equal(g.phase,'finished');
  assert.throws(() => roll(g,'socket2',g.version));
});
