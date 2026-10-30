// Обычная колода карт: достоинство + масть, например «TH» — десятка червей.
// Модуль без браузера: те же правила проверяются тестами в node.

export const SUITS = ['S', 'H', 'D', 'C'];
export const SUIT_SIGN = { S: '♠', H: '♥', D: '♦', C: '♣' };
export const SUIT_NAME = { S: 'пики', H: 'червы', D: 'бубны', C: 'трефы' };
const RANKS = '23456789TJQKA';

export const rankOf = (c) => c[0];
export const suitOf = (c) => c[1];
export const rankValue = (c) => RANKS.indexOf(c[0]);
export const isCard = (c) => typeof c === 'string' && /^[2-9TJQKA][SHDC]$/.test(c);
export const isRed = (c) => c[1] === 'H' || c[1] === 'D';
export const rankLabel = (c) => (c[0] === 'T' ? '10' : c[0] === 'J' ? 'В' : c[0] === 'Q' ? 'Д' : c[0] === 'K' ? 'К' : c[0] === 'A' ? 'Т' : c[0]);
export const cardLabel = (c) => rankLabel(c) + SUIT_SIGN[c[1]];

// Колода от младшей карты: '6' — 36 карт для дурака, '2' — 52 карты.
export function makeDeck(from) {
  const start = RANKS.indexOf(from);
  const out = [];
  for (const s of SUITS) for (let i = start; i < RANKS.length; i++) out.push(RANKS[i] + s);
  return out;
}

// Случай берётся из криптографического генератора: колоду не предскажешь по времени или порядку ходов.
export function cryptoRandom() {
  const u = new Uint32Array(1);
  globalThis.crypto.getRandomValues(u);
  return u[0] / 4294967296;
}

// Тасование Фишера — Йетса: каждый порядок карт равновероятен.
export function shuffle(arr, rand = cryptoRandom) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Порядок карт в руке: по масти, внутри масти по старшинству. Масть trump — в конце, её удобно держать справа.
export function sortHand(hand, trump = null) {
  const order = (c) => (suitOf(c) === trump ? 10 : SUITS.indexOf(suitOf(c))) * 100 + rankValue(c);
  return [...hand].sort((a, b) => order(a) - order(b));
}

export const sameMove = (a, b) => !!a && !!b && a.type === b.type && (a.card ?? null) === (b.card ?? null)
  && (a.target ?? null) === (b.target ?? null) && (a.suit ?? null) === (b.suit ?? null);
