const { RequestError } = require('./operations');
const { randomInt, randomUUID } = require('crypto');
const ladders = [[10,12],[11,33],[20,38],[6,24],[40,59],[45,54],[64,78],[72,91],[86,96]];
const snakes = [[19,4],[13,7],[48,14],[57,36],[68,49],[83,61],[87,66],[94,88],[98,84]];
const transitions = new Map([...ladders, ...snakes]);
function createGame(roomId, capacity) {
  if (!Number.isInteger(capacity) || capacity < 2 || capacity > 8) throw new RequestError('Choose between 2 and 8 players.');
  return { roomId, capacity, players: [], phase: 'waiting', turn: 0, version: 0, winnerId: null, lastMove: null, busyUntil: 0, rematchVotes: [], ladders, snakes };
}
function addPlayer(game, socketId) {
  if (game.players.some(p => p.socketId === socketId)) throw new RequestError('You already joined this room.');
  if (game.phase !== 'waiting' || game.players.length >= game.capacity) throw new RequestError('Room is full or the game has started.');
  const player = { id: randomUUID(), socketId, token: randomUUID(), connected: true, forfeited: false, position: 1 };
  game.players.push(player);
  if (game.players.length === game.capacity) game.phase = 'playing';
  game.version++;
  return player;
}
function roll(game, socketId, version, dice = () => randomInt(1,7)) {
  if (!game.players.some(p => p.socketId === socketId)) throw new RequestError('You are not a member of this room.');
  if (game.phase !== 'playing') throw new RequestError(game.phase === 'finished' ? 'This game has finished.' : 'Waiting for all players.');
  if (game.players.some(p => !p.forfeited && !p.connected)) throw new RequestError('Waiting for disconnected players to return.');
  if (Date.now() < game.busyUntil) throw new RequestError('Wait for the move animation to finish.');
  if (version !== game.version) throw new RequestError('Game state changed. Please try again.');
  const player = game.players[game.turn];
  if (player.socketId !== socketId) throw new RequestError('It is not your turn.');
  const value = dice();
  const from = player.position;
  const landed = from + value > 100 ? from : from + value;
  player.position = landed === from ? from : (transitions.get(landed) || landed);
  game.version++;
  game.lastMove = { number: game.version, playerId: player.id, roll: value, from, landed, to: player.position };
  if (player.position === 100) { game.phase = 'finished'; game.winnerId = player.id; }
  else { do { game.turn = (game.turn + 1) % game.players.length; } while (game.players[game.turn].forfeited); }
}
function snapshot(game) {
  return { ...game, serverTime: Date.now(), players: game.players.map(({socketId, token, ...player}) => player) };
}
module.exports = { createGame, addPlayer, roll, snapshot };
