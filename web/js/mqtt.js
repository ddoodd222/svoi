// Минимальный клиент MQTT 3.1.1 поверх WebSocket: подключиться, подписаться, публиковать (QoS 0).
// Своя реализация вместо библиотеки: меньше чужого кода — меньше мест, где можно спрятать закладку.
// Посредник получает только зашифрованные байты, поэтому доверять ему не нужно.

import { enc, hex, randomBytes } from './crypto.js';

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

export class MqttLink {
  constructor(url, topic, { onMessage, onState } = {}) {
    this.url = url;
    this.topic = topic;
    this.onMessage = onMessage || (() => {});
    this.onState = onState || (() => {});
    this.ws = null;
    this.ready = false;
    this.stopped = true;
    this.backoff = 1000;
    this.buf = new Uint8Array(0);
    this.lastSeen = 0;
    this.timers = [];
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this._teardown(true);
  }

  publish(bytes) {
    if (!this.ready) return false;
    const body = new Uint8Array([...str(this.topic), ...bytes]);
    this._send(packet(0x30, body));
    return true;
  }

  _send(bytes) {
    try { this.ws.send(bytes); } catch { /* закроется и переподключится */ }
  }

  _setReady(v) {
    if (this.ready !== v) { this.ready = v; this.onState(v); }
  }

  _connect() {
    if (this.stopped) return;
    let ws;
    try {
      ws = new WebSocket(this.url, ['mqtt']);
    } catch {
      this._retry();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.buf = new Uint8Array(0);
    ws.onopen = () => {
      const clientId = 'svoi' + hex(randomBytes(8));
      // Протокол MQTT, уровень 4, флаг «чистая сессия», keepalive 30 с.
      const body = new Uint8Array([...str('MQTT'), 4, 0x02, 0, 30, ...str(clientId)]);
      this._send(packet(0x10, body));
    };
    ws.onmessage = (e) => this._onData(new Uint8Array(e.data));
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this._teardown(false);
      this._retry();
    };
    this.lastSeen = Date.now();
    // Пинг каждые 10 с. Если 25 с не пришло ни байта, соединение «замёрзло» (так бывает у провайдеров):
    // рвём его и подключаемся заново, а не ждём вечно.
    this.timers.push(setInterval(() => {
      if (!this.ws) return;
      if (Date.now() - this.lastSeen > 25000) {
        // Не ждём, пока замёрзшее соединение закроется само: бросаем его и открываем новое.
        this.stalls = (this.stalls || 0) + 1;
        this._teardown(false);
        this._retry();
        return;
      }
      if (this.ready) this._send(new Uint8Array([0xc0, 0]));
    }, 10000));
  }

  _teardown(final) {
    this.timers.forEach(clearInterval);
    this.timers = [];
    this._setReady(false);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      if (final && ws.readyState === 1) { try { ws.send(new Uint8Array([0xe0, 0])); } catch {} }
      try { ws.close(); } catch {}
    }
  }

  _retry() {
    if (this.stopped) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 15000);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this._connect(), delay);
  }

  // Вкладка вернулась из фона: не ждать паузы между попытками, подключиться сразу.
  wake() {
    if (this.stopped || this.ws) return;
    clearTimeout(this.retryTimer);
    this.backoff = 1000;
    this._connect();
  }

  _onData(chunk) {
    this.lastSeen = Date.now();
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    let buf = merged;
    for (;;) {
      if (buf.length < 2) break;
      let len = 0, mul = 1, i = 1, b;
      do {
        if (i >= buf.length) { len = -1; break; }
        b = buf[i++];
        len += (b & 0x7f) * mul;
        mul *= 128;
        if (i > 5) { try { this.ws.close(); } catch {} return; }
      } while (b & 0x80);
      if (len < 0 || buf.length < i + len) break;
      this._onPacket(buf[0], buf.subarray(i, i + len));
      buf = buf.subarray(i + len);
    }
    this.buf = buf.slice();
    if (this.buf.length > 1 << 20) { try { this.ws.close(); } catch {} }
  }

  _onPacket(head, body) {
    const type = head >> 4;
    if (type === 2) { // CONNACK
      if (body[1] !== 0) { try { this.ws.close(); } catch {} return; }
      const sub = new Uint8Array([0, 1, ...str(this.topic), 0]);
      this._send(packet(0x82, sub));
    } else if (type === 9) { // SUBACK
      if (body[2] === 0x80) { try { this.ws.close(); } catch {} return; }
      this.backoff = 1000;
      this._setReady(true);
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
