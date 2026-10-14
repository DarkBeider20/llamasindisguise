'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { createGame } = require('./src/engine');
const { BOT_NAMES, MAX_SEATS, MAX_SPECTATORS, targetFor } = require('./src/data');

const PORT = process.env.PORT || 3000;
const app = express();
// La página se sirve con un número de versión en el enlace a app.js: cada deploy obliga al navegador
// a bajar el app.js nuevo aunque tenga uno viejo guardado.
const PUB = path.join(__dirname, 'public');
// Si falta algún archivo (por ejemplo, uno nuevo que no se subió), el servidor avisa en el log pero no se cae.
const readOr = (f, fallback = '') => { try { return fs.readFileSync(path.join(PUB, f)); } catch (_) { console.warn(`Aviso: falta public/${f}`); return fallback; } };
const BUILD = crypto.createHash('sha1')
  .update(readOr('app.js')).update(readOr('music.js')).update(readOr('index.html'))
  .digest('hex').slice(0, 8);
const INDEX = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8').replace(/__V__/g, BUILD);
const sendIndex = (_req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.type('html').send(INDEX); };
app.get(['/', '/index.html'], sendIndex);
// HTML y JS siempre se revalidan (así cada deploy se ve al instante); las imágenes se guardan 7 días.
app.use(express.static(PUB, {
  index: false,
  setHeaders: (res, file) => {
    if (/\.(html|js|css)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'public, max-age=604800');
  },
}));
app.get('/health', (_req, res) => res.send('ok'));
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 20000, pingTimeout: 25000 });

/* ---------------- salas ---------------- */
// room = { code, host(token), seats:[{token,uid,name,bot,sid}], watchers:[{token,uid,name,sid,wants}], opts:{short}, game, phase:'lobby'|'playing'|'over', prompts:Map, idleSince }
// Los espectadores (watchers) ven la mesa sin ninguna mano; `wants` = quieren jugar en la próxima partida.
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function newCode() {
  for (;;) {
    let c = ''; for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.random() * CODE_CHARS.length | 0];
    if (!rooms.has(c)) return c;
  }
}
const cleanName = s => String(s || '').replace(/[<>]/g, '').trim().slice(0, 16) || 'Jugador';
const seatOf = (room, token) => room.seats.findIndex(s => !s.bot && s.token === token);
const watchOf = (room, token) => room.watchers.findIndex(w => w.token === token);
const humans = room => room.seats.filter(s => !s.bot).concat(room.watchers);
const newUid = () => crypto.randomBytes(4).toString('hex');
const memberOf = (room, token) => room.seats.find(s => !s.bot && s.token === token) || room.watchers.find(w => w.token === token) || null;

function roomInfo(room, token) {
  const m = memberOf(room, token);
  return {
    code: room.code, phase: room.phase, opts: room.opts, max: MAX_SEATS, maxWatch: MAX_SPECTATORS,
    you: seatOf(room, token), watching: watchOf(room, token) >= 0, uid: m ? m.uid : null,
    host: seatOf(room, room.host), isHost: room.host === token,
    target: targetFor(room.seats.length, room.opts.short),
    seats: room.seats.map(s => ({ name: s.name, bot: s.bot, online: s.bot || !!s.sid, uid: s.uid || null, host: !s.bot && s.token === room.host })),
    watchers: room.watchers.map(w => ({ name: w.name, online: !!w.sid, uid: w.uid, wants: !!w.wants, host: w.token === room.host })),
  };
}
function sendRoom(room) {
  for (const s of room.seats) if (s.sid) io.to(s.sid).emit('room', roomInfo(room, s.token));
  for (const w of room.watchers) if (w.sid) io.to(w.sid).emit('room', roomInfo(room, w.token));
}
// Al volver a la sala (o al pedir revancha), los espectadores que quieren jugar ocupan los asientos libres.
function promoteWatchers(room) {
  for (const w of [...room.watchers]) {
    if (room.seats.length >= MAX_SEATS) break;
    if (!w.wants || !w.sid) continue;
    room.watchers.splice(room.watchers.indexOf(w), 1);
    room.seats.push({ token: w.token, uid: w.uid, name: w.name, bot: false, sid: w.sid });
  }
}
let pendingState = new Set();
function sendState(room) {
  if (pendingState.has(room)) return;
  pendingState.add(room);
  setImmediate(() => {
    pendingState.delete(room);
    if (!room.game) return;
    room.seats.forEach((s, i) => { if (s.sid) io.to(s.sid).emit('state', room.game.view(i)); });
    const live = room.watchers.filter(w => w.sid);
    if (live.length) { const v = room.game.view(-1); live.forEach(w => io.to(w.sid).emit('state', v)); }
  });
}
function pickHost(room) {
  const next = room.seats.find(s => !s.bot && s.sid) || room.watchers.find(w => w.sid) || room.seats.find(s => !s.bot) || room.watchers[0];
  room.host = next ? next.token : null;
}

