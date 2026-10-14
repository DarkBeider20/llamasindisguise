'use strict';
// Motor del juego, autoritativo en el servidor. Cada partida es un closure con su estado S.
// La comunicación con los jugadores humanos pasa por `hooks`:
//   hooks.change()                     -> el estado cambió (el servidor reenvía vistas)
//   hooks.toast(seat|null, msg, cls)   -> aviso flotante a un jugador o a todos
//   hooks.attack(card, text)           -> animación de ataque para todos
//   hooks.prompt(seat, prompt, ms)     -> Promise con la respuesta del jugador (undefined si no responde)
//   hooks.over(info)                   -> fin de la partida
const { SHEEP, GOLD, SH, ACT, ATK, targetFor } = require('./data');

class Over extends Error { constructor(w, gold = false) { super('over'); this.w = w; this.gold = gold; } }
class Stale extends Error { constructor() { super('stale'); } }

const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pick = a => a[Math.random() * a.length | 0];
const isGold = c => c && c.kind === 'sheep' && c.type === 'dorada';
const cn = c => c.kind === 'sheep' ? 'Alpaca ' + SH[c.type].n : c.kind === 'action' ? ACT[c.type].n : ATK[c.type].n;
const pub = c => ({ id: c.id, kind: c.kind, type: c.type });

const TIMING = { bot: 900, attack: 1700, nice: 15000, pick: 20000, turn: 35000, turnBonus: 10000, smallBonus: 5000, turnAway: 6000 };

