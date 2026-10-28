// «Проверка связи»: что работает из текущей сети, а что нет.
// Ничего не отправляет в комнаты: для проверки берётся случайный пустой канал.

import { MqttLink } from './mqtt.js';
import { BROKERS } from './signal.js';
import { STUN } from './room.js';
import { randomBytes, hex } from './crypto.js';

const SIZES = [500, 4000, 12000, 24000, 48000];

// Посредник: подключиться и проверить, что доходят посылки нарастающего размера.
// Российские провайдеры иногда «замораживают» соединение с зарубежным сервером после 15–20 КБ.
export async function checkBroker(url, onStep) {
  const name = url.split('/')[2].split(':')[0];
  const topic = 'svoi/check/' + hex(randomBytes(8));
  const res = { name, connectMs: null, sizes: [], ok: false };
  const waiters = new Map();
  const t0 = performance.now();
  const link = new MqttLink(url, topic, {
    onMessage: (b) => { const key = hex(b.subarray(0, 8)); waiters.get(key)?.(); },
    onState: () => {},
    rotate: false, // проверяем сеть как есть, без обхода
  });
  link.start();
  const ready = await until(() => link.ready, 8000);
  if (!ready) { link.stop(); onStep?.(res); return res; }
  res.connectMs = Math.round(performance.now() - t0);
  onStep?.(res);
  for (const size of SIZES) {
    const body = randomBytes(size);
    const key = hex(body.subarray(0, 8));
    const s0 = performance.now();
    const got = new Promise((resolve) => { waiters.set(key, () => resolve(true)); setTimeout(() => resolve(false), 7000); });
    link.publish(body);
    const ok = await got;
    res.sizes.push({ size, ok, ms: ok ? Math.round(performance.now() - s0) : null });
    onStep?.(res);
    if (!ok) break;
  }
  res.ok = res.sizes.length === SIZES.length && res.sizes.every((s) => s.ok);
  link.stop();
  return res;
}

// STUN: узнаёт ли устройство свой адрес в интернете через этот сервер.
export async function checkStun(urls, extra = {}) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls, ...extra }], iceTransportPolicy: extra.username ? 'relay' : 'all' });
  pc.createDataChannel('check');
  const types = new Set();
  const addrs = new Set();
  let firstPublic = null;
  const t0 = performance.now();
  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    const type = e.candidate.type || (/ typ (\w+)/.exec(e.candidate.candidate) || [])[1];
    if (type) types.add(type);
    if (type === 'srflx') { const m = / ([0-9a-f.:]+) \d+ typ srflx/i.exec(e.candidate.candidate); if (m) addrs.add(m[1]); }
    if ((type === 'srflx' || type === 'relay') && firstPublic === null) firstPublic = Math.round(performance.now() - t0);
  };
  await pc.setLocalDescription(await pc.createOffer());
  await until(() => pc.iceGatheringState === 'complete' || firstPublic !== null, 6000);
  pc.close();
  return { urls, types: [...types], publicMs: firstPublic, addrs: [...addrs] };
}

function until(fn, ms) {
  return new Promise((resolve) => {
    if (fn()) return resolve(true);
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (fn()) { clearInterval(iv); resolve(true); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); resolve(false); }
    }, 50);
  });
}

export { BROKERS, STUN, SIZES };
