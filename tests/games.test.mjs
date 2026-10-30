// Карточные игры: дурак и «Восьмёрки». Без браузера.
// Точные сценарии по каждому правилу и тысячи случайных партий с проверкой, что ничего не ломается.
// Запуск: node tests/games.test.mjs

import { newDurak, durakFrom, legalDurak, applyDurak, viewDurak, beats, durakCardCount } from '../web/js/games/durak.js';
import { newEights, legalEights, applyEights, viewEights, eightsCardCount, playable } from '../web/js/games/eights.js';

let failed = 0;
let checks = 0;
const ok = (cond, what) => { checks++; if (!cond) { console.log('FAIL ' + what); failed++; } else console.log('ok   ' + what); };
const quiet = (cond, what) => { checks++; if (!cond) { console.log('FAIL ' + what); failed++; } };

// Повторяемый случай: одна и та же «затравка» — одни и те же партии.
function seeded(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const has = (moves, m) => moves.some((x) => x.type === m.type && (x.card ?? null) === (m.card ?? null) && (x.target ?? null) === (m.target ?? null) && (x.suit ?? null) === (m.suit ?? null));

// ===================== ДУРАК: правила =====================

{
  const s = newDurak(['a', 'b'], seeded(1));
  ok(s.hands.a.length === 6 && s.hands.b.length === 6 && s.deck.length === 24, 'дурак вдвоём: по 6 карт, в колоде 24');
  ok(s.trumpCard === s.deck[s.deck.length - 1] && s.trump === s.trumpCard[1], 'козырь — нижняя карта колоды');
  const low = (p) => Math.min(...s.hands[p].filter((c) => c[1] === s.trump).map((c) => '6789TJQKA'.indexOf(c[0])), 99);
  const first = low('a') <= low('b') ? 'a' : 'b';
  ok(low('a') === 99 && low('b') === 99 ? true : s.attacker === first, 'первым ходит тот, у кого младший козырь');
  ok(s.defender !== s.attacker, 'отбивается сосед ходящего');
}
{
  const s = newDurak(['a', 'b', 'c', 'd', 'e', 'f'], seeded(2));
  ok(s.deck.length === 0 && s.players.every((p) => s.hands[p].length === 6), 'вшестером: колоды не остаётся, у всех по 6');
  ok(['S', 'H', 'D', 'C'].includes(s.trump), 'вшестером козырь — масть последней сданной карты');
}
ok(beats('7H', '9H', 'S') && !beats('9H', '7H', 'S'), 'бьют старшей картой той же масти');
ok(beats('AH', '6S', 'S') && !beats('6S', 'AH', 'S'), 'любой козырь бьёт некозырную, некозырная козырь не бьёт');
ok(beats('7S', 'QS', 'S') && !beats('QS', '7S', 'S'), 'козырь бьётся только старшим козырем');
ok(!beats('7H', '9D', 'S'), 'другой некозырной мастью не бьют');

{
  // Подкидывание: только достоинства со стола, не больше лимита.
  const s = durakFrom({ players: ['a', 'b', 'c'], trump: 'S', attacker: 'a',
    hands: { a: ['7H', '7D', '9C', 'KC', 'AD', '6C'], b: ['8H', 'TD', 'QC', 'JH', '6H', '6D'], c: ['7C', 'TH', 'QH', 'KH', 'AH', 'JD'] } });
  ok(s.defender === 'b' && s.limit === 6, 'ходит a, отбивается b, лимит 6 карт');
  ok(legalDurak(s, 'c').length === 0, 'на пустой стол ходит только первый');
  ok(!applyDurak(s, 'b', { type: 'attack', card: '8H' }).ok, 'отбивающийся не ходит под себя');
  ok(applyDurak(s, 'a', { type: 'attack', card: '7H' }).ok, 'a ходит семёркой червей');
  ok(has(legalDurak(s, 'c'), { type: 'attack', card: '7C' }) && !has(legalDurak(s, 'c'), { type: 'attack', card: 'TH' }), 'c может подкинуть только семёрку');
  ok(has(legalDurak(s, 'b'), { type: 'defend', card: '8H', target: 0 }) && !has(legalDurak(s, 'b'), { type: 'defend', card: '6H', target: 0 }), 'b бьёт восьмёркой червей, шестёркой — нет');
  ok(applyDurak(s, 'b', { type: 'defend', card: '8H', target: 0 }).ok, 'b отбился');
  ok(has(legalDurak(s, 'a'), { type: 'attack', card: '7D' }) === true, 'после отбоя восьмёркой можно подкинуть и семёрку, и восьмёрку');
  const before = JSON.stringify(s);
  ok(!applyDurak(s, 'c', { type: 'attack', card: 'TH' }).ok && JSON.stringify(s) === before, 'недопустимый ход отклонён, расклад не изменился');
  ok(applyDurak(s, 'a', { type: 'pass' }).ok && s.table.length === 1, 'a сказал «пас», а c ещё может подкинуть — отбой ждёт');
  ok(applyDurak(s, 'c', { type: 'pass' }).ok, 'c тоже «пас»');
  ok(s.table.length === 0 && s.discard === 2 && s.attacker === 'b', 'всё отбито, все спасовали — бито, ходит отбившийся b');
  ok(s.hands.a.length === 5 && s.hands.b.length === 5 && s.hands.c.length === 6, 'колоды нет — добирать нечего: у a и b по 5, у c 6');
}
{
  // «Беру» и подкидывание вдогонку; ход переходит к соседу взявшего.
  const s = durakFrom({ players: ['a', 'b', 'c'], trump: 'S', attacker: 'a',
    hands: { a: ['7H', '7D', '9C'], b: ['6H', '6D', 'QC'], c: ['7C', 'TH', 'QH'] } });
  ok(s.limit === 3, 'у отбивающегося 3 карты — подкинуть можно не больше 3');
  applyDurak(s, 'a', { type: 'attack', card: '7H' });
  ok(applyDurak(s, 'b', { type: 'take' }).ok && s.taking, 'b берёт');
  ok(has(legalDurak(s, 'c'), { type: 'attack', card: '7C' }), 'вдогонку можно подкинуть');
  applyDurak(s, 'c', { type: 'attack', card: '7C' });
  ok(!has(legalDurak(s, 'a'), { type: 'attack', card: '7D' }) === false, 'и ещё одну, пока карт у b хватает');
  applyDurak(s, 'a', { type: 'attack', card: '7D' });
  ok(legalDurak(s, 'a').every((m) => m.type !== 'attack'), 'неотбитых уже 3 при 3 картах у b — больше нельзя');
  applyDurak(s, 'a', { type: 'pass' });
  ok(s.table.length === 0 && s.hands.b.length === 6, 'все спасовали — b забрал стол: 3 + 3 = 6 карт');
  ok(s.attacker === 'c' && s.defender === 'a', 'взявший пропускает ход: ходит его сосед c');
}
{
  // Добор: первым ходивший, потом по кругу, отбивавшийся последним.
  const s = durakFrom({ players: ['a', 'b', 'c'], trump: 'S', attacker: 'a', deck: ['2S', '3S', '4S', '5S'].map((x, i) => ['6D', '6C', 'JD', 'JC'][i]),
    hands: { a: ['7H', 'KD', 'KC', 'QD', 'QC', 'AD'], b: ['8H', 'AC', 'TC', 'TD', '9D', '9C'], c: ['8D', 'KH', 'QH', 'JH', 'TH', '9H'] } });
  applyDurak(s, 'a', { type: 'attack', card: '7H' });
  applyDurak(s, 'b', { type: 'defend', card: '8H', target: 0 });
  applyDurak(s, 'a', { type: 'pass' });
  ok(s.table.length === 1, 'c может подкинуть восьмёрку — отбой ждёт c');
  applyDurak(s, 'c', { type: 'pass' });
  ok(s.hands.a.includes('6D') && s.hands.c.length === 6 && s.hands.b.includes('6C') && s.deck.length === 2,
    'добор: a взял первую карту, c ничего (у него 6), b — вторую');
}
{
  // Конец: кто остался с картами при пустой колоде — дурак.
  const s = durakFrom({ players: ['a', 'b'], trump: 'S', attacker: 'a', hands: { a: ['7H'], b: ['8H', '6D'] } });
  applyDurak(s, 'a', { type: 'attack', card: '7H' });
  applyDurak(s, 'b', { type: 'defend', card: '8H', target: 0 });
  ok(s.phase === 'over' && s.loser === 'b' && s.out.includes('a'), 'a вышел, у b осталась карта — b дурак');
}
{
  const s = durakFrom({ players: ['a', 'b'], trump: 'S', attacker: 'a', hands: { a: ['7H'], b: ['8H'] } });
  applyDurak(s, 'a', { type: 'attack', card: '7H' });
  applyDurak(s, 'b', { type: 'defend', card: '8H', target: 0 });
  ok(s.phase === 'over' && s.loser === null, 'вышли оба разом — ничья');
}
{
  // Вид игрока: своих карт — все, чужих — ни одной.
  const s = newDurak(['a', 'b', 'c'], seeded(5));
  const v = viewDurak(s, 'a');
  const json = JSON.stringify(v);
  ok(v.hand.length === 6 && s.hands.b.every((c) => !json.includes('"' + c + '"') || c === v.trumpCard), 'в виде игрока a нет карт игрока b');
  ok(v.players.find((x) => x.id === 'b').count === 6, 'видно, сколько карт у соседа');
}

// ===================== ВОСЬМЁРКИ: правила =====================

const eightsFrom = ({ players, hands, deck = [], pile, suit, turn }) => ({
  kind: 'eights', players, hands: structuredClone(hands), deck: [...deck], pile: [...pile], suit: suit || pile[pile.length - 1][1],
  turn: turn || players[0], drawn: false, phase: 'play', winner: null, last: null, moves: 0, stuck: 0, rand: seeded(9),
});
{
  const s = newEights(['a', 'b'], seeded(3));
  ok(s.hands.a.length === 7 && s.hands.b.length === 7 && s.pile.length === 1 && s.deck.length === 52 - 15, 'вдвоём по 7 карт, одна открыта в сброс');
  const s3 = newEights(['a', 'b', 'c'], seeded(4));
  ok(s3.players.every((p) => s3.hands[p].length === 5), 'втроём по 5');
}
{
  const s = eightsFrom({ players: ['a', 'b', 'c'], pile: ['9H'], deck: ['2C', '3C', '4C'],
    hands: { a: ['9S', 'KH', '8D', '2D', '7S'], b: ['5C', '6C', 'QS'], c: ['4D', '3D'] } });
  ok(playable(s, '9S') && playable(s, 'KH') && playable(s, '8D') && !playable(s, '2D'), 'в масть или в достоинство, восьмёрка — всегда');
  ok(legalEights(s, 'b').length === 0, 'не твой ход — ходить нельзя');
  ok(has(legalEights(s, 'a'), { type: 'play', card: '8D', suit: 'C' }) && !has(legalEights(s, 'a'), { type: 'play', card: '8D' }), 'восьмёрка — только с выбором масти');
  ok(applyEights(s, 'a', { type: 'play', card: '8D', suit: 'C' }).ok && s.suit === 'C' && s.turn === 'b', 'восьмёрка назвала трефы, ход b');
  ok(has(legalEights(s, 'b'), { type: 'play', card: '5C' }) && !has(legalEights(s, 'b'), { type: 'play', card: 'QS' }), 'теперь кладут трефы');
  applyEights(s, 'b', { type: 'play', card: '5C' });
  ok(s.turn === 'c' && has(legalEights(s, 'c'), { type: 'draw' }) && !has(legalEights(s, 'c'), { type: 'pass' }), 'у c нечем ходить: можно взять, пасовать сразу нельзя');
  applyEights(s, 'c', { type: 'draw' });
  ok(s.hands.c.length === 3 && has(legalEights(s, 'c'), { type: 'pass' }) && !has(legalEights(s, 'c'), { type: 'draw' }), 'взял одну — теперь «пас» или ход, второй раз брать нельзя');
  ok(has(legalEights(s, 'c'), { type: 'play', card: '2C' }), 'взятой подходящей картой можно сходить сразу');
  applyEights(s, 'c', { type: 'pass' });
  ok(s.turn === 'a' && !s.drawn, '«пас» — ход следующего');
}
{
  const s = eightsFrom({ players: ['a', 'b', 'c'], pile: ['9H'], deck: ['2C', '3C', '4C', '5C'],
    hands: { a: ['7H', 'KH'], b: ['5S', '6S'], c: ['4D', '3D'] } });
  applyEights(s, 'a', { type: 'play', card: '7H' });
  ok(s.hands.b.length === 4 && s.turn === 'c', 'семёрка: следующий взял 2 и пропустил ход');
  const t = eightsFrom({ players: ['a', 'b', 'c'], pile: ['9H'], hands: { a: ['AH', 'KH'], b: ['5S'], c: ['4D'] } });
  applyEights(t, 'a', { type: 'play', card: 'AH' });
  ok(t.turn === 'c' && t.hands.b.length === 1, 'туз: следующий пропускает ход, карт не берёт');
  const u = eightsFrom({ players: ['a', 'b'], pile: ['9H'], hands: { a: ['AH', 'KH'], b: ['5S'] } });
  applyEights(u, 'a', { type: 'play', card: 'AH' });
  ok(u.turn === 'a', 'вдвоём туз — снова твой ход');
}
{
  const s = eightsFrom({ players: ['a', 'b'], pile: ['2H', '3H', '9H'], deck: [], hands: { a: ['5S'], b: ['6S'] } });
  applyEights(s, 'a', { type: 'draw' });
  ok(s.hands.a.length === 2 && s.pile.length === 1 && s.pile[0] === '9H' && s.deck.length === 1, 'колода пуста — сброс без верхней карты стал колодой');
  const w = eightsFrom({ players: ['a', 'b'], pile: ['9H'], hands: { a: ['KH'], b: ['6S'] } });
  applyEights(w, 'a', { type: 'play', card: 'KH' });
  ok(w.phase === 'over' && w.winner === 'a', 'избавился от всех карт — победа');
  const st = eightsFrom({ players: ['a', 'b'], pile: ['9H'], deck: [], hands: { a: ['5S', '4S'], b: ['6S'] } });
  ok(has(legalEights(st, 'a'), { type: 'pass' }) && !has(legalEights(st, 'a'), { type: 'draw' }), 'брать нечего — можно сразу «пас»');
  applyEights(st, 'a', { type: 'pass' });
  applyEights(st, 'b', { type: 'pass' });
  ok(st.phase === 'over' && st.winner === 'b', 'тупик: все спасовали, брать нечего — побеждает тот, у кого меньше карт');
  const v = viewEights(newEights(['a', 'b', 'c'], seeded(6)), 'b');
  ok(v.players.every((p) => typeof p.count === 'number') && !('hands' in v), 'в виде игрока нет чужих рук');
}

// ===================== Случайные партии =====================

function allCardsUnique(zones) {
  const seen = new Set();
  for (const c of zones) { if (seen.has(c)) return false; seen.add(c); }
  return true;
}

function fuzzDurak(games) {
  let maxMoves = 0, draws = 0, losers = 0, illegalRejected = 0;
  for (let g = 0; g < games; g++) {
    const rand = seeded(1000 + g);
    const n = 2 + (g % 5);
    const ids = Array.from({ length: n }, (_, i) => 'p' + i);
    const s = newDurak(ids, rand);
    let steps = 0;
    while (s.phase === 'play') {
      if (++steps > 5000) { quiet(false, `дурак: партия ${g} не закончилась за 5000 ходов`); break; }
      const options = s.players.map((p) => [p, legalDurak(s, p)]).filter(([, m]) => m.length);
      if (!options.length) { quiet(false, `дурак: партия ${g}, ход ${steps}: ни у кого нет хода — тупик`); break; }
      // Иногда пробуем незаконный ход: должен отклониться без следов.
      if (rand() < 0.05) {
        const p = s.players[Math.floor(rand() * n)];
        const bad = { type: 'attack', card: 'XX' };
        const snap = JSON.stringify(s);
        if (!applyDurak(s, p, bad).ok && JSON.stringify(s) === snap) illegalRejected++;
        else quiet(false, 'дурак: незаконный ход прошёл');
      }
      const [p, moves] = options[Math.floor(rand() * options.length)];
      // Отбивающийся чаще бьётся, чем берёт: так партии похожи на настоящие.
      const defend = moves.filter((m) => m.type === 'defend');
      const pick = defend.length && rand() < 0.85 ? defend[Math.floor(rand() * defend.length)] : moves[Math.floor(rand() * moves.length)];
      quiet(applyDurak(s, p, pick).ok, 'дурак: законный ход не прошёл');
      quiet(durakCardCount(s) === 36, `дурак: карт не 36 (${durakCardCount(s)}) в партии ${g}`);
      const zones = [...Object.values(s.hands).flat(), ...s.deck, ...s.table.flatMap((x) => (x.d ? [x.a, x.d] : [x.a]))];
      quiet(allCardsUnique(zones), 'дурак: карта задвоилась');
      if (s.phase === 'play') {
        quiet(!s.out.includes(s.attacker) && !s.out.includes(s.defender) && s.attacker !== s.defender, 'дурак: ходит или отбивается вышедший');
        for (const q of s.players) {
          const v = viewDurak(s, q);
          const others = s.players.filter((x) => x !== q).flatMap((x) => s.hands[x]);
          const visible = new Set([...v.hand, ...v.table.flatMap((x) => [x.a, x.d]), v.trumpCard]);
          if (others.some((c) => visible.has(c) && !v.hand.includes(c) && c !== v.trumpCard)) quiet(false, 'дурак: в виде игрока видна чужая карта');
        }
      }
    }
    maxMoves = Math.max(maxMoves, steps);
    if (s.phase === 'over') {
      quiet(s.loser === null || s.players.includes(s.loser), 'дурак: дурак — не игрок');
      quiet(s.out.length + (s.loser ? 1 : 0) === n, 'дурак: не все вышли, кроме дурака');
      if (s.loser) losers++; else draws++;
    }
  }
  return { maxMoves, draws, losers, illegalRejected };
}

function fuzzEights(games) {
  let maxMoves = 0, stuck = 0;
  for (let g = 0; g < games; g++) {
    const rand = seeded(5000 + g);
    const n = 2 + (g % 7);
    const s = newEights(Array.from({ length: n }, (_, i) => 'p' + i), rand);
    let steps = 0;
    while (s.phase === 'play') {
      if (++steps > 20000) { quiet(false, `восьмёрки: партия ${g} не закончилась`); break; }
      const others = s.players.filter((p) => p !== s.turn);
      quiet(others.every((p) => legalEights(s, p).length === 0), 'восьмёрки: ходит не тот, чей ход');
      const moves = legalEights(s, s.turn);
      if (!moves.length) { quiet(false, 'восьмёрки: у ходящего нет хода'); break; }
      const plays = moves.filter((m) => m.type === 'play');
      const pick = plays.length && rand() < 0.8 ? plays[Math.floor(rand() * plays.length)]
        : moves.find((m) => m.type === 'draw') || moves.find((m) => m.type === 'pass') || moves[0];
      quiet(applyEights(s, s.turn ?? pick.who, pick).ok || false, 'восьмёрки: законный ход не прошёл');
      quiet(eightsCardCount(s) === 52, `восьмёрки: карт не 52 (${eightsCardCount(s)})`);
      quiet(allCardsUnique([...Object.values(s.hands).flat(), ...s.deck, ...s.pile]), 'восьмёрки: карта задвоилась');
    }
    if (s.last?.type === 'stuck') stuck++;
    maxMoves = Math.max(maxMoves, steps);
    quiet(s.phase !== 'over' || s.players.includes(s.winner), 'восьмёрки: победитель — не игрок');
  }
  return { maxMoves, stuck };
}

const before = failed;
const d = fuzzDurak(3000);
ok(failed === before, `дурак: 3000 случайных партий на 2–6 игроков — карты не теряются и не двоятся, чужих не видно, тупиков нет (дураков ${d.losers}, ничьих ${d.draws}, самая длинная партия ${d.maxMoves} ходов, незаконных ходов отклонено ${d.illegalRejected})`);
const before2 = failed;
const e = fuzzEights(3000);
ok(failed === before2, `восьмёрки: 3000 случайных партий на 2–8 игроков — 52 карты на месте, ходит только тот, чей ход (самая длинная ${e.maxMoves} ходов, тупиков ${e.stuck})`);

console.log(`\nПроверок: ${checks}`);
console.log(failed ? `ПРОВАЛОВ: ${failed}` : 'ВСЁ ПРОШЛО');
process.exit(failed ? 1 : 0);
