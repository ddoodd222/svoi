// Вся криптография приложения. Только WebCrypto браузера, без сторонних библиотек.
//
// Что здесь есть:
//  - секрет комнаты (32 случайных байта) живёт только в ссылке после «#»;
//  - из секрета выводятся адрес канала и ключ AES-256-GCM для всех служебных сообщений;
//  - у каждого участника пара ключей ECDSA P-256 (подпись) и ECDH P-256 (личные конверты);
//  - id участника — хэш его открытых ключей, подделать его без закрытого ключа нельзя.

const te = new TextEncoder();
const td = new TextDecoder();
export const enc = (s) => te.encode(s);
export const dec = (b) => td.decode(b);

const SALT = enc('svoi/v1');
const subtle = globalThis.crypto.subtle;

export function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function b64u(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) throw new Error('bad base64url');
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export async function sha256(bytes) {
  return new Uint8Array(await subtle.digest('SHA-256', bytes));
}

async function hkdf(ikm, info, length = 32) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info: enc(info) }, key, length * 8);
  return new Uint8Array(bits);
}

// ---------- Комната ----------

export function newRoomSecret() {
  return randomBytes(32);
}

// Канал и общий ключ комнаты. Посредник видит только адрес канала — хэш, из которого секрет не восстановить.
export async function roomKeys(secret) {
  if (!(secret instanceof Uint8Array) || secret.length !== 32) throw new Error('bad room secret');
  const topic = 'svoi/v1/' + hex(await hkdf(secret, 'topic', 16));
  const aes = await subtle.importKey('raw', await hkdf(secret, 'signal-aes', 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { secret, topic, aes, aad: enc(topic) };
}

export async function seal(key, plaintext, aad) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, plaintext));
  return concat(iv, ct);
}

export async function open(key, data, aad) {
  if (data.length < 12 + 16) throw new Error('short');
  const iv = data.subarray(0, 12);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, data.subarray(12)));
}

// ---------- Личность участника ----------

const SIG = { name: 'ECDSA', namedCurve: 'P-256' };
const DH = { name: 'ECDH', namedCurve: 'P-256' };

// Закрытые ключи создаются неизвлекаемыми: их нельзя прочитать даже кодом этой страницы.
export async function createKeys() {
  const sig = await subtle.generateKey(SIG, false, ['sign', 'verify']);
  const dh = await subtle.generateKey(DH, false, ['deriveBits']);
  return { sig, dh };
}

export async function idFromPub(sigPub, dhPub) {
  return b64u(await sha256(concat(enc('id'), sigPub, dhPub))).slice(0, 22);
}

// keys — объект из createKeys() или из хранилища (CryptoKey переживают IndexedDB).
export async function loadIdentity(keys) {
  const sigPub = new Uint8Array(await subtle.exportKey('raw', keys.sig.publicKey));
  const dhPub = new Uint8Array(await subtle.exportKey('raw', keys.dh.publicKey));
  const id = await idFromPub(sigPub, dhPub);
  return { id, keys, sigPub, dhPub, pk: [b64u(sigPub), b64u(dhPub)] };
}

export async function sign(identity, bytes) {
  return new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.keys.sig.privateKey, bytes));
}

// Чужие открытые ключи: проверка, что точка лежит на кривой, встроена в importKey.
export async function importPeer(pk) {
  if (!Array.isArray(pk) || pk.length !== 2) throw new Error('bad pk');
  const sigPub = unb64u(pk[0]);
  const dhPub = unb64u(pk[1]);
  if (sigPub.length !== 65 || dhPub.length !== 65) throw new Error('bad pk length');
  const sigKey = await subtle.importKey('raw', sigPub, SIG, false, ['verify']);
  const dhKey = await subtle.importKey('raw', dhPub, DH, false, []);
  return { id: await idFromPub(sigPub, dhPub), sigKey, dhKey, pk };
}

export async function verify(peer, bytes, signature) {
  if (signature.length !== 64) return false;
  return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, peer.sigKey, signature, bytes);
}

// Личный конверт для одного получателя. Для каждого письма — новый одноразовый ключ ECDH,
// поэтому снаружи не видно ни отправителя, ни получателя: только шум.
// Ключ привязан к секрету комнаты и к id получателя.
async function boxKey(priv, pub, roomSecret, ephPub, recipientId) {
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256));
  const raw = await hkdf(concat(shared, roomSecret, ephPub), 'box|' + recipientId, 32);
  return subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function boxSeal(peer, roomSecret, plaintext) {
  const eph = await subtle.generateKey(DH, false, ['deriveBits']);
  const ephPub = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
  const key = await boxKey(eph.privateKey, peer.dhKey, roomSecret, ephPub, peer.id);
  return concat(ephPub, await seal(key, plaintext, ephPub));
}

