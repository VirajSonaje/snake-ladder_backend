const { Server } = require('socket.io');
const { randomBytes } = require('crypto');
const { networkInterfaces } = require('os');
const { createGame, addPlayer, roll, snapshot } = require('./game');
function lanOrigins() {
  return ['http://localhost:3000', ...Object.values(networkInterfaces()).flat().filter(a => a.family === 'IPv4' && !a.internal).map(a => `http://${a.address}:3000`)];
}
function createServer(options = {}) {
  const io = new Server(options.port ?? Number(process.env.PORT || 3500), {
    cors: { origin: options.origins || (process.env.FRONTEND_ORIGINS ? process.env.FRONTEND_ORIGINS.split(',') : lanOrigins()) }
  });
  const rooms = new Map(), timers = new Map();
  const graceMs = options.graceMs ?? 120000;
  const publish = game => io.to(game.roomId).emit('game-state', snapshot(game));
  function cancel(player) { clearTimeout(timers.get(player.id)); timers.delete(player.id); }
  function depart(game, player) {
    cancel(player);
    player.connected = false; player.forfeited = true; player.socketId = null; player.token = null;
    game.rematchVotes = [];
    if (game.phase === 'waiting') game.players = game.players.filter(p => p !== player);
    else if (game.phase === 'playing') {
      const remaining = game.players.filter(p => !p.forfeited);
      if (remaining.length < 2) { game.phase = 'finished'; game.winnerId = remaining[0]?.id || null; }
      else if (game.players[game.turn] === player) {
        do { game.turn = (game.turn + 1) % game.players.length; } while (game.players[game.turn].forfeited);
      }
    }
    game.version++;
    if (!game.players.some(p => !p.forfeited)) rooms.delete(game.roomId);
    else publish(game);
  }
  io.on('connection', socket => {
    function handle(event, action) {
      socket.on(event, (payload, ack) => {
        if (typeof ack !== 'function') return;
        try { ack({ ok: true, ...action(payload || {}) }); }
        catch (error) { ack({ ok: false, error: error.message }); }
      });
    }
    function available() { if (socket.data.roomId) throw Error('You already belong to a room.'); }
    function membership(roomId) {
      const game = rooms.get(roomId);
      const player = game?.players.find(p => p.socketId === socket.id && !p.forfeited);
      if (!game || socket.data.roomId !== roomId || !player) throw Error('You are not a member of this room.');
      return {game, player};
    }
    function admit(game, player) {
      socket.data.roomId = game.roomId; socket.join(game.roomId); publish(game);
      return {playerId:player.id, token:player.token, state:snapshot(game)};
    }
    handle('create-room', ({capacity}) => {
      available(); let roomId;
      do { roomId = randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(roomId));
      const game = createGame(roomId, capacity), player = addPlayer(game, socket.id);
      rooms.set(roomId, game); return admit(game, player);
    });
    handle('join-room', ({roomId}) => {
      available();
      if (typeof roomId !== 'string' || !/^[A-F0-9]{6}$/.test(roomId)) throw Error('Enter a valid six-character room code.');
      const game = rooms.get(roomId); if (!game) throw Error('Room not found.');
      return admit(game, addPlayer(game, socket.id));
    });
    handle('resume-room', ({roomId, token}) => {
      const game = rooms.get(roomId);
      const player = typeof token === 'string' && game?.players.find(p => p.token === token && !p.forfeited);
      if (!player) throw Error('Your saved game expired. Create or join a new room.');
      if (socket.data.roomId === roomId && player.socketId === socket.id) return {playerId:player.id, token:player.token, state:snapshot(game)};
      available();
      if (player.disconnectedUntil && Date.now() >= player.disconnectedUntil) { depart(game,player); throw Error('Your reconnect time expired.'); }
      // Replace the old socket without letting its disconnect event mark the restored player offline.
      const old = io.sockets.sockets.get(player.socketId);
      if (old && old !== socket) { old.data.roomId = null; old.leave(roomId); old.disconnect(true); }
      cancel(player); player.socketId = socket.id; player.connected = true; delete player.disconnectedUntil;
      game.version++; return admit(game, player);
    });
    handle('roll', ({roomId, version}) => {
      const {game} = membership(roomId); roll(game, socket.id, version, options.dice);
      const diceMs=options.animationMs === undefined ? 1500 : 0;
      const duration = options.animationMs ?? (diceMs + (game.lastMove.landed - game.lastMove.from) * 160 + (game.lastMove.to !== game.lastMove.landed ? 700 : 0) + 180);
      game.lastMove.diceMs = diceMs;
      game.lastMove.startedAt = Date.now(); game.lastMove.duration = duration;
      game.busyUntil = game.lastMove.startedAt + duration;
      publish(game); return {state:snapshot(game)};
    });
    handle('leave-room', ({roomId}) => {
      const {game, player} = membership(roomId);
      socket.leave(roomId); socket.data.roomId = null; depart(game, player); return {};
    });
    handle('rematch', ({roomId}) => {
      const {game, player} = membership(roomId);
      if (game.phase !== 'finished') throw Error('Finish this game before requesting a rematch.');
      const active = game.players.filter(p => !p.forfeited);
      if (active.length < 2 || active.some(p => !p.connected)) throw Error('At least two connected players are needed.');
      if (!game.rematchVotes.includes(player.id)) game.rematchVotes.push(player.id);
      if (active.every(p => game.rematchVotes.includes(p.id))) {
        game.players = active; game.capacity = active.length;
        game.players.forEach(p => {p.position = 1;});
        game.phase = 'playing'; game.turn = 0; game.winnerId = null; game.lastMove = null; game.busyUntil = 0; game.rematchVotes = [];
      }
      game.version++; publish(game); return {state:snapshot(game)};
    });
    socket.on('disconnect', () => {
      const game = rooms.get(socket.data.roomId), player = game?.players.find(p => p.socketId === socket.id && !p.forfeited);
      if (!player) return;
      player.connected = false; player.disconnectedUntil = Date.now() + graceMs; game.version++; publish(game);
      cancel(player);
      const timer = setTimeout(() => depart(game,player), graceMs); timer.unref(); timers.set(player.id,timer);
    });
  });
  io.httpServer.on('close', () => {for (const timer of timers.values()) clearTimeout(timer); timers.clear();});
  return { io, rooms };
}
if (require.main === module) createServer();
module.exports = { createServer };