function createGame(seats, opts, hooks) {
  let uid = 0, fid = 0;
  const mk = (kind, type) => ({ id: ++uid, kind, type });
  const players = seats.map(s => ({ name: s.name, bot: !!s.bot, connected: !s.bot, hand: [], flocks: [], gold: 0 }));
  const n = players.length;

  const deck = [];
  SHEEP.forEach(s => { for (let i = 0; i < 9; i++) deck.push(mk('sheep', s.k)); });
  Object.entries(ACT).forEach(([k, a]) => { for (let i = 0; i < a.q; i++) deck.push(mk('action', k)); });
  shuffle(deck);
  players.forEach(p => { for (let i = 0; i < 5; i++) p.hand.push(deck.pop()); });
  const field = [deck.pop(), deck.pop(), deck.pop()];
  // Como en el reglamento: Instantáneas (ataques) y Doradas entran al mazo después de repartir.
  Object.keys(ATK).forEach(k => deck.push(mk('attack', k)));
  for (let i = 0; i < 3; i++) deck.push(mk('sheep', 'dorada'));
  shuffle(deck);

  const S = {
    players, deck, discard: [], field, turn: Math.random() * n | 0, traded: false,
    target: targetFor(n, opts && opts.short), busy: false, waiting: null, deadline: 0,
    log: [], over: null, alive: true, endTurn: null, turnTimer: null,
  };

  const D = opts && opts.fast ? 0 : 1;
  const sleep = ms => new Promise((res, rej) => setTimeout(() => S.alive ? res() : rej(new Stale()), ms * D));
  const idx = p => S.players.indexOf(p);
  const render = () => { if (S.alive || S.over) hooks.change(); };
  const fname = f => f.wild ? 'Comodín' : SH[f.type].n;
  const opps = p => S.players.filter(q => q !== p);
  const count = (p, t) => p.hand.filter(c => c.kind === 'sheep' && c.type === t).length;
  const hasFlock = (p, t) => p.flocks.some(f => f.type === t);
  const removeCards = (p, cs) => { p.hand = p.hand.filter(c => !cs.includes(c)); };
  const hasNice = q => q.hand.some(c => c.kind === 'action' && c.type === 'nice');

  // priv: { seatIndex: 'texto que solo ve ese jugador' }
  function log(msg, cls = '', priv = null) {
    if (!cls && /forma un rebaño/.test(msg)) cls = 'flk';
    S.log.unshift({ msg, cls, priv });
    if (S.log.length > 200) S.log.pop();
    if (cls === 'atk' || cls === 'flk') hooks.toast(null, msg, cls);
    if (priv) for (const [k, m] of Object.entries(priv)) if (!(cls === 'atk' || cls === 'flk')) hooks.toast(+k, m, '');
  }

  /* ---------- preguntas a humanos ---------- */
  async function askHuman(p, prompt, ms, dflt) {
    if (p.bot || !p.connected || !S.alive) return dflt;
    const v = await hooks.prompt(idx(p), prompt, ms);
    if (!S.alive) throw new Stale();
    return v === undefined || v === null ? dflt : v;
  }
  async function pickCards(p, { title, text = '', cards, count: k, dflt }) {
    const fallback = dflt || shuffle([...cards]).slice(0, k);
    const ids = await askHuman(p, { type: 'pick', title, text, cards: cards.map(pub), count: k }, TIMING.pick, null);
    if (!Array.isArray(ids)) return fallback;
    const chosen = [...new Set(ids)].map(id => cards.find(c => c.id === id)).filter(Boolean);
    return chosen.length === k ? chosen : fallback;
  }

  /* ---------- mazo, campo y ataques ---------- */
  function drawRaw() {
    if (!S.deck.length) {
      if (!S.discard.length) return null;
      S.deck = shuffle(S.discard); S.discard = [];
      log('El mazo se acabó: se baraja el descarte.');
    }
    return S.deck.pop();
  }
  async function drawCard(p) {
    while (true) {
      const c = drawRaw(); if (!c) return null;
      if (c.kind === 'attack') { S.discard.push(c); await resolveAttack(c, p); continue; }
      p.hand.push(c); render(); await checkFlocks(); return c;
    }
  }
  async function refillField() {
    while (S.field.length < 3) {
      const c = drawRaw(); if (!c) return;
      if (c.kind === 'attack') { log('¡Salió un Ataque en el Campo!', 'atk'); S.discard.push(c); await resolveAttack(c, null); continue; }
      S.field.push(c);
    }
    render();
  }
  async function resolveAttack(c, drawer) {
    const a = ATK[c.type];
    log(`¡ATAQUE: ${a.n}!${drawer ? ` (lo sacó ${drawer.name})` : ''}`, 'atk');
    const exposed = []; S.players.forEach(p => p.flocks.forEach(f => { if (f.exposed) exposed.push([p, f]); }));
    hooks.attack(pub(c), exposed.length ? `Devora ${exposed.length === 1 ? 'el rebaño desenmascarado' : `los ${exposed.length} rebaños desenmascarados`}.` : a.d);
    render(); await sleep(TIMING.attack);
    if (exposed.length) {
      for (const [p, f] of exposed) {
        p.flocks.splice(p.flocks.indexOf(f), 1); S.discard.push(...f.cards, f.exposed);
        log(`El ${a.n} devora el rebaño ${fname(f)} de ${p.name}.`, 'atk');
      }
    } else await secondary(c.type);
    render(); await checkFlocks();
  }
  async function secondary(t) {
    const P = S.players;
    if (t === 'puma' || t === 'condor') {
      const dir = t === 'puma' ? 1 : -1;
      const gives = await Promise.all(P.map(async (p, i) => {
        if (!p.hand.length) return null;
        if (p.bot) return worst(p, p.hand);
        const to = P[(i + dir + n) % n].name;
        return (await pickCards(p, { title: `Pasa 1 carta a ${to}`, text: 'Ataque: todos pasan una carta.', cards: p.hand, count: 1, dflt: [worst(p, p.hand)] }))[0];
      }));
      P.forEach((p, i) => { if (gives[i] && p.hand.includes(gives[i])) removeCards(p, [gives[i]]); else gives[i] = null; });
      P.forEach((p, i) => { if (gives[i]) P[(i + dir + n) % n].hand.push(gives[i]); });
      const priv = {};
      P.forEach((p, i) => {
        if (p.bot) return;
        const mine = gives[i], got = gives[(i - dir + n) % n];
        priv[i] = `Diste ${mine ? cn(mine) : 'nada'} y recibiste ${got ? cn(got) : 'nada'}.`;
      });
      log(`Todos pasan una carta al jugador ${dir === 1 ? 'siguiente' : 'anterior'}.`, '', priv);
    } else if (t === 'zorro') {
      P.forEach(p => { if (p.hand.length) { const c = pick(p.hand); removeCards(p, [c]); S.discard.push(c); log(`${p.name} descarta ${cn(c)}.`); } });
    } else if (t === 'lobo') {
      const picks = await Promise.all(P.map(async p => {
        if (!p.hand.length) return null;
        if (p.bot) return worst(p, p.hand);
        return (await pickCards(p, { title: 'Descarta 1 carta', text: 'Ataque del Lobo.', cards: p.hand, count: 1, dflt: [worst(p, p.hand)] }))[0];
      }));
      P.forEach((p, i) => { const c = picks[i]; if (c && p.hand.includes(c)) { removeCards(p, [c]); S.discard.push(c); log(`${p.name} descarta ${cn(c)}.`); } });
    } else if (t === 'oso') {
      S.discard.push(...S.field); S.field = []; log('Se renueva el Campo.'); await refillField();
    } else if (t === 'aguila') {
      for (const p of P) await drawCard(p);
      log('Todos roban una carta.');
    }
  }
  async function checkFlocks() {
    for (const p of S.players) {
      const g = count(p, 'dorada');
      if (!p.bot && g === 2 && p.gold < 2) hooks.toast(idx(p), '¡Tienes 2 Alpacas Doradas! Te falta 1 para ganar.', 'turn');
      p.gold = g;
      for (const s of SHEEP) {
        if (!hasFlock(p, s.k) && count(p, s.k) >= 3) {
          const cs = p.hand.filter(c => c.kind === 'sheep' && c.type === s.k).slice(0, 3);
          removeCards(p, cs); p.flocks.push({ id: ++fid, type: s.k, cards: cs, exposed: null, wild: false });
          log(`${p.name} forma un rebaño de ${s.n} (${p.flocks.length}/${S.target}).`);
        }
      }
    }
    checkWin();
  }
  function checkWin() {
    for (const p of S.players) if (count(p, 'dorada') >= 3) throw new Over(p, true);
    for (const p of S.players) if (p.flocks.length >= S.target && !p.flocks.some(f => f.exposed)) throw new Over(p);
  }

  /* ---------- acciones ---------- */
  function describe(pl) {
    let s = '';
    if (pl.target) s += ` contra ${pl.target.name}`;
    if (pl.flock) s += ` (rebaño ${fname(pl.flock)})`;
    if (pl.action === 'gimme') s += pl.want ? `, pidiendo ${cn(pl.want)}` : ', que elija qué dar';
    if (pl.action === 'restock') s += pl.mode === 'hand' ? ': cambia su mano' : ': renueva el Campo';
    if (pl.action === 'yoink') s += pl.what === 'expose' ? ': quita el Desenmascarar' : ': toma la carta de arriba';
    return s;
  }
  async function playAction(p, cards, pl) {
    removeCards(p, cards); S.discard.push(...cards);
    log(`${p.name} juega ${pl.double ? 'Doble ' : ''}${ACT[pl.action].n}${describe(pl)}.`);
    render(); await sleep(300);
    const cancelled = await niceTryWindow(p, pl);
    if (cancelled) { log(`La acción de ${p.name} queda cancelada.`); render(); return; }
    const r = await resolve(p, pl, cards);
    render(); await checkFlocks(); render(); return r;
  }
  // Cadena de ¡Buen intento!: solo participan quien jugó la acción (quiere que ocurra) y su objetivo (quiere cancelarla).
  async function niceTryWindow(actor, pl) {
    const side = new Map(), chain = [];
    side.set(actor, 1);
    if (pl.target && pl.target !== actor) side.set(pl.target, -1);
    let cancelled = false, last = actor, guard = 0;
    while (guard++ < 100) {
      let responder = null; const start = idx(last);
      for (let k = 1; k < n; k++) {
        const q = S.players[(start + k) % n];
        if (!hasNice(q)) continue;
        if (await wantsNice(q, { actor, pl, cancelled, side, chain })) { responder = q; break; }
      }
      if (!responder) break;
      const nt = responder.hand.find(c => c.kind === 'action' && c.type === 'nice');
      if (!nt) break;
      removeCards(responder, [nt]); S.discard.push(nt);
      cancelled = !cancelled; last = responder;
      chain.push({ who: responder.name, cancelled });
      log(`${responder.name} responde con ¡Buen intento! ${cancelled ? '(cancela la jugada)' : '(niega la cancelación: la jugada sigue)'}`);
      hooks.toast(null, `${responder.name}: ¡Buen intento! → ${cancelled ? 'jugada cancelada' : 'la jugada sigue'}`, cancelled ? 'atk' : 'flk');
      render(); await sleep(550);
    }
    return cancelled;
  }
  function wouldHurt(q, pl) {
    if (pl.action === 'gimme' && pl.want) return q.hand.some(c => c.kind === pl.want.kind && c.type === pl.want.type);
    if (pl.action === 'gimme' || pl.action === 'steal') return q.hand.length > 0;
    if (pl.flock) return q.flocks.includes(pl.flock);
    return true;
  }
  async function wantsNice(q, { actor, pl, cancelled, side, chain }) {
    const a = pl.action, sd = side.get(q) ?? 0;
    const against = (sd === 1 && cancelled) || (sd === -1 && !cancelled);
    if (!against) return false;
    // Al objetivo solo se le ofrece ¡Buen intento! si la jugada de verdad le quitaría algo
    // (p. ej. ¡Dame! pidiendo una carta que no tiene no le hace nada).
    if (sd === -1 && !wouldHurt(q, pl)) return false;
    if (!q.bot) {
      const left = q.hand.filter(c => c.kind === 'action' && c.type === 'nice').length;
      const rows = [`${actor.name} juega ${ACT[a].n}${describe(pl)}`]
        .concat(chain.map(st => `${st.who}: ¡Buen intento! → ${st.cancelled ? 'cancelada' : 'la jugada sigue'}`));
      const title = cancelled ? 'Cancelaron tu jugada' : (chain.length ? 'Negaron tu cancelación' : '¿Usar ¡Buen intento!?');
      const v = await askHuman(q, { type: 'nice', title, rows, cancelled, left }, TIMING.nice, false);
      return v === true;
    }
    const ch = sd === 1 ? .75 : ({ yank: .95, expose: .8, yoink: .8, steal: .45, gimme: .45 }[a] ?? .3);
    return Math.random() < ch;
  }
  async function resolve(p, pl, cards) {
    const a = pl.action, q = pl.target, f = pl.flock, pi = idx(p);
    if (a === 'draw2') {
      const got = [];
      for (let i = 0; i < 2; i++) { const c = await drawCard(p); if (c) got.push(c); await sleep(200); }
      log(`${p.name} roba 2 cartas.`, '', p.bot ? null : { [pi]: `Robaste ${got.map(cn).join(' y ') || 'nada'}.` });
    } else if (a === 'take2') {
      const k = Math.min(2, S.field.length); if (!k) return;
      const dflt = [...S.field].sort((x, y) => val(p, y, true) - val(p, x, true)).slice(0, k);
      const picks = p.bot ? dflt : await pickCards(p, { title: 'Toma 2 cartas del Campo', cards: S.field, count: k, dflt });
      S.field = S.field.filter(c => !picks.includes(c)); p.hand.push(...picks);
      log(`${p.name} toma ${picks.map(cn).join(' y ')} del Campo.`); await checkFlocks(); await refillField();
    } else if (a === 'restock') {
      if (pl.mode === 'hand') {
        S.discard.push(...p.hand); p.hand = [];
        log(`${p.name} descarta su mano y roba 5.`);
        for (let i = 0; i < 5; i++) await drawCard(p);
        return 'end';
      }
      S.discard.push(...S.field); S.field = []; log('Se renueva el Campo.'); await refillField();
    } else if (a === 'yank') {
      if (!q.flocks.includes(f) || hasFlock(p, f.type)) { log('El rebaño ya no se puede arrebatar.'); return; }
      q.flocks.splice(q.flocks.indexOf(f), 1); p.flocks.push(f);
      log(`${p.name} arrebata el rebaño ${fname(f)} de ${q.name}${f.exposed ? ' (sigue desenmascarado)' : ''}.`, 'atk');
    } else if (a === 'dig') {
      const pool = S.discard.filter(c => c.kind !== 'attack' && !cards.includes(c));
      if (!pool.length) { log('El descarte está vacío.'); return; }
      const c = p.bot ? best(p, pool) : (await pickCards(p, { title: 'Escarba en el descarte', text: 'Elige 1 carta.', cards: pool, count: 1, dflt: [best(p, pool)] }))[0];
      S.discard.splice(S.discard.indexOf(c), 1); p.hand.push(c); log(`${p.name} recupera ${cn(c)} del descarte.`);
    } else if (a === 'expose') {
      if (!q.flocks.includes(f) || f.exposed) return;
      const card = cards[0]; S.discard.splice(S.discard.indexOf(card), 1); f.exposed = card;
      log(`El rebaño ${fname(f)} de ${q.name} queda desenmascarado.`, 'atk');
    } else if (a === 'steal') {
      if (!q.hand.length) return;
      const c = pick(q.hand); removeCards(q, [c]); p.hand.push(c);
      const priv = {}; if (!p.bot) priv[pi] = `Le hurtas ${cn(c)} a ${q.name}.`; if (!q.bot) priv[idx(q)] = `${p.name} te hurta ${cn(c)}.`;
      log(`${p.name} hurta una carta a ${q.name}.`, '', priv);
    } else if (a === 'gimme') {
      let c = null;
      if (pl.want) {
        c = q.hand.find(x => x.kind === pl.want.kind && x.type === pl.want.type);
        if (!c) { log(`${q.name} no tiene ${cn(pl.want)}.`); return; }
        removeCards(q, [c]); p.hand.push(c);
        log(`${q.name} entrega ${cn(c)} a ${p.name}.`);
      } else {
        if (!q.hand.length) return;
        c = q.bot ? worst(q, q.hand) : (await pickCards(q, { title: `${p.name} te pide una carta`, text: 'Tú eliges cuál le das.', cards: q.hand, count: 1, dflt: [worst(q, q.hand)] }))[0];
        if (!q.hand.includes(c)) return;
        removeCards(q, [c]); p.hand.push(c);
        const priv = {}; if (!p.bot) priv[pi] = `${q.name} te entrega ${cn(c)}.`; if (!q.bot) priv[idx(q)] = `Le entregas ${cn(c)} a ${p.name}.`;
        log(`${q.name} entrega una carta a ${p.name}.`, '', priv);
      }
    } else if (a === 'yoink') {
      if (!q.flocks.includes(f)) return;
      if (pl.what === 'expose') {
        if (!f.exposed) return;
        p.hand.push(f.exposed); f.exposed = null;
        log(`${p.name} quita el Desenmascarar del rebaño ${fname(f)}.`);
      } else {
        const c = f.cards.pop(); q.flocks.splice(q.flocks.indexOf(f), 1); q.hand.push(...f.cards);
        if (f.exposed) S.discard.push(f.exposed);
        p.hand.push(c);
        log(`${p.name} pellizca ${cn(c)} del rebaño de ${q.name}; el resto vuelve a su mano.`);
      }
    }
  }
  async function payExpose(p, f, two) {
    removeCards(p, two); S.discard.push(...two, f.exposed); f.exposed = null;
    log(`${p.name} paga 2 cartas y quita el Desenmascarar de su rebaño ${fname(f)}.`);
    render(); await checkFlocks();
  }
  async function formWild(p, five) {
    removeCards(p, five); p.flocks.push({ id: ++fid, type: 'wild', wild: true, cards: five, exposed: null });
    log(`${p.name} forma un rebaño comodín (${p.flocks.length}/${S.target}).`, 'flk'); render(); await checkFlocks();
  }
  async function tradeWith(p, hc, fc) {
    removeCards(p, [hc]); S.field.splice(S.field.indexOf(fc), 1, hc); p.hand.push(fc); S.traded = true;
    log(`${p.name} cambia ${cn(hc)} por ${cn(fc)} del Campo.`); render(); await checkFlocks();
  }
  async function buy(p, two, fc) {
    removeCards(p, two); S.discard.push(...two); S.field.splice(S.field.indexOf(fc), 1); p.hand.push(fc);
    log(`${p.name} paga 2 cartas iguales y compra ${cn(fc)} del Campo.`); render(); await checkFlocks(); await refillField();
  }

  /* ---------- bots ---------- */
  const AV = { nice: 9, yank: 8, yoink: 7, expose: 6, take2: 6, draw2: 6, steal: 5, gimme: 5, dig: 4, restock: 3 };
  function val(p, c, incoming = false) {
    if (isGold(c)) return 10 + (count(p, 'dorada') - (incoming ? 0 : 1)) * 12;
    if (c.kind === 'sheep') { if (hasFlock(p, c.type)) return 1; const k = count(p, c.type) - (incoming ? 0 : 1); return 3 + k * 4; }
    return AV[c.type] || 0;
  }
  const best = (p, cs) => [...cs].sort((a, b) => val(p, b, true) - val(p, a, true))[0];
  const worst = (p, cs) => [...cs].sort((a, b) => val(p, a) - val(p, b))[0];
  function botMove(p) {
    const H = t => p.hand.filter(c => c.kind === 'action' && c.type === t);
    const others = opps(p);
    const leader = [...others].sort((a, b) => b.flocks.length - a.flocks.length)[0];
    if (H('draw2').length) return { cards: [H('draw2')[0]], pl: { action: 'draw2' } };
    if (H('yoink').length) {
      for (const q of others) for (const f of q.flocks) if (!f.wild && count(p, f.type) === 2 && !hasFlock(p, f.type)) return { cards: [H('yoink')[0]], pl: { action: 'yoink', target: q, flock: f, what: 'top' } };
      const ex = p.flocks.find(f => f.exposed); if (ex) return { cards: [H('yoink')[0]], pl: { action: 'yoink', target: p, flock: ex, what: 'expose' } };
    }
    const yk = H('yank');
    if (yk.length) {
      const c = []; others.forEach(q => q.flocks.forEach(f => { if (!hasFlock(p, f.type)) c.push({ q, f, ok: q.flocks.length > p.flocks.length }); }));
      c.sort((a, b) => (a.f.exposed ? 1 : 0) - (b.f.exposed ? 1 : 0) || b.q.flocks.length - a.q.flocks.length);
      const s = c.find(x => x.ok); if (s) return { cards: [yk[0]], pl: { action: 'yank', target: s.q, flock: s.f } };
      if (yk.length >= 2 && c.length) return { cards: yk.slice(0, 2), pl: { action: 'yank', double: true, target: c[0].q, flock: c[0].f } };
    }
    if (H('expose').length && leader && leader.flocks.length) {
      const f = leader.flocks.find(f => !f.exposed);
      if (f && (leader.flocks.length >= 2 || Math.random() < .35)) return { cards: [H('expose')[0]], pl: { action: 'expose', target: leader, flock: f } };
    }
    if (H('take2').length && S.field.length && Math.max(...S.field.map(c => val(p, c, true))) >= 7) return { cards: [H('take2')[0]], pl: { action: 'take2' } };
    if (H('dig').length) { const pool = S.discard.filter(c => c.kind !== 'attack'); if (pool.some(c => val(p, c, true) >= 9)) return { cards: [H('dig')[0]], pl: { action: 'dig' } }; }
    const rich = others.filter(q => q.hand.length).sort((a, b) => b.hand.length - a.hand.length)[0];
    if (H('steal').length && rich) return { cards: [H('steal')[0]], pl: { action: 'steal', target: rich } };
    if (H('gimme').length && rich) {
      const t = count(p, 'dorada') === 2 ? GOLD : SHEEP.find(s => count(p, s.k) === 2 && !hasFlock(p, s.k));
      return { cards: [H('gimme')[0]], pl: { action: 'gimme', target: rich, want: t && Math.random() < (t.gold ? .7 : .45) ? { kind: 'sheep', type: t.k } : null } };
    }
    if (H('restock').length && S.field.length && Math.max(...S.field.map(c => val(p, c, true))) < 5) return { cards: [H('restock')[0]], pl: { action: 'restock', mode: 'field' } };
    return null;
  }
  async function botTurn(p) {
    await sleep(TIMING.bot);
    for (const f of p.flocks.filter(f => f.exposed)) {
      if (p.hand.length >= 2 && (p.hand.length >= 4 || p.flocks.length >= S.target - 1 || Math.random() < .5)) {
        const two = [...p.hand].sort((a, b) => val(p, a) - val(p, b)).slice(0, 2); await payExpose(p, f, two); await sleep(TIMING.bot);
      }
    }
    for (let i = 0; i < 10; i++) { const m = botMove(p); if (!m) break; const r = await playAction(p, m.cards, m.pl); await sleep(TIMING.bot); if (r === 'end') return; }
    const groups = {}; p.hand.forEach(c => { const k = c.kind + ':' + c.type; (groups[k] = groups[k] || []).push(c); });
    for (const g of Object.values(groups)) {
      if (g.length < 2 || !S.field.length) continue;
      const useless = g[0].kind === 'sheep' ? hasFlock(p, g[0].type) : (g[0].type === 'restock' || g[0].type === 'dig');
      const b = best(p, S.field);
      if (useless && val(p, b, true) >= 11) { await buy(p, g.slice(0, 2), b); await sleep(TIMING.bot); break; }
    }
    if (!S.traded && S.field.length && p.hand.length) {
      const fb = best(p, S.field), hw = worst(p, p.hand);
      if (val(p, fb, true) > val(p, hw) + 1) { await tradeWith(p, hw, fb); await sleep(TIMING.bot); }
    }
    if (!hasFlock(p, 'wild') && p.flocks.length < S.target) {
      const types = [...new Set(p.hand.filter(c => c.kind === 'sheep' && !isGold(c)).map(c => c.type))].filter(t => hasFlock(p, t) || count(p, t) === 1);
      if (types.length >= 5) { const five = types.slice(0, 5).map(t => p.hand.find(c => c.kind === 'sheep' && c.type === t)); await formWild(p, five); await sleep(TIMING.bot); }
    }
    log(`${p.name} roba y termina su turno.`); await drawCard(p); render();
  }

  /* ---------- turno humano ---------- */
  function armTurnTimer(p) {
    clearTimeout(S.turnTimer);
    if (!S.alive || S.waiting !== p) return;
    const ms = Math.max(200, S.deadline - Date.now());
    S.turnTimer = setTimeout(() => {
      if (!S.alive || S.waiting !== p) return;
      if (S.busy) { S.deadline = Date.now() + 3000; return armTurnTimer(p); }
      log(`Se acabó el tiempo de ${p.name}.`);
      intent(idx(p), { op: 'draw' }, true);
    }, ms);
  }
  function humanTurn(p) {
    return new Promise(res => {
      S.waiting = p; S.endTurn = res;
      S.deadline = Date.now() + (p.connected ? TIMING.turn : TIMING.turnAway) * D;
      armTurnTimer(p); render();
    });
  }
  function finishTurn() {
    clearTimeout(S.turnTimer);
    const r = S.endTurn; S.endTurn = null; S.waiting = null; r && r();
  }

  // Valida y ejecuta una jugada enviada por un jugador. Devuelve {ok} o {error}.
  async function intent(seat, msg, forced = false) {
    const p = S.players[seat];
    if (!p || S.over || !S.alive) return { error: 'La partida terminó.' };
    if (S.waiting !== p) return { error: 'No es tu turno.' };
    if (S.busy) return { error: 'Espera a que termine la jugada en curso.' };
    const byId = (list, id) => list.find(c => c.id === id);
    const handCards = ids => {
      if (!Array.isArray(ids)) return null;
      const cs = [...new Set(ids)].map(id => byId(p.hand, id));
      return cs.every(Boolean) && cs.length === ids.length ? cs : null;
    };
    const op = msg && msg.op;
    let run = null;

    if (op === 'draw') {
      run = async () => { log(`${p.name} roba y termina su turno.`); const c = await drawCard(p); if (c && !p.bot) hooks.toast(seat, `Robaste ${cn(c)}.`, ''); return 'end'; };
    } else if (op === 'trade') {
      const hc = byId(p.hand, msg.hand), fc = byId(S.field, msg.field);
      if (S.traded) return { error: 'Ya cambiaste con el Campo este turno.' };
      if (!hc || !fc) return { error: 'Esa carta ya no está disponible.' };
      run = () => tradeWith(p, hc, fc);
    } else if (op === 'buy') {
      const two = handCards(msg.cards), fc = byId(S.field, msg.field);
      if (!two || two.length !== 2 || two[0].kind !== two[1].kind || two[0].type !== two[1].type) return { error: 'Para comprar paga 2 cartas iguales.' };
      if (!fc) return { error: 'Esa carta ya no está en el Campo.' };
      run = () => buy(p, two, fc);
    } else if (op === 'pay') {
      const two = handCards(msg.cards), f = p.flocks.find(x => x.id === msg.flock);
      if (!two || two.length !== 2) return { error: 'Elige 2 cartas para pagar.' };
      if (!f || !f.exposed) return { error: 'Ese rebaño no está desenmascarado.' };
      run = () => payExpose(p, f, two);
    } else if (op === 'wild') {
      const five = handCards(msg.cards);
      if (!five || five.length !== 5 || !five.every(c => c.kind === 'sheep' && !isGold(c)) || new Set(five.map(c => c.type)).size !== 5) return { error: 'El comodín necesita 5 alpacas de tipos distintos.' };
      if (hasFlock(p, 'wild')) return { error: 'Ya tienes un rebaño comodín.' };
      run = () => formWild(p, five);
    } else if (op === 'play') {
      const cards = handCards(msg.cards);
      if (!cards || !cards.length || !cards.every(c => c.kind === 'action' && c.type === cards[0].type)) return { error: 'Jugada no válida.' };
      const t = cards[0].type, raw = msg.pl || {};
      if (t === 'nice') return { error: '¡Buen intento! solo se usa como respuesta.' };
      if (cards.length > 1 && !(t === 'yank' && cards.length === 2)) return { error: 'Solo Arrebatar se puede jugar doble.' };
      const pl = { action: t, double: cards.length === 2 };
      const target = Number.isInteger(raw.target) ? S.players[raw.target] : null;
      const flock = target ? target.flocks.find(f => f.id === raw.flock) : null;
      if (t === 'yank') {
        if (!target || target === p || !flock) return { error: 'Elige un rebaño rival.' };
        if (hasFlock(p, flock.type)) return { error: 'Ya tienes un rebaño de ese tipo.' };
        if (!pl.double && target.flocks.length <= p.flocks.length) return { error: 'Solo puedes arrebatar a quien tenga más rebaños que tú.' };
        Object.assign(pl, { target, flock });
      } else if (t === 'expose') {
        if (!target || target === p || !flock || flock.exposed) return { error: 'Elige un rebaño rival sin desenmascarar.' };
        Object.assign(pl, { target, flock });
      } else if (t === 'steal' || t === 'gimme') {
        if (!target || target === p || !target.hand.length) return { error: 'Elige un rival con cartas.' };
        pl.target = target;
        if (t === 'gimme') {
          const w = raw.want;
          if (w) {
            const ok = (w.kind === 'sheep' && SH[w.type]) || (w.kind === 'action' && ACT[w.type]);
            if (!ok) return { error: 'Carta pedida no válida.' };
            pl.want = { kind: w.kind, type: w.type };
          } else pl.want = null;
        }
      } else if (t === 'yoink') {
        if (!target || !flock) return { error: 'Elige un rebaño.' };
        if (raw.what === 'expose' && !flock.exposed) return { error: 'Ese rebaño no tiene Desenmascarar.' };
        Object.assign(pl, { target, flock, what: raw.what === 'expose' ? 'expose' : 'top' });
      } else if (t === 'restock') {
        pl.mode = raw.mode === 'hand' ? 'hand' : 'field';
      } else if (t === 'take2') {
        if (!S.field.length) return { error: 'El Campo está vacío.' };
      } else if (t === 'dig') {
        if (!S.discard.some(c => c.kind !== 'attack')) return { error: 'El descarte está vacío.' };
      }
      run = () => playAction(p, cards, pl);
    } else return { error: 'Jugada desconocida.' };

    // El reloj se pausa mientras se resuelve la jugada (p. ej. esperando un ¡Buen intento! del rival)
    // Cada carta de acción suma 10 s; cambiar, comprar, pagar un Desenmascarar o formar el comodín suman 5 s.
    const remain = Math.max(0, S.deadline - Date.now());
    S.busy = true; render();
    try {
      const r = await run();
      if (r === 'end') finishTurn();
    } catch (e) {
      if (e instanceof Over) endGame(e.w, e.gold);
      else if (!(e instanceof Stale)) console.error(e);
    } finally {
      if (S.alive && S.waiting === p && !forced) {
        S.deadline = Date.now() + Math.max(remain, 3000 * D) + (op === 'play' ? TIMING.turnBonus : ['trade', 'buy', 'pay', 'wild'].includes(op) ? TIMING.smallBonus : 0) * D;
        armTurnTimer(p);
      }
      S.busy = false; render();
    }
    return { ok: true };
  }

  /* ---------- bucle principal ---------- */
  function endGame(w, gold = false) {
    if (S.over) return;
    S.over = { winner: idx(w), name: w.name, gold, flocks: w.flocks.length };
    log(gold ? `¡${w.name} juntó las 3 Alpacas Doradas! Victoria instantánea.` : `Ganó ${w.name} con ${w.flocks.length} rebaños a salvo.`, 'win');
    S.waiting = null; clearTimeout(S.turnTimer);
    S.alive = false;
    const r = S.endTurn; S.endTurn = null; r && r();
    hooks.change(); hooks.over(S.over);
  }
  async function loop() {
    try {
      log(`Nueva partida: ${n} jugadores, gana quien junte ${S.target} rebaños (o las 3 Alpacas Doradas).`);
      render(); await checkFlocks();
      while (S.alive) {
        const p = S.players[S.turn]; S.traded = false;
        log(`Turno de ${p.name}`, 'turnl');
        if (!p.bot) hooks.toast(S.turn, '¡Tu turno!', 'turn');
        render();
        if (p.bot) await botTurn(p); else await humanTurn(p);
        if (!S.alive) return;
        S.turn = (S.turn + 1) % n;
      }
    } catch (e) {
      if (e instanceof Over) endGame(e.w, e.gold);
      else if (!(e instanceof Stale)) { console.error(e); }
    }
  }

  /* ---------- vista por jugador ---------- */
  function view(seat) {
    const p = S.players[seat];
    const pubFlock = f => ({ id: f.id, type: f.type, wild: !!f.wild, exposed: !!f.exposed, cards: f.wild ? f.cards.map(c => c.type) : null });
    return {
      you: seat, target: S.target, turn: S.turn, traded: S.traded, busy: S.busy,
      waiting: S.waiting ? idx(S.waiting) : -1, deadline: S.deadline, now: Date.now(),
      over: S.over,
      players: S.players.map(q => ({ name: q.name, bot: q.bot, connected: q.connected, handCount: q.hand.length, flocks: q.flocks.map(pubFlock) })),
      hand: p ? p.hand.map(pub) : [],
      field: S.field.map(pub), discard: S.discard.map(pub), deck: S.deck.length,
      log: S.log.slice(0, 80).map(e => ({ msg: (e.priv && e.priv[seat]) || e.msg, cls: e.cls })),
    };
  }

  function setConnected(seat, on) {
    const p = S.players[seat]; if (!p || p.bot) return;
    p.connected = on;
    if (!on && S.waiting === p) { S.deadline = Math.min(S.deadline, Date.now() + TIMING.turnAway); armTurnTimer(p); }
    if (on && S.waiting === p) { S.deadline = Math.max(S.deadline, Date.now() + 30000); armTurnTimer(p); }
    render();
  }
  function destroy() { S.alive = false; clearTimeout(S.turnTimer); const r = S.endTurn; S.endTurn = null; r && r(); }

  loop();
  return { intent, view, setConnected, destroy, get over() { return S.over; }, _S: S };
}

module.exports = { createGame, TIMING };
