// Минимальный клиент MQTT 3.1.1 поверх WebSocket: подключиться, подписаться, публиковать (QoS 0).
// Своя реализация вместо библиотеки: меньше чужого кода — меньше мест, где можно спрятать закладку.
// Посредник получает только зашифрованные байты, поэтому доверять ему не нужно.
//
// Частая смена соединения. Российские провайдеры без VPN пропускают по соединению с зарубежным
// сервером около 12 пакетов, потом соединение молча застывает (замерено в октябре 2026).
// Поэтому после нескольких пакетов клиент заранее открывает новое соединение и переходит на него,
// а старое закрывает. Если сеть не режет (VPN, другая страна), смена отключается сама.

import { enc, hex, randomBytes } from './crypto.js';

const SEG = 1400;        // примерно столько байт помещается в один пакет
const ROTATE_AT = 6;     // после стольких пакетов готовим новое соединение
const PROBE_AT = 18;     // старое соединение проверяем пингом после стольких пакетов: живо — сеть не режет
const PING = new Uint8Array([0xc0, 0]);

function varLen(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
}

function str(s) {
  const b = enc(s);
  return [b.length >> 8, b.length & 0xff, ...b];
}

function packet(type, body) {
  const head = [type, ...varLen(body.length)];
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

const segs = (n) => Math.max(1, Math.ceil(n / SEG));

export class MqttLink {
  // rotate: false — без смены соединения (для проверки связи: там нужно увидеть ограничение как есть).
  constructor(url, topic, { onMessage, onState, rotate = true } = {}) {
    this.url = url;
    this.topic = topic;
    this.onMessage = onMessage || (() => {});
    this.onState = onState || (() => {});
    this.rotate = rotate;
    this.tight = rotate;  // режим частой смены соединения
    this.probed = false;  // проверка «режет ли сеть» уже сделана
    this.cur = null;      // рабочее соединение
    this.next = null;     // новое, пока подключается
    this.probe = null;    // старое, оставленное для проверки сети
    this.ready = false;
    this.stopped = true;
    this.backoff = 1000;
    this.stalls = 0;
    this.rotations = 0;
  }

  start() {
    this.stopped = false;
    clearInterval(this.tick);
    // Один редкий таймер: в свёрнутом браузере частые таймеры всё равно замедляются.
    this.tick = setInterval(() => this._tick(), 2000);
    this._open(false);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.tick);
    for (const s of [this.next, this.probe]) this._drop(s);
    this.next = this.probe = null;
    const s = this.cur;
    this.cur = null;
    if (s?.ws.readyState === 1) { try { s.ws.send(new Uint8Array([0xe0, 0])); } catch {} }
    this._drop(s);
    this._setReady(false);
  }

  // retain: посредник хранит последнее такое сообщение и отдаёт его каждому, кто подпишется позже.
  publish(bytes, { retain = false } = {}) {
    if (!this.ready || !this.cur) return false;
    const body = new Uint8Array([...str(this.topic), ...bytes]);
    this._send(this.cur, packet(retain ? 0x31 : 0x30, body));
    return true;
  }

  // Вкладка вернулась из фона: не ждать паузы между попытками, подключиться сразу.
  wake() {
    if (this.stopped || this.cur) return;
    clearTimeout(this.retryTimer);
    this.backoff = 1000;
    this._open(false);
  }

  _setReady(v) {
    if (this.ready !== v) { this.ready = v; this.onState(v); }
  }

  _open(asNext) {
    if (this.stopped) return;
    let ws;
    try {
      ws = new WebSocket(this.url, ['mqtt']);
    } catch {
      if (!asNext) this._retry();
      return;
    }
    ws.binaryType = 'arraybuffer';
    const s = { ws, buf: new Uint8Array(0), segs: 0, subscribed: false, born: Date.now(), lastSeen: Date.now(), pingAt: 0 };
    if (asNext) this.next = s; else this.cur = s;
    ws.onopen = () => {
      const clientId = 'svoi' + hex(randomBytes(8));
      // Протокол MQTT, уровень 4, флаг «чистая сессия», keepalive 120 с.
      // В свёрнутом браузере таймеры срабатывают раз в минуту: короткий keepalive обрывал бы связь.
      const body = new Uint8Array([...str('MQTT'), 4, 0x02, 0, 120, ...str(clientId)]);
      this._raw(s, packet(0x10, body));
    };
    ws.onmessage = (e) => this._onData(s, new Uint8Array(e.data));
    ws.onerror = () => {};
    ws.onclose = () => this._closed(s);
  }

  _raw(s, bytes) {
    try { s.ws.send(bytes); } catch { /* закроется и переподключится */ }
  }

  // Отправка с учётом пакетов: на рабочем соединении заранее готовим замену.
  _send(s, bytes) {
    this._raw(s, bytes);
    this._count(s, bytes.length);
  }

  _count(s, n) {
    if (!s.subscribed) return;
    s.segs += segs(n);
    if (s === this.cur && this.tight && !this.next && s.segs >= ROTATE_AT) {
      this.rotations++;
      this._open(true);
    }
    if (s === this.probe && s.segs >= PROBE_AT && !s.pingAt) { s.pingAt = Date.now(); this._raw(s, PING); }
  }

  _drop(s) {
    if (!s) return;
    s.ws.onclose = null;
    s.ws.onmessage = null;
    try { s.ws.close(); } catch {}
  }

  _closed(s) {
    if (s === this.next) { this.next = null; return; }
    if (s === this.probe) { this._probeDone(false); return; }
    if (s !== this.cur) return;
    this.cur = null;
    if (this.next?.subscribed) { this._promote(); return; }
    this._drop(this.next);
    this.next = null;
    this._setReady(false);
    this._retry();
  }

  // Новое соединение готово: работаем через него, старое закрываем или оставляем проверить сеть.
  _promote() {
    const old = this.cur;
    this.cur = this.next;
    this.next = null;
    this.backoff = 1000;
    if (old && !this.probed && !this.probe) { this.probe = old; old.probeSince = Date.now(); }
    else this._drop(old);
    this._setReady(true);
  }

  // Старое соединение пережило порог и ответило на пинг: сеть не режет, часто менять соединение незачем.
  _probeDone(alive) {
    const p = this.probe;
    this.probe = null;
    this._drop(p);
    if (!p) return;
    if (alive && p.segs >= PROBE_AT) { this.tight = false; this.probed = true; }
    else if (!alive && p.pingAt) this.probed = true; // застыло: сеть режет, остаёмся в частой смене
    // Ответило, но трафика было мало — вывода нет, проверим при следующей смене.
  }

  _tick() {
    if (this.stopped) return;
    const now = Date.now();
    const s = this.cur;
    if (s) {
      // Пинг без ответа 15 с или подключение без ответа 15 с: соединение застыло, бросаем его.
      // Считаем от пинга, а не от тишины: в фоне таймеры редкие, и тишина ещё не значит обрыв.
      const unanswered = s.pingAt > s.lastSeen && now - s.pingAt > 15000;
      const silentConnect = !s.subscribed && now - s.born > 15000;
      if (unanswered || silentConnect) {
        this.stalls++;
        // Застыло рабочее соединение — значит, сеть режет: снова включаем частую смену и проверку.
        if (this.rotate && s.subscribed) { this.tight = true; this.probed = false; }
        this._drop(s);
        this._closed(s);
        return;
      }
      if (s.subscribed && s.pingAt <= s.lastSeen && now - Math.max(s.pingAt, s.born) > 10000) {
        s.pingAt = now;
        this._send(s, PING);
      }
    }
    const n = this.next;
    if (n && !n.subscribed && now - n.born > 15000) { this.next = null; this._drop(n); }
    const p = this.probe;
    if (p) {
      if (p.pingAt && p.lastSeen > p.pingAt) this._probeDone(true);
      else if (p.pingAt && now - p.pingAt > 6000) this._probeDone(false);
      // Через 20 с проверяем пингом в любом случае: застывшее соединение не ответит.
      else if (!p.pingAt && now - p.probeSince > 20000) { p.pingAt = now; this._raw(p, PING); }
    }
  }

  _retry() {
    if (this.stopped) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 15000);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this._open(false), delay);
  }

  _onData(s, chunk) {
    s.lastSeen = Date.now();
    this._count(s, chunk.length);
    const merged = new Uint8Array(s.buf.length + chunk.length);
    merged.set(s.buf, 0);
    merged.set(chunk, s.buf.length);
    let buf = merged;
    for (;;) {
      if (buf.length < 2) break;
      let len = 0, mul = 1, i = 1, b;
      do {
        if (i >= buf.length) { len = -1; break; }
        b = buf[i++];
        len += (b & 0x7f) * mul;
        mul *= 128;
        if (i > 5) { try { s.ws.close(); } catch {} return; }
      } while (b & 0x80);
      if (len < 0 || buf.length < i + len) break;
      this._onPacket(s, buf[0], buf.subarray(i, i + len));
      buf = buf.subarray(i + len);
    }
    s.buf = buf.slice();
    if (s.buf.length > 1 << 20) { try { s.ws.close(); } catch {} }
  }

  _onPacket(s, head, body) {
    const type = head >> 4;
    if (type === 2) { // CONNACK
      if (body[1] !== 0) { try { s.ws.close(); } catch {} return; }
      const sub = new Uint8Array([0, 1, ...str(this.topic), 0]);
      this._raw(s, packet(0x82, sub));
    } else if (type === 9) { // SUBACK
      if (body[2] === 0x80) { try { s.ws.close(); } catch {} return; }
      s.subscribed = true;
      if (s === this.next) this._promote();
      else if (s === this.cur) { this.backoff = 1000; this._setReady(true); }
    } else if (type === 3) { // PUBLISH
      const qos = (head >> 1) & 3;
      const tlen = (body[0] << 8) | body[1];
      let o = 2 + tlen;
      if (qos > 0) o += 2;
      if (o <= body.length) this.onMessage(body.slice(o));
    }
    // PINGRESP (13) и прочее — только отметка «жив», она уже сделана в _onData.
  }
}
