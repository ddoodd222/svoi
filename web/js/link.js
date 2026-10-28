// Ссылка-приглашение. Всё важное стоит после «#»: эта часть адреса не уходит на сервер,
// её видит только браузер того, кто открыл ссылку.
//
//   k — секрет комнаты, 32 случайных байта;
//   h — id хозяина: только его подпись под списком участников принимается;
//   t — по желанию: настройки TURN-ретранслятора хозяина.

import { b64u, unb64u, enc, dec } from './crypto.js';
import { PUBLIC_URL } from './config.js';

export function baseUrl() {
  // Внутри приложения для Android страница живёт по служебному адресу: гостям нужна веб-версия.
  if (location.hostname === 'appassets.androidplatform.net') return PUBLIC_URL;
  return location.origin + location.pathname;
}

export function makeLink({ secret, hostId, turn }) {
  const p = new URLSearchParams();
  p.set('k', b64u(secret));
  p.set('h', hostId);
  if (turn?.urls) p.set('t', b64u(enc(JSON.stringify({ u: turn.urls, n: turn.username || '', c: turn.credential || '' }))));
  return baseUrl() + '#' + p.toString();
}

// Принимает адрес целиком, только часть после «#» или текст сообщения со ссылкой внутри.
export function parseLink(text) {
  if (!text) return null;
  const s = String(text).trim();
  const i = s.indexOf('#');
  const frag = (i >= 0 ? s.slice(i + 1) : s).split(/\s/)[0];
  const p = new URLSearchParams(frag);
  const k = p.get('k'), h = p.get('h');
  if (!k || !h || !/^[A-Za-z0-9_-]{22}$/.test(h)) return null;
  let secret;
  try { secret = unb64u(k); } catch { return null; }
  if (secret.length !== 32) return null;
  let turn = null;
  const t = p.get('t');
  if (t) {
    try {
      const j = JSON.parse(dec(unb64u(t)));
      const urls = (Array.isArray(j.u) ? j.u : [j.u]).filter((u) => typeof u === 'string' && /^turns?:/.test(u)).slice(0, 4);
      if (urls.length) turn = { urls, username: String(j.n || ''), credential: String(j.c || '') };
    } catch {}
  }
  return { secret, hostId: h, turn };
}
