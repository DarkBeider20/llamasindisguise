'use strict';
/* =========================================================
   Rebaño de Incógnito — cliente online
   El servidor es la autoridad: aquí solo se dibuja la vista
   que llega por socket y se envían las jugadas.
   ========================================================= */

/* ---------------- datos ---------------- */
const SHEEP = [
  { k: 'astro', n: 'Astronauta', c: '#2f6fdb', s: 'AS' }, { k: 'pirata', n: 'Pirata', c: '#c2343f', s: 'PI' },
  { k: 'chef', n: 'Chef', c: '#b07800', s: 'CH' }, { k: 'lucha', n: 'Luchadora', c: '#c13a98', s: 'LU' },
  { k: 'ninja', n: 'Ninja', c: '#3b3f55', s: 'NI' }, { k: 'detective', n: 'Detective', c: '#8a5a2b', s: 'DE' },
  { k: 'rock', n: 'Rockera', c: '#7a3fd1', s: 'RO' }, { k: 'bombera', n: 'Bombera', c: '#d4561b', s: 'BO' }];
const GOLD = { k: 'dorada', n: 'Dorada', c: '#c99400', s: '★', gold: true };
const SH = Object.fromEntries(SHEEP.map(s => [s.k, s]).concat([['dorada', GOLD]]));
const isGold = c => c && c.kind === 'sheep' && c.type === 'dorada';
const ACT = {
  take2: { n: 'Tomar 2', o: 'Take 2', q: 6, d: 'Toma 2 cartas del Campo.' },
  restock: { n: 'Reponer', o: 'Restock', q: 4, d: 'Cambia toda tu mano por 5 nuevas (termina tu turno) o renueva el Campo.' },
  yank: { n: 'Arrebatar', o: 'Yank', q: 5, d: 'Quita un rebaño a un rival con más rebaños que tú. Dos juntas: a cualquiera.' },
  dig: { n: 'Escarbar', o: 'Dig', q: 6, d: 'Toma 1 carta del descarte.' },
  expose: { n: 'Desenmascarar', o: 'Expose', q: 8, d: 'Colócala sobre un rebaño rival: el próximo Ataque lo devora.' },
  nice: { n: '¡Buen intento!', o: 'Nice Try', q: 8, d: 'Cancela una acción jugada en tu contra, o niega la cancelación de tu propia jugada.' },
  draw2: { n: 'Robar 2', o: 'Draw 2', q: 7, d: 'Roba 2 cartas. No termina tu turno.' },
  steal: { n: 'Hurtar', o: 'Steal', q: 7, d: 'Toma 1 carta al azar de la mano de un rival.' },
  gimme: { n: '¡Dame!', o: 'Gimme', q: 7, d: 'Pide una carta concreta a un rival, o que él elija cuál darte.' },
  yoink: { n: 'Pellizcar', o: 'Yoink', q: 6, d: 'Toma la carta de arriba de cualquier rebaño, o una carta Desenmascarar.' } };
const ATK = {
  puma: { n: 'Puma', d: 'Todos pasan 1 carta (a elección) al jugador siguiente.' },
  condor: { n: 'Cóndor', d: 'Todos pasan 1 carta (a elección) al jugador anterior.' },
  zorro: { n: 'Zorro', d: 'Todos descartan 1 carta al azar.' },
  lobo: { n: 'Lobo', d: 'Todos descartan 1 carta a elección.' },
  oso: { n: 'Oso', d: 'Se descarta todo el Campo y se repone.' },
  aguila: { n: 'Águila', d: 'Todos roban 1 carta.' } };
const AVC = ['#3446d6', '#c2343f', '#0e8a68', '#b07800', '#7a3fd1', '#d4561b', '#2a8fb0', '#8a5a2b'];

/* ---------------- utilidades ---------------- */
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
const cn = c => c.kind === 'sheep' ? 'Alpaca ' + SH[c.type].n : c.kind === 'action' ? ACT[c.type].n : ATK[c.type].n;
const fname = f => f.wild ? 'Comodín' : SH[f.type].n;
const store = {
  get: k => { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} },
  del: k => { try { localStorage.removeItem(k); } catch (_) {} },
};
let TOKEN = store.get('rb_token');
if (!TOKEN) { TOKEN = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()); store.set('rb_token', TOKEN); }
let NAME = store.get('rb_name') || '';

let ROOM = null;     // información de la sala
let V = null;        // vista de la partida
let sel = new Set(); // cartas seleccionadas de tu mano
let pending = false; // esperando respuesta del servidor
let clockSkew = 0;   // diferencia de reloj con el servidor
let overShownFor = null;
const seen = new Map(), fseen = new Map();

/* ---------------- socket ---------------- */
const socket = io({ transports: ['websocket', 'polling'] });
socket.on('connect', () => {
  $('#net').hidden = true;
  socket.emit('hello', { token: TOKEN });
  const want = new URLSearchParams(location.search).get('sala');
  const last = store.get('rb_room');
  const code = want && want.toUpperCase() !== last ? null : last;
  if (code) socket.emit('join', { code, name: NAME }, r => { if (r && r.error) { store.del('rb_room'); renderHome(want); } });
  else if (!ROOM) renderHome(want);
});
socket.on('disconnect', () => { $('#net').hidden = false; });
socket.on('room', r => {
  const prevPhase = ROOM && ROOM.phase;
  ROOM = r; store.set('rb_room', r.code);
  if (r.phase === 'playing' && prevPhase !== 'playing') { seen.clear(); fseen.clear(); overShownFor = null; hideBanner(); }
  if (r.phase === 'lobby') { V = null; closeModal(true); hideBanner(); renderLobby(); }
  else render();
});
socket.on('state', v => {
  if (!v) { V = null; return ROOM ? renderLobby() : renderHome(); }
  V = v; clockSkew = Date.now() - v.now;
  const ids = new Set(v.hand.map(c => c.id)); [...sel].forEach(id => { if (!ids.has(id)) sel.delete(id); });
  render();
  if (v.over && overShownFor !== ROOM.code + v.over.name + v.log.length) { overShownFor = ROOM.code + v.over.name + v.log.length; showOver(); }
});
socket.on('toast', ({ msg, cls }) => toast(msg, cls));
socket.on('attack', ({ card, text }) => { banner(card, text); setTimeout(hideBanner, 1600); });
socket.on('prompt', pr => queuePrompt(pr));
socket.on('promptClose', ({ id }) => dropPrompt(id));
socket.on('kicked', () => { ROOM = null; V = null; store.del('rb_room'); closeModal(true); renderHome(); toast('El anfitrión te sacó de la sala.', 'atk'); });

function emit(ev, data) { return new Promise(res => socket.emit(ev, data, r => res(r || {}))); }
async function send(msg) {
  if (pending) return;
  pending = true; sel.clear(); render();
  const r = await emit('intent', msg);
  pending = false;
  if (r.error) toast(r.error, 'atk');
  render();
}

