// «Восьмёрки» — народная игра на обычной колоде (52 карты), от 2 до 8 игроков. Родня «Мау-мау».
//
// Правила:
// - вдвоём по 7 карт, втроём и больше — по 5; верхняя карта колоды открывается в сброс;
// - в свой ход кладёшь карту той же масти или того же достоинства, что сверху сброса;
// - восьмёрку можно положить на что угодно и назвать любую масть — дальше кладут в неё;
// - семёрка: следующий берёт 2 карты и пропускает ход;
// - туз: следующий пропускает ход (вдвоём — ходишь снова);
// - нечем или не хочется ходить — берёшь одну карту; после этого можно сходить любой подходящей или сказать «пас»;
// - колода кончилась — сброс, кроме верхней карты, тасуется в новую колоду;
//   брать совсем нечего — можно сразу «пас»;
// - кто первым избавился от всех карт — победил, игра заканчивается;
// - брать нечего и все по кругу сказали «пас» — тупик: побеждает тот, у кого меньше карт.
//
// Состояние меняется только через applyEights, и только ходом из legalEights.

import { makeDeck, shuffle, cryptoRandom, rankOf, suitOf, SUITS, sortHand, sameMove } from './cards.js';

export const EIGHTS_PLAYERS = { min: 2, max: 8 };

export function newEights(playerIds, rand = cryptoRandom) {
  if (playerIds.length < EIGHTS_PLAYERS.min || playerIds.length > EIGHTS_PLAYERS.max) throw new Error('players');
  const players = shuffle([...playerIds], rand);
  const deck = shuffle(makeDeck('2'), rand);
  const size = players.length === 2 ? 7 : 5;
  const hands = Object.fromEntries(players.map((p) => [p, []]));
  for (let k = 0; k < size; k++) for (const p of players) hands[p].push(deck.shift());
  const top = deck.shift();
  return {
    kind: 'eights', players, hands, deck, pile: [top], suit: suitOf(top),
    turn: players[0], drawn: false, phase: 'play', winner: null, last: null, moves: 0, stuck: 0, rand,
  };
}

const topCard = (s) => s.pile[s.pile.length - 1];
const nextOf = (s, p) => s.players[(s.players.indexOf(p) + 1) % s.players.length];

export function playable(s, card) {
  return rankOf(card) === '8' || suitOf(card) === s.suit || rankOf(card) === rankOf(topCard(s));
}

// Колода пуста — сброс без верхней карты тасуется в новую. Возвращает, сколько можно взять.
function refillDeck(s) {
  if (s.deck.length || s.pile.length < 2) return s.deck.length;
  const top = s.pile.pop();
  s.deck = shuffle(s.pile, s.rand || cryptoRandom);
  s.pile = [top];
  return s.deck.length;
}

const canDraw = (s) => s.deck.length > 0 || s.pile.length > 1;

export function legalEights(s, p) {
  const moves = [];
  if (s.phase !== 'play' || p !== s.turn) return moves;
  for (const card of s.hands[p]) {
    if (!playable(s, card)) continue;
    if (rankOf(card) === '8') for (const suit of SUITS) moves.push({ type: 'play', card, suit });
    else moves.push({ type: 'play', card });
  }
  if (!s.drawn && canDraw(s)) moves.push({ type: 'draw' });
  if (s.drawn || !canDraw(s)) moves.push({ type: 'pass' });
  return moves;
}

function drawCards(s, p, n) {
  let got = 0;
  for (let i = 0; i < n; i++) {
    if (!refillDeck(s)) break;
    s.hands[p].push(s.deck.shift());
    got++;
  }
  return got;
}

export function applyEights(s, p, move) {
  if (!legalEights(s, p).some((m) => sameMove(m, move))) return { ok: false, error: 'illegal' };
  s.moves++;
  if (move.type === 'draw') {
    drawCards(s, p, 1);
    s.drawn = true;
    s.last = { who: p, type: 'draw' };
    return { ok: true };
  }
  if (move.type === 'pass') {
    s.last = { who: p, type: 'pass' };
    s.stuck = canDraw(s) ? 0 : s.stuck + 1;
    if (s.stuck >= s.players.length) {
      // Тупик: брать нечего, ходить никому нечем. Побеждает тот, у кого меньше карт (при равенстве — кто раньше по кругу).
      s.phase = 'over';
      s.winner = s.players.reduce((a, b) => (s.hands[b].length < s.hands[a].length ? b : a));
      s.turn = null;
      s.last = { who: s.winner, type: 'stuck' };
      return { ok: true };
    }
    endTurn(s, nextOf(s, p));
    return { ok: true };
  }
  const hand = s.hands[p];
  hand.splice(hand.indexOf(move.card), 1);
  s.pile.push(move.card);
  s.stuck = 0;
  s.suit = rankOf(move.card) === '8' ? move.suit : suitOf(move.card);
  s.last = { who: p, type: 'play', card: move.card, suit: rankOf(move.card) === '8' ? move.suit : null };
  if (!hand.length) {
    s.phase = 'over';
    s.winner = p;
    s.turn = null;
    return { ok: true };
  }
  let next = nextOf(s, p);
  if (rankOf(move.card) === '7') {
    const got = drawCards(s, next, 2);
    s.last.victim = next;
    s.last.drew = got;
    next = nextOf(s, next);
  } else if (rankOf(move.card) === 'A') {
    s.last.victim = next;
    next = nextOf(s, next);
  }
  endTurn(s, next);
  return { ok: true };
}

function endTurn(s, next) {
  s.turn = next;
  s.drawn = false;
}

export function viewEights(s, p) {
  return {
    kind: 'eights',
    phase: s.phase,
    me: p,
    players: s.players.map((id) => ({ id, count: s.hands[id].length })),
    hand: s.hands[p] ? sortHand(s.hands[p]) : [],
    top: topCard(s),
    suit: s.suit,
    deck: s.deck.length,
    pile: s.pile.length,
    turn: s.turn,
    drawn: s.turn === p && s.drawn,
    winner: s.winner,
    last: s.last,
    legal: legalEights(s, p),
  };
}

export const eightsCardCount = (s) => Object.values(s.hands).reduce((n, h) => n + h.length, 0) + s.deck.length + s.pile.length;