let pid = 0;
function startGame(room) {
  if (room.game) room.game.destroy();
  for (const pr of room.prompts.values()) { clearTimeout(pr.timer); pr.resolve(undefined); }
  room.prompts.clear();
  room.phase = 'playing';
  const hooks = {
    change: () => sendState(room),
    toast: (seat, msg, cls) => {
      if (seat === null) io.to(room.code).emit('toast', { msg, cls });
      else { const s = room.seats[seat]; if (s && s.sid) io.to(s.sid).emit('toast', { msg, cls }); }
    },
    attack: (card, text) => io.to(room.code).emit('attack', { card, text }),
    prompt: (seat, prompt, ms) => new Promise(resolve => {
      const id = ++pid;
      const pr = { id, seat, prompt, resolve, deadline: Date.now() + ms };
      pr.timer = setTimeout(() => finishPrompt(room, id, undefined), ms);
      room.prompts.set(id, pr);
      const s = room.seats[seat];
      if (s && s.sid) io.to(s.sid).emit('prompt', { id, ...prompt, ms });
      else finishPrompt(room, id, undefined);
    }),
    over: () => { room.phase = 'over'; sendRoom(room); },
  };
  room.game = createGame(room.seats.map(s => ({ name: s.name, bot: s.bot })), { ...room.opts, fast: process.env.FAST === '1' }, hooks);
  room.seats.forEach((s, i) => { if (!s.bot && !s.sid) room.game.setConnected(i, false); });
  sendRoom(room); sendState(room);
}
function finishPrompt(room, id, value) {
  const pr = room.prompts.get(id); if (!pr) return;
  clearTimeout(pr.timer); room.prompts.delete(id);
  const s = room.seats[pr.seat]; if (s && s.sid) io.to(s.sid).emit('promptClose', { id });
  pr.resolve(value);
}