/* ---------------- dibujo de cartas ---------------- */
function cardHTML(c, { cls = '', attrs = '', style = '' } = {}) {
  if (c.kind === 'sheep') { const s = SH[c.type]; return `<button data-ck="${c.kind}:${c.type}" data-cid="${c.id ?? ''}" class="card sheep ${s.gold ? 'gold' : ''} ${cls}" style="--c:${s.c};${style}" ${attrs} aria-label="Alpaca ${s.n}"><img class="pic" src="img/${s.k}.webp" alt="" draggable="false"><span class="corner">${s.s}</span><span class="nm">${s.n}</span></button>`; }
  if (c.kind === 'action') { const a = ACT[c.type]; return `<button data-ck="${c.kind}:${c.type}" data-cid="${c.id ?? ''}" class="card action ${c.type} ${cls}" style="${style}" ${attrs} aria-label="${a.n}: ${a.d}"><img class="pic" src="img/a-${c.type}.webp" alt="" draggable="false"><span class="corner">ACCIÓN</span><span class="nm">${a.n}</span></button>`; }
  const a = ATK[c.type]; return `<button data-ck="${c.kind}:${c.type}" data-cid="${c.id ?? ''}" class="card attack ${cls}" style="${style}" ${attrs} aria-label="Ataque ${a.n}: ${a.d}"><img class="pic" src="img/${c.type}.webp" alt="" draggable="false"><span class="corner">ATAQUE</span><span class="nm">${a.n}</span></button>`;
}
function fresh(c) {
  const now = performance.now(); if (!seen.has(c.id)) seen.set(c.id, now);
  const el = now - seen.get(c.id); return el < 450 ? { cls: 'enter', style: `animation-delay:-${el | 0}ms;` } : { cls: '', style: '' };
}
function flockFresh(f) {
  const now = performance.now(); if (!fseen.has(f.id)) fseen.set(f.id, now);
  const el = now - fseen.get(f.id); return el < 450 ? { cls: 'new', style: `animation-delay:-${el | 0}ms;` } : { cls: '', style: '' };
}
const bobDelay = () => `animation-delay:-${(performance.now() % 1200) | 0}ms`;
function flockHTML(f) {
  const fr = flockFresh(f);
  const c = f.wild ? '#5d6550' : SH[f.type].c;
  const minis = (f.wild ? (f.cards || []).slice(0, 3) : [f.type, f.type, f.type]).map(t => { const s = SH[t]; return `<i style="--c:${s.c}"><img src="img/${s.k}.webp" alt="" draggable="false"></i>`; }).join('');
  return `<span class="flock ${fr.cls} ${f.wild ? 'wild' : ''} ${f.exposed ? 'exposed' : ''}" style="--c:${c};${fr.style}" title="Rebaño ${fname(f)}${f.exposed ? ' (desenmascarado)' : ''}"><span class="stk">${minis}</span><span class="fl">${fname(f)}${f.exposed ? '<span class="eye">expuesto</span>' : ''}</span></span>`;
}
function chipHTML(f) {
  const c = f.wild ? '#5d6550' : SH[f.type].c;
  return `<span class="chip ${f.exposed ? 'exposed' : ''}" style="--c:${c}"><span class="dot">${f.wild ? '★' : SH[f.type].s}</span>${fname(f)}${f.wild ? ' (5)' : ''}${f.exposed ? ' <span class="tag">DESENMASCARADO</span>' : ''}</span>`;
}
function pips(p) { const ex = p.flocks.some(f => f.exposed); return `<span class="pips" aria-label="${p.flocks.length} de ${V.target} rebaños">${Array.from({ length: V.target }, (_, i) => `<b class="${i < p.flocks.length ? (ex ? 'warn' : 'on') : ''}"></b>`).join('')}</span>`; }
const avatar = (name, i) => `<span class="av" style="--av:${AVC[i % AVC.length]}">${esc((name || '?')[0].toUpperCase())}</span>`;
const SORD = Object.fromEntries(SHEEP.map((x, i) => [x.k, i])), AORD = Object.fromEntries(Object.keys(ACT).map((k, i) => [k, i]));
function sortHand(h) {
  const key = c => isGold(c) ? -1 : c.kind === 'sheep' ? SORD[c.type] : 100 + (AORD[c.type] ?? 50);
  return [...h].sort((a, b) => key(a) - key(b) || a.id - b.id);
}

/* ---------------- estado derivado ---------------- */
const me = () => V && V.players[V.you];
const myHand = () => (V ? V.hand : []);
const countMine = t => myHand().filter(c => c.kind === 'sheep' && c.type === t).length;
const hasFlockMine = t => !!me() && me().flocks.some(f => f.type === t);
function canAct() { return !!V && V.waiting === V.you && !V.busy && !V.over && !pending; }
function canTrade() { return canAct() && !V.traded && V.field.length > 0; }
const playable = c => c && c.kind === 'action' && c.type !== 'nice';
function canDragCard(c) { return canAct() && (canTrade() || playable(c)); }
const selCards = () => myHand().filter(c => sel.has(c.id));
const others = () => V.players.map((p, i) => ({ p, i })).filter(x => x.i !== V.you);

