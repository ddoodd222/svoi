// Стол на экране звонка: лобби, карты, ходы и итог. Здесь только отрисовка:
// какие ходы можно сделать, решает стол ведущего (session.js), кнопки просто показывают его список.

import { h, replace } from '../dom.js';
import { GAMES, decodeMove } from './session.js';
import { rankLabel, SUIT_SIGN, SUIT_NAME, isRed, suitOf, rankOf, cardLabel, SUITS } from './cards.js';

const RANK_NAME = { 2: 'двойка', 3: 'тройка', 4: 'четвёрка', 5: 'пятёрка', 6: 'шестёрка', 7: 'семёрка', 8: 'восьмёрка', 9: 'девятка', T: 'десятка', J: 'валет', Q: 'дама', K: 'король', A: 'туз' };
const SUIT_OF = { S: 'пик', H: 'червей', D: 'бубен', C: 'треф' };
const cardName = (c) => `${RANK_NAME[rankOf(c)]} ${SUIT_OF[suitOf(c)]}`;

const RULES = {
  durak: [
    'Козырь — масть открытой карты под колодой. Первым ходит тот, у кого младший козырь.',
    'Бьют старшей картой той же масти или любым козырем. Не можете или не хотите — «Беру».',
    'Подкидывают все, кроме отбивающегося: карты тех достоинств, что уже на столе. Всё отбито и подкидывать нечего — «Бито».',
    'После отбоя добирают до шести. Колода кончилась — кто без карт, тот вышел. Последний с картами — дурак.',
  ],
  eights: [
    'Кладите карту той же масти или того же достоинства, что сверху.',
    'Восьмёрка — на что угодно, и вы называете масть. Семёрка: следующий берёт две и пропускает ход. Туз: следующий пропускает ход.',
    'Нечем ходить — возьмите карту, потом можно сходить или сказать «пас».',
    'Кто первым избавится от всех карт, тот победил.',
  ],
};

// opts.confirm(title, text, okText) → Promise<boolean>: окно подтверждения в стиле приложения.
export function renderGame(el, games, opts = {}) {
  if (opts.confirm) el._confirm = opts.confirm;
  const ui = el._ui || (el._ui = { sel: null, eight: null });
  el.className = 'game';
  const g = games;
  if (!g.lobby) {
    if (g.ended) {
      replace(el, h('div', { class: 'g-note' },
        h('p', { raw: g.ended.reason }),
        h('button', { class: 'btn', on: { click: () => g.dismiss() } }, 'Закрыть')));
    } else replace(el);
    return;
  }
  const kind = GAMES[g.lobby.kind];
  // Есть вид стола — показываем его (и итог прошлой партии, пока ведущий не начал новую). Нет — лобби.
  if (!g.view) {
    if (!g.lobby.started) return lobby(el, g, kind);
    replace(el, h('div', { class: 'g-note' }, h('p', { text: 'Раздаём карты…' })));
    return;
  }
  if (g.view.kind === 'durak') durak(el, g, g.view, ui);
  else eights(el, g, g.view, ui);
}

// ---------- лобби ----------

function lobby(el, g, kind) {
  const l = g.lobby;
  const enough = l.players.length >= kind.players.min;
  replace(el,
    h('div', { class: 'g-lobby' },
      h('h3', {}, kind.emoji + ' ' + kind.name),
      h('p', { class: 'hint', text: g.isHost
        ? `Все в звонке получили приглашение. Играют от ${kind.players.min} до ${kind.players.max}.`
        : 'Вы за столом. Ждём, пока ведущий начнёт.' }),
      h('ul', { class: 'g-seats' }, l.players.map((id) => h('li', {},
        h('b', { raw: g.nameOf(id) }), id === l.host ? h('small', { text: 'ведущий' }) : null))),
      rules(l.kind),
      h('div', { class: 'row' },
        g.isHost ? h('button', { class: 'btn primary', disabled: !enough, on: { click: () => g.start() } }, enough ? `Начать (${l.players.length})` : 'Ждём хотя бы одного') : null,
        h('button', { class: 'btn', on: { click: () => g.leave() } }, g.isHost ? 'Отмена' : 'Выйти'))));
}