/* ---------------- conexiones ---------------- */
io.on('connection', socket => {
  let token = null, room = null;

  const fail = (cb, msg) => cb && cb({ error: msg });
  const enter = (r, cb, extra) => {
    room = r; socket.join(r.code);
    const i = seatOf(r, token);
    socket.emit('chatHistory', r.chat || []);
    if (i < 0) { // espectador
      const w = r.watchers[watchOf(r, token)]; w.sid = socket.id;
      if (r.game && r.phase !== 'lobby') socket.emit('state', r.game.view(-1));
      sendRoom(r);
      return cb && cb({ ok: true, code: r.code, watching: true, ...extra });
    }
    r.seats[i].sid = socket.id;
    if (r.game && r.phase !== 'lobby') {
      r.game.setConnected(i, true);
      socket.emit('state', r.game.view(i));
      for (const pr of r.prompts.values()) if (pr.seat === i) socket.emit('prompt', { id: pr.id, ...pr.prompt, ms: Math.max(1000, pr.deadline - Date.now()) });
    }
    sendRoom(r);
    cb && cb({ ok: true, code: r.code });
  };
  const leaveCurrent = () => {
    if (!room) return;
    const r = room; room = null; socket.leave(r.code);
    const wi = watchOf(r, token);
    if (wi >= 0) { r.watchers.splice(wi, 1); if (r.host === token) pickHost(r); if (!humans(r).some(s => s.sid)) r.idleSince = Date.now(); return sendRoom(r); }
    const i = seatOf(r, token);
    if (i < 0) return;
    if (r.phase === 'lobby') r.seats.splice(i, 1);
    else { r.seats[i].sid = null; r.game && r.game.setConnected(i, false); }
    if (r.host === token) pickHost(r);
    if (!humans(r).some(s => s.sid)) r.idleSince = Date.now();
    sendRoom(r);
  };

  socket.on('hello', ({ token: t } = {}) => { token = String(t || '').slice(0, 64) || null; });

  socket.on('create', ({ name } = {}, cb) => {
    if (!token) return fail(cb, 'Recarga la página.');
    leaveCurrent();
    const r = { code: newCode(), host: token, seats: [{ token, uid: newUid(), name: cleanName(name), bot: false, sid: null }], watchers: [], opts: { short: false }, game: null, phase: 'lobby', prompts: new Map(), idleSince: 0, chat: [] };
    rooms.set(r.code, r);
    enter(r, cb);
  });

  // mode: 'play' (jugar) o 'watch' (mirar). Si la partida ya empezó y quiere jugar, mira y entra en la próxima.
  socket.on('join', ({ code, name, mode } = {}, cb) => {
    if (!token) return fail(cb, 'Recarga la página.');
    const r = rooms.get(String(code || '').toUpperCase().trim());
    if (!r) return fail(cb, 'No existe una sala con ese código.');
    if (room && room !== r) leaveCurrent();
    const i = seatOf(r, token);
    if (i >= 0) { if (name) r.seats[i].name = r.phase === 'lobby' ? cleanName(name) : r.seats[i].name; return enter(r, cb); }
    const wi = watchOf(r, token);
    if (wi >= 0) { if (name) r.watchers[wi].name = cleanName(name); return enter(r, cb); }
    const watch = mode === 'watch';
    if (!watch && r.phase === 'lobby') {
      if (r.seats.length >= MAX_SEATS) return fail(cb, `La sala está llena (máximo ${MAX_SEATS} jugadores). Puedes entrar a mirar.`);
      r.seats.push({ token, uid: newUid(), name: cleanName(name), bot: false, sid: null });
      if (!r.host) r.host = token;
      return enter(r, cb);
    }
    if (r.watchers.length >= MAX_SPECTATORS) return fail(cb, `Ya hay ${MAX_SPECTATORS} espectadores en esa sala.`);
    r.watchers.push({ token, uid: newUid(), name: cleanName(name), sid: null, wants: !watch });
    if (!r.host) r.host = token;
    enter(r, cb, { queued: !watch });
  });
  // Cambiar entre jugar y mirar. En la sala de espera es inmediato; durante la partida, un espectador
  // solo marca si quiere entrar en la próxima.
  socket.on('mode', ({ mode } = {}, cb) => {
    if (!room) return fail(cb, 'No estás en una sala.');
    const r = room, i = seatOf(r, token), wi = watchOf(r, token);
    if (mode === 'watch' && i >= 0) {
      if (r.phase !== 'lobby') return fail(cb, 'No puedes dejar tu asiento en plena partida.');
      if (r.watchers.length >= MAX_SPECTATORS) return fail(cb, 'Ya no caben más espectadores.');
      const s = r.seats.splice(i, 1)[0];
      r.watchers.push({ token, uid: s.uid || newUid(), name: s.name, sid: s.sid, wants: false });
    } else if (mode === 'play' && wi >= 0) {
      const w = r.watchers[wi];
      if (r.phase === 'lobby') {
        if (r.seats.length >= MAX_SEATS) return fail(cb, `La sala está llena (máximo ${MAX_SEATS} jugadores).`);
        r.watchers.splice(wi, 1);
        r.seats.push({ token, uid: w.uid, name: w.name, bot: false, sid: w.sid });
      } else w.wants = true;
    } else if (mode === 'watch' && wi >= 0) r.watchers[wi].wants = false;
    sendRoom(r); cb && cb({ ok: true });
  });

  socket.on('leave', (_d, cb) => { leaveCurrent(); cb && cb({ ok: true }); });

  const hostOnly = (cb) => {
    if (!room) { fail(cb, 'No estás en una sala.'); return false; }
    const h = memberOf(room, room.host);
    if (!h || !h.sid) pickHost(room); // si el anfitrión se fue, lo hereda alguien conectado
    if (room.host !== token) { fail(cb, 'Solo el anfitrión puede hacer eso.'); return false; }
    return true;
  };
  socket.on('addBot', (_d, cb) => {
    if (!hostOnly(cb)) return;
    if (room.phase !== 'lobby') return fail(cb, 'Solo en la sala de espera.');
    if (room.seats.length >= MAX_SEATS) return fail(cb, `Máximo ${MAX_SEATS} jugadores.`);
    const used = new Set(room.seats.map(s => s.name));
    const name = BOT_NAMES.find(b => !used.has(b)) || `Bot ${room.seats.length}`;
    room.seats.push({ token: null, name, bot: true, sid: null });
    sendRoom(room); cb && cb({ ok: true });
  });
  socket.on('kick', ({ seat, watcher } = {}, cb) => {
    if (!hostOnly(cb)) return;
    if (watcher) {
      const wi = room.watchers.findIndex(w => w.uid === watcher); const w = room.watchers[wi];
      if (!w || w.token === token) return fail(cb, 'No se puede.');
      room.watchers.splice(wi, 1);
      if (w.sid) { const so = io.sockets.sockets.get(w.sid); if (so) { so.leave(room.code); so.emit('kicked'); } }
      sendRoom(room); return cb && cb({ ok: true });
    }
    if (room.phase !== 'lobby') return fail(cb, 'Solo en la sala de espera.');
    const s = room.seats[seat]; if (!s || s.token === token) return fail(cb, 'No se puede.');
    room.seats.splice(seat, 1);
    if (!s.bot && s.sid) { const so = io.sockets.sockets.get(s.sid); if (so) { so.leave(room.code); so.emit('kicked'); } }
    sendRoom(room); cb && cb({ ok: true });
  });
  socket.on('opts', ({ short } = {}, cb) => {
    if (!hostOnly(cb)) return;
    if (room.phase !== 'lobby') return fail(cb, 'Solo en la sala de espera.');
    room.opts.short = !!short; sendRoom(room); cb && cb({ ok: true });
  });
  socket.on('start', (_d, cb) => {
    if (!hostOnly(cb)) return;
    if (room.phase === 'playing') return fail(cb, 'La partida ya empezó.');
    if (room.phase === 'over') { room.seats = room.seats.filter(s => s.bot || s.sid); promoteWatchers(room); }
    if (room.seats.length < 2) return fail(cb, 'Hacen falta al menos 2 jugadores (puedes agregar bots).');
    startGame(room); cb && cb({ ok: true });
  });
  socket.on('toLobby', (_d, cb) => {
    if (!hostOnly(cb)) return;
    if (room.game) room.game.destroy();
    room.game = null; room.phase = 'lobby';
    room.seats = room.seats.filter(s => s.bot || s.sid);
    promoteWatchers(room);
    sendRoom(room); io.to(room.code).emit('state', null); cb && cb({ ok: true });
  });

  socket.on('intent', async (msg, cb) => {
    if (!room || !room.game) return fail(cb, 'No hay partida.');
    const i = seatOf(room, token); if (i < 0) return fail(cb, 'No estás en esta partida.');
    try { const r = await room.game.intent(i, msg || {}); cb && cb(r); }
    catch (e) { console.error(e); fail(cb, 'Error del servidor.'); }
  });
  // Chat de la sala: se guarda solo en memoria (últimos 50 mensajes).
  let lastChat = 0;
  // Emotes: burbujas sobre el avatar, no se guardan. Máximo uno cada 2 segundos por jugador.
  const EMOTES = ['risa', 'gg', 'mald', 'llanto', 'zzz', 'pensando', 'sudor', 'aplauso', 'apura'];
  let lastEmote = 0;
  socket.on('emote', ({ id } = {}, cb) => {
    if (!room) return fail(cb, 'No estás en una sala.');
    const m = memberOf(room, token); if (!m) return fail(cb, 'No estás en esta sala.');
    const i = seatOf(room, token);
    if (!EMOTES.includes(id)) return fail(cb, 'Emote desconocido.');
    const now = Date.now(); if (now - lastEmote < 2000) return fail(cb, 'Espera un momento.');
    lastEmote = now;
    io.to(room.code).emit('emote', { seat: i, uid: m.uid, w: i < 0, id });
    cb && cb({ ok: true });
  });

  socket.on('chat', ({ text, react } = {}, cb) => {
    if (!room) return fail(cb, 'No estás en una sala.');
    const m = memberOf(room, token); if (!m) return fail(cb, 'No estás en esta sala.');
    const i = seatOf(room, token);
    const now = Date.now();
    if (now - lastChat < 700) return fail(cb, 'Más despacio.');
    const clean = String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
    if (!clean) return fail(cb, 'Mensaje vacío.');
    lastChat = now;
    const msg = { seat: i, uid: m.uid, w: i < 0, name: m.name, text: clean, react: !!react, ts: now };
    room.chat = room.chat || []; room.chat.push(msg); if (room.chat.length > 50) room.chat.shift();
    io.to(room.code).emit('chat', msg);
    cb && cb({ ok: true });
  });

  socket.on('answer', ({ id, value } = {}) => {
    if (!room) return;
    const pr = room.prompts.get(id); if (!pr) return;
    if (pr.seat !== seatOf(room, token)) return;
    finishPrompt(room, id, value);
  });

  socket.on('disconnect', () => {
    if (!room) return;
    const r = room, wi = watchOf(r, token);
    if (wi >= 0) {
      const w = r.watchers[wi]; if (w.sid !== socket.id) return;
      w.sid = null;
      // Un espectador que no vuelve en 20 s deja la sala.
      setTimeout(() => { const j = watchOf(r, token); if (j >= 0 && !r.watchers[j].sid) { r.watchers.splice(j, 1); if (r.host === token) pickHost(r); sendRoom(r); } }, 20000);
      if (!humans(r).some(s => s.sid)) r.idleSince = Date.now();
      return sendRoom(r);
    }
    const i = seatOf(r, token);
    if (i < 0 || r.seats[i].sid !== socket.id) return;
    r.seats[i].sid = null;
    if (r.phase === 'lobby') {
      // En la sala de espera, si no vuelve en 20 s, libera el asiento.
      setTimeout(() => {
        const j = seatOf(r, token);
        if (j >= 0 && !r.seats[j].sid && r.phase === 'lobby') { r.seats.splice(j, 1); if (r.host === token) pickHost(r); sendRoom(r); }
      }, 20000);
    } else {
      r.game && r.game.setConnected(i, false);
      for (const pr of [...r.prompts.values()]) if (pr.seat === i) finishPrompt(r, pr.id, undefined);
    }
    if (!humans(r).some(s => s.sid)) r.idleSince = Date.now();
    sendRoom(r);
  });
});

// Limpieza: borra salas sin humanos conectados durante 15 minutos.
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    const anyone = humans(r).some(s => s.sid);
    if (!anyone && r.idleSince && now - r.idleSince > 15 * 60 * 1000) { r.game && r.game.destroy(); rooms.delete(code); }
    if (!humans(r).length) { r.game && r.game.destroy(); rooms.delete(code); }
  }
}, 60 * 1000);

server.listen(PORT, () => console.log(`Rebaño de Incógnito (versión ${BUILD}) escuchando en http://localhost:${PORT}`));