/* ---------------- pantallas: inicio y sala ---------------- */
function renderHome(prefill) {
  document.body.classList.remove('in-game');
  ROOM = null; V = null;
  $('#stats').innerHTML = `<button class="btn small" data-a="rules">Reglas</button>`;
  const sample = [{ kind: 'sheep', type: 'lucha' }, { kind: 'action', type: 'expose' }, { kind: 'sheep', type: 'dorada' }, { kind: 'attack', type: 'puma' }, { kind: 'sheep', type: 'rock' }];
  $('#board').innerHTML = `<div class="setup"><div class="hero"><h2>Esconde tus alpacas. <em>Desenmascara</em> las ajenas.</h2>
    <p>Junta tríos de alpacas disfrazadas, róbales rebaños a tus amigos y reza para que el próximo depredador no encuentre los tuyos. Salas de hasta 8 jugadores.</p>
    <div class="stage"><div class="fan">${sample.map((c, i) => cardHTML(c, { attrs: 'tabindex="-1"', style: `--r:${(i - 2) * 7}deg;--y:${Math.abs(i - 2) * 8}px;--d:${-i * .6}s` })).join('')}</div></div></div>
    <form class="panel" id="homeForm" autocomplete="off"><h3>Jugar online</h3>
      <label class="label" for="nm">Tu nombre</label>
      <input class="field-in" id="nm" maxlength="16" placeholder="Ej. David" value="${esc(NAME)}" required>
      <button class="btn go wide" type="button" data-a="create">Crear sala</button>
      <div class="or"><span>o únete con un código</span></div>
      <div class="joinrow"><input class="field-in code" id="code" maxlength="4" placeholder="ABCD" value="${esc(prefill || '')}" aria-label="Código de sala"><button class="btn primary" type="submit">Unirse</button></div>
      <p class="note">Comparte el código o el enlace de la sala con tus amigos. Los asientos vacíos se pueden llenar con bots.</p>
    </form></div>`;
  $('#homeForm').onsubmit = e => { e.preventDefault(); doJoin(); };
}
function readName() {
  const n = ($('#nm') && $('#nm').value.trim()) || NAME;
  if (!n) { toast('Escribe tu nombre primero.', 'atk'); $('#nm') && $('#nm').focus(); return null; }
  NAME = n.slice(0, 16); store.set('rb_name', NAME); return NAME;
}
async function doCreate() { const n = readName(); if (!n) return; const r = await emit('create', { name: n }); if (r.error) toast(r.error, 'atk'); }
async function doJoin() {
  const n = readName(); if (!n) return;
  const code = ($('#code').value || '').trim().toUpperCase();
  if (code.length !== 4) return toast('El código tiene 4 letras.', 'atk');
  const r = await emit('join', { code, name: n }); if (r.error) toast(r.error, 'atk');
}
function shareLink() { return `${location.origin}${location.pathname}?sala=${ROOM.code}`; }
function renderLobby() {
  document.body.classList.remove('in-game');
  if (!ROOM) return renderHome();
  const isHost = ROOM.you === ROOM.host && ROOM.you >= 0;
  $('#stats').innerHTML = `<button class="btn small" data-a="rules">Reglas</button><button class="btn small" data-a="leave">Salir de la sala</button>`;
  const slots = Array.from({ length: ROOM.max }, (_, i) => {
    const s = ROOM.seats[i];
    if (!s) return `<li class="seat empty"><span class="av ghost">+</span><span>Asiento libre</span></li>`;
    const tags = [i === ROOM.host ? '<span class="tag-h">Anfitrión</span>' : '', s.bot ? '<span class="tag-b">Bot</span>' : '', i === ROOM.you ? '<span class="tag-y">Tú</span>' : '', !s.online ? '<span class="tag-off">Desconectado</span>' : ''].join('');
    const kick = isHost && i !== ROOM.you ? `<button class="btn small ghostbtn" data-kick="${i}" aria-label="Quitar a ${esc(s.name)}">Quitar</button>` : '';
    return `<li class="seat">${avatar(s.name, i)}<span class="sn">${esc(s.name)}</span>${tags}${kick}</li>`;
  }).join('');
  $('#board').innerHTML = `<div class="lobby"><div class="lobby-main panel">
      <p class="label">Código de la sala</p>
      <div class="codebox"><span class="bigcode">${ROOM.code}</span><button class="btn small" data-a="copy">Copiar enlace</button></div>
      <p class="linkline"><span id="lnk">${esc(shareLink())}</span></p>
      <p class="label" style="margin-top:18px">Jugadores · ${ROOM.seats.length}/${ROOM.max}</p>
      <ul class="seats">${slots}</ul></div>
    <div class="panel lobby-side"><h3>${isHost ? 'Tú eres el anfitrión' : 'Esperando al anfitrión'}</h3>
      <div class="goal">${ROOM.seats.length} jugadores · meta ${ROOM.target} rebaños<span class="pips">${'<b class="on"></b>'.repeat(Math.max(0, ROOM.target))}</span></div>
      ${isHost ? `<button class="btn wide" data-a="addbot" ${ROOM.seats.length >= ROOM.max ? 'disabled' : ''}>Agregar bot</button>
      <label class="check"><input type="checkbox" id="short" ${ROOM.opts.short ? 'checked' : ''}> Partida corta (un rebaño menos)</label>
      <button class="btn go wide" data-a="start" ${ROOM.seats.length < 2 ? 'disabled' : ''}>Empezar partida</button>
      <p class="note">${ROOM.seats.length < 2 ? 'Hacen falta al menos 2 jugadores: invita a alguien o agrega un bot.' : 'Cuando estén todos, empieza la partida.'}</p>`
    : `<p class="note">El anfitrión agrega bots y empieza la partida. Mientras tanto, revisa las reglas.</p>`}
      <p class="note">Las 3 Alpacas Doradas siempre están en el mazo: quien las junte gana al instante.</p></div></div>`;
}