function rules(kind) {
  return h('details', { class: 'more g-rules' }, h('summary', {}, h('span', { text: 'Как играть' })),
    h('ul', {}, RULES[kind].map((t) => h('li', { text: t }))));
}

// ---------- общее ----------

function cardEl(c, extra = '') {
  return h('span', { class: 'card' + (isRed(c) ? ' red' : '') + (extra ? ' ' + extra : ''), role: 'img', 'aria-label': cardName(c), 'data-card': c },
    h('b', { raw: rankLabel(c) }), h('span', { class: 's', raw: SUIT_SIGN[suitOf(c)] }));
}

function handCard(c, { enabled, selected, onClick }) {
  return h('button', {
    type: 'button', class: 'card' + (isRed(c) ? ' red' : '') + (selected ? ' sel' : ''), 'data-card': c,
    'aria-label': cardName(c) + (enabled ? '' : ', сейчас не подходит'), disabled: !enabled, on: { click: onClick },
  }, h('b', { raw: rankLabel(c) }), h('span', { class: 's', raw: SUIT_SIGN[suitOf(c)] }));
}

// 1 карта, 2 карты, 5 карт.
export function cardsWord(n) {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return 'карта';
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return 'карты';
  return 'карт';
}

function backs(n) {
  return h('span', { class: 'backs', 'aria-label': `${n} ${cardsWord(n)}` }, h('span', { class: 'card back mini' }), h('b', { raw: String(n) }));
}

// Глаголы в настоящем времени: пол игрока приложению неизвестен. «Вы» — со своими окончаниями.
function act(g, who, third, second) {
  return who === g.me ? `Вы ${second}` : `${g.nameOf(who)} ${third}`;
}

function bar(el, g, over) {
  const kids = [];
  if (over && g.isHost && g.canRematch) kids.push(h('button', { class: 'btn primary small', on: { click: () => g.rematch() } }, 'Ещё раз'));
  else if (over && g.isHost) kids.push(h('small', { class: 'hint', text: 'Для новой партии нужен ещё хотя бы один игрок. Позвали всех в звонке.' }));
  kids.push(h('button', { class: 'btn small ghost', on: { click: () => leaveTable(el, g, over) } }, over ? (g.isHost ? 'Закрыть стол' : 'Встать из-за стола') : 'Выйти из игры'));
  return h('div', { class: 'g-bar' }, rules(g.lobby.kind), h('div', { class: 'row' }, kids));
}

async function leaveTable(el, g, over) {
  if (!over) {
    const ask = el._confirm || (async (t) => window.confirm(t));
    const ok = await ask(g.isHost ? 'Закрыть стол?' : 'Выйти из игры?', 'Без вас партию не доиграть: она закончится у всех.', g.isHost ? 'Закрыть' : 'Выйти');
    if (!ok) return;
  }
  g.leave();
}

// ---------- дурак ----------

