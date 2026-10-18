const { Server } = require('socket.io');
const { createServer: createHttpServer } = require('http');
const { createLimiter, RequestError } = require('./operations');
const { randomBytes } = require('crypto');
const { networkInterfaces } = require('os');
const { createGame, addPlayer, roll, snapshot } = require('./game');
function lanOrigins() {
  return ['http://localhost:3000', ...Object.values(networkInterfaces()).flat().filter(a => a.family === 'IPv4' && !a.internal).map(a => `http://${a.address}:3000`)];
}
function createServer(options = {}) {
  const rooms = new Map(), timers = new Map();
  const startedAt=Date.now();
  const logger=options.logger || (record=>console.log(JSON.stringify(record)));
  function log(level,event,details={}) {
    try {logger({time:new Date().toISOString(),level,event,...details});} catch { /* Logging cannot interrupt a turn. */ }
  }
  const httpServer=createHttpServer((request,response)=>{
    if (request.method==='GET' && request.url==='/health') {
      response.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
      response.end(JSON.stringify({status:'ok',uptimeSeconds:Math.floor((Date.now()-startedAt)/1000),rooms:rooms.size,connections:io.engine.clientsCount}));
    } else {response.writeHead(404,{'Content-Type':'application/json'});response.end(JSON.stringify({error:'Not found'}));}
  });
  const io = new Server(httpServer, {
    maxHttpBufferSize:16384,
    cors: { origin: options.origins || (process.env.FRONTEND_ORIGINS ? process.env.FRONTEND_ORIGINS.split(',') : lanOrigins()) }
  });
  const windowMs=options.rateLimit?.windowMs ?? 10000;
  const socketLimit=createLimiter({limit:options.rateLimit?.perSocket ?? 30,windowMs});
  const addressLimit=createLimiter({limit:options.rateLimit?.perAddress ?? 150,windowMs});
  const sweep=setInterval(()=>{socketLimit.sweep();addressLimit.sweep();},windowMs);
  sweep.unref();
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
    log('info','player_forfeited',{roomId:game.roomId});
    if (!game.players.some(p => !p.forfeited)) {rooms.delete(game.roomId);log('info','room_deleted',{roomId:game.roomId});}
    else publish(game);
  }
  io.on('connection', socket => {
    function handle(event, action) {
      socket.on(event, (payload, ack) => {
        const local=socketLimit.consume(socket.id), shared=addressLimit.consume(socket.handshake.address);
        if (!local.allowed || !shared.allowed) {
          if(local.firstDenied || shared.firstDenied) log('warn','rate_limited',{action:event,roomId:socket.data.roomId});
          if(typeof ack==='function') ack({ok:false,error:'Too many requests. Please wait before trying again.',retryAfterMs:Math.max(!local.allowed?local.retryAfterMs:0,!shared.allowed?shared.retryAfterMs:0)});
          return;
        }
        if (typeof ack !== 'function') return;
        if (!payload || typeof payload!=='object' || Array.isArray(payload)) {
          log('warn','request_rejected',{action:event,reason:'invalid_payload'});
          ack({ok:false,error:'Invalid request.'});return;
        }
        try {
          const result=action(payload);
          if(event==='roll' && result.state.phase==='finished') log('info','game_finished',{roomId:socket.data.roomId});
          ack({ok:true,...result});
        } catch (error) {
          const unexpected=!(error instanceof RequestError);
          log(unexpected?'error':'warn',unexpected?'request_failed':'request_rejected',{action:event,roomId:socket.data.roomId,reason:unexpected?error.name:error.message});
          ack({ok:false,error:unexpected?'The server could not complete this request. Please try again.':error.message});
        }
      });
    }
    function available() { if (socket.data.roomId) throw new RequestError('You already belong to a room.'); }
    function membership(roomId) {
      const game = rooms.get(roomId);
      const player = game?.players.find(p => p.socketId === socket.id && !p.forfeited);
      if (!game || socket.data.roomId !== roomId || !player) throw new RequestError('You are not a member of this room.');
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
      rooms.set(roomId, game);log('info','room_created',{roomId,capacity}); return admit(game, player);
    });
    handle('join-room', ({roomId}) => {
      available();
      if (typeof roomId !== 'string' || !/^[A-F0-9]{6}$/.test(roomId)) throw new RequestError('Enter a valid six-character room code.');
      const game = rooms.get(roomId); if (!game) throw new RequestError('Room not found.');
      const player=addPlayer(game,socket.id);log('info','player_joined',{roomId,players:game.players.length});
      return admit(game,player);
    });
    handle('resume-room', ({roomId, token}) => {
      const game = rooms.get(roomId);
      const player = typeof token === 'string' && game?.players.find(p => p.token === token && !p.forfeited);
      if (!player) throw new RequestError('Your saved game expired. Create or join a new room.');
      if (socket.data.roomId === roomId && player.socketId === socket.id) return {playerId:player.id, token:player.token, state:snapshot(game)};
      available();
      if (player.disconnectedUntil && Date.now() >= player.disconnectedUntil) { depart(game,player); throw new RequestError('Your reconnect time expired.'); }
      // Replace the old socket without letting its disconnect event mark the restored player offline.
      const old = io.sockets.sockets.get(player.socketId);
      if (old && old !== socket) { old.data.roomId = null; old.leave(roomId); old.disconnect(true); }
      cancel(player); player.socketId = socket.id; player.connected = true; delete player.disconnectedUntil;
      game.version++; log('info','player_resumed',{roomId}); return admit(game, player);
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
      if (game.phase !== 'finished') throw new RequestError('Finish this game before requesting a rematch.');
      const active = game.players.filter(p => !p.forfeited);
      if (active.length < 2 || active.some(p => !p.connected)) throw new RequestError('At least two connected players are needed.');
      if (!game.rematchVotes.includes(player.id)) game.rematchVotes.push(player.id);
      if (active.every(p => game.rematchVotes.includes(p.id))) {
        game.players = active; game.capacity = active.length;
        game.players.forEach(p => {p.position = 1;});
        log('info','rematch_started',{roomId});
        game.phase = 'playing'; game.turn = 0; game.winnerId = null; game.lastMove = null; game.busyUntil = 0; game.rematchVotes = [];
      }
      game.version++; publish(game); return {state:snapshot(game)};
    });
    socket.on('disconnect', () => {
      socketLimit.remove(socket.id);
      const game = rooms.get(socket.data.roomId), player = game?.players.find(p => p.socketId === socket.id && !p.forfeited);
      if (!player) return;
      log('info','player_disconnected',{roomId:game.roomId});
      player.connected = false; player.disconnectedUntil = Date.now() + graceMs; game.version++; publish(game);
      cancel(player);
      const timer = setTimeout(() => depart(game,player), graceMs); timer.unref(); timers.set(player.id,timer);
    });
  });
  httpServer.on('close', () => {
    clearInterval(sweep);socketLimit.clear();addressLimit.clear();
    for (const timer of timers.values()) clearTimeout(timer); timers.clear();
    log('info','server_stopped');
  });
  httpServer.on('error',error=>{log('error','server_error',{code:error.code || 'UNKNOWN'});if(require.main===module) process.exitCode=1;io.close();});
  httpServer.listen(options.port ?? Number(process.env.PORT || 3500),()=>log('info','server_started',{port:httpServer.address().port}));
  return { io, rooms };
}
if (require.main === module) {
  const {io}=createServer();
  for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>io.close());
}
module.exports = { createServer };
