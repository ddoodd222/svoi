// Подкидной дурак, 36 карт, от 2 до 6 игроков.
//
// Правила, как обычно играют:
// - каждому по 6 карт; козырь — нижняя карта колоды, она лежит открытой и уходит последней;
//   если колоды не осталось (шестеро игроков), козырь — масть последней сданной карты;
// - первым ходит тот, у кого младший козырь;
// - отбиваются старшей картой той же масти или козырем; козырь бьётся только старшим козырем;
// - подкидывать могут все, кроме отбивающегося, — карты тех достоинств, что уже лежат на столе;
//   всего за отбой не больше 6 карт и не больше, чем было карт у отбивающегося в начале,
//   а неотбитых — не больше, чем карт у него на руке;
// - «Беру»: отбивающийся забирает стол, остальные могут подкинуть вдогонку; следующим ходит его сосед;
// - «Бито»: все отбито и никто больше не подкидывает; следующим ходит отбившийся;
// - после отбоя добирают до 6 карт: первым тот, кто ходил, потом остальные по кругу, отбивавшийся последним;
// - кто остался без карт при пустой колоде — вышел. Последний с картами — дурак. Вышли все разом — ничья.
//
// Состояние меняется только через applyDurak, и только ходом из legalDurak. Никто не видит чужие карты:
// viewDurak отдаёт игроку его руку и сколько карт у остальных.

import { makeDeck, shuffle, cryptoRandom, rankValue, rankOf, suitOf, sortHand, sameMove } from './cards.js';

export const DURAK_PLAYERS = { min: 2, max: 6 };
const HAND = 6;

export function newDurak(playerIds, rand = cryptoRandom) {
  if (playerIds.length < DURAK_PLAYERS.min || playerIds.length > DURAK_PLAYERS.max) throw new Error('players');
  const players = shuffle([...playerIds], rand); // места за столом — случайно
  const deck = shuffle(makeDeck('6'), rand);
  const hands = Object.fromEntries(players.map((p) => [p, []]));
  let lastDealt = null;
  for (let k = 0; k < HAND; k++) for (const p of players) { lastDealt = deck.shift(); hands[p].push(lastDealt); }
  const trumpCard = deck.length ? deck[deck.length - 1] : lastDealt;
  const s = {
    kind: 'durak', players, hands, deck, trump: suitOf(trumpCard), trumpCard,
    table: [], discard: 0, out: [], phase: 'play', loser: null,
    attacker: null, defender: null, limit: 0, passed: [], taking: false, last: null, moves: 0,
  };
  let first = players[0];
  let best = Infinity;
  for (const p of players) for (const c of hands[p]) if (suitOf(c) === s.trump && rankValue(c) < best) { best = rankValue(c); first = p; }
  startBout(s, first);
  return s;
}

const isOut = (s, p) => s.out.includes(p);
const activePlayers = (s) => s.players.filter((p) => !isOut(s, p));

function nextActive(s, from) {
  const n = s.players.length;
  const i = s.players.indexOf(from);
  for (let k = 1; k <= n; k++) {
    const p = s.players[(i + k) % n];
    if (!isOut(s, p)) return p;
  }
  return null;
}

export function beats(attack, defend, trump) {
  if (suitOf(defend) === suitOf(attack)) return rankValue(defend) > rankValue(attack);
  return suitOf(defend) === trump && suitOf(attack) !== trump;
}

const unbeaten = (s) => s.table.filter((x) => !x.d).length;
const tableRanks = (s) => new Set(s.table.flatMap((x) => (x.d ? [rankOf(x.a), rankOf(x.d)] : [rankOf(x.a)])));

function canAttackWith(s, p, card) {
  if (s.phase !== 'play' || p === s.defender || isOut(s, p) || !s.hands[p].includes(card)) return false;
  if (!s.table.length) return p === s.attacker;
  return tableRanks(s).has(rankOf(card)) && s.table.length < s.limit && unbeaten(s) < s.hands[s.defender].length;
}

export function legalDurak(s, p) {
  const moves = [];
  if (s.phase !== 'play' || !s.hands[p] || isOut(s, p)) return moves;
  const hand = s.hands[p];
  if (p === s.defender) {
    if (s.taking) return moves;
    s.table.forEach((pair, target) => {
      if (pair.d) return;
      for (const card of hand) if (beats(pair.a, card, s.trump)) moves.push({ type: 'defend', card, target });
    });
    if (unbeaten(s) > 0) moves.push({ type: 'take' });
    return moves;
  }
  for (const card of hand) if (canAttackWith(s, p, card)) moves.push({ type: 'attack', card });
  if (s.table.length && !s.passed.includes(p)) moves.push({ type: 'pass' });
  return moves;
}