function durak(el, g, v, ui) {
  const legal = v.legal.map(decodeMove).filter(Boolean);
  const attackCards = new Set(legal.filter((m) => m.type === 'attack').map((m) => m.card));
  const defends = legal.filter((m) => m.type === 'defend');
  const defendCards = new Set(defends.map((m) => m.card));
  const canTake = legal.some((m) => m.type === 'take');
  const canPass = legal.some((m) => m.type === 'pass');
  if (ui.sel && !defendCards.has(ui.sel)) ui.sel = null;
  const targets = new Set(defends.filter((m) => m.card === ui.sel).map((m) => m.target));
  const over = v.phase === 'over';
  const me = v.me;
  const isDef = v.defender === me;
  const allBeaten = v.table.length > 0 && v.table.every((x) => x.d);

  const defend = (card, target) => { ui.sel = null; g.move({ type: 'defend', card, target }); };
  const onCard = (c) => {
    if (g.pending) return;
    if (attackCards.has(c)) { g.move({ type: 'attack', card: c }); return; }
    if (!defendCards.has(c)) return;
    const ts = defends.filter((m) => m.card === c).map((m) => m.target);
    if (ts.length === 1) defend(c, ts[0]);
    else { ui.sel = ui.sel === c ? null : c; renderGame(el, g); }
  };

  const seats = v.players.filter((p) => p.id !== me).map((p) => h('div', {
    class: 'g-seat' + (p.id === v.attacker ? ' attack' : '') + (p.id === v.defender ? ' defend' : '') + (p.out ? ' out' : ''),
  }, h('b', { raw: g.nameOf(p.id) }), p.out ? h('small', { text: 'без карт ✓' }) : backs(p.count),
    h('small', { text: p.out ? '' : p.id === v.defender ? (v.taking ? 'берёт' : 'отбивается') : p.id === v.attacker ? 'ходит' : p.passed ? 'пас' : '' })));

  const deck = v.deck > 0
    ? h('div', { class: 'g-deck', 'aria-label': `В колоде ${v.deck} ${cardsWord(v.deck)}, козырь: ${SUIT_NAME[v.trump]}` },
      h('div', { class: 'g-stack' }, v.trumpCard ? cardEl(v.trumpCard, 'trump') : null, h('span', { class: 'card back' })),
      h('b', { raw: String(v.deck) }),
      h('small', { class: v.trump === 'H' || v.trump === 'D' ? 'red' : '', raw: 'козырь ' + SUIT_SIGN[v.trump] }))
    : h('div', { class: 'g-deck empty' }, h('span', { class: 'trump-badge' + (v.trump === 'H' || v.trump === 'D' ? ' red' : ''), raw: SUIT_SIGN[v.trump] }), h('small', { text: 'козырь' }));

  const table = h('div', { class: 'g-table', 'aria-label': 'Стол' },
    v.table.length ? v.table.map((pair, i) => h('div', {
      class: 'pair' + (targets.has(i) ? ' target' : ''), role: targets.has(i) ? 'button' : null,
      'aria-label': targets.has(i) ? 'Побить ' + cardName(pair.a) : null, tabindex: targets.has(i) ? '0' : null,
      on: targets.has(i) ? { click: () => defend(ui.sel, i), keydown: (e) => { if (e.key === 'Enter') defend(ui.sel, i); } } : {},
    }, cardEl(pair.a), pair.d ? cardEl(pair.d, 'on') : null))
      : h('p', { class: 'hint', text: over ? '' : 'Стол пуст' }));

  let status;
  // В игре можно жёстче, чем в звонке: и так понятно, что это игра (владелец 2026-10-30).
  if (over) status = v.loser ? (v.loser === me ? 'Дурак — вы. Ну и лох, конечно.' : `Дурак — ${g.nameOf(v.loser)}. Ну и лох, конечно.`) : 'Ничья: все вышли разом, дураков нет.';
  else if (v.out.includes(me)) status = 'Вы без карт — вы на свободе. Досмотрите, кто останется дураком.';
  else if (isDef) status = v.taking ? 'Вы берёте. Ждём, подкинут ли ещё.' : v.table.some((x) => !x.d)
    ? (ui.sel ? 'Теперь нажмите карту на столе, которую бьёте.' : 'Отбивайтесь: нажмите свою карту. Или «Беру».') : 'Всё отбито. Ждём, подкинут ли ещё.';
  else if (!v.table.length && v.attacker === me) status = 'Ваш ход: положите любую карту.';
  else if (v.taking) {
    const who = g.nameOf(v.defender);
    status = attackCards.size ? `${who} берёт. Можно подкинуть вдогонку карту того же достоинства.` + (canPass ? ' Или «Пас».' : '')
      : `${who} берёт.` + (canPass ? ' Подкинуть нечего — нажмите «Пас».' : ' Ждём, подкинут ли остальные.');
  } else if (attackCards.size) status = 'Можно подкинуть карту того же достоинства, что на столе.' + (canPass ? ' Или ' + (allBeaten && v.attacker === me ? '«Бито».' : '«Пас».') : '');
  else if (canPass && allBeaten) status = v.attacker === me ? 'Всё отбито, подкинуть нечего. Нажмите «Бито».' : 'Подкинуть нечего. Нажмите «Пас».';
  else if (canPass) status = `Подкинуть нечего. Ждём, отобьётся ли ${g.nameOf(v.defender)}.`;
  else if (!v.table.length) status = `Ходит ${g.nameOf(v.attacker)}, отбивается ${g.nameOf(v.defender)}.`;
  else status = v.attacker === me ? `Вы ходите, отбивается ${g.nameOf(v.defender)}.` : `Ходит ${g.nameOf(v.attacker)}, отбивается ${g.nameOf(v.defender)}.`;

  const last = v.last && !over ? lastDurak(g, v.last) : '';
  const actions = h('div', { class: 'g-actions' },
    canTake ? h('button', { class: 'btn', disabled: g.pending, on: { click: () => g.move({ type: 'take' }) } }, 'Беру') : null,
    canPass ? h('button', { class: 'btn primary', disabled: g.pending, on: { click: () => g.move({ type: 'pass' }) } }, allBeaten && v.attacker === me ? 'Бито' : 'Пас') : null);

  replace(el,
    h('div', { class: 'g-seats-row' }, seats),
    h('div', { class: 'g-center' }, deck, table, h('div', { class: 'g-discard' }, h('small', { text: 'Бито' }), h('b', { raw: String(v.discard) }))),
    h('div', { class: 'g-status', role: 'status' }, last ? h('small', { raw: last }) : null, h('p', { text: status })),
    actions,
    h('div', { class: 'g-hand', 'aria-label': 'Ваши карты' }, v.hand.map((c) => handCard(c, {
      enabled: !over && !g.pending && (attackCards.has(c) || defendCards.has(c)), selected: ui.sel === c, onClick: () => onCard(c),
    }))),
    bar(el, g, over));
}