/* ---------------- partida ---------------- */
function render() {
  if (!ROOM) return;
  if (ROOM.phase === 'lobby' || !V) { document.documentElement.style.setProperty('--dock', '0px'); return renderLobby(); }
  const pc = peekEl && peekEl.dataset.cid;
  const hs = $('.hand') ? $('.hand').scrollLeft : 0;
  renderGame();
  const hand = $('.hand'); if (hand) hand.scrollLeft = hs;
  const dock = $('.me'); document.documentElement.style.setProperty('--dock', dock ? dock.offsetHeight + 'px' : '0px');
  if (!pc) { if (peekEl && !peekEl.isConnected) hidePeek(); return; }
  const el = [...document.querySelectorAll(`.card[data-cid="${pc}"]`)].find(x => !x.closest('#banner'));
  el ? showPeek(el) : hidePeek();
}
function cardBlurb(c) {
  if (c.kind === 'action') {
    if (c.type === 'nice') return '<b>¡Buen intento!</b> Se usa sola: te la ofreceremos cuando alguien juegue una acción en tu contra.';
    return `<b>${ACT[c.type].n}:</b> ${esc(ACT[c.type].d)}`;
  }
  if (isGold(c)) return `<b>Alpaca Dorada:</b> junta las 3 y ganas al instante. Tienes ${countMine('dorada')} de 3.`;
  const k = countMine(c.type), has = hasFlockMine(c.type);
  return `<b>Alpaca ${SH[c.type].n}:</b> ` + (has ? 'ya tienes este rebaño; sirve para pagar, comprar o cambiar.' : `tienes ${k}, te ${3 - k === 1 ? 'falta 1' : 'faltan ' + Math.max(0, 3 - k)} para el rebaño.`) + (canTrade() ? ' Puedes cambiarla con el Campo.' : '');
}
function timeLeft() { return Math.max(0, Math.ceil((V.deadline + clockSkew - Date.now()) / 1000)); }
function renderGame() {
  document.body.classList.add('in-game');
  const p = me(), cur = V.players[V.turn];
  const waitingName = V.waiting >= 0 ? V.players[V.waiting].name : cur.name;
  $('#stats').innerHTML = `<span class="pill">Sala ${ROOM.code}</span><span class="pill">Meta: ${V.target} rebaños</span><button class="btn small mob-only" data-a="log">Bitácora</button><button class="btn small" data-a="rules">Reglas</button><button class="btn small" data-a="leave">Salir</button>`;
  const stripH = others().map(({ p: q, i }) => {
    const on = V.turn === i && !V.over;
    const dots = q.flocks.map(f => { const t = f.wild ? ((f.cards && f.cards[0]) || 'astro') : f.type; return `<i class="${f.exposed ? 'x' : ''}" style="--c:${f.wild ? '#5d6550' : SH[f.type].c}" title="${fname(f)}${f.exposed ? ' (expuesto)' : ''}"><img src="img/${t}.webp" alt=""></i>`; }).join('');
    return `<button class="rv ${on ? 'turn' : ''} ${q.connected || q.bot ? '' : 'off'}" data-rival="${i}" aria-label="Ver a ${esc(q.name)}">${avatar(q.name, i)}<span class="rv-b"><span class="rv-n">${esc(q.name)}</span><span class="rv-s">${q.connected || q.bot ? `${q.handCount} cartas` : 'Desconectado'}</span><span class="rv-f">${dots}<b>${q.flocks.length}/${V.target}</b></span></span>${on ? '<span class="rv-t">turno</span>' : ''}</button>`;
  }).join('');
  const top = V.discard[V.discard.length - 1];
  const s = selCards(), ops = [], mine = canAct();
  let hint = '';
  if (mine) {
    const allSame = s.length === 2 && s[0].kind === s[1].kind && s[0].type === s[1].type;
    if (s.length === 1 && playable(s[0])) ops.push(`<button class="btn primary" data-op="play">Jugar ${ACT[s[0].type].n}</button>`);
    if (allSame && s[0].type === 'yank') ops.push(`<button class="btn primary" data-op="dyank">Doble Arrebatar</button>`);
    if (s.length === 1 && canTrade()) ops.push(`<button class="btn" data-op="trade">Cambiar con el Campo</button>`);
    if (allSame && V.field.length) ops.push(`<button class="btn" data-op="buy">Comprar del Campo (pagas estas 2)</button>`);
    if (s.length === 2 && p.flocks.some(f => f.exposed)) ops.push(`<button class="btn danger" data-op="pay">Pagar 2 para quitar Desenmascarar</button>`);
    if (s.length === 5 && !hasFlockMine('wild') && s.every(c => c.kind === 'sheep' && !isGold(c)) && new Set(s.map(c => c.type)).size === 5) ops.push(`<button class="btn" data-op="wild">Formar rebaño comodín</button>`);
    ops.push(`<span class="ttimer" id="ttimer">${timeLeft()} s</span><button class="btn go" data-op="draw">Robar y terminar turno</button>`);
    if (!s.length) hint = isCoarse()
      ? '<b>Tu turno.</b> Toca cartas para elegir. <b>Mantén presionada</b> una para verla en grande y, sin soltar, arrástrala al Campo o a la mesa.' + (V.traded ? ' Ya cambiaste con el Campo.' : '')
      : '<b>Tu turno.</b> Toca cartas de tu mano: 1 acción para jugarla, 2 iguales para comprar, 5 alpacas distintas para un rebaño comodín. ' + (V.traded ? 'Ya cambiaste con el Campo este turno.' : '<b>Arrastra una carta sobre el Campo</b> para cambiarla.') + ' Arrastra una acción a la mesa para jugarla.';
    else if (s.length === 1) hint = cardBlurb(s[0]);
    if (p.flocks.some(f => f.exposed)) hint += ' <b>Tienes un rebaño desenmascarado:</b> elige 2 cartas cualesquiera para pagar y protegerlo.';
  } else if (!V.over) hint = pending || (V.busy && V.waiting === V.you) ? 'Resolviendo…' : `Turno de <b>${esc(waitingName)}</b>. Espera tu turno.`;
  const H = sortHand(V.hand), m = (H.length - 1) / 2, ov = H.length > 9 ? -30 : H.length > 6 ? -22 : -12;
  const handH = H.map((c, i) => { const f = fresh(c); return cardHTML(c, { cls: (sel.has(c.id) ? 'sel ' : '') + f.cls + (canDragCard(c) ? ' dg' : ''), style: `${f.style}--r:${((i - m) * 2.2).toFixed(1)}deg;--y:${(Math.abs(i - m) * 1.6).toFixed(1)}px;--ov:${!i ? 0 : (H[i - 1].kind !== c.kind ? 14 : H[i - 1].type !== c.type ? ov + 6 : ov)}px;`, attrs: `data-h="${c.id}" aria-pressed="${sel.has(c.id)}"` }); }).join('');
  const myTurnNow = V.turn === V.you && !V.over;
  $('#board').innerHTML = `<div class="game"><div class="zone">
    <div class="rivals-strip" aria-label="Rivales">${stripH}</div>
    <section class="table" aria-label="Mesa"><p class="label tbl-meta mob-only">Sala ${ROOM.code} · meta ${V.target} rebaños</p><div><p class="label">El Campo</p><div class="field">${V.field.map(c => { const f = fresh(c); return cardHTML(c, { cls: f.cls, style: f.style, attrs: 'tabindex="-1"' }); }).join('') || '<div class="card ghost"></div>'}</div></div>
      <div><p class="label">Pilas</p><div class="pileset"><div class="pile"><div class="deckstack"><div class="card back"></div></div>Mazo · ${V.deck}</div>
      <div class="pile">${top ? cardHTML(top, { attrs: 'data-a="discard" title="Ver descarte"' }) : '<div class="card ghost"></div>'}Descarte · ${V.discard.length}</div></div></div></section>
    <section class="me ${myTurnNow ? 'turn' : ''}"><div class="me-head">${avatar(p ? p.name : '?', V.you)}<h3>${esc(p ? p.name : 'Espectador')}</h3>${myTurnNow ? `<span class="turnflag" style="margin-left:0;${bobDelay()}">Tu turno</span>` : ''}<div class="flocks myf">${p && p.flocks.length ? p.flocks.map(flockHTML).join('') : '<span class="empty">Junta 3 alpacas iguales y el rebaño se forma solo.</span>'}</div>${p ? pips(p) : ''}<button class="ticker mob-only" data-a="log" aria-label="Abrir bitácora">${esc((V.log[0] && V.log[0].msg) || '')}</button></div>
      <div class="hand">${handH || '<span class="empty">Mano vacía</span>'}</div>
      <div class="bar">${hint ? `<p class="hint">${hint}</p>` : ''}${ops.join('')}</div></section>
  </div><aside class="log" aria-label="Bitácora"><p class="label">Bitácora</p><ol>${V.log.map(l => `<li class="${l.cls}">${esc(l.msg)}</li>`).join('')}</ol></aside></div>`;
}
setInterval(() => { const t = $('#ttimer'); if (t && V) { const s = timeLeft(); t.textContent = `${s} s`; t.classList.toggle('low', s <= 15); } }, 1000);

