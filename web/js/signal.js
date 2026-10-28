// Защищённый служебный канал комнаты.
//
// Каждое сообщение:
//  1. подписано ключом отправителя (ECDSA) — чужое сообщение от его имени не пройдёт;
//  2. если адресовано одному человеку — целиком, вместе с именем отправителя и типом,
//     запечатано в личный конверт с одноразовым ключом. Снаружи не видно, кто кому пишет;
//  3. зашифровано ключом комнаты (AES-256-GCM) — посредник видит только шум;
//  4. несёт метку времени и случайный номер — повтор старого сообщения отбрасывается.
//
// Сообщения дублируются через несколько независимых посредников: если один недоступен, работает другой.

import { MqttLink } from './mqtt.js';
import * as C from './crypto.js';

export const BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];

const MAX_SKEW = 10 * 60 * 1000;
const MAX_MSG = 256 * 1024;
const KIND_ALL = 0x62; // всем в комнате
const KIND_ONE = 0x64; // одному, в личном конверте
// Свои же сообщения обычно пропускаем. Кроме двух: так второе устройство хозяина (вошедшее по коду хозяина)
// замечает первое и получает сохранённые настройки комнаты.
const SELF_OK = new Set(['hello', 'state']);
// Сохранённые настройки комнаты лежат у посредника долго, поэтому их не отсекаем по времени.
const NO_SKEW = new Set(['state']);

export class SecureChannel {
  constructor(room, identity, { onMessage, onState } = {}) {
    this.room = room;
    this.me = identity;
    this.onMessage = onMessage || (() => {});
    this.onState = onState || (() => {});
    this.known = new Map(); // "sigPk.dhPk" -> peer
    this.seenIv = new Map();
    this.seenNonce = new Map();
    this.online = false;
    this.links = BROKERS.map((url) => new MqttLink(url, room.topic, {
      onMessage: (b) => this._onRaw(b).catch(() => {}),
      onState: () => this._state(),
    }));
  }

  start() {
    this.links.forEach((l) => l.start());
    this.pruneTimer = setInterval(() => this._prune(), 30000);
  }

  stop() {
    clearInterval(this.pruneTimer);
    this.links.forEach((l) => l.stop());
    this._state();
  }

  wake() { this.links.forEach((l) => l.wake()); }

  // Для диагностики: какие посредники сейчас на связи.
  status() { return this.links.map((l) => ({ name: l.url.split('/')[2].split(':')[0], ready: l.ready })); }

  _state() {
    const on = this.links.some((l) => l.ready);
    if (on !== this.online) { this.online = on; this.onState(on); }
  }

  _prune() {
    const now = Date.now();
    for (const m of [this.seenIv, this.seenNonce]) for (const [k, t] of m) if (t < now) m.delete(k);
  }

  // Открытые ключи участника по его pk. Кэш ограничен, чтобы мусорные сообщения не съели память.
  async learn(pk) {
    const key = pk[0] + '.' + pk[1];
    let peer = this.known.get(key);
    if (!peer) {
      peer = await C.importPeer(pk);
      if (this.known.size > 300) this.known.clear();
      this.known.set(key, peer);
    }
    return peer;
  }

  // to: '*' — всем в канале, или объект peer — лично ему.
  async send(type, body = {}, to = '*', { retain = false } = {}) {
    const msg = {
      v: 2, type, from: this.me.id, pk: this.me.pk,
      to: to === '*' ? '*' : to.id,
      ts: Date.now(), n: C.b64u(C.randomBytes(12)), body,
    };
    const m = JSON.stringify(msg);
    const s = C.b64u(await C.sign(this.me, C.enc(m)));
    const signed = C.enc(JSON.stringify({ m, s }));
    const framed = to === '*'
      ? C.concat(new Uint8Array([KIND_ALL]), signed)
      : C.concat(new Uint8Array([KIND_ONE]), await C.boxSeal(to, this.room.secret, signed));
    const sealed = await C.seal(this.room.aes, framed, this.room.aad);
    let sent = false;
    for (const l of this.links) sent = l.publish(sealed, { retain }) || sent;
    return sent;
  }

  async _onRaw(bytes) {
    if (bytes.length > MAX_MSG || bytes.length < 40) return;
    const ivKey = C.b64u(bytes.subarray(0, 12));
    if (this.seenIv.has(ivKey)) return; // та же посылка через второго посредника
    const framed = await C.open(this.room.aes, bytes, this.room.aad);
    // Отмечаем только настоящие посылки: мусор с чужим вектором не заглушит копию от второго посредника.
    this.seenIv.set(ivKey, Date.now() + 2 * MAX_SKEW);

    let signed;
    if (framed[0] === KIND_ALL) signed = framed.subarray(1);
    else if (framed[0] === KIND_ONE) signed = await C.boxOpen(this.me, this.room.secret, framed.subarray(1)); // не нам — бросит ошибку
    else return;

    const outer = JSON.parse(C.dec(signed));
    if (typeof outer?.m !== 'string' || typeof outer?.s !== 'string') return;
    const msg = JSON.parse(outer.m);
    if (msg?.v !== 2 || typeof msg.type !== 'string' || typeof msg.from !== 'string' ||
        typeof msg.to !== 'string' || typeof msg.ts !== 'number' || typeof msg.n !== 'string') return;
    if (msg.from === this.me.id && !SELF_OK.has(msg.type)) return;
    // Адрес внутри подписи должен совпадать с конвертом: подписанное письмо нельзя переложить другому.
    if (framed[0] === KIND_ALL ? msg.to !== '*' : msg.to !== this.me.id) return;
    if (!NO_SKEW.has(msg.type) && Math.abs(Date.now() - msg.ts) > MAX_SKEW) return;
    if (this.seenNonce.has(msg.n)) return;

    const peer = await this.learn(msg.pk);
    if (peer.id !== msg.from) return;
    if (!(await C.verify(peer, C.enc(outer.m), C.unb64u(outer.s)))) return;
    this.seenNonce.set(msg.n, Date.now() + 2 * MAX_SKEW);

    const body = msg.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return;
    this.onMessage({ type: msg.type, from: msg.from, to: msg.to, ts: msg.ts, body, peer });
  }
}

// Стереть сохранённые настройки комнаты у посредников (когда хозяин удаляет комнату).
export async function clearRetained(topic) {
  await Promise.all(BROKERS.map((url) => new Promise((resolve) => {
    const link = new MqttLink(url, topic, {
      onState: (on) => { if (on) { link.publish(new Uint8Array(0), { retain: true }); setTimeout(() => { link.stop(); resolve(); }, 400); } },
    });
    link.start();
    setTimeout(() => { link.stop(); resolve(); }, 6000);
  })));
}