function lastDurak(g, l) {
  const c = l.card ? ' ' + cardLabel(l.card) : '';
  if (l.type === 'attack') return act(g, l.who, 'кладёт', 'кладёте') + c;
  if (l.type === 'defend') return act(g, l.who, 'бьёт', 'бьёте') + c;
  if (l.type === 'take') return act(g, l.who, 'берёт', 'берёте');
  if (l.type === 'pass') return `${g.nameOf(l.who)}: пас`;
  if (l.type === 'bito') return 'Бито';
  if (l.type === 'took') return act(g, l.who, 'забирает карты', 'забираете карты');
  return '';
}

// ---------- восьмёрки ----------

function eights(el, g, v, ui) {
  const legal = v.legal.map(decodeMove).filter(Boolean);
  const plays = legal.filter((m) => m.type === 'play');
  const playCards = new Set(plays.map((m) => m.card));
  const canDraw = legal.some((m) => m.type === 'draw');
  const canPass = legal.some((m) => m.type === 'pass');
  const over = v.phase === 'over';
  const me = v.me;
  if (ui.eight && !playCards.has(ui.eight)) ui.eight = null;

  const onCard = (c) => {
    if (g.pending || !playCards.has(c)) return;
    if (rankOf(c) === '8') { ui.eight = ui.eight === c ? null : c; renderGame(el, g); return; }
    g.move({ type: 'play', card: c });
  };

  const seats = v.players.filter((p) => p.id !== me).map((p) => h('div', { class: 'g-seat' + (p.id === v.turn ? ' attack' : '') },
    h('b', { raw: g.nameOf(p.id) }), backs(p.count), h('small', { text: p.id === v.turn ? 'ходит' : '' })));

  const changed = v.suit !== suitOf(v.top);
  const center = h('div', { class: 'g-center' },
    h('button', { class: 'g-deck as-btn', type: 'button', disabled: !canDraw || g.pending, 'aria-label': canDraw ? 'Взять карту' : `В колоде ${v.deck}`,
      on: { click: () => g.move({ type: 'draw' }) } }, h('span', { class: 'card back' }), h('b', { raw: String(v.deck) }), canDraw ? h('small', { text: 'взять' }) : null),
    h('div', { class: 'g-pile' }, cardEl(v.top, 'big'),
      changed ? h('span', { class: 'trump-badge' + (v.suit === 'H' || v.suit === 'D' ? ' red' : ''), title: 'Заказана масть: ' + SUIT_NAME[v.suit], raw: SUIT_SIGN[v.suit] }) : null));

  let status;
  if (over) {
    const who = v.winner === me ? 'Победа ваша! Остальным — реванш.' : `Победа: ${g.nameOf(v.winner)}.`;
    status = v.last?.type === 'stuck' ? 'Тупик: брать нечего, и ходить никому нечем. Побеждает тот, у кого меньше всех карт. ' + who : who;
  } else if (v.turn === me) {
    status = ui.eight ? 'Какую масть заказываете?'
      : v.drawn ? 'Сходите подходящей картой или скажите «пас».'
      : `Ваш ход: ${SUIT_SIGN[v.suit]} ${SUIT_NAME[v.suit]} или ${rankLabel(v.top)}. Восьмёрка — на что угодно.` + (canDraw ? ' Нечем — возьмите карту.' : '');
  } else status = `Ходит ${g.nameOf(v.turn)}.`;

  const picker = ui.eight ? h('div', { class: 'g-suits', role: 'group', 'aria-label': 'Заказать масть' },
    SUITS.map((s) => h('button', { type: 'button', class: 'btn' + (s === 'H' || s === 'D' ? ' red' : ''), 'aria-label': 'Заказать ' + SUIT_NAME[s], disabled: g.pending,
      on: { click: () => { const c = ui.eight; ui.eight = null; g.move({ type: 'play', card: c, suit: s }); } } }, SUIT_SIGN[s]))) : null;

  const last = v.last && !over ? lastEights(g, v.last) : '';
  replace(el,
    h('div', { class: 'g-seats-row' }, seats),
    center,
    h('div', { class: 'g-status', role: 'status' }, last ? h('small', { raw: last }) : null, h('p', { text: status })),
    picker || h('div', { class: 'g-actions' }, canPass ? h('button', { class: 'btn primary', disabled: g.pending, on: { click: () => g.move({ type: 'pass' }) } }, 'Пас') : null),
    h('div', { class: 'g-hand', 'aria-label': 'Ваши карты' }, v.hand.map((c) => handCard(c, {
      enabled: !over && !g.pending && playCards.has(c), selected: ui.eight === c, onClick: () => onCard(c),
    }))),
    bar(el, g, over));
}

function lastEights(g, l) {
  if (l.type === 'draw') return act(g, l.who, 'берёт карту', 'берёте карту');
  if (l.type === 'pass') return `${g.nameOf(l.who)}: пас`;
  if (l.type !== 'play') return '';
  let t = act(g, l.who, 'кладёт', 'кладёте') + ' ' + cardLabel(l.card);
  if (l.suit) t += ` и заказывает ${SUIT_NAME[l.suit]}`.replace('заказывает', l.who === g.me ? 'заказываете' : 'заказывает');
  if (rankOf(l.card) === '7' && l.victim) {
    t += l.drew ? `. ${act(g, l.victim, 'берёт', 'берёте')} ${l.drew} ${cardsWord(l.drew)} и ${l.victim === g.me ? 'пропускаете' : 'пропускает'} ход`
      : `. Брать нечего, ${act(g, l.victim, 'просто пропускает', 'просто пропускаете')} ход`;
  }
  else if (rankOf(l.card) === 'A' && l.victim) t += `. ${act(g, l.victim, 'пропускает', 'пропускаете')} ход`;
  return t;
}
