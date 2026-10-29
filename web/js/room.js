// Комната: хозяин, допуск гостей и прямые соединения между всеми участниками.
//
// Хозяин — единственный, кто решает, кого впустить. Его id зашит в ссылку,
// поэтому список участников принимается только с его подписью.
// Видео и звук идут напрямую между устройствами (WebRTC, DTLS-SRTP).
// Отпечатки ключей DTLS передаются в подписанных личных конвертах,
// поэтому подменить собеседника посередине нельзя.

import * as C from './crypto.js';
import { SecureChannel } from './signal.js';
import { LADDER, PAUSE, newAdapt, stepAdapt } from './adapt.js';

export const MAX_MEMBERS = 8;
const HELLO_EVERY = 4000;
const KNOCK_EVERY = 4000;
const ALIVE_TIMEOUT = 45000;
const HOST_TIMEOUT = 20000;
const RECENT_FOR = 3 * 60000;
const KNOWN_MAX = 60; // столько знакомых хозяин помнит
const DEPUTY_AFTER = 30000; // через столько тишины от хозяина двери берёт временный хозяин
const CERT_TTL = 3 * 3600 * 1000; // подпись хозяина под списком действует три часа
const CODE_TRIES = 5; // столько неверных кодов входа за минуту, дальше проверка кода засыпает на 5 минут
// Несколько независимых STUN: из части сетей (например, в России) сервер Google не отвечает.
// Российских серверов в списке нет намеренно: STUN-сервер видит настоящий адрес устройства.
export const STUN = ['stun:stun.cloudflare.com:3478', 'stun:global.stun.twilio.com:3478', 'stun:stun.l.google.com:19302'];
const GATHER_WAIT = 2000; // сколько ждём адреса до отправки; поздние досылаются отдельно