/* ---------------- jugadas propias ---------------- */
async function humanPlay(cards) {
  const p = me(), t = cards[0].type, pl = {}, double = cards.length === 2;
  const flockOpt = (q, i, f, extra = '') => ({ label: `${chipHTML(f)} de ${esc(q.name)}${extra}`, value: { t: i, f: f.id } });
  if (t === 'yank') {
    const o = []; others().forEach(({ p: q, i }) => q.flocks.forEach(f => { if (!hasFlockMine(f.type) && (double || q.flocks.length > p.flocks.length)) o.push(flockOpt(q, i, f)); }));
    if (!o.length) return toast(double ? 'No hay rebaños que puedas arrebatar.' : 'Solo puedes arrebatar a quien tenga más rebaños que tú (y de un tipo que no tengas). Prueba con dos Arrebatar juntas.', 'atk');
    const v = await ask({ title: '¿Qué rebaño arrebatas?', options: o, cancel: true }); if (!v) return; pl.target = v.t; pl.flock = v.f;
  } else if (t === 'expose') {
    const o = []; others().forEach(({ p: q, i }) => q.flocks.forEach(f => { if (!f.exposed) o.push(flockOpt(q, i, f)); }));
    if (!o.length) return toast('Ningún rival tiene rebaños sin desenmascarar.', 'atk');
    const v = await ask({ title: '¿Qué rebaño desenmascaras?', text: 'Si sale un Ataque antes de que lo pague, lo pierde.', options: o, cancel: true }); if (!v) return; pl.target = v.t; pl.flock = v.f;
  } else if (t === 'steal' || t === 'gimme') {
    const o = others().filter(({ p: q }) => q.handCount).map(({ p: q, i }) => ({ label: `${esc(q.name)} · ${q.handCount} cartas`, value: { t: i } }));
    if (!o.length) return toast('Ningún rival tiene cartas en la mano.', 'atk');
    const q = await ask({ title: t === 'steal' ? '¿A quién le hurtas?' : '¿A quién le pides?', options: o, cancel: true }); if (!q) return; pl.target = q.t;
    if (t === 'gimme') {
      const wo = [{ label: 'Que elija qué darme', value: 'choice' }].concat(SHEEP.concat([GOLD]).map(s => ({ label: `Alpaca ${s.n}`, value: { kind: 'sheep', type: s.k } }))).concat(Object.entries(ACT).map(([k, a]) => ({ label: a.n, value: { kind: 'action', type: k } })));
      const w = await ask({ title: '¿Qué le pides?', text: 'Si pides una carta concreta y no la tiene, no recibes nada.', options: wo, cancel: true }); if (!w) return; pl.want = w === 'choice' ? null : w;
    }
  } else if (t === 'yoink') {
    const o = []; V.players.forEach((q, i) => q.flocks.forEach(f => { o.push({ label: `Carta de arriba: ${chipHTML(f)} de ${esc(q.name)}`, value: { t: i, f: f.id, w: 'top' } }); if (f.exposed) o.push({ label: `Quitar el Desenmascarar: ${chipHTML(f)} de ${esc(q.name)}`, value: { t: i, f: f.id, w: 'expose' } }); }));
    if (!o.length) return toast('Todavía nadie tiene rebaños.', 'atk');
    const v = await ask({ title: '¿Qué pellizcas?', text: 'Si tomas una alpaca, el resto del rebaño vuelve a la mano de su dueño.', options: o, cancel: true }); if (!v) return; pl.target = v.t; pl.flock = v.f; pl.what = v.w;
  } else if (t === 'restock') {
    const m = await ask({ title: 'Reponer', options: [{ label: 'Renovar el Campo (sigues jugando)', value: 'field' }, { label: 'Descartar mi mano y robar 5 (termina mi turno)', value: 'hand' }], cancel: true }); if (!m) return; pl.mode = m;
  } else if (t === 'take2') { if (!V.field.length) return toast('El Campo está vacío.', 'atk'); }
  else if (t === 'dig') { if (!V.discard.some(c => c.kind !== 'attack')) return toast('El descarte está vacío.', 'atk'); }
  else if (t === 'draw2') {
    const ok = await ask({ title: '¿Jugar Robar 2?', text: ACT.draw2.d, html: `<div class="swap">${cardHTML(cards[0], { attrs: 'tabindex="-1"' })}</div>`, options: [{ label: 'Sí, jugar', value: true }, { label: 'Cancelar', value: false }] });
    if (!ok) return;
  }
  if (!canAct()) return;
  return send({ op: 'play', cards: cards.map(c => c.id), pl });
}
async function confirmTrade(hc, fc) {
  const ok = await ask({ title: '¿Cambiar con el Campo?', text: 'Solo puedes hacer un cambio con el Campo por turno.',
    html: `<div class="swap">${cardHTML(hc, { attrs: 'tabindex="-1"' })}<span class="swap-ar" aria-hidden="true">⇄</span>${cardHTML(fc, { attrs: 'tabindex="-1"' })}</div><p class="swap-cap"><span>Das <b>${cn(hc)}</b></span><span>Recibes <b>${cn(fc)}</b></span></p>`,
    options: [{ label: 'Sí, cambiar', value: true }, { label: 'Cancelar', value: false }] });
  if (ok && canTrade()) send({ op: 'trade', hand: hc.id, field: fc.id });
}
async function onOp(op) {
  const p = me(), s = selCards();
  if (op === 'play' || op === 'dyank') return humanPlay(s);
  if (op === 'draw') return send({ op: 'draw' });
  if (op === 'trade') {
    const v = await ask({ title: `Cambiar ${cn(s[0])} por…`, text: 'Solo un cambio con el Campo por turno.', options: V.field.map(c => ({ label: cn(c), value: c.id })), cancel: true }); if (!v) return;
    return canTrade() && send({ op: 'trade', hand: s[0].id, field: v });
  }
  if (op === 'buy') {
    const v = await ask({ title: 'Comprar del Campo', text: `Pagas ${cn(s[0])} ×2. ¿Qué carta te llevas?`, options: V.field.map(c => ({ label: cn(c), value: c.id })), cancel: true }); if (!v) return;
    return canAct() && send({ op: 'buy', cards: s.map(c => c.id), field: v });
  }
  if (op === 'pay') {
    const ex = p.flocks.filter(f => f.exposed); let f = ex[0] && ex[0].id;
    if (ex.length > 1) { f = await ask({ title: '¿Qué rebaño proteges?', options: ex.map(x => ({ label: chipHTML(x), value: x.id })), cancel: true }); if (!f) return; }
    return send({ op: 'pay', cards: s.map(c => c.id), flock: f });
  }
  if (op === 'wild') return send({ op: 'wild', cards: s.map(c => c.id) });
}

/* ---------------- preguntas del servidor ---------------- */
const promptQueue = []; let activePrompt = null;
function queuePrompt(pr) { promptQueue.push(pr); if (!activePrompt) nextPrompt(); }
function dropPrompt(id) {
  const k = promptQueue.findIndex(p => p.id === id); if (k >= 0) promptQueue.splice(k, 1);
  if (activePrompt && activePrompt.id === id) { activePrompt = null; closeModal(false); nextPrompt(); }
}
function answer(id, value) {
  socket.emit('answer', { id, value });
  if (activePrompt && activePrompt.id === id) { activePrompt = null; closeModal(false); }
  nextPrompt();
}
function nextPrompt() {
  if (activePrompt || !promptQueue.length) return;
  const pr = activePrompt = promptQueue.shift();
  closeModal(true); hidePeek(); hideSheet();
  const bar = `<div class="pbar"><i style="animation-duration:${pr.ms}ms"></i></div>`;
  if (pr.type === 'nice') {
    openModal(`${bar}<h3>${esc(pr.title)}</h3><ol class="ntchain">${pr.rows.map((r, i) => `<li class="${i === 0 ? '' : (r.includes('cancelada') ? 'no' : 'yes')}">${esc(r)}</li>`).join('')}</ol><p>Tienes ${pr.left} ¡Buen intento! en la mano.</p>
      <div class="opts"><button class="opt" data-ans="1">${pr.cancelled ? 'Jugar ¡Buen intento!: que la jugada siga' : 'Jugar ¡Buen intento!: cancelarla'}</button><button class="opt ghost" data-ans="0">Dejarlo así</button></div>`,
      e => { const b = e.target.closest('[data-ans]'); if (b) answer(pr.id, b.dataset.ans === '1'); });
  } else if (pr.type === 'pick') {
    const chosen = new Set();
    const cards = pr.cards.every(c => myHand().some(h => h.id === c.id)) ? sortHand(pr.cards) : pr.cards;
    const draw = () => openModal(`${bar}<h3>${esc(pr.title)}</h3>${pr.text ? `<p>${esc(pr.text)}</p>` : ''}<p>${pr.count > 1 ? `Elige ${pr.count} cartas (${chosen.size}/${pr.count}).` : 'Toca una carta.'}</p><div class="picker">${cards.map(c => cardHTML(c, { cls: chosen.has(c.id) ? 'sel' : '', attrs: `data-p="${c.id}"` })).join('')}</div>${pr.count > 1 ? `<button class="btn primary" data-ok ${chosen.size === pr.count ? '' : 'disabled'}>Confirmar</button>` : ''}`,
      e => {
        if (e.target.closest('[data-ok]') && chosen.size === pr.count) return answer(pr.id, [...chosen]);
        const b = e.target.closest('[data-p]'); if (!b) return; const id = +b.dataset.p;
        if (pr.count === 1) return answer(pr.id, [id]);
        chosen.has(id) ? chosen.delete(id) : chosen.size < pr.count && chosen.add(id); draw();
      });
    draw();
  }
}

