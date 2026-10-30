// Игра за столом в звонке: лобби, раздача, ходы, конец.
//
// Кто позвал играть, у того на устройстве и «стол»: он тасует, раздаёт, проверяет каждый ход
// по правилам и рассылает каждому только его карты. Остальные шлют ему ходы и показывают то, что пришло.
// Сообщения идут по прямым зашифрованным каналам звонка (DTLS), посредник их не видит.
// Честность стола — на совести ведущего: его устройство знает все карты. Для игры «своих» это нормально.

import { newDurak, applyDurak, viewDurak, DURAK_PLAYERS } from './durak.js';
import { newEights, applyEights, viewEights, EIGHTS_PLAYERS } from './eights.js';
import { isCard, SUITS } from './cards.js';

export const GAMES = {
  durak: { name: 'Дурак', emoji: '🃏', players: DURAK_PLAYERS, create: newDurak, apply: applyDurak, view: viewDurak },
  eights: { name: 'Восьмёрки', emoji: '🎴', players: EIGHTS_PLAYERS, create: newEights, apply: applyEights, view: viewEights },
};

const isTag = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(s);
const randomTag = () => { const u = new Uint8Array(9); crypto.getRandomValues(u); return btoa(String.fromCharCode(...u)).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' }[c])); };

// Ходы в коротких строках: так вид игрока помещается в одно сообщение даже с полной рукой.
export function encodeMove(m) {
  if (m.type === 'attack') return 'a:' + m.card;
  if (m.type === 'defend') return 'd:' + m.card + ':' + m.target;
  if (m.type === 'play') return 'pl:' + m.card + (m.suit ? ':' + m.suit : '');
  return { take: 't', pass: 'p', draw: 'dr' }[m.type] || '';
}

export function decodeMove(str) {
  if (typeof str !== 'string' || str.length > 16) return null;
  const [k, a, b] = str.split(':');
  if (k === 'a' && isCard(a)) return { type: 'attack', card: a };
  if (k === 'd' && isCard(a) && /^[0-5]$/.test(b || '')) return { type: 'defend', card: a, target: Number(b) };
  if (k === 'pl' && isCard(a)) return b === undefined ? { type: 'play', card: a } : SUITS.includes(b) ? { type: 'play', card: a, suit: b } : null;
  const simple = { t: { type: 'take' }, p: { type: 'pass' }, dr: { type: 'draw' } };
  return Object.hasOwn(simple, k) ? simple[k] : null;
}

export class Games extends EventTarget {
  constructor(room) {
    super();
    this.room = room;
    this.me = room.me.id;
    this.lobby = null;   // { gid, kind, host, players: [id], started }
    this.invite = null;  // приглашение, на которое ещё не ответили
    this.view = null;    // мой вид стола
    this.ended = null;   // { reason } — игра прервалась
    this.pending = false;
    this.seq = 0;
    this.state = null;   // только у ведущего: полный расклад
    this.onMsg = (e) => this._onMsg(e.detail.from, e.detail.msg);
    this.onMembers = () => this._onMembers();
    room.addEventListener('game', this.onMsg);
    room.addEventListener('members', this.onMembers);
    this.lost = new Map(); // с кем пропала прямая связь и с какого момента
    this.declined = new Set(); // столы, от которых отказались или из-за которых встали: туда больше не зовём
    this.lastTick = 0; // когда последний раз ведущий подал знак «стол жив»
    this.lastInvite = 0;
    this.watch = setInterval(() => this._watch(), 2000);
  }

  // Человек может пропасть, не выходя из звонка: закрыл вкладку, уехал в метро. Хозяина звонка
  // из списка участников не вычёркивают сразу — ждут, вдруг вернётся. Поэтому смотрим на прямую связь:
  // нет её 12 секунд — стол закрывается, а не висит с недоигранной партией.
  _watch() {
    const l = this.lobby;
    if (!l) { this.lost.clear(); return; }
    const now = Date.now();
    if (this.isHost) {
      // «Стол жив» — раз в 5 секунд каждому за столом. Перезагрузившийся игрок ответит «меня тут нет».
      if (now - (this.lastTickSent || 0) >= 5000) {
        this.lastTickSent = now;
        for (const id of l.players) if (id !== this.me) this.room.sendGame(id, { op: 'tick', gid: l.gid });
      }
      // Пока за стол можно сесть, зовём и тех, кто пришёл в звонок позже. Отказавшихся не дёргаем: они помнят стол.
      if (this.joinable && now - this.lastInvite >= 10000) {
        this.lastInvite = now;
        this._broadcast({ op: 'invite', gid: l.gid, kind: l.kind, host: this.me, players: l.players });
      }
    } else if (now - this.lastTick > 15000) {
      // Ведущий молчит 15 секунд — его стола больше нет (закрыл вкладку, перезагрузил страницу).
      this._localEnd('Связь с ведущим пропала, стол закрыт.');
      return;
    }
    const gone = (id) => {
      if (id === this.me || this.room.conns.get(id)?.state === 'connected') { this.lost.delete(id); return false; }
      if (!this.lost.has(id)) this.lost.set(id, now);
      return now - this.lost.get(id) > 12000;
    };
    if (!this.isHost) {
      if (gone(l.host)) this._localEnd('Связь с ведущим пропала, стол закрыт.');
      return;
    }
    const lost = l.players.filter((id) => gone(id));
    if (!lost.length) return;
    if (l.started && this.state?.phase === 'play') { this._end(`${this.nameOf(lost[0])}: связь пропала, партия прервана.`); return; }
    l.players = l.players.filter((id) => !lost.includes(id));
    this._broadcast({ op: 'lobby', ...this._lobbyMsg() });
    this.emit();
  }

  emit() { this.dispatchEvent(new Event('change')); }
  // Сесть за стол можно, пока партия не идёт: до начала или после конца.
  get joinable() { return !!this.lobby && (!this.lobby.started || this.state?.phase === 'over'); }
  // «Ещё раз» имеет смысл, только если за столом хватает игроков, которые ещё в звонке.
  get canRematch() {
    const l = this.lobby;
    return !!l && this.isHost && l.players.filter((id) => id === this.me || this.room.members.has(id)).length >= GAMES[l.kind].players.min;
  }
  get isHost() { return this.lobby?.host === this.me; }
  get busy() { return !!this.lobby; }
  // Стол показываем тем, кто в лобби или в игре, и после конца — пока не закроют.
  get showTable() { return !!(this.lobby || this.ended); }
  nameOf(id) { return id === this.me ? 'Вы' : this.room.members.get(id)?.name || this.names?.[id] || 'Игрок'; }

  // ---------- ведущий ----------

  create(kind) {
    if (this.lobby || !GAMES[kind]) return;
    this.ended = null;
    this.invite = null;
    this.lobby = { gid: randomTag(), kind, host: this.me, players: [this.me], started: false };
    this.seq = 0;
    this.viewSeq = 0;
    this._rememberNames();
    this.lastInvite = Date.now();
    this._broadcast({ op: 'invite', gid: this.lobby.gid, kind, host: this.me, players: this.lobby.players });
    this.emit();
  }

  start() {
    const l = this.lobby;
    if (!this.isHost || l.started || l.players.length < GAMES[l.kind].players.min) return;
    this.state = GAMES[l.kind].create(l.players);
    l.started = true;
    this._broadcast({ op: 'lobby', ...this._lobbyMsg() });
    this._push();
  }

  // Ещё раз тем же составом (кто ещё в звонке и не ушёл из-за стола).
  rematch() {
    const l = this.lobby;
    if (!this.isHost || !l) return;
    l.players = l.players.filter((id) => id === this.me || this.room.members.has(id));
    if (l.players.length < GAMES[l.kind].players.min) return;
    this.state = GAMES[l.kind].create(l.players);
    this._broadcast({ op: 'lobby', ...this._lobbyMsg() });
    this._push();
  }

  _push() {
    const l = this.lobby;
    this.seq++;
    for (const id of l.players) {
      const v = GAMES[l.kind].view(this.state, id);
      v.legal = v.legal.map(encodeMove);
      if (id === this.me) this._setView(v, this.seq);
      else this.room.sendGame(id, { op: 'view', gid: l.gid, seq: this.seq, view: v });
    }
  }

  _hostMove(from, move) {
    const l = this.lobby;
    if (!this.isHost || !l?.started || !this.state || !l.players.includes(from) || !move) return;
    const r = GAMES[l.kind].apply(this.state, from, move);
    if (r.ok) this._push();
    else if (from !== this.me) this.room.sendGame(from, { op: 'view', gid: l.gid, seq: this.seq, view: this._viewFor(from) }); // снять «жду ответа»
  }

  _viewFor(id) {
    const v = GAMES[this.lobby.kind].view(this.state, id);
    v.legal = v.legal.map(encodeMove);
    return v;
  }

  _end(reason) {
    if (this.lobby) this._broadcast({ op: 'end', gid: this.lobby.gid, reason });
    this._localEnd(reason);
  }

  _lobbyMsg() {
    const l = this.lobby;
    return { gid: l.gid, kind: l.kind, host: l.host, players: l.players, started: l.started && this.state?.phase === 'play' };
  }

  // ---------- игрок ----------

  accept() {
    const inv = this.invite;
    if (!inv || this.lobby) return;
    this.invite = null;
    this.ended = null;
    this.lobby = { ...inv, started: false, players: [...inv.players, this.me], confirmed: false };
    this.viewSeq = 0;
    this.lastTick = Date.now();
    this._rememberNames();
    this._askJoin();
    this.emit();
  }

  // Просьба сесть за стол повторяется, пока ведущий не подтвердит: первая могла разминуться со списком.
  _askJoin(n = 1) {
    clearTimeout(this.joinTimer);
    const l = this.lobby;
    if (!l || this.isHost || l.confirmed || n > 5) return;
    this.room.sendGame(l.host, { op: 'join', gid: l.gid });
    this.joinTimer = setTimeout(() => this._askJoin(n + 1), 2500);
  }

  decline() {
    if (this.invite) this.declined.add(this.invite.gid);
    this.invite = null;
    this.emit();
  }

  move(m) {
    const l = this.lobby;
    if (!l?.started || this.pending) return;
    if (this.isHost) { this._hostMove(this.me, m); return; }
    this.pending = true;
    clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => { this.pending = false; this.emit(); }, 4000);
    this.room.sendGame(l.host, { op: 'move', gid: l.gid, move: encodeMove(m) });
    this.emit();
  }

  // Встать из-за стола. Ведущий закрывает стол для всех. Игрок посреди партии её прерывает:
  // без его карт продолжить нельзя. В лобби или после конца — просто уходит.
  leave() {
    const l = this.lobby;
    if (!l) { this.ended = null; this.emit(); return; }
    if (this.isHost) {
      this._broadcast({ op: 'end', gid: l.gid, reason: 'Ведущий закрывает стол.' });
      this._localEnd(null);
      return;
    }
    this.room.sendGame(l.host, { op: 'quit', gid: l.gid });
    this.declined.add(l.gid);
    this._localEnd(null);
  }

  // Закрыть надпись «игра прервалась».
  dismiss() {
    this.ended = null;
    this.emit();
  }

  _localEnd(reason) {
    clearTimeout(this.joinTimer);
    this.lobby = null;
    this.view = null;
    this.viewSeq = 0; // у следующего стола счёт обновлений начнётся заново
    this.state = null;
    this.pending = false;
    this.ended = reason ? { reason } : null;
    this.emit();
  }

  _setView(view, seq) {
    this.view = view;
    this.viewSeq = seq;
    this.pending = false;
    clearTimeout(this.pendingTimer);
    this.emit();
  }

  // ---------- сообщения ----------

  _broadcast(msg) { this.room.broadcastGame(msg); }

  _onMsg(from, g) {
    if (!g || typeof g !== 'object' || !isTag(g.gid)) return;
    const l = this.lobby;
    if (g.op === 'invite') {
      if (from !== g.host || !GAMES[g.kind] || !Array.isArray(g.players) || g.players.length > 8 || l || this.declined.has(g.gid)) return;
      this.invite = { gid: g.gid, kind: g.kind, host: g.host, players: g.players.filter(isTag) };
      this.emit();
    } else if (g.op === 'lobby') {
      if (!GAMES[g.kind] || !Array.isArray(g.players)) return;
      const players = g.players.filter(isTag).slice(0, 8);
      if (l && l.gid === g.gid && from === l.host) {
        if (!players.includes(this.me)) {
          if (g.started) { this._localEnd('Партия началась без вас. Позовут в следующую.'); return; }
          // До начала партии список без меня: ведущий ещё не получил просьбу или вычеркнул по ошибке
          // (связь мигнула). Просим место снова.
          l.confirmed = false;
          this._askJoin();
          return;
        }
        l.confirmed = true;
        l.players = players;
        l.started = !!g.started;
        this._rememberNames();
        this.emit();
      } else if (this.invite?.gid === g.gid && from === this.invite.host) {
        if (g.started) this.invite = null; // начали без нас
        else this.invite.players = players;
        this.emit();
      }
    } else if (g.op === 'join') {
      if (!this.isHost || l.gid !== g.gid) { if (!l) this.room.sendGame(from, { op: 'end', gid: g.gid, reason: 'Этот стол уже закрыт.' }); return; }
      if (!this.room.members.has(from)) return;
      // Повтор просьбы от того, кто уже за столом: просто подтвердить списком.
      if (l.players.includes(from)) { this.room.sendGame(from, { op: 'lobby', ...this._lobbyMsg() }); return; }
      if (!this.joinable) { this.room.sendGame(from, { op: 'end', gid: g.gid, reason: 'Партия уже идёт. Позовут в следующую.' }); return; }
      if (l.players.length >= GAMES[l.kind].players.max) { this.room.sendGame(from, { op: 'end', gid: g.gid, reason: 'За столом нет мест.' }); return; }
      l.players.push(from);
      this._rememberNames();
      this._broadcast({ op: 'lobby', ...this._lobbyMsg() });
      this.emit();
    } else if (g.op === 'quit') {
      if (!this.isHost || l.gid !== g.gid || !l.players.includes(from)) return;
      if (l.started && this.state?.phase === 'play') { this._end(`${this.nameOf(from)} встаёт из-за стола, партия прервана.`); return; }
      l.players = l.players.filter((id) => id !== from);
      this._broadcast({ op: 'lobby', ...this._lobbyMsg() });
      this.emit();
    } else if (g.op === 'move') {
      // Ход в стол, которого здесь уже нет (ведущий перезагрузил страницу): сказать, что стол закрыт.
      if (!l || l.gid !== g.gid) { if (!l) this.room.sendGame(from, { op: 'end', gid: g.gid, reason: 'Стол закрыт: ведущий перезагружает страницу.' }); return; }
      if (!this.isHost) return;
      this._hostMove(from, decodeMove(g.move));
    } else if (g.op === 'tick') {
      if (l && l.gid === g.gid && from === l.host) this.lastTick = Date.now();
      else if (!l || l.gid !== g.gid) this.room.sendGame(from, { op: 'quit', gid: g.gid }); // меня за этим столом нет
    } else if (g.op === 'view') {
      if (!l || l.gid !== g.gid) { this.room.sendGame(from, { op: 'quit', gid: g.gid }); return; } // стол-призрак после перезагрузки
      if (from !== l.host || typeof g.seq !== 'number' || g.seq < (this.viewSeq || 0)) return;
      this.lastTick = Date.now();
      const v = g.view;
      if (!v || v.kind !== l.kind || !Array.isArray(v.hand) || !v.hand.every(isCard) || !Array.isArray(v.legal)) return;
      l.started = true;
      this._setView(v, g.seq);
    } else if (g.op === 'end') {
      if (l && l.gid === g.gid && from === l.host) this._localEnd(typeof g.reason === 'string' ? g.reason.slice(0, 200) : 'Игра закончилась.');
      else if (this.invite?.gid === g.gid && from === this.invite.host) { this.invite = null; this.emit(); }
    }
  }

  // Кто-то ушёл из звонка: из лобби — вычеркнуть, посреди партии — партия прервана. Ушёл ведущий — стол закрыт.
  _onMembers() {
    const l = this.lobby;
    if (this.invite && !this.room.members.has(this.invite.host)) { this.invite = null; this.emit(); }
    if (!l) return;
    if (!this.isHost) {
      if (!this.room.members.has(l.host)) this._localEnd('Ведущий выходит из звонка, стол закрыт.');
      return;
    }
    const gone = l.players.filter((id) => id !== this.me && !this.room.members.has(id));
    if (!gone.length) return;
    if (l.started && this.state?.phase === 'play') { this._end(`${this.nameOf(gone[0])} выходит из звонка, партия прервана.`); return; }
    l.players = l.players.filter((id) => !gone.includes(id));
    this._broadcast({ op: 'lobby', ...this._lobbyMsg() });
    this.emit();
  }

  // Имена игроков запоминаем: после конца партии человек может уйти, а в итогах его имя нужно.
  _rememberNames() {
    this.names = this.names || {};
    for (const id of this.lobby?.players || []) { const n = this.room.members.get(id)?.name; if (n) this.names[id] = n; }
  }

  dispose() {
    clearInterval(this.watch);
    clearTimeout(this.joinTimer);
    if (this.isHost && this.lobby) this._end('Ведущий выходит из звонка, стол закрыт.');
    else if (this.lobby) { this.room.sendGame(this.lobby.host, { op: 'quit', gid: this.lobby.gid }); this._localEnd(null); }
    this.room.removeEventListener('game', this.onMsg);
    this.room.removeEventListener('members', this.onMembers);
  }
}