// Ход игрока p. Возвращает { ok, error }. Недопустимый ход состояние не меняет.
export function applyDurak(s, p, move) {
  if (!legalDurak(s, p).some((m) => sameMove(m, move))) return { ok: false, error: 'illegal' };
  const hand = s.hands[p];
  const take = (card) => hand.splice(hand.indexOf(card), 1);
  s.moves++;
  if (move.type === 'attack') {
    take(move.card);
    s.table.push({ a: move.card, d: null });
    s.passed = [];
  } else if (move.type === 'defend') {
    take(move.card);
    s.table[move.target].d = move.card;
    s.passed = [];
  } else if (move.type === 'take') {
    s.taking = true;
    s.passed = [];
  } else if (move.type === 'pass') {
    s.passed.push(p);
  }
  s.last = { who: p, type: move.type, card: move.card || null };
  settle(s);
  return { ok: true };
}

// После каждого хода: не пора ли закончить отбой.
function settle(s) {
  if (s.phase !== 'play' || !s.table.length) return;
  const attackers = activePlayers(s).filter((x) => x !== s.defender);
  // Отбой ждёт тех, кто ещё может подкинуть и не сказал «пас». Кому подкинуть нечего — того не ждём.
  const waiting = attackers.some((x) => !s.passed.includes(x) && s.hands[x].some((c) => canAttackWith(s, x, c)));
  if (waiting) return;
  if (s.taking) finishBout(s, 'take');
  else if (unbeaten(s) === 0) finishBout(s, 'bito');
}

function finishBout(s, how) {
  const { attacker, defender } = s;
  const cards = s.table.flatMap((x) => (x.d ? [x.a, x.d] : [x.a]));
  if (how === 'take') s.hands[defender].push(...cards);
  else s.discard += cards.length;
  s.table = [];
  s.taking = false;
  s.passed = [];
  refill(s, attacker, defender);
  // Без карт при пустой колоде — вышел.
  if (!s.deck.length) for (const p of activePlayers(s)) if (!s.hands[p].length) s.out.push(p);
  s.last = { who: defender, type: how === 'take' ? 'took' : 'bito', card: null };
  const left = activePlayers(s);
  if (left.length <= 1) {
    s.phase = 'over';
    s.loser = left[0] || null;
    s.attacker = s.defender = null;
    return;
  }
  // Отбился — ходит сам. Взял — ход переходит к соседу.
  const next = how === 'bito' ? (isOut(s, defender) ? nextActive(s, defender) : defender) : nextActive(s, defender);
  startBout(s, next);
}

function refill(s, attacker, defender) {
  const n = s.players.length;
  const start = s.players.indexOf(attacker);
  const order = [];
  for (let k = 0; k < n; k++) {
    const p = s.players[(start + k) % n];
    if (p !== defender && !isOut(s, p)) order.push(p);
  }
  if (!isOut(s, defender)) order.push(defender);
  for (const p of order) while (s.hands[p].length < HAND && s.deck.length) s.hands[p].push(s.deck.shift());
}

function startBout(s, attacker) {
  s.attacker = isOut(s, attacker) ? nextActive(s, attacker) : attacker;
  s.defender = nextActive(s, s.attacker);
  s.limit = Math.min(HAND, s.hands[s.defender].length);
  s.table = [];
  s.passed = [];
  s.taking = false;
}

// Расклад по заказу — для проверок правил: кто за столом, у кого какие карты, что в колоде, кто ходит.
export function durakFrom({ players, hands, deck = [], trump, attacker, discard = 0, out = [] }) {
  const s = {
    kind: 'durak', players: [...players], hands: Object.fromEntries(players.map((p) => [p, [...(hands[p] || [])]])),
    deck: [...deck], trump, trumpCard: deck.length ? deck[deck.length - 1] : null,
    table: [], discard, out: [...out], phase: 'play', loser: null,
    attacker: null, defender: null, limit: 0, passed: [], taking: false, last: null, moves: 0,
  };
  startBout(s, attacker);
  return s;
}

// Что видит игрок p: свои карты, стол, сколько карт у остальных. Чужих карт в виде нет.
export function viewDurak(s, p) {
  return {
    kind: 'durak',
    phase: s.phase,
    me: p,
    players: s.players.map((id) => ({
      id, count: s.hands[id].length, out: isOut(s, id),
      role: id === s.defender ? 'defend' : id === s.attacker ? 'attack' : 'throw',
      passed: s.passed.includes(id),
    })),
    hand: s.hands[p] ? sortHand(s.hands[p], s.trump) : [],
    table: s.table.map((x) => ({ a: x.a, d: x.d })),
    trump: s.trump,
    trumpCard: s.deck.length ? s.trumpCard : null,
    deck: s.deck.length,
    discard: s.discard,
    taking: s.taking,
    limit: s.limit,
    attacker: s.attacker,
    defender: s.defender,
    loser: s.loser,
    out: [...s.out],
    last: s.last,
    legal: legalDurak(s, p),
  };
}

// Для проверок: сколько всего карт в игре. Всегда 36.
export const durakCardCount = (s) => Object.values(s.hands).reduce((n, h) => n + h.length, 0)
  + s.deck.length + s.discard + s.table.reduce((n, x) => n + (x.d ? 2 : 1), 0);