/* ---------------- modales, avisos y banner ---------------- */
let modalRej = null;
class Stale extends Error {}
function openModal(html, onclick) { const m = $('#modal'); m.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`; m.hidden = false; m.onclick = onclick; const b = m.querySelector('button:not(:disabled)'); b && b.focus(); }
function closeModal(reject) { const m = $('#modal'); m.hidden = true; m.innerHTML = ''; m.onclick = null; if (reject && modalRej) { const r = modalRej; modalRej = null; r(new Stale()); } modalRej = null; }
function ask({ title, text = '', html = '', options, cancel = false }) {
  if (activePrompt) return Promise.resolve(null);
  return new Promise((res, rej) => {
    modalRej = rej;
    openModal(`<h3>${title}</h3>${text ? `<p>${esc(text)}</p>` : ''}${html}<div class="opts">${options.map((o, i) => `<button class="opt" data-i="${i}" ${o.disabled ? 'disabled' : ''}>${o.label}</button>`).join('')}${cancel ? '<button class="opt ghost" data-i="-1">Cancelar</button>' : ''}</div>`,
      e => { const b = e.target.closest('[data-i]'); if (!b) return; const i = +b.dataset.i; modalRej = null; closeModal(); res(i < 0 ? null : options[i].value); });
  }).catch(() => null);
}
function info(title, html) { if (activePrompt) return; openModal(`<h3>${title}</h3>${html}<div style="margin-top:14px"><button class="btn" data-close>Cerrar</button></div>`, e => { if (e.target.closest('[data-close]')) closeModal(); }); }
function toast(msg, cls = '') {
  const box = $('#toasts'); if (!box) return;
  const t = document.createElement('div'); t.className = 'toast ' + cls; t.textContent = msg; box.appendChild(t);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, cls === 'turn' ? 1600 : 2800);
}
function banner(c, txt) { const b = $('#banner'); b.classList.remove('goldwin'); b.onclick = null; b.innerHTML = `<div class="inner">${cardHTML(c)}<div><h3>¡${ATK[c.type].n}!</h3><p>${esc(txt)}</p></div></div>`; b.hidden = false; }
function hideBanner() { const b = $('#banner'); if (!b.classList.contains('goldwin')) b.hidden = true; }

function showOver() {
  const o = V.over, won = o.winner === V.you, isHost = ROOM.you === ROOM.host;
  const btns = isHost
    ? `<button class="btn go" data-g="again">Revancha</button><button class="btn" data-g="lobby">Volver a la sala</button><button class="btn" data-g="stay">Ver la mesa</button>`
    : `<button class="btn" data-g="stay">Ver la mesa</button><button class="btn" data-g="leave">Salir</button>`;
  const wait = isHost ? '' : '<p class="note" style="color:inherit;opacity:.8">El anfitrión decide si hay revancha.</p>';
  closeModal(true);
  const b = $('#banner');
  if (o.gold) {
    b.classList.add('goldwin');
    b.innerHTML = `<div class="inner gold"><div class="trio">${[0, 1, 2].map(i => `<img src="img/dorada.webp" alt="" style="--i:${i}">`).join('')}</div><div><h3>¡Alpaca Dorada!</h3><p>${won ? 'Juntaste' : esc(o.name) + ' juntó'} las 3 Alpacas Doradas. Victoria instantánea.</p><div class="gbtns">${btns}</div>${wait}</div></div>`;
  } else {
    b.classList.add('goldwin', 'plainwin');
    b.innerHTML = `<div class="inner gold"><div><h3>${won ? '¡Tu rebaño sobrevivió!' : esc(o.name) + ' gana'}</h3><p>${won ? 'Juntaste' : 'Juntó'} ${o.flocks} rebaños sin ninguno desenmascarado.</p><div class="gbtns">${btns}</div>${wait}</div></div>`;
  }
  b.hidden = false;
  b.onclick = async e => {
    const t = e.target.closest('[data-g]'); if (!t) return;
    const g = t.dataset.g;
    if (g === 'stay') { b.hidden = true; b.classList.remove('goldwin', 'plainwin'); return; }
    if (g === 'leave') { b.hidden = true; b.classList.remove('goldwin', 'plainwin'); return leaveRoom(); }
    const r = await emit(g === 'again' ? 'start' : 'toLobby'); if (r.error) return toast(r.error, 'atk');
    b.hidden = true; b.classList.remove('goldwin', 'plainwin');
  };
}
async function leaveRoom() { await emit('leave'); ROOM = null; V = null; store.del('rb_room'); history.replaceState(null, '', location.pathname); renderHome(); }

/* ---------------- vista ampliada al pasar el mouse ---------------- */
function peekHTML(kind, type) {
  let img, name, tag, desc, extra = '', col;
  if (kind === 'sheep') {
    const x = SH[type]; img = `img/${x.k}.webp`; name = `Alpaca ${x.n}`; tag = 'Alpaca'; col = x.c;
    desc = 'Junta 3 alpacas iguales y forman un rebaño al instante. Solo puedes tener un rebaño de cada tipo.';
    if (type === 'dorada') { tag = 'Legendaria'; name = 'Alpaca Dorada'; desc = 'Solo hay 3 en todo el mazo. Quien junte las 3 en su mano gana la partida al instante, sin importar sus rebaños.'; extra = V ? `Tienes ${countMine('dorada')} de 3.` : '3 copias en el mazo.'; }
    else if (V && me()) { const k = countMine(type), has = hasFlockMine(type); extra = has ? 'Ya tienes este rebaño: las copias extra sirven para pagar o cambiar.' : `Tienes ${k} en la mano · te ${3 - k === 1 ? 'falta 1' : 'faltan ' + Math.max(0, 3 - k)} para el rebaño.`; }
    else extra = '9 copias en el mazo.';
  } else if (kind === 'action') {
    const a = ACT[type]; img = `img/a-${type}.webp`; name = a.n; tag = `Acción · ${a.o}`; col = type === 'nice' ? '#0a7a5e' : type === 'expose' ? '#b4461a' : '#2b39b5'; desc = a.d;
    extra = { nice: 'Solo sirve contra acciones dirigidas a ti (Arrebatar, Desenmascarar, Pellizcar, Hurtar, ¡Dame!). Se juega aunque no sea tu turno, y puedes encadenarla si te niegan la cancelación.', expose: 'Se coloca sobre un rebaño rival. El dueño puede pagar 2 cartas para quitarla.', yank: 'Juega dos juntas para arrebatar a cualquier jugador.', restock: 'Reponer tu mano termina tu turno; renovar el Campo no.', gimme: 'Si pides una carta concreta y no la tiene, no recibes nada.' }[type] || '';
  } else {
    const a = ATK[type]; img = `img/${type}.webp`; name = a.n; tag = 'Ataque'; col = '#c72f2a';
    desc = 'Devora todos los rebaños desenmascarados de la mesa.'; extra = `Si no hay ninguno, efecto secundario: ${a.d}`;
  }
  return `<div class="pk-card" style="--pc:${col}"><img src="${img}" alt=""></div><div class="pk-info" style="--pc:${col}"><span class="pk-tag">${tag}</span><h4>${name}</h4><p>${desc}</p>${extra ? `<p class="pk-x">${extra}</p>` : ''}</div>`;
}
const canHover = window.matchMedia && matchMedia('(hover: hover) and (pointer: fine)').matches;
const isCoarse = () => !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
let peekEl = null, peekBlock = false;
function showPeek(el) {
  if (peekBlock) return;
  const pk = $('#peek'); const [kind, type] = el.dataset.ck.split(':');
  const html = peekHTML(kind, type); if (pk.innerHTML !== html) pk.innerHTML = html; pk.hidden = false; peekEl = el;
  const r = el.getBoundingClientRect(), w = pk.offsetWidth, h = pk.offsetHeight, vw = innerWidth, vh = innerHeight, m = 12;
  let x, y;
  if (r.right + m + w <= vw - m) { x = r.right + m; y = r.top + r.height / 2 - h / 2; }
  else if (r.left - m - w >= m) { x = r.left - m - w; y = r.top + r.height / 2 - h / 2; }
  else { x = r.left + r.width / 2 - w / 2; y = r.top - m - h >= m ? r.top - m - h : r.bottom + m; }
  x = Math.max(m, Math.min(vw - w - m, x)); y = Math.max(m, Math.min(vh - h - m, y));
  pk.style.left = x + 'px'; pk.style.top = y + 'px';
}
function hidePeek() { const pk = $('#peek'); if (pk) pk.hidden = true; peekEl = null; }
// En el celular: la carta en grande, como hoja desde abajo. Se cierra con un toque.
function showSheet(kind, type) {
  const t = $('#tsheet'); if (!t || activePrompt) return;
  t.innerHTML = `<div class="ts-in" role="dialog" aria-label="Detalle de la carta">${peekHTML(kind, type)}<p class="ts-x">Toca en cualquier parte para cerrar</p></div>`;
  t.hidden = false;
}
function hideSheet() { const t = $('#tsheet'); if (t) t.hidden = true; }
if (canHover) {
  document.addEventListener('mouseover', e => { const el = e.target.closest('.card[data-ck]'); if (!el || el.closest('#banner')) return; if (el !== peekEl) showPeek(el); });
  document.addEventListener('mouseout', e => { const el = e.target.closest('.card[data-ck]'); if (el && (!e.relatedTarget || !el.contains(e.relatedTarget))) hidePeek(); });
  document.addEventListener('click', hidePeek, true);
  addEventListener('scroll', hidePeek, true);
}

/* ---------------- arrastrar cartas ---------------- */
let drag = null, swallowClick = false;
// Con mouse: arrastra al mover 7 px. Con el dedo: mantén presionada la carta ~0,3 s y luego arrastra
// (si deslizas enseguida, la mano se desplaza como siempre).
function startDrag(x, y) {
  const d = drag; if (!d || d.on) return;
  d.on = true; hidePeek(); peekBlock = true;
  const r = d.el.getBoundingClientRect(), g = d.el.cloneNode(true);
  g.classList.remove('sel', 'enter', 'lp'); g.classList.add('drag-ghost'); g.removeAttribute('data-ck');
  g.style.cssText = `width:${r.width}px;height:${r.height}px;left:0;top:0`; d.dx = x - r.left; d.dy = y - r.top;
  document.body.appendChild(g); d.ghost = g; d.el.classList.remove('lp'); d.el.classList.add('dragging');
  const tb = $('.table'); if (tb) { if (canTrade()) tb.classList.add('dropping'); if (playable(d.card)) { tb.classList.add('can-play'); tb.dataset.play = `Suelta aquí para jugar ${ACT[d.card.type].n}`; } }
  try { d.el.setPointerCapture(d.pid); } catch (_) {}
  if (d.touch && navigator.vibrate) { try { navigator.vibrate(15); } catch (_) {} }
  moveDrag(x, y);
}
function moveDrag(x, y) {
  const d = drag; if (!d || !d.on) return;
  d.ghost.style.transform = `translate(${x - d.dx}px,${y - d.dy}px) rotate(-5deg) scale(1.06)`;
  d.ghost.style.visibility = 'hidden';
  const under = document.elementFromPoint(x, y);
  d.ghost.style.visibility = '';
  const hot = canTrade() ? under && under.closest('.field .card[data-cid]') : null;
  const onTable = !hot && playable(d.card) && under && under.closest('.table');
  if (hot !== d.hot) { d.hot && d.hot.classList.remove('drop-hot'); hot && hot.classList.add('drop-hot'); d.hot = hot; }
  d.play = !!onTable; const tbl = $('.table'); tbl && tbl.classList.toggle('play-hot', d.play);
}
document.addEventListener('pointerdown', e => {
  const el = e.target.closest('.hand .card[data-h]'); if (!el || e.button > 0) return;
  const hc0 = myHand().find(c => c.id === +el.dataset.h); if (!hc0) return;
  const touch = e.pointerType === 'touch' || e.pointerType === 'pen';
  const can = canDragCard(hc0);
  if (!touch && !can) return;
  drag = { el, card: hc0, id: hc0.id, x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, on: false, armed: false, can, ghost: null, hot: null, pid: e.pointerId, touch };
  if (touch) {
    // Mantener presionada: se abre la carta en grande. Si luego mueves el dedo, la arrastras.
    const d = drag;
    d.lp = setTimeout(() => {
      if (drag !== d || d.on) return;
      d.armed = true; el.classList.add('lp'); showSheet(hc0.kind, hc0.type);
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch (_) {} }
    }, 300);
  }
});
document.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.pid) return;
  drag.lx = e.clientX; drag.ly = e.clientY;
  if (!drag.on) {
    const moved = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
    if (drag.touch) {
      if (!drag.armed) { if (moved > 8) { clearTimeout(drag.lp); drag = null; } return; }
      if (!drag.can || moved < 12) return;
      hideSheet(); startDrag(e.clientX, e.clientY);
    }
    else if (moved < 7) return;
    else startDrag(e.clientX, e.clientY);
  }
  if (!drag.on) return;
  e.preventDefault();
  moveDrag(e.clientX, e.clientY);
}, { passive: false });
// Mientras arrastras con el dedo, la página no debe desplazarse.
document.addEventListener('touchmove', e => { if (drag && (drag.on || drag.armed)) e.preventDefault(); }, { passive: false });
const noSelectZone = t => { const el = t && (t.nodeType === 1 ? t : t.parentElement); return el && el.closest('.card, .hand, .table, .rv, .me-head, .flock, #tsheet'); };
document.addEventListener('contextmenu', e => { if (noSelectZone(e.target)) e.preventDefault(); });
document.addEventListener('selectstart', e => { if (noSelectZone(e.target)) e.preventDefault(); });
document.addEventListener('dragstart', e => { if (noSelectZone(e.target)) e.preventDefault(); });
function endDrag(e, cancel) {
  if (!drag || (e && e.pointerId !== drag.pid)) return;
  const d = drag; drag = null; peekBlock = false;
  clearTimeout(d.lp); d.el.classList.remove('lp');
  if (!d.on) { if (d.armed) { swallowClick = true; setTimeout(() => { swallowClick = false; }, 0); } return; }
  swallowClick = true; setTimeout(() => { swallowClick = false; }, 0);
  d.ghost.remove(); d.el.classList.remove('dragging'); d.hot && d.hot.classList.remove('drop-hot');
  const tb = $('.table'); tb && tb.classList.remove('dropping', 'can-play', 'play-hot');
  if (cancel) return;
  const c = myHand().find(x => x.id === d.id); if (!c) return;
  if (!d.hot && d.play && canAct()) { sel.clear(); humanPlay([c]); return; }
  if (!d.hot) return;
  const fc = V.field.find(x => x.id === +d.hot.dataset.cid);
  if (fc && canTrade()) confirmTrade(c, fc);
}
document.addEventListener('pointerup', e => endDrag(e, false));
document.addEventListener('pointercancel', e => endDrag(e, true));
document.addEventListener('click', e => { if (swallowClick) { e.stopImmediatePropagation(); e.preventDefault(); swallowClick = false; } }, true);

/* ---------------- reglas ---------------- */
const RULES = `<div class="rules">
<h4>Objetivo</h4><ul><li>3 alpacas iguales en tu mano forman un <b>rebaño</b> al instante. Solo un rebaño de cada tipo.</li><li>Gana quien junte los rebaños necesarios (5 con 2–3 jugadores, 4 con 4, 3 con 5–8) <b>sin ninguno desenmascarado</b>.</li><li>O quien junte las <b>3 Alpacas Doradas</b>: victoria instantánea.</li></ul>
<h4>Tu turno</h4><ul><li>Juega tantas acciones como quieras.</li><li>Cambia 1 carta con el Campo (una vez por turno).</li><li>Compra: paga 2 cartas iguales y toma 1 del Campo (ilimitado).</li><li>Rebaño comodín: 5 alpacas de tipos distintos, una vez y solo en tu turno.</li><li>Roba 1 carta para terminar. Tienes 2 minutos por turno.</li></ul>
<h4>Ataques</h4><ul><li>Se resuelven al aparecer. Devoran todos los rebaños desenmascarados; si no hay ninguno, todos sufren su efecto secundario.</li><li>Quitas un Desenmascarar de tu rebaño pagando 2 cartas en tu turno.</li></ul>
<h4>Alpaca Dorada</h4><div class="rrow gold"><img src="img/dorada.webp" alt="Carta Alpaca Dorada"><div><b>Alpaca Dorada</b> <small>Legendaria · ×3</small><p>Junta las 3 en tu mano y ganas al instante. No forma rebaño ni cuenta para el comodín.</p></div></div>
<h4>Alpacas</h4><div class="rgrid">${SHEEP.map(x => `<div class="ritem"><img src="img/${x.k}.webp" alt="" style="--c:${x.c}"><span><b>${x.n}</b><small>×9 en el mazo</small></span></div>`).join('')}</div>
<h4>Acciones</h4><div class="rlist">${Object.entries(ACT).map(([k, a]) => `<div class="rrow"><img src="img/a-${k}.webp" alt="Carta ${a.n}"><div><b>${a.n}</b> <small>${a.o} · ×${a.q}</small><p>${a.d}</p></div></div>`).join('')}</div>
<h4>Ataques</h4><div class="rlist">${Object.entries(ATK).map(([k, a]) => `<div class="rrow atk"><img src="img/${k}.webp" alt="Carta ${a.n}"><div><b>${a.n}</b> <small>Ataque · ×1</small><p>Devora todos los rebaños desenmascarados. Si no hay ninguno: ${a.d}</p></div></div>`).join('')}</div>
<p class="note">Mazo: 72 alpacas (8 tipos × 9), 3 Alpacas Doradas, 64 acciones, 6 ataques.</p>
<p class="note">Versión ${(document.querySelector('meta[name=build]') || {}).content || '?'}</p></div>`;

/* ---------------- clics ---------------- */
document.addEventListener('click', async e => {
  const a = e.target.closest('[data-a]');
  if (a) {
    const v = a.dataset.a;
    if (v === 'rules') return info('Cómo se juega', RULES);
    if (v === 'create') return doCreate();
    if (v === 'leave') return leaveRoom();
    if (v === 'addbot') { const r = await emit('addBot'); if (r.error) toast(r.error, 'atk'); return; }
    if (v === 'start') { const r = await emit('start'); if (r.error) toast(r.error, 'atk'); return; }
    if (v === 'copy') {
      const link = shareLink();
      try { await navigator.clipboard.writeText(link); toast('Enlace copiado. Pásalo a tus amigos.', 'flk'); }
      catch (_) { const r = document.createRange(); r.selectNodeContents($('#lnk')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Copia el enlace seleccionado.', ''); }
      return;
    }
    if (v === 'log' && V) return info('Bitácora', `<ol class="loglist">${V.log.map(l => `<li class="${l.cls}">${esc(l.msg)}</li>`).join('')}</ol>`);
    if (v === 'discard' && V) return info(`Descarte (${V.discard.length})`, `<div class="picker">${[...V.discard].reverse().map(c => cardHTML(c, { attrs: 'tabindex="-1"' })).join('')}</div>`);
  }
  const rv = e.target.closest('[data-rival]');
  if (rv && V) {
    const i = +rv.dataset.rival, q = V.players[i];
    return info(esc(q.name), `<p>${q.bot ? 'Bot · ' : ''}${q.handCount} carta${q.handCount === 1 ? '' : 's'} en la mano · ${q.flocks.length} de ${V.target} rebaños ${pips(q)}</p><div class="flocks rv-flocks">${q.flocks.length ? q.flocks.map(flockHTML).join('') : '<span class="empty">Sin rebaños todavía</span>'}</div>`);
  }
  const k = e.target.closest('[data-kick]');
  if (k) { const r = await emit('kick', { seat: +k.dataset.kick }); if (r.error) toast(r.error, 'atk'); return; }
  if (!V) return;
  const h = e.target.closest('[data-h]');
  if (h && canAct()) { const id = +h.dataset.h; sel.has(id) ? sel.delete(id) : sel.add(id); return render(); }
  const op = e.target.closest('[data-op]');
  if (op && canAct()) onOp(op.dataset.op);
});
document.addEventListener('change', async e => {
  if (e.target.id === 'short') { const r = await emit('opts', { short: e.target.checked }); if (r.error) toast(r.error, 'atk'); }
});
document.addEventListener('click', e => {
  const t = $('#tsheet');
  if (t && !t.hidden && t.contains(e.target)) { e.stopImmediatePropagation(); hideSheet(); return; }
  // En pantallas táctiles, tocar una carta que no es de tu mano (Campo, descarte abierto) muestra su detalle.
  if (!isCoarse()) return;
  const c = e.target.closest('.card[data-ck]');
  if (!c || c.closest('.hand') || c.closest('[data-p]') || c.closest('#banner') || c.matches('[data-a]') || c.closest('.swap')) return;
  const [kind, type] = c.dataset.ck.split(':'); e.stopImmediatePropagation(); showSheet(kind, type);
}, true);
document.addEventListener('input', e => { if (e.target.id === 'code') e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); });

$('#logo').innerHTML = '<img src="img/back.webp" alt="">';