// Порядок дорожек одинаковый у всех: микрофон, камера, экран, звук экрана.
export const SLOTS = ['audio', 'video', 'video', 'audio'];
export const SLOT = { mic: 0, cam: 1, screen: 2, screenAudio: 3 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Фото в чате идут напрямую между устройствами, по отдельному зашифрованному каналу, кусками по 16 КБ.
export const IMG_MAX = 8 * 1024 * 1024;
const CHUNK = 16 * 1024;
// Реакции передаются номером: чужой текст через них не пролезет.
export const REACTIONS = ['👍', '😂', '❤️', '🔥', '👏', '💩'];

// Что это за картинка — по первым байтам, а не по словам отправителя.
export function sniffImage(b) {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}
const dim = (n) => (Number.isInteger(n) && n > 0 && n <= 20000 ? n : 0);
// Отпечаток кода входа для подписи хозяина: временный хозяин сверяет код, не зная его.
const entryHash = async (secret, code) => C.b64u(await C.sha256(C.concat(C.enc('entry|'), secret, C.enc('|' + code))));
const HOST_ONLY = new Set(['challenge', 'roster', 'deny', 'end']);
const isTag = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(s);

export class Room extends EventTarget {
  /**
   * opts: { secret, hostId, isHost, identity, name, title, turn, relayOnly, media, saved }
   * saved — сохранённое состояние хозяина ({ ver, members, locked, denied }) на случай перезагрузки страницы.
   */
  constructor(opts) {
    super();
    Object.assign(this, {
      secret: opts.secret, hostId: opts.hostId, isHost: !!opts.isHost,
      me: opts.identity, myName: opts.name, title: opts.title || '', turn: opts.turn || null,
      relayOnly: !!opts.relayOnly, media: opts.media,
      entryCode: C.normalizeCode(opts.entryCode || ''), // хозяину: код входа комнаты; гостю: код, который он ввёл
      shareState: !!opts.shareState, // комната с кодом хозяина: настройки лежат у посредника для другого устройства
    });
    this.known = new Map(); // кого хозяин уже впускал: они входят без вопроса
    this.autoKnown = true;
    this.openLink = false; // пускать всех, у кого есть ссылка, без «Впустить»
    this.codeFails = [];
    this.codeSleepUntil = 0;
    this.members = new Map();
    this.knocks = new Map();
    this.denied = new Set();
    this.conns = new Map();
    this.alive = new Map();
    this.seen = new Set(); // кто подал голос в этом сеансе хозяина
    this.recent = new Map(); // кто недавно выпал: при возврате впускаем без нового запроса
    this.rosterSentAt = new Map();
    this.pendingOffers = new Map();
    this.codes = new Map();
    this.locked = false;
    this.ver = 0;
    this.phase = 'connecting';
    this.hostSeen = 0;
    this.hostPeer = null;
    this.hostSession = null; // сеанс хозяина: отличает текущую встречу от прошлой
    this.hostHelloTs = 0;
    this.myCode = null;
    this.timers = [];
    this.saved = opts.saved || null;
    this.onMediaChange = () => this._mediaChanged();
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  setPhase(phase, extra = {}) {
    this.phase = phase;
    this.emit('phase', { phase, ...extra });
  }

  async start() {
    this.keys = await C.roomKeys(this.secret);
    this.channel = new SecureChannel(this.keys, this.me, {
      onMessage: (m) => this._onSignal(m).catch((e) => console.warn('signal', m.type, e)),
      onState: (on) => this.emit('signal', { online: on }),
    });
    this.channel.start();
    this.media.addEventListener('change', this.onMediaChange);

    if (this.isHost) {
      this.session = C.b64u(C.randomBytes(12));
      this.since = Date.now();
      this.myCode = await this.codeOf(this.me.id, '');
      this.members.set(this.me.id, { id: this.me.id, name: this.myName, pk: this.me.pk, r: '' });
      if (this.saved) {
        // Страница хозяина перезагрузилась посреди встречи: возвращаем тех, кто был в комнате.
        for (const m of this.saved.members || []) {
          if (m.id === this.me.id) continue;
          try {
            const peer = await this.channel.learn(m.pk);
            if (peer.id !== m.id) continue;
            const r = isTag(m.r) ? m.r : '';
            this.members.set(m.id, { id: m.id, name: cleanName(m.name), pk: m.pk, r });
            this.alive.set(m.id, Date.now());
            await this.codeOf(m.id, r);
          } catch {}
        }
        this._adoptSettings(this.saved);
        this.locked = !!this.saved.locked;
        this.ver = (this.saved.ver || 0) + 1;
      }
      this.ver = Math.max(this.ver, Date.now());
      this.setPhase('joined');
      this.lastReap = Date.now();
      this._hello();
      this._every(HELLO_EVERY, () => this._hello());
      this._every(15000, () => this._pushRoster());
      this._every(5000, () => this._reapSilent());
      this._every(5000, () => this._expireKnocks());
      this._syncConns();
      this.emit('members');
    } else {
      this.setPhase('waiting-host');
      // Гость стучит каждые 4 с, пока ждёт, и каждые 8 с, когда уже внутри: это заодно знак «я на связи».
      let tick = 0;
      this._every(KNOCK_EVERY, () => { tick++; if (this.phase === 'knocking' || (this.phase === 'joined' && tick % 2 === 0)) this._knock(); });
      this._every(5000, () => {
        const online = Date.now() - this.hostSeen < HOST_TIMEOUT;
        if (online !== this.hostOnline) { this.hostOnline = online; this.emit('host', { online }); }
        this._deputyTick().catch(() => {});
      });
    }
    this._every(250, () => this._levels());
    this._every(8000, () => { for (const c of this.conns.values()) c.sendDc({ t: 'ping' }); });
    this._every(4000, () => { for (const c of this.conns.values()) c.quality().catch(() => {}); });
  }

  _every(ms, fn) {
    this.timers.push(setInterval(() => { try { const r = fn(); if (r?.catch) r.catch(() => {}); } catch {} }, ms));
  }

  _hello() {
    if (this.replacedBy) return null;
    return this.channel.send('hello', { locked: this.locked, hs: this.session, since: this.since });
  }

  // Знакомые, отказы, код входа — из сохранённого на этом устройстве или пришедшего с другого.
  _adoptSettings(st) {
    for (const id of st.denied || []) if (isTag(id)) { this.denied.add(id); this.known.delete(id); }
    for (const k of st.known || []) {
      if (isTag(k?.id) && Array.isArray(k.pk) && !this.denied.has(k.id)) this.known.set(k.id, { id: k.id, name: cleanName(k.name), pk: k.pk, r: isTag(k.r) ? k.r : '' });
    }
    if (typeof st.entryCode === 'string' && !this.entryCode) this.entryCode = C.normalizeCode(st.entryCode);
    if (typeof st.autoKnown === 'boolean') this.autoKnown = st.autoKnown;
    if (typeof st.openLink === 'boolean') this.openLink = st.openLink;
    if (typeof st.title === 'string' && !this.title) this.title = st.title.slice(0, 80);
  }

  // Другое устройство хозяина (вошло по коду хозяина) прислало приветствие. Кто открыл позже, тот и хозяин.
  _onSelfHello(body) {
    if (this.replacedBy || body.hs === this.session || typeof body.since !== 'number') return;
    if (body.since > this.since) {
      // Хозяин открыл комнату на другом устройстве. Это устройство не уходит, а остаётся в звонке гостем:
      // приложение сразу передаст новому хозяину, кого впускать (см. handOff).
      this.replacedBy = body.hs;
      this.timers.forEach(clearInterval);
      this.timers = [];
      this._leaveCall();
      this.setPhase('replaced');
    }
  }

  // Передать новому устройству хозяина список участников, где это устройство уже записано гостем.
  async handOff(guest) {
    this.members.set(guest.id, { id: guest.id, name: cleanName(guest.name), pk: guest.pk, r: '' });
    this.known.set(guest.id, { id: guest.id, name: cleanName(guest.name), pk: guest.pk, r: '' });
    this.alive.set(guest.id, Date.now());
    this.ver = Math.max(this.ver + 1, Date.now());
    // Комната без кода хозяина тоже бывает открыта дважды (две вкладки) — тогда сообщение просто личное, без хранения.
    await this._publishState(this._stateBody(), { force: true });
  }

  // Сохранённые настройки комнаты от другого устройства хозяина.
  async _onState(body) {
    if (typeof body.ver !== 'number' || body.ver <= (this.stateVer || 0)) return;
    this.stateVer = body.ver;
    this._adoptSettings(body);
    // Участников берём, если это свежий список с другого устройства хозяина (идёт встреча)
    // или если у этого устройства своего списка нет. Тогда при смене хозяина никого не выкинет.
    const fresh = typeof body.updatedAt === 'number' && Date.now() - body.updatedAt < 10 * 60000;
    const fromOther = typeof body.hs === 'string' && body.hs !== this.session;
    if (Array.isArray(body.members) && ((fresh && fromOther) || !this.saved)) {
      for (const m of body.members.slice(0, MAX_MEMBERS)) {
        if (!isTag(m?.id) || m.id === this.me.id || this.members.has(m.id)) continue;
        try {
          const peer = await this.channel.learn(m.pk);
          if (peer.id !== m.id) continue;
          this.members.set(m.id, { id: m.id, name: cleanName(m.name), pk: m.pk, r: isTag(m.r) ? m.r : '' });
          this.alive.set(m.id, Date.now());
        } catch {}
      }
      this.ver = Math.max(this.ver + 1, Date.now());
    }
    this._changedMembers();
  }

  async codeOf(id, r = '') {
    const key = id + '|' + r;
    if (!this.codes.has(key)) this.codes.set(key, await C.safetyCode(this.secret, id, r));
    return this.codes.get(key);
  }

  memberList() {
    return [...this.members.values()].map((m) => ({
      ...m, me: m.id === this.me.id, host: m.id === this.hostId, code: this.codes.get(m.id + '|' + (m.r || '')) || '',
      conn: this.conns.get(m.id) || null,
    }));
  }

  // ---------- Служебные сообщения ----------

  async _onSignal({ type, from, ts, body, peer }) {
    if (this.closed) return;

    if (this.isHost) {
      if (from === this.me.id) {
        if (type === 'hello') return this._onSelfHello(body);
        if (type === 'state') return this._onState(body);
        return;
      }
      if (type === 'knock') return this._onKnock(peer, body);
      if (type === 'handback') return this._onHandback(peer, body);
      if (type === 'leave') {
        if (this.members.has(from)) this._removeMember(from, { remember: false });
        return;
      }
    } else if (from !== this.hostId) {
      // Без хозяина: временный хозяин и всё, что от него.
      if (type === 'dhello') return this._onDHello(peer, body);
      if (type === 'droster') return this._onDRoster(peer, body);
      if (type === 'knock' && this.deputy) return this._onDeputyKnock(peer, body);
      if (this.door && from === this.door.id && body.ds === this.door.ds) {
        if (type === 'challenge') return this._onChallenge(body);
        if (type === 'deny') {
          const reason = String(body.reason || 'denied');
          if (this.phase === 'joined') return;
          if (reason === 'locked' || reason === 'full') { this.retryAt = Date.now() + 15000; this.setPhase(reason); }
          else { this._leaveCall(); this.setPhase('denied', { reason }); }
          return;
        }
      }
    }
    if (!this.isHost && from === this.hostId) {
      if (type === 'hello') return this._onHello(peer, ts, body);
      if (HOST_ONLY.has(type)) {
        // Команды хозяина — только из текущего сеанса. Повтор сообщения прошлой встречи не сработает.
        if (!this.hostSession || body.hs !== this.hostSession) return;
        if (type === 'challenge') return this._onChallenge(body);
        if (type === 'roster') return this._onRoster(body);
        if (type === 'deny') {
          const reason = String(body.reason || 'denied');
          this._leaveCall();
          if (reason === 'locked' || reason === 'full') { this.retryAt = Date.now() + 15000; this.setPhase(reason); }
          else this.setPhase('denied', { reason });
          return;
        }
        if (type === 'end') { this._end('ended'); return; }
      }
    }

    if (type === 'offer' || type === 'answer' || type === 'restart' || type === 'ice') {
      const conn = this.phase === 'joined' && this.members.has(from) ? this.conns.get(from) : null;
      if (!conn) {
        // Предложение от того, кого ещё нет в нашем списке: подождать список от хозяина.
        if (type === 'offer' && this.pendingOffers.size < 20) this.pendingOffers.set(from, { body, until: Date.now() + 10000 });
        return;
      }
      if (type === 'offer') await conn.onOffer(body);
      else if (type === 'answer') await conn.onAnswer(body);
      else if (type === 'ice') await conn.onIce(body);
      else conn.onRestartRequest();
    }
  }

  _onHello(peer, ts, body) {
    if (ts < this.hostHelloTs || !isTag(body.hs)) return; // старый привет, повторённый посредником
    this.hostHelloTs = ts;
    this.hostPeer = peer;
    this.hostSeen = Date.now();
    if (body.hs !== this.hostSession) {
      // Хозяин открыл комнату заново или перешёл на другое устройство: нужен новый код проверки,
      // а соединение с ним — пересобрать сразу, не дожидаясь, пока старое отомрёт само.
      const changed = !!this.hostSession;
      this.hostSession = body.hs;
      if (this.phase !== 'joined') { this.myCode = null; this.emit('code'); }
      else if (changed) this.conns.get(this.hostId)?.nudge(true);
    }
    if (!this.hostOnline) { this.hostOnline = true; this.emit('host', { online: true }); }
    if (this.phase === 'waiting-host') { this.setPhase('knocking'); this._knock(); }
    if (body.locked && this.phase === 'knocking') this.setPhase('locked');
    const canRetry = (this.phase === 'locked' && !body.locked) || (this.phase === 'full' && Date.now() > (this.retryAt || 0));
    if (canRetry) { this.setPhase('knocking'); this._knock(); }
  }

  async _onChallenge(body) {
    if (!isTag(body.r) || this.phase === 'joined') return;
    if (!!body.badCode !== !!this.badCode) { this.badCode = !!body.badCode; this.emit('code'); }
    if (this.challenge === body.r && this.myCode) return;
    this.challenge = body.r;
    this.myCode = await C.safetyCode(this.secret, this.me.id, body.r);
    this.emit('code');
  }

  async _knock() {
    if (this.isHost || this.deputy || !['knocking', 'joined'].includes(this.phase)) return;
    const hostHere = this.hostPeer && Date.now() - this.hostSeen < HOST_TIMEOUT;
    const target = hostHere ? this.hostPeer : (this.door && Date.now() - this.door.seen < HOST_TIMEOUT ? this.door.peer : this.hostPeer);
    if (!target) return;
    const body = { name: this.myName, joined: this.phase === 'joined' };
    if (this.entryCode && this.phase !== 'joined') body.code = this.entryCode;
    await this.channel.send('knock', body, target);
  }

  // ---------- Временный хозяин ----------

  get canAdmit() { return this.isHost || !!this.deputy; }

  // Проверить подпись хозяина под составом встречи. Возвращает содержимое или null.
  async _checkCert(cert) {
    if (!cert || typeof cert.d !== 'string' || typeof cert.s !== 'string' || cert.d.length > 20000) return null;
    if (this.certOk?.s === cert.s) return this.certOk.d;
    const peer = await this.channel.learn(cert.pk);
    if (peer.id !== this.hostId) return null;
    if (!(await C.verify(peer, C.enc(cert.d), C.unb64u(cert.s)))) return null;
    const d = JSON.parse(cert.d);
    if (d.t !== 'svoi-cert' || d.topic !== this.keys.topic || !(d.exp > Date.now()) || !Array.isArray(d.members)) return null;
    this.certOk = { s: cert.s, d };
    return d;
  }

  // Каждые 5 с: если хозяина нет, решить, кто держит двери.
  async _deputyTick() {
    if (this.isHost || this.closed) return;
    const gone = this.phase === 'joined' && this.hostSeen && Date.now() - this.hostSeen >= HOST_TIMEOUT;
    if (!gone) {
      this.hostMissingSent = false;
      this.deputyId = null;
      if (this.deputy) await this._stopDeputy();
      return;
    }
    // Сначала шанс тому, у кого есть ключ хозяина (вводил код хозяина): приложение само сделает его хозяином.
    if (!this.hostMissingSent) { this.hostMissingSent = true; this.emit('host-missing'); }
    const d = this.cert ? await this._checkCert(this.cert) : null;
    if (!d || Date.now() - this.hostSeen < DEPUTY_AFTER) return;
    const present = (id) => id === this.me.id || this.conns.get(id)?.state === 'connected';
    const first = d.members.filter((id) => id !== this.hostId).find(present) || null;
    if (first !== this.deputyId) { this.deputyId = first; this.emit('host', {}); }
    if (this.deputy) for (const [id, k] of this.knocks) if (Date.now() - k.last > 15000) { this.knocks.delete(id); this.emit('knocks', {}); }
    if (first === this.me.id && !this.deputy) this._startDeputy();
    else if (first !== this.me.id && this.deputy) await this._stopDeputy();
  }

  _startDeputy() {
    this.deputy = { ds: C.b64u(C.randomBytes(9)), ver: Date.now(), added: new Map() };
    this.knocks.clear();
    this.emit('deputy', { on: true });
    this._dHello();
    this.deputyTimer = setInterval(() => this._dHello(), HELLO_EVERY);
    this._pushDRoster();
  }

  async _stopDeputy() {
    const dep = this.deputy;
    clearInterval(this.deputyTimer);
    this.deputy = null;
    this.knocks.clear();
    this.emit('knocks', {});
    this.emit('deputy', { on: false });
    // Хозяин вернулся: передать ему всех, кого впустили без него.
    if (dep?.added.size && this.hostPeer) {
      try { await this.channel.send('handback', { added: [...dep.added.values()] }, this.hostPeer); } catch {}
    }
  }

  _dHello() {
    if (!this.deputy) return null;
    return this.channel.send('dhello', { cert: this.cert, ds: this.deputy.ds, locked: !!this.certOk?.d.locked });
  }

  async _sendDRoster(id) {
    const m = this.members.get(id);
    if (!m || !this.deputy) return;
    const body = { cert: this.cert, ds: this.deputy.ds, ver: this.deputy.ver, title: this.title, members: [...this.members.values()] };
    await this.channel.send('droster', body, await this.channel.learn(m.pk));
  }

  _pushDRoster() {
    if (!this.deputy) return;
    this.deputy.ver = Math.max(this.deputy.ver + 1, Date.now());
    for (const id of this.members.keys()) if (id !== this.me.id && id !== this.hostId) this._sendDRoster(id).catch(() => {});
  }

  async _onDeputyKnock(peer, body) {
    const id = peer.id;
    const now = Date.now();
    const d = this.certOk?.d;
    if (!d) return;
    if (this.members.has(id)) return this._sendDRoster(id);
    const dDeny = (reason) => this.channel.send('deny', { reason, ds: this.deputy.ds }, peer);
    if (d.locked) return dDeny('locked');
    if (this.members.size >= MAX_MEMBERS) return dDeny('full');
    const name = cleanName(body.name);
    const viaCode = d.entry && typeof body.code === 'string' && body.code && now > this.codeSleepUntil
      && (await entryHash(this.secret, C.normalizeCode(body.code))) === d.entry;
    if (d.known.includes(id) || viaCode || d.open === true) {
      const r = C.b64u(C.randomBytes(9));
      this.knocks.set(id, { id, name, pk: peer.pk, peer, r, code: await this.codeOf(id, r), last: now });
      return this.admit(id);
    }
    let k = this.knocks.get(id);
    if (!k) {
      if (this.knocks.size >= 20) return;
      const r = C.b64u(C.randomBytes(9));
      k = { id, name, pk: peer.pk, peer, r, code: await this.codeOf(id, r), last: now };
      this.knocks.set(id, k);
      this.emit('knocks', { added: id });
    }
    k.last = now;
    await this.channel.send('challenge', { r: k.r, ds: this.deputy.ds }, peer);
  }

  // Гость без хозяина: временный хозяин зовёт к себе. Проверяем подпись хозяина и что он в списке.
  async _onDHello(peer, body) {
    if (this.isHost || this.deputy || (this.hostSeen && Date.now() - this.hostSeen < HOST_TIMEOUT)) return;
    const d = await this._checkCert(body.cert);
    if (!d || !d.members.includes(peer.id) || !isTag(body.ds)) return;
    const fresh = !this.door || this.door.id !== peer.id || this.door.ds !== body.ds;
    this.door = { id: peer.id, peer, ds: body.ds, seen: Date.now() };
    if (fresh) { this.dver = 0; this.emit('host', {}); }
    if (this.phase === 'waiting-host') { this.setPhase('knocking'); this._knock(); }
  }

  async _onDRoster(peer, body) {
    if (this.isHost || this.deputy) return;
    if (this.hostSeen && Date.now() - this.hostSeen < HOST_TIMEOUT) return; // хозяин на месте — слушаем его
    const d = await this._checkCert(body.cert);
    if (!d || !d.members.includes(peer.id) || typeof body.ver !== 'number' || !Array.isArray(body.members)) return;
    if (!this.door || this.door.id !== peer.id) this.door = { id: peer.id, peer, ds: body.ds, seen: Date.now() };
    if (body.ver <= (this.dver || 0)) return;
    const next = new Map();
    for (const m of body.members.slice(0, MAX_MEMBERS)) {
      try {
        const p = await this.channel.learn(m.pk);
        if (p.id !== m.id) continue;
        next.set(m.id, { id: m.id, name: cleanName(m.name), pk: m.pk, r: isTag(m.r) ? m.r : '' });
        await this.codeOf(m.id, isTag(m.r) ? m.r : '');
      } catch {}
    }
    if (!next.has(this.me.id) || !next.has(this.hostId)) return;
    this.dver = body.ver;
    if (!this.title) this.title = String(body.title || '').slice(0, 80);
    if (this.orphan) { this.orphan = false; this.emit('host', {}); }
    this.members = next;
    this.myCode = this.codes.get(this.me.id + '|' + next.get(this.me.id).r) || this.myCode;
    if (this.phase !== 'joined') this.setPhase('joined');
    this._syncConns();
    this.emit('members');
  }

  // ---------- Хозяин ----------

  async _onKnock(peer, body) {
    const id = peer.id;
    const now = Date.now();
    this.seen.add(id);
    if (this.members.has(id)) {
      // Участник подаёт знак «я на связи». Если давно не получал список — напомнить.
      this.alive.set(id, now);
      // Ещё не внутри (например, перезагрузил страницу) — список сразу. Уже внутри — только если давно не слал.
      if (!body.joined || now - (this.rosterSentAt.get(id) || 0) > 12000) await this._sendRoster(id);
      return;
    }
    if (this.denied.has(id)) return this._deny(peer, 'denied');
    const back = this.recent.get(id);
    if (back && now - back.at < RECENT_FOR && this.members.size < MAX_MEMBERS) {
      // Тот же человек с тем же ключом вернулся после обрыва или перезагрузки. Его уже впускали.
      this.recent.delete(id);
      this.knocks.set(id, { id, name: back.name, pk: peer.pk, peer, r: back.r, code: await this.codeOf(id, back.r), last: now });
      return this.admit(id);
    }
    if (this.locked) return this._deny(peer, 'locked');
    if (this.members.size >= MAX_MEMBERS) return this._deny(peer, 'full');
    const known = this.known.get(id);
    if (known && this.autoKnown) {
      // Уже впускали на прошлых встречах: тот же ключ устройства, значит, тот же человек.
      this.knocks.set(id, { id, name: cleanName(body.name), pk: peer.pk, peer, r: known.r, code: await this.codeOf(id, known.r), last: now });
      return this.admit(id);
    }
    if (this.openLink) {
      // Комната открыта по ссылке: ссылка и есть пропуск.
      const r = C.b64u(C.randomBytes(9));
      this.knocks.set(id, { id, name: cleanName(body.name), pk: peer.pk, peer, r, code: await this.codeOf(id, r), last: now });
      return this.admit(id);
    }
    let badCode = false;
    if (this.entryCode && typeof body.code === 'string' && body.code && now > this.codeSleepUntil) {
      if (C.normalizeCode(body.code) === this.entryCode) {
        const r = C.b64u(C.randomBytes(9));
        this.knocks.set(id, { id, name: cleanName(body.name), pk: peer.pk, peer, r, code: await this.codeOf(id, r), last: now });
        return this.admit(id);
      }
      badCode = true;
      this.codeFails = this.codeFails.filter((t) => now - t < 60000);
      this.codeFails.push(now);
      if (this.codeFails.length > CODE_TRIES) {
        this.codeSleepUntil = now + 5 * 60000;
        this.emit('warn', { text: 'Кто-то подбирает код входа. Проверка кода выключена на 5 минут.' });
      }
    }
    let k = this.knocks.get(id);
    if (!k) {
      if (this.knocks.size >= 20) return; // не дать завалить хозяина запросами
      // Случайная добавка к коду придумывается после стука: ключ гостя уже не поменять под чужой код.
      const r = C.b64u(C.randomBytes(9));
      k = { id, name: cleanName(body.name), pk: peer.pk, peer, r, code: await this.codeOf(id, r), last: now };
      this.knocks.set(id, k);
      this.emit('knocks', { added: id });
    }
    k.last = now;
    await this.channel.send('challenge', { r: k.r, hs: this.session, badCode }, peer);
  }

  _deny(peer, reason) {
    return this.channel.send('deny', { reason, hs: this.session }, peer);
  }

  _expireKnocks() {
    let changed = false;
    for (const [id, k] of this.knocks) if (Date.now() - k.last > 15000) { this.knocks.delete(id); changed = true; }
    if (changed) this.emit('knocks', {});
  }

  async admit(id) {
    const k = this.knocks.get(id);
    if (!k || !this.canAdmit) return;
    if (this.deputy) {
      // Временный хозяин: впускает в звонок и запоминает, чтобы потом передать хозяину.
      this.knocks.delete(id);
      if (this.members.size >= MAX_MEMBERS) { this.emit('knocks', {}); return; }
      const m = { id, name: k.name, pk: k.pk, r: k.r };
      this.members.set(id, m);
      this.deputy.added.set(id, m);
      this.emit('knocks', {});
      this._pushDRoster();
      this._syncConns();
      this.emit('members');
      return;
    }
    this.knocks.delete(id);
    if (this.members.size >= MAX_MEMBERS) { await this._deny(k.peer, 'full'); this.emit('knocks', {}); return; }
    this.members.set(id, { id, name: k.name, pk: k.pk, r: k.r });
    this.known.delete(id);
    this.known.set(id, { id, name: k.name, pk: k.pk, r: k.r });
    while (this.known.size > KNOWN_MAX) this.known.delete(this.known.keys().next().value);
    this.alive.set(id, Date.now());
    this.ver = Math.max(this.ver + 1, Date.now());
    this.emit('knocks', {});
    this._changedMembers();
  }

  async deny(id) {
    const k = this.knocks.get(id);
    if (!k || !this.canAdmit) return;
    if (this.deputy) {
      this.knocks.delete(id);
      this.emit('knocks', {});
      await this.channel.send('deny', { reason: 'denied', ds: this.deputy.ds }, k.peer);
      return;
    }
    this.knocks.delete(id);
    this.denied.add(id);
    this.known.delete(id);
    this._persist();
    await this._deny(k.peer, 'denied');
    this.emit('knocks', {});
  }

  async kick(id) {
    if (!this.isHost || id === this.me.id || !this.members.has(id)) return;
    const m = this.members.get(id);
    this.denied.add(id);
    this.known.delete(id);
    this._removeMember(id, { remember: false });
    try { await this._deny(await this.channel.learn(m.pk), 'kicked'); } catch {}
  }

  setEntryCode(code) {
    if (!this.isHost) return;
    this.entryCode = C.normalizeCode(code);
    this.codeFails = [];
    this.codeSleepUntil = 0;
    this._persist();
    this.emit('members');
  }

  setOpenLink(v) {
    if (!this.isHost) return;
    this.openLink = !!v;
    // Кто уже стоит у двери, тот и проходит: ссылка у него есть.
    if (this.openLink) for (const id of [...this.knocks.keys()]) this.admit(id);
    this._persist();
    this.emit('members');
  }

  setTitle(title) {
    if (!this.isHost) return;
    this.title = String(title || '').trim().slice(0, 80);
    this.ver = Math.max(this.ver + 1, Date.now());
    this._persist();
    this._pushRoster();
    this.emit('members');
  }

  setAutoKnown(v) {
    if (!this.isHost) return;
    this.autoKnown = !!v;
    this._persist();
    this.emit('members');
  }

  forgetKnown() {
    if (!this.isHost) return;
    this.known.clear();
    this._persist();
    this.emit('members');
  }

  setLocked(v) {
    if (!this.isHost) return;
    this.locked = !!v;
    if (this.locked) {
      for (const k of this.knocks.values()) this._deny(k.peer, 'locked');
      this.knocks.clear();
      this.emit('knocks', {});
    }
    this._hello();
    this._persist();
    this.emit('members');
  }

  _removeMember(id, { remember = true } = {}) {
    const m = this.members.get(id);
    // В «недавние» попадает только тот, кто подавал голос в этом сеансе.
    if (m && remember && this.seen.has(id)) this.recent.set(id, { name: m.name, r: m.r || '', at: Date.now() });
    this.members.delete(id);
    this.alive.delete(id);
    this.ver = Math.max(this.ver + 1, Date.now());
    this._changedMembers();
  }

  _reapSilent() {
    const now = Date.now();
    const gap = now - this.lastReap;
    this.lastReap = now;
    if (gap > 15000) {
      // Телефон хозяина спал или был без сети: молчание гостей — не их вина. Даём им время отозваться.
      for (const id of this.members.keys()) this.alive.set(id, now);
      return;
    }
    for (const id of [...this.members.keys()]) {
      if (id === this.me.id) continue;
      const conn = this.conns.get(id);
      const t = Math.max(this.alive.get(id) || 0, conn?.lastAlive || 0);
      if (now - t > ALIVE_TIMEOUT) this._removeMember(id);
    }
  }

  _changedMembers() {
    this._persist();
    this._pushRoster();
    this._syncConns();
    this.emit('members');
  }

  _rosterBody() {
    return {
      ver: this.ver, title: this.title, locked: this.locked, hs: this.session,
      members: [...this.members.values()].map((m) => ({ id: m.id, name: m.name, pk: m.pk, r: m.r || '' })),
    };
  }

  async _sendRoster(id) {
    const m = this.members.get(id);
    if (!m) return;
    this.rosterSentAt.set(id, Date.now());
    const body = this._rosterBody();
    body.cert = await this._certFor();
    await this.channel.send('roster', body, await this.channel.learn(m.pk));
  }

  // Временный хозяин вернул тех, кого впустил без хозяина. Они уже в звонке — записываем.
  async _onHandback(peer, body) {
    if (!this.members.has(peer.id) || !Array.isArray(body.added)) return;
    let changed = false;
    for (const m of body.added.slice(0, MAX_MEMBERS)) {
      try {
        if (!isTag(m?.id) || this.members.has(m.id) || this.denied.has(m.id) || this.members.size >= MAX_MEMBERS) continue;
        const p = await this.channel.learn(m.pk);
        if (p.id !== m.id) continue;
        const entry = { id: m.id, name: cleanName(m.name), pk: m.pk, r: isTag(m.r) ? m.r : '' };
        this.members.set(m.id, entry);
        this.known.set(m.id, entry);
        this.alive.set(m.id, Date.now());
        await this.codeOf(m.id, entry.r);
        changed = true;
      } catch {}
    }
    if (changed) { this.ver = Math.max(this.ver + 1, Date.now()); this._changedMembers(); }
  }

  // Подпись хозяина под составом встречи. Если хозяин вылетит, по ней остальные поверят временному хозяину:
  // им может быть только тот, кто в этом списке. Подпись живёт три часа.
  async _certFor() {
    const key = [this.ver, this.members.size, this.known.size, this.entryCode, this.locked, this.openLink].join('|');
    if (this.certCache?.key === key && this.certCache.exp - Date.now() > 3600000) return this.certCache.cert;
    const exp = Date.now() + CERT_TTL;
    const d = JSON.stringify({
      t: 'svoi-cert', topic: this.keys.topic, ver: this.ver, exp, locked: this.locked, open: this.openLink,
      members: [...this.members.keys()], known: [...this.known.keys()].slice(-KNOWN_MAX),
      entry: this.entryCode ? await entryHash(this.secret, this.entryCode) : '',
    });
    const cert = { d, s: C.b64u(await C.sign(this.me, C.enc(d))), pk: this.me.pk };
    this.certCache = { key, exp, cert };
    return cert;
  }

  async _pushRoster() {
    if (!this.isHost) return;
    for (const id of this.members.keys()) if (id !== this.me.id) this._sendRoster(id).catch(() => {});
  }

  _persist({ ended = false } = {}) {
    if (!this.isHost) return;
    // Закрытый вход и список участников живут до конца встречи. Следующая начинается с открытой пустой комнаты.
    const st = this._stateBody({ ended });
    this.emit('persist', st);
    // Комната с кодом хозяина: настройки лежат у посредника в конверте самому себе — для другого устройства хозяина.
    if (this.shareState) {
      clearTimeout(this.stateTimer);
      this.stateTimer = setTimeout(() => this._publishState(st), 1500);
    }
  }

  _stateBody({ ended = false } = {}) {
    return {
      ver: this.ver, locked: ended ? false : this.locked, members: ended ? [] : this._rosterBody().members,
      denied: [...this.denied].slice(-200), known: [...this.known.values()], entryCode: this.entryCode,
      autoKnown: this.autoKnown, openLink: this.openLink, title: this.title, hs: this.session, updatedAt: Date.now(),
    };
  }

  async _publishState(st, { force = false } = {}) {
    if (!this.shareState && !force) return;
    clearTimeout(this.stateTimer);
    try {
      this.stateVer = Math.max((this.stateVer || 0) + 1, Date.now());
      await this.channel.send('state', { ...st, ver: this.stateVer }, await this.channel.learn(this.me.pk), { retain: this.shareState });
    } catch {}
  }

  // ---------- Гость ----------

  async _onRoster(body) {
    if (typeof body.ver !== 'number' || !Array.isArray(body.members) || body.members.length > MAX_MEMBERS) return;
    if (body.ver <= this.ver) return; // старый или повторённый список
    const next = new Map();
    for (const m of body.members) {
      try {
        const peer = await this.channel.learn(m.pk);
        if (peer.id !== m.id) continue;
        const r = isTag(m.r) ? m.r : '';
        next.set(m.id, { id: m.id, name: cleanName(m.name), pk: m.pk, r });
        await this.codeOf(m.id, r);
      } catch {}
    }
    if (body.ver <= this.ver) return; // пока проверяли ключи, пришёл список новее
    if (body.cert && (await this._checkCert(body.cert))) this.cert = body.cert;
    if (!next.has(this.hostId)) return;
    this.ver = body.ver;
    this.title = String(body.title || '').slice(0, 80);
    this.locked = !!body.locked;
    const wasJoined = this.phase === 'joined';
    if (!next.has(this.me.id)) {
      // Нас нет в списке. Это не удаление: удаляют отдельным сообщением. Скорее всего, сменился хозяин,
      // и он нас ещё не впустил. Остаёмся в звонке и стучимся дальше; знакомых он пустит сам.
      if (wasJoined && !this.orphan) { this.orphan = true; this.emit('host', {}); }
      return;
    }
    if (this.orphan) { this.orphan = false; this.emit('host', {}); }
    this.members = next;
    this.myCode = this.codes.get(this.me.id + '|' + next.get(this.me.id).r) || this.myCode;
    if (!wasJoined) this.setPhase('joined');
    this._syncConns();
    for (const [id, p] of this.pendingOffers) {
      this.pendingOffers.delete(id);
      if (p.until > Date.now() && this.conns.has(id)) this.conns.get(id).onOffer(p.body).catch(() => {});
    }
    this.emit('members');
  }

  // ---------- Соединения ----------

  iceConfig() {
    const servers = [{ urls: STUN }];
    if (this.turn?.urls) servers.push({ urls: this.turn.urls, username: this.turn.username, credential: this.turn.credential });
    return {
      iceServers: servers,
      iceTransportPolicy: this.relayOnly && this.turn?.urls ? 'relay' : 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    };
  }

  _syncConns() {
    if (this.phase !== 'joined') return;
    for (const [id, conn] of this.conns) if (!this.members.has(id)) { conn.close(); this.conns.delete(id); }
    for (const m of this.members.values()) {
      if (m.id === this.me.id || this.conns.has(m.id)) continue;
      const conn = new Conn(this, m);
      this.conns.set(m.id, conn);
      conn.start();
    }
    for (const c of this.conns.values()) c.tune();
  }

  _mediaChanged() {
    for (const c of this.conns.values()) c.pushTracks();
    this.emit('local');
  }

  localState() {
    const s = this.media.state();
    return { t: 'state', mic: s.mic, cam: s.cam, screen: s.screen };
  }

  sendChat(text) {
    text = String(text).trim().slice(0, 2000);
    if (!text) return null;
    const msg = { t: 'chat', id: C.b64u(C.randomBytes(9)), text, ts: Date.now() };
    for (const c of this.conns.values()) c.sendDc(msg);
    const item = { id: msg.id, from: this.me.id, name: this.myName, text, ts: msg.ts, me: true };
    this.emit('chat', item);
    return item;
  }

  // Фото: каждому, с кем есть прямое соединение. Опоздавшие не получат, как и сообщения чата.
  async sendImage(blob, { w = 0, h = 0 } = {}) {
    if (!blob || blob.size > IMG_MAX) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const mime = sniffImage(bytes);
    if (!mime) return null;
    const id = C.b64u(C.randomBytes(9));
    const file = new Blob([bytes], { type: mime });
    const item = { id, from: this.me.id, name: this.myName, kind: 'img', ts: Date.now(), me: true, w: dim(w), h: dim(h), blob: file, url: URL.createObjectURL(file), progress: 0 };
    this.emit('chat', item);
    const targets = [...this.conns.values()].filter((c) => c.fdc?.readyState === 'open');
    const parts = targets.map(() => 0);
    let last = 0;
    const report = () => {
      const now = Date.now();
      if (now - last < 150) return;
      last = now;
      this.emit('chat-update', { id, from: this.me.id, progress: parts.reduce((a, b) => a + b, 0) / parts.length });
    };
    const results = await Promise.all(targets.map((c, i) => c.sendFile({ t: 'img', id, size: bytes.length, w: item.w, h: item.h }, bytes, (p) => { parts[i] = p; report(); })));
    const sent = results.filter(Boolean).length;
    this.emit('chat-update', { id, from: this.me.id, progress: 1, sent, total: this.conns.size });
    return item;
  }

  sendReaction(i) {
    if (!Number.isInteger(i) || i < 0 || i >= REACTIONS.length) return;
    for (const c of this.conns.values()) c.sendDc({ t: 'react', e: i });
    this.emit('react', { from: this.me.id, e: i });
  }

  _levels() {
    const levels = {};
    for (const [id, c] of this.conns) levels[id] = c.audioLevel();
    levels[this.me.id] = this.media.level();
    // Анти-эхо «сильное» приглушает микрофон, пока говорят другие.
    let remote = 0;
    for (const [id, v] of Object.entries(levels)) if (id !== this.me.id) remote = Math.max(remote, v);
    this.media.duck?.(remote);
    this.emit('levels', levels);
  }

  // Вкладка вернулась из фона: сразу переподключиться к посредникам и добить зависшие соединения.
  nudge() {
    if (this.closed) return;
    this.channel?.wake();
    for (const c of this.conns.values()) if (c.state !== 'connected') c.nudge();
  }

  // ---------- Выход ----------

  _leaveCall() {
    for (const c of this.conns.values()) c.close();
    this.conns.clear();
    this.emit('members');
  }

  _end(phase) {
    if (this.closed) return;
    this._leaveCall();
    this.setPhase(phase);
    this.stop();
  }

  async leave() {
    if (this.closed) return;
    try {
      if (this.isHost) {
        // Встреча закончена: при следующем открытии комната начнётся пустой.
        this._persist({ ended: true });
        await this.channel.send('end', { hs: this.session });
        await sleep(150);
        await this.channel.send('end', { hs: this.session });
      } else if (this.hostPeer && this.phase === 'joined') {
        await this.channel.send('leave', {}, this.hostPeer);
      }
      await sleep(250);
    } catch {}
    this._end('left');
  }

  stop() {
    this.closed = true;
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.media.removeEventListener('change', this.onMediaChange);
    for (const c of this.conns.values()) c.close();
    this.conns.clear();
    this.channel?.stop();
  }
}

// ---------- Соединение с одним участником ----------

class Conn {
  constructor(room, member) {
    this.room = room;
    this.member = member;
    this.id = member.id;
    this.initiator = room.me.id < member.id; // предложение всегда шлёт тот, у кого id меньше: без гонок
    this.pc = null;
    this.dc = null;
    this.sid = null;
    this.state = 'connecting';
    this.attempt = 0;
    this.remote = { mic: false, cam: false, screen: false };
    this.tracks = [null, null, null, null];
    this.lastAlive = Date.now();
    this.timer = null;
    this.failures = 0;
    this.info = { local: new Set(), remote: new Set(), blocked: false };
    this.pendingIce = [];
    this.incoming = new Map(); // фото, которые сейчас приходят
    this.q = null; // качество связи: good, weak, bad
    this.reacts = [];
    this.adapt = newAdapt(); // ступенька качества нашего видео для этого собеседника
    this.remotePaused = false; // собеседник поставил своё видео нам на паузу из-за связи
    this.frozen = false; // видео собеседника застыло
    this.lastFrames = -1;
  }

  emit() { this.room.emit('peer', { id: this.id }); }

  setState(s) { if (this.state !== s) { this.state = s; this.emit(); } }

  async start() {
    if (this.initiator) await this.makeOffer();
    else this.timer = setTimeout(() => this._askRestart(), 15000);
  }

  async _peer() {
    return this.room.channel.learn(this.member.pk);
  }

  _newPc() {
    this._closePc();
    const pc = new RTCPeerConnection(this.room.iceConfig());
    this.pc = pc;
    this.dc = pc.createDataChannel('ctl', { negotiated: true, id: 0, ordered: true });
    this._wireDc(this.dc);
    this._dropIncoming();
    this.adapt = newAdapt();
    this.remotePaused = false;
    this.frozen = false;
    this.lastFrames = -1;
    this.fdc = pc.createDataChannel('file', { negotiated: true, id: 1, ordered: true });
    this._wireFile(this.fdc);
    pc.onconnectionstatechange = () => this._onPcState(pc);
    pc.oniceconnectionstatechange = () => this._onPcState(pc);
    this.info.local = new Set();
    this.info.remote = new Set();
    this.descSent = false;
    this.lateSent = 0;
    this.pendingIce = [];
    pc.onicecandidate = (e) => {
      if (pc !== this.pc || !e.candidate) return;
      const type = e.candidate.type || (/ typ (\w+)/.exec(e.candidate.candidate) || [])[1];
      if (type) this.info.local.add(type);
      // Адрес нашёлся уже после отправки предложения — досылаем его отдельно (медленный STUN или ретранслятор).
      if (this.descSent && this.lateSent < 12) {
        this.lateSent++;
        this._peer().then((peer) => this.room.channel.send('ice', { sid: this.sid, c: e.candidate.toJSON() }, peer)).catch(() => {});
      }
    };
    return pc;
  }

  _noteRemote(sdp) {
    for (const m of sdp.matchAll(/ typ (\w+)/g)) this.info.remote.add(m[1]);
  }

  // В описании нет ни одного адреса: браузер запретил прямую связь (часто так делает VPN-расширение).
  _checkBlocked(pc) {
    this.info.blocked = !/a=candidate:/.test(pc.localDescription?.sdp || '');
    if (this.info.blocked) this.room.emit('blocked', { id: this.id });
  }

  async onIce({ sid, c }) {
    if (this.closed || sid !== this.sid || !this.pc || !c || typeof c.candidate !== 'string' || c.candidate.length > 1000) return;
    const t = (/ typ (\w+)/.exec(c.candidate) || [])[1];
    if (t) this.info.remote.add(t);
    if (!this.pc.remoteDescription) { if (this.pendingIce.length < 20) this.pendingIce.push(c); return; }
    try { await this.pc.addIceCandidate(c); } catch {}
  }

  async _flushIce() {
    const list = this.pendingIce;
    this.pendingIce = [];
    for (const c of list) { try { await this.pc?.addIceCandidate(c); } catch {} }
  }

  _onPcState(pc) {
    if (pc !== this.pc) return;
    const s = pc.connectionState || pc.iceConnectionState;
    if (s === 'connected' || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      clearTimeout(this.timer);
      this.attempt = 0;
      this.failures = 0;
      this.setState('connected');
      this.tune();
    } else if (s === 'failed') {
      this.failures++;
      // Ответная сторона тоже должна честно показать, что напрямую не выходит.
      this.setState(this.attempt >= 2 || this.failures >= 2 ? 'failed' : 'connecting');
      this._scheduleRetry(1000);
    } else if (s === 'disconnected') {
      this.setState('connecting');
      this._scheduleRetry(7000, true);
    }
  }

  _scheduleRetry(ms, onlyIfStillDown = false) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (onlyIfStillDown && this.pc && ['connected'].includes(this.pc.connectionState)) return;
      if (this.initiator) this.makeOffer();
      else this._askRestart();
    }, ms);
  }

  async _askRestart(force = false) {
    if (this.closed || (this.state === 'connected' && !force)) return;
    try { await this.room.channel.send('restart', {}, await this._peer()); } catch {}
    this._scheduleRetry(20000, true);
  }

  nudge(force = false) {
    if (this.closed) return;
    if (this.initiator) { if (force || Date.now() - (this.lastOfferAt || 0) > 5000) this.makeOffer(); }
    else this._askRestart(force);
  }

  onRestartRequest() {
    if (!this.initiator || this.closed) return;
    // Новое устройство хозяина ещё не соединено с гостем: просьбу выполняем, даже если старое было «на связи».
    if (this.state === 'connected' && this.pc?.connectionState === 'connected' && this.room.isHost === false) return;
    if (Date.now() - (this.lastOfferAt || 0) < 5000) return;
    this.makeOffer();
  }

  async makeOffer() {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.attempt++;
    this.lastOfferAt = Date.now();
    if (this.attempt > 1) this.setState(this.attempt > 3 ? 'failed' : 'connecting');
    const sid = C.b64u(C.randomBytes(9));
    this.sid = sid;
    const pc = this._newPc();
    const media = this.room.media;
    SLOTS.forEach((kind, i) => pc.addTransceiver(media.track(i) || kind, { direction: 'sendrecv' }));
    preferRed(pc.getTransceivers()[SLOT.mic]);
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc, GATHER_WAIT);
    if (pc !== this.pc || this.closed) return;
    this._grabTracks(pc);
    this._checkBlocked(pc);
    const peer = await this._peer();
    const offerSdp = pc.localDescription.sdp;
    this.descSent = true;
    await this.room.channel.send('offer', { sid, sdp: offerSdp }, peer);
    const wait = Math.min(15000 * this.attempt, 45000);
    this._scheduleRetry(wait, true);
  }

  async onOffer({ sid, sdp }) {
    if (this.closed || this.initiator || typeof sid !== 'string' || typeof sdp !== 'string' || sdp.length > 100000) return;
    if (sid === this.sid) return;
    clearTimeout(this.timer);
    this.sid = sid;
    const pc = this._newPc();
    await pc.setRemoteDescription({ type: 'offer', sdp });
    this._noteRemote(sdp);
    await this._flushIce();
    const media = this.room.media;
    const trs = pc.getTransceivers();
    preferRed(trs[SLOT.mic]);
    for (let i = 0; i < trs.length && i < SLOTS.length; i++) {
      trs[i].direction = 'sendrecv';
      await trs[i].sender.replaceTrack(media.track(i));
    }
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc, GATHER_WAIT);
    if (pc !== this.pc || this.closed) return;
    this._grabTracks(pc);
    this._checkBlocked(pc);
    const peer = await this._peer();
    const answerSdp = pc.localDescription.sdp;
    this.descSent = true;
    await this.room.channel.send('answer', { sid, sdp: answerSdp }, peer);
    this._scheduleRetry(30000, true);
  }

  async onAnswer({ sid, sdp }) {
    if (this.closed || !this.initiator || sid !== this.sid || typeof sdp !== 'string' || sdp.length > 100000) return;
    if (!this.pc || this.pc.signalingState !== 'have-local-offer') return;
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
    this._noteRemote(sdp);
    await this._flushIce();
    this._grabTracks(this.pc);
  }

  _grabTracks(pc) {
    const trs = pc.getTransceivers();
    this.tracks = SLOTS.map((_, i) => trs[i]?.receiver?.track || null);
    this.emit();
  }

  pushTracks() {
    if (!this.pc) return;
    const trs = this.pc.getTransceivers();
    trs.slice(0, SLOTS.length).forEach((t, i) => {
      const want = this.room.media.track(i);
      if (t.sender.track !== want) t.sender.replaceTrack(want).catch(() => {});
    });
    this.sendDc(this.room.localState());
    this.tune();
  }

  // Битрейт под число собеседников (в сетке каждый отправляет видео каждому) и под связь с этим собеседником.
  // Звук важнее всего: у него высший приоритет, у видео — низкий.
  tune() {
    const pc = this.pc;
    if (!pc || pc.connectionState !== 'connected') return;
    const others = Math.max(1, this.room.members.size - 1);
    const base = others <= 1 ? 1500000 : others <= 3 ? 800000 : 450000;
    const step = LADDER[this.adapt.level];
    const trs = pc.getTransceivers();
    setParams(trs[SLOT.cam]?.sender, {
      maxBitrate: Math.min(base, step.bitrate), scaleResolutionDownBy: (others <= 3 ? 1 : 1.5) * step.scale,
      maxFramerate: step.fps, active: !step.pause, priority: 'low', networkPriority: 'low',
    }, { degradationPreference: 'balanced' });
    setParams(trs[SLOT.screen]?.sender, {
      maxBitrate: Math.min(others <= 2 ? 2500000 : 1200000, step.pause ? 300000 : Infinity), maxFramerate: step.screenFps, priority: 'medium',
    }, { degradationPreference: 'maintain-resolution' });
    setParams(trs[SLOT.mic]?.sender, { maxBitrate: 64000, priority: 'high', networkPriority: 'high' });
  }

  _wireDc(dc) {
    dc.onopen = () => {
      this.lastAlive = Date.now();
      this.sendDc(this.room.localState());
    };
    dc.onmessage = (e) => {
      if (typeof e.data !== 'string' || e.data.length > 8000) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this.lastAlive = Date.now();
      if (msg.t === 'state') {
        this.remote = { mic: !!msg.mic, cam: !!msg.cam, screen: !!msg.screen };
        this.emit();
      } else if (msg.t === 'chat' && typeof msg.text === 'string') {
        const name = this.room.members.get(this.id)?.name || 'Гость';
        this.room.emit('chat', { id: String(msg.id).slice(0, 20), from: this.id, name, text: msg.text.slice(0, 2000), ts: Date.now(), me: false });
      } else if (msg.t === 'react' && Number.isInteger(msg.e) && msg.e >= 0 && msg.e < REACTIONS.length) {
        // Не больше шести реакций за две секунды: салют из какашек тоже надо уметь остановить.
        const now = Date.now();
        this.reacts = this.reacts.filter((t) => now - t < 2000);
        if (this.reacts.length < 6) { this.reacts.push(now); this.room.emit('react', { from: this.id, e: msg.e }); }
      } else if (msg.t === 'vpause') {
        this.remotePaused = !!msg.on;
        this.emit();
      } else if (msg.t === 'ping') {
        // просто признак жизни
      }
    };
  }

  sendDc(obj) {
    if (this.dc?.readyState === 'open') { try { this.dc.send(JSON.stringify(obj)); } catch {} }
  }

  // Фото: сначала заголовок, потом куски. Канал упорядоченный, поэтому куски приходят по порядку.
  async sendFile(header, bytes, onProgress) {
    const dc = this.fdc;
    if (!dc || dc.readyState !== 'open') return false;
    try {
      dc.send(JSON.stringify(header));
      const idb = C.unb64u(header.id);
      for (let o = 0; o < bytes.length; o += CHUNK) {
        if (dc.bufferedAmount > 1 << 20) {
          await new Promise((resolve) => {
            const done = () => { dc.removeEventListener('bufferedamountlow', done); resolve(); };
            dc.addEventListener('bufferedamountlow', done);
            setTimeout(done, 3000);
          });
        }
        if (dc.readyState !== 'open' || this.fdc !== dc) return false;
        dc.send(C.concat(idb, bytes.subarray(o, o + CHUNK)));
        onProgress?.(Math.min(1, (o + CHUNK) / bytes.length));
      }
      return true;
    } catch { return false; }
  }

  _wireFile(dc) {
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 256 * 1024;
    dc.onmessage = (e) => {
      const now = Date.now();
      if (typeof e.data === 'string') {
        if (e.data.length > 1000) return;
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m?.t !== 'img' || !isTag(m.id) || !Number.isInteger(m.size) || m.size < 12 || m.size > IMG_MAX) return;
        if (this.incoming.size >= 3 || this.incoming.has(m.id)) return; // не больше трёх фото разом от одного человека
        this.incoming.set(m.id, { buf: new Uint8Array(m.size), got: 0, last: now });
        const name = this.room.members.get(this.id)?.name || 'Гость';
        this.room.emit('chat', { id: m.id, from: this.id, name, kind: 'img', ts: now, me: false, w: dim(m.w), h: dim(m.h), url: null, progress: 0 });
        return;
      }
      const b = new Uint8Array(e.data);
      if (b.length < 10) return;
      const id = C.b64u(b.subarray(0, 9));
      const f = this.incoming.get(id);
      if (!f) return;
      const part = b.subarray(9);
      if (f.got + part.length > f.buf.length) { this._fileFailed(id); return; }
      f.buf.set(part, f.got);
      f.got += part.length;
      if (f.got === f.buf.length) {
        this.incoming.delete(id);
        const mime = sniffImage(f.buf);
        if (!mime) { this.room.emit('chat-update', { id, from: this.id, failed: true }); return; }
        const file = new Blob([f.buf], { type: mime });
        this.room.emit('chat-update', { id, from: this.id, progress: 1, blob: file, url: URL.createObjectURL(file) });
      } else if (now - f.last > 150) {
        f.last = now;
        this.room.emit('chat-update', { id, from: this.id, progress: f.got / f.buf.length });
      }
    };
  }

  _fileFailed(id) {
    this.incoming.delete(id);
    this.room.emit('chat-update', { id, from: this.id, failed: true });
  }

  // Ступенька качества нашего видео для этого собеседника. Пауза — сообщаем ему, чтобы показал аватар, а не застывший кадр.
  _adaptVideo(bwe, loss) {
    const before = this.adapt.level;
    const after = stepAdapt(this.adapt, { bwe, loss });
    if (after === before) return;
    this.tune();
    if ((after === PAUSE) !== (before === PAUSE)) {
      this.sendDc({ t: 'vpause', on: after === PAUSE });
      this.room.emit('vpause', { id: this.id, on: after === PAUSE });
    }
  }

  // Соединение пересоздаётся или закрывается: недошедшие фото уже не дойдут.
  _dropIncoming() {
    for (const id of [...this.incoming.keys()]) this._fileFailed(id);
  }

  // Качество связи по задержке и потерям звука за последние секунды.
  async quality() {
    const pc = this.pc;
    if (!pc || pc.connectionState !== 'connected') { if (this.q) { this.q = null; this.emit(); } return; }
    const r = await pc.getStats();
    let rtt = null, lost = 0, recv = 0, bwe = null, vloss = null, frames = null;
    const camMid = pc.getTransceivers()[SLOT.cam]?.mid;
    r.forEach((s) => {
      if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') {
        if (typeof s.currentRoundTripTime === 'number') rtt = s.currentRoundTripTime;
        if (typeof s.availableOutgoingBitrate === 'number') bwe = s.availableOutgoingBitrate;
      }
      if (s.type === 'inbound-rtp' && s.kind === 'audio') { lost += s.packetsLost || 0; recv += s.packetsReceived || 0; }
      if (s.type === 'remote-inbound-rtp' && s.kind === 'video' && typeof s.fractionLost === 'number') vloss = Math.max(vloss || 0, s.fractionLost);
      if (s.type === 'inbound-rtp' && s.kind === 'video' && (s.mid === camMid || camMid == null)) frames = (frames || 0) + (s.framesDecoded || 0);
    });
    this._adaptVideo(bwe, vloss);
    // Видео собеседника застыло: камера у него включена, а новых кадров за 4 секунды нет.
    const frozen = this.remote.cam && !this.remotePaused && frames !== null && frames === this.lastFrames;
    this.lastFrames = frames ?? -1;
    if (frozen !== this.frozen) { this.frozen = frozen; this.emit(); }
    const prev = this.qPrev || { lost, recv };
    this.qPrev = { lost, recv };
    const dl = Math.max(0, lost - prev.lost), dr = Math.max(0, recv - prev.recv);
    const loss = dl + dr > 25 ? dl / (dl + dr) : 0;
    const q = (rtt !== null && rtt > 0.6) || loss > 0.12 ? 'bad' : (rtt !== null && rtt > 0.35) || loss > 0.05 ? 'weak' : 'good';
    if (q !== this.q) { this.q = q; this.emit(); }
  }

  audioLevel() {
    const t = this.pc?.getTransceivers()[SLOT.mic];
    if (!t || !this.remote.mic) return 0;
    try {
      const s = t.receiver.getSynchronizationSources?.() || [];
      return s.length ? s[0].audioLevel || 0 : 0;
    } catch { return 0; }
  }

  async stats() {
    if (!this.pc) return null;
    const r = await this.pc.getStats();
    let pair = null, local = null, remote = null;
    r.forEach((s) => { if (s.type === 'candidate-pair' && (s.nominated || s.selected) && s.state === 'succeeded') pair = s; });
    if (pair) { local = r.get(pair.localCandidateId); remote = r.get(pair.remoteCandidateId); }
    return { relay: local?.candidateType === 'relay' || remote?.candidateType === 'relay', rtt: pair?.currentRoundTripTime };
  }

  _closePc() {
    if (this.pc) {
      this.pc.onconnectionstatechange = null;
      this.pc.oniceconnectionstatechange = null;
      try { this.pc.close(); } catch {}
    }
    this.pc = null;
    this.dc = null;
    this.fdc = null;
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this._dropIncoming();
    this._closePc();
    this.tracks = [null, null, null, null];
  }
}

