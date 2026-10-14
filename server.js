'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { createGame } = require('./src/engine');
const { BOT_NAMES, MAX_SEATS, targetFor } = require('./src/data');

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
// room = { code, host(token), seats:[{token,name,bot,sid}], opts:{short}, game, phase:'lobby'|'playing'|'over', prompts:Map, idleSince }
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
const humans = room => room.seats.filter(s => !s.bot);

function roomInfo(room, token) {
  return {
    code: room.code, phase: room.phase, opts: room.opts, max: MAX_SEATS,
    you: seatOf(room, token), host: seatOf(room, room.host),
    target: targetFor(room.seats.length, room.opts.short),
    seats: room.seats.map(s => ({ name: s.name, bot: s.bot, online: s.bot || !!s.sid })),
  };
}
function sendRoom(room) {
  for (const s of room.seats) if (s.sid) io.to(s.sid).emit('room', roomInfo(room, s.token));
}
let pendingState = new Set();
function sendState(room) {
  if (pendingState.has(room)) return;
  pendingState.add(room);
  setImmediate(() => {
    pendingState.delete(room);
    if (!room.game) return;
    room.seats.forEach((s, i) => { if (s.sid) io.to(s.sid).emit('state', room.game.view(i)); });
  });
}
function pickHost(room) {
  const next = room.seats.find(s => !s.bot && s.sid) || room.seats.find(s => !s.bot);
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
  const enter = (r, cb) => {
    room = r; socket.join(r.code);
    const i = seatOf(r, token);
    r.seats[i].sid = socket.id;
    socket.emit('chatHistory', r.chat || []);
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
    const r = { code: newCode(), host: token, seats: [{ token, name: cleanName(name), bot: false, sid: null }], opts: { short: false }, game: null, phase: 'lobby', prompts: new Map(), idleSince: 0, chat: [] };
    rooms.set(r.code, r);
    enter(r, cb);
  });

  socket.on('join', ({ code, name } = {}, cb) => {
    if (!token) return fail(cb, 'Recarga la página.');
    const r = rooms.get(String(code || '').toUpperCase().trim());
    if (!r) return fail(cb, 'No existe una sala con ese código.');
    if (room && room !== r) leaveCurrent();
    const i = seatOf(r, token);
    if (i >= 0) { if (name) r.seats[i].name = r.phase === 'lobby' ? cleanName(name) : r.seats[i].name; return enter(r, cb); }
    if (r.phase !== 'lobby') return fail(cb, 'Esa sala ya está jugando. Espera a que vuelvan a la sala.');
    if (r.seats.length >= MAX_SEATS) return fail(cb, `La sala está llena (máximo ${MAX_SEATS}).`);
    r.seats.push({ token, name: cleanName(name), bot: false, sid: null });
    if (!r.host) r.host = token;
    enter(r, cb);
  });

  socket.on('leave', (_d, cb) => { leaveCurrent(); cb && cb({ ok: true }); });

  const hostOnly = (cb) => {
    if (!room) { fail(cb, 'No estás en una sala.'); return false; }
    const h = room.seats.find(s => !s.bot && s.token === room.host);
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
  socket.on('kick', ({ seat } = {}, cb) => {
    if (!hostOnly(cb)) return;
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
    if (room.seats.length < 2) return fail(cb, 'Hacen falta al menos 2 jugadores (puedes agregar bots).');
    startGame(room); cb && cb({ ok: true });
  });
  socket.on('toLobby', (_d, cb) => {
    if (!hostOnly(cb)) return;
    if (room.game) room.game.destroy();
    room.game = null; room.phase = 'lobby';
    room.seats = room.seats.filter(s => s.bot || s.sid);
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
    const i = seatOf(room, token); if (i < 0) return fail(cb, 'No estás en esta sala.');
    if (!EMOTES.includes(id)) return fail(cb, 'Emote desconocido.');
    const now = Date.now(); if (now - lastEmote < 2000) return fail(cb, 'Espera un momento.');
    lastEmote = now;
    io.to(room.code).emit('emote', { seat: i, id });
    cb && cb({ ok: true });
  });

  socket.on('chat', ({ text, react } = {}, cb) => {
    if (!room) return fail(cb, 'No estás en una sala.');
    const i = seatOf(room, token); if (i < 0) return fail(cb, 'No estás en esta sala.');
    const now = Date.now();
    if (now - lastChat < 700) return fail(cb, 'Más despacio.');
    const clean = String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
    if (!clean) return fail(cb, 'Mensaje vacío.');
    lastChat = now;
    const msg = { seat: i, name: room.seats[i].name, text: clean, react: !!react, ts: now };
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
    const r = room, i = seatOf(r, token);
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
    if (!r.seats.some(s => !s.bot)) { r.game && r.game.destroy(); rooms.delete(code); }
  }
}, 60 * 1000);

server.listen(PORT, () => console.log(`Rebaño de Incógnito (versión ${BUILD}) escuchando en http://localhost:${PORT}`));
