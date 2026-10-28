// Комната: хозяин, допуск гостей и прямые соединения между всеми участниками.
//
// Хозяин — единственный, кто решает, кого впустить. Его id зашит в ссылку,
// поэтому список участников принимается только с его подписью.
// Видео и звук идут напрямую между устройствами (WebRTC, DTLS-SRTP).
// Отпечатки ключей DTLS передаются в подписанных личных конвертах,
// поэтому подменить собеседника посередине нельзя.

import * as C from './crypto.js';
import { SecureChannel } from './signal.js';

export const MAX_MEMBERS = 8;
const HELLO_EVERY = 4000;
const KNOCK_EVERY = 4000;
const ALIVE_TIMEOUT = 45000;
const HOST_TIMEOUT = 20000;
const RECENT_FOR = 3 * 60000;
// Несколько независимых STUN: из части сетей (например, в России) сервер Google не отвечает.
// Российских серверов в списке нет намеренно: STUN-сервер видит настоящий адрес устройства.
export const STUN = ['stun:stun.cloudflare.com:3478', 'stun:global.stun.twilio.com:3478', 'stun:stun.l.google.com:19302'];
const GATHER_WAIT = 2000; // сколько ждём адреса до отправки; поздние досылаются отдельно

// Порядок дорожек одинаковый у всех: микрофон, камера, экран, звук экрана.
export const SLOTS = ['audio', 'video', 'video', 'audio'];
export const SLOT = { mic: 0, cam: 1, screen: 2, screenAudio: 3 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
    });
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
        for (const id of this.saved.denied || []) if (isTag(id)) this.denied.add(id);
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
      });
    }
    this._every(250, () => this._levels());
    this._every(8000, () => { for (const c of this.conns.values()) c.sendDc({ t: 'ping' }); });
  }

  _every(ms, fn) {
    this.timers.push(setInterval(() => { try { const r = fn(); if (r?.catch) r.catch(() => {}); } catch {} }, ms));
  }

  _hello() {
    return this.channel.send('hello', { locked: this.locked, hs: this.session });
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
      if (type === 'knock') return this._onKnock(peer, body);
      if (type === 'leave') {
        if (this.members.has(from)) this._removeMember(from, { remember: false });
        return;
      }
    } else if (from === this.hostId) {
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
      // Хозяин открыл комнату заново: нужен новый код проверки.
      this.hostSession = body.hs;
      if (this.phase !== 'joined') { this.myCode = null; this.emit('code'); }
    }
    if (!this.hostOnline) { this.hostOnline = true; this.emit('host', { online: true }); }
    if (this.phase === 'waiting-host') { this.setPhase('knocking'); this._knock(); }
    if (body.locked && this.phase === 'knocking') this.setPhase('locked');
    const canRetry = (this.phase === 'locked' && !body.locked) || (this.phase === 'full' && Date.now() > (this.retryAt || 0));
    if (canRetry) { this.setPhase('knocking'); this._knock(); }
  }

  async _onChallenge(body) {
    if (!isTag(body.r) || this.phase === 'joined') return;
    if (this.challenge === body.r && this.myCode) return;
    this.challenge = body.r;
    this.myCode = await C.safetyCode(this.secret, this.me.id, body.r);
    this.emit('code');
  }

  async _knock() {
    if (this.isHost || !this.hostPeer || !['knocking', 'joined'].includes(this.phase)) return;
    await this.channel.send('knock', { name: this.myName, joined: this.phase === 'joined' }, this.hostPeer);
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
    await this.channel.send('challenge', { r: k.r, hs: this.session }, peer);
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
    if (!k || !this.isHost) return;
    this.knocks.delete(id);
    if (this.members.size >= MAX_MEMBERS) { await this._deny(k.peer, 'full'); this.emit('knocks', {}); return; }
    this.members.set(id, { id, name: k.name, pk: k.pk, r: k.r });
    this.alive.set(id, Date.now());
    this.ver = Math.max(this.ver + 1, Date.now());
    this.emit('knocks', {});
    this._changedMembers();
  }

  async deny(id) {
    const k = this.knocks.get(id);
    if (!k || !this.isHost) return;
    this.knocks.delete(id);
    this.denied.add(id);
    this._persist();
    await this._deny(k.peer, 'denied');
    this.emit('knocks', {});
  }

  async kick(id) {
    if (!this.isHost || id === this.me.id || !this.members.has(id)) return;
    const m = this.members.get(id);
    this.denied.add(id);
    this._removeMember(id, { remember: false });
    try { await this._deny(await this.channel.learn(m.pk), 'kicked'); } catch {}
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
    await this.channel.send('roster', this._rosterBody(), await this.channel.learn(m.pk));
  }

  async _pushRoster() {
    if (!this.isHost) return;
    for (const id of this.members.keys()) if (id !== this.me.id) this._sendRoster(id).catch(() => {});
  }

  _persist({ ended = false } = {}) {
    if (!this.isHost) return;
    // Закрытый вход и список участников живут до конца встречи. Следующая начинается с открытой пустой комнаты.
    const members = ended ? [] : this._rosterBody().members;
    this.emit('persist', { ver: this.ver, locked: ended ? false : this.locked, members, denied: [...this.denied].slice(-200) });
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
    if (!next.has(this.hostId)) return;
    this.ver = body.ver;
    this.title = String(body.title || '').slice(0, 80);
    this.locked = !!body.locked;
    const wasJoined = this.phase === 'joined';
    if (!next.has(this.me.id)) {
      if (wasJoined) { this._leaveCall(); this.setPhase('denied', { reason: 'kicked' }); }
      return;
    }
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

  async _askRestart() {
    if (this.closed || this.state === 'connected') return;
    try { await this.room.channel.send('restart', {}, await this._peer()); } catch {}
    this._scheduleRetry(20000, true);
  }

  nudge() {
    if (this.closed) return;
    if (this.initiator) { if (Date.now() - (this.lastOfferAt || 0) > 5000) this.makeOffer(); }
    else this._askRestart();
  }

  onRestartRequest() {
    if (!this.initiator || this.closed) return;
    if (this.state === 'connected' && this.pc?.connectionState === 'connected') return;
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

  // Битрейт под число собеседников: в сетке каждый отправляет видео каждому.
  tune() {
    const pc = this.pc;
    if (!pc || pc.connectionState !== 'connected') return;
    const others = Math.max(1, this.room.members.size - 1);
    const cam = others <= 1 ? 1500000 : others <= 3 ? 800000 : 450000;
    const camScale = others <= 3 ? 1 : 1.5;
    const trs = pc.getTransceivers();
    setParams(trs[SLOT.cam]?.sender, { maxBitrate: cam, scaleResolutionDownBy: camScale });
    setParams(trs[SLOT.screen]?.sender, { maxBitrate: others <= 2 ? 2500000 : 1200000, maxFramerate: 15 });
    setParams(trs[SLOT.mic]?.sender, { maxBitrate: 64000 });
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
      } else if (msg.t === 'ping') {
        // просто признак жизни
      }
    };
  }

  sendDc(obj) {
    if (this.dc?.readyState === 'open') { try { this.dc.send(JSON.stringify(obj)); } catch {} }
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
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this._closePc();
    this.tracks = [null, null, null, null];
  }
}

function setParams(sender, values) {
  if (!sender) return;
  try {
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) return;
    let changed = false;
    for (const [k, v] of Object.entries(values)) if (p.encodings[0][k] !== v) { p.encodings[0][k] = v; changed = true; }
    if (changed) sender.setParameters(p).catch(() => {});
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