// Бросает ошибку, если конверт не нам.
export async function boxOpen(identity, roomSecret, data) {
  if (data.length < 65 + 12 + 16) throw new Error('short');
  const ephPub = data.subarray(0, 65);
  const pub = await subtle.importKey('raw', ephPub, DH, false, []);
  const key = await boxKey(identity.keys.dh.privateKey, pub, roomSecret, ephPub, identity.id);
  return open(key, data.subarray(65), ephPub);
}

// Код проверки: девять цифр. Хозяин сверяет его голосом с гостем перед тем, как впустить.
// r — случайная добавка, которую хозяин присылает гостю уже после стука.
// Ключи гостя к этому моменту известны, поэтому подобрать ключ под чужой код заранее нельзя.
export async function safetyCode(roomSecret, id, r = '') {
  const h = await sha256(concat(enc('code|'), roomSecret, enc('|' + id + '|' + r)));
  let n = 0n;
  for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(h[i]);
  const s = (n % 1000000000n).toString().padStart(9, '0');
  return `${s.slice(0, 3)} ${s.slice(3, 6)} ${s.slice(6)}`;
}

// ---------- Код хозяина ----------
// Ключи хозяина можно вывести из секрета комнаты и кода хозяина. Тогда тот, кто знает код,
// станет хозяином на любом устройстве: id хозяина в ссылке совпадёт.
// Код подбирается без участия приложения, поэтому вывод нарочно медленный (PBKDF2, 600 000 шагов)
// и код не короче 8 знаков.

const P = 2n ** 256n - 2n ** 224n + 2n ** 192n + 2n ** 96n - 1n;
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const G = [0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n, 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n];
const md = (a) => ((a % P) + P) % P;
function modPow(b, e) {
  let r = 1n;
  b = md(b);
  while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; }
  return r;
}
const inv = (a) => modPow(a, P - 2n);
function ecAdd(A, B) {
  if (!A) return B;
  if (!B) return A;
  const [x1, y1] = A, [x2, y2] = B;
  let l;
  if (x1 === x2) {
    if (md(y1 + y2) === 0n) return null;
    l = (md(3n * x1 * x1 - 3n) * inv(2n * y1)) % P;
  } else {
    l = (md(y2 - y1) * inv(md(x2 - x1))) % P;
  }
  const x3 = md(l * l - x1 - x2);
  return [x3, md(l * (x1 - x3) - y1)];
}
function ecMul(k) {
  let R = null, Q = G;
  while (k > 0n) { if (k & 1n) R = ecAdd(R, Q); Q = ecAdd(Q, Q); k >>= 1n; }
  return R;
}
const toBig = (b) => BigInt('0x' + hex(b));
const to32 = (n) => { const h = n.toString(16).padStart(64, '0'); return Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16)); };

export function normalizeCode(code) {
  return String(code || '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

async function pairFromScalar(d, alg, privUsages, pubUsages) {
  const [x, y] = ecMul(d);
  const jwk = { kty: 'EC', crv: 'P-256', x: b64u(to32(x)), y: b64u(to32(y)) };
  const privateKey = await subtle.importKey('jwk', { ...jwk, d: b64u(to32(d)) }, alg, false, privUsages);
  const publicKey = await subtle.importKey('jwk', jwk, alg, true, pubUsages);
  return { privateKey, publicKey };
}

export async function deriveHostKeys(roomSecret, code) {
  const pass = await subtle.importKey('raw', enc(normalizeCode(code)), 'PBKDF2', false, ['deriveBits']);
  const seed = new Uint8Array(await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: concat(enc('svoi-host|'), roomSecret), iterations: 600000 }, pass, 512));
  const dSig = (toBig(seed.subarray(0, 32)) % (N - 1n)) + 1n;
  const dDh = (toBig(seed.subarray(32, 64)) % (N - 1n)) + 1n;
  return {
    sig: await pairFromScalar(dSig, SIG, ['sign'], ['verify']),
    dh: await pairFromScalar(dDh, DH, ['deriveBits'], []),
  };
}