function setParams(sender, values, top = {}) {
  if (!sender) return;
  try {
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) return;
    let changed = false;
    for (const [k, v] of Object.entries(values)) if (p.encodings[0][k] !== v) { p.encodings[0][k] = v; changed = true; }
    for (const [k, v] of Object.entries(top)) if (p[k] !== v) { p[k] = v; changed = true; }
    if (!changed) return;
    // Старый браузер не знает общих параметров (degradationPreference): тогда без них, но с остальным.
    sender.setParameters(p).catch(() => {
      for (const k of Object.keys(top)) delete p[k];
      sender.setParameters(p).catch(() => {});
    });
  } catch {}
}

// Звук с запасом (RED): каждый пакет несёт копию прошлого. Потерялся пакет — слово не пропадает.
// Если собеседник так не умеет, договорятся на обычный Opus.
function preferRed(tr) {
  try {
    const codecs = RTCRtpReceiver.getCapabilities?.('audio')?.codecs || [];
    const red = codecs.filter((c) => c.mimeType.toLowerCase() === 'audio/red');
    if (!red.length || !tr?.setCodecPreferences) return;
    tr.setCodecPreferences([...red, ...codecs.filter((c) => c.mimeType.toLowerCase() !== 'audio/red')]);
  } catch {}
}

function gathered(pc, ms) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const t = setTimeout(resolve, ms);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
    });
  });
}

export function cleanName(name) {
  const s = String(name || '').replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').trim().slice(0, 40);
  return s || 'Гость';
}
