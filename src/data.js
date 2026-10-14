'use strict';
// Datos compartidos por el servidor (el cliente tiene su propia copia en public/index.html).
const SHEEP = [
  { k: 'astro', n: 'Astronauta' }, { k: 'pirata', n: 'Pirata' },
  { k: 'chef', n: 'Chef' }, { k: 'lucha', n: 'Luchadora' },
  { k: 'ninja', n: 'Ninja' }, { k: 'detective', n: 'Detective' },
  { k: 'rock', n: 'Rockera' }, { k: 'bombera', n: 'Bombera' },
];
const GOLD = { k: 'dorada', n: 'Dorada', gold: true };
const SH = Object.fromEntries(SHEEP.map(s => [s.k, s]).concat([['dorada', GOLD]]));
const ACT = {
  take2: { n: 'Tomar 2', q: 6 },
  restock: { n: 'Reponer', q: 6 },
  yank: { n: 'Arrebatar', q: 4 },
  dig: { n: 'Escarbar', q: 6 },
  expose: { n: 'Desenmascarar', q: 6 },
  nice: { n: '¡Buen intento!', q: 8 },
  draw2: { n: 'Robar 2', q: 6 },
  steal: { n: 'Hurtar', q: 8 },
  gimme: { n: '¡Dame!', q: 8 },
  yoink: { n: 'Pellizcar', q: 6 },
};
const ATK = {
  puma: { n: 'Puma', d: 'Todos pasan 1 carta (a elección) al jugador siguiente.' },
  condor: { n: 'Cóndor', d: 'Todos pasan 1 carta (a elección) al jugador anterior.' },
  zorro: { n: 'Zorro', d: 'Todos descartan 1 carta al azar.' },
  lobo: { n: 'Lobo', d: 'Todos descartan 1 carta a elección.' },
  oso: { n: 'Oso', d: 'Se descarta todo el Campo y se repone.' },
  aguila: { n: 'Águila', d: 'Todos roban 1 carta.' },
};
const BOT_NAMES = ['Rosa', 'Benito', 'Lucha', 'Paco', 'Dora', 'Tito', 'Nina'];
const MAX_SEATS = 8;
// Rebaños para ganar según el número de jugadores (2-3: 5, 4: 4, 5-8: 3).
const targetFor = (n, short) => (n <= 3 ? 5 : n === 4 ? 4 : 3) - (short ? 1 : 0);

module.exports = { SHEEP, GOLD, SH, ACT, ATK, BOT_NAMES, MAX_SEATS, targetFor };
