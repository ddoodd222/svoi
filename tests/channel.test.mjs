// Проверка шифрования и служебного канала на настоящих публичных посредниках.
// Запуск: node tests/channel.test.mjs
import * as C from '../web/js/crypto.js';
import { SecureChannel } from '../web/js/signal.js';

const assert = (ok, what) => { if (!ok) { console.error('FAIL', what); process.exit(1); } console.log('ok  ', what); };

const secret = C.newRoomSecret();
assert(C.unb64u(C.b64u(secret)).every((b, i) => b === secret[i]), 'base64url туда и обратно');
const room = await C.roomKeys(secret);
const a = await C.loadIdentity(await C.createKeys());
const b = await C.loadIdentity(await C.createKeys());
const eve = await C.loadIdentity(await C.createKeys());
assert(a.id.length === 22 && a.id !== b.id, 'id участников разные');
assert(/^\d{3} \d{3} \d{3}$/.test(await C.safetyCode(secret, a.id)), 'код проверки из девяти цифр');

const sig = await C.sign(a, C.enc('hello'));
const pa = await C.importPeer(a.pk);
assert(await C.verify(pa, C.enc('hello'), sig), 'подпись проверяется');
assert(!(await C.verify(pa, C.enc('hellO'), sig)), 'подделка текста ловится');

const box = await C.boxSeal(await C.importPeer(b.pk), secret, C.enc('секрет'));
assert(C.dec(await C.boxOpen(b, secret, box)) === 'секрет', 'получатель открывает личный конверт');
let leaked = true; try { await C.boxOpen(eve, secret, box); } catch { leaked = false; }
assert(!leaked, 'третий не открывает личный конверт');
const box2 = await C.boxSeal(await C.importPeer(b.pk), secret, C.enc('секрет'));
assert(C.b64u(box).slice(0, 40) !== C.b64u(box2).slice(0, 40), 'у каждого конверта свой одноразовый ключ');
const c1 = await C.safetyCode(secret, a.id, 'r1'), c2 = await C.safetyCode(secret, a.id, 'r2');
assert(c1 !== c2, 'код проверки зависит от добавки хозяина');

const hk1 = await C.loadIdentity(await C.deriveHostKeys(secret, 'Зелёный слон пьёт чай'));
const hk2 = await C.loadIdentity(await C.deriveHostKeys(secret, '  зелёный  СЛОН пьёт чай '));
const hk3 = await C.loadIdentity(await C.deriveHostKeys(C.newRoomSecret(), 'Зелёный слон пьёт чай'));
assert(hk1.id === hk2.id, 'код хозяина даёт того же хозяина на любом устройстве');
assert(hk1.id !== hk3.id, 'тот же код в другой комнате — другой хозяин');
assert(await C.verify(await C.importPeer(hk1.pk), C.enc('x'), await C.sign(hk2, C.enc('x'))), 'ключ хозяина из кода подписывает правильно');

// Канал через посредников
const got = { b: [], eve: [] };
const chA = new SecureChannel(room, a);
const chB = new SecureChannel(room, b, { onMessage: (m) => got.b.push(m) });
const chE = new SecureChannel(room, eve, { onMessage: (m) => got.eve.push(m) });
const otherRoom = await C.roomKeys(C.newRoomSecret());
const chX = new SecureChannel({ ...otherRoom, topic: room.topic, aad: room.aad }, eve); // тот же адрес, другой ключ
const gotX = []; chX.onMessage = (m) => gotX.push(m);
[chA, chB, chE, chX].forEach((c) => c.start());
const t0 = Date.now();
while (![chA, chB, chE, chX].every((c) => c.online) && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 200));
assert(chA.online && chB.online, 'подключились к посредникам за ' + (Date.now() - t0) + ' мс; готовы: ' + chA.links.map((l) => l.url.split('/')[2] + '=' + l.ready).join(', '));

await chA.send('ping', { x: 1 });
await chA.send('secret', { text: 'только для b' }, await chA.learn(b.pk));
const big = 'x'.repeat(12000);
await chA.send('big', { big });
await new Promise((r) => setTimeout(r, 4000));
assert(got.b.filter((m) => m.type === 'ping').length === 1, 'общее сообщение пришло ровно один раз (дубли от второго посредника отброшены)');
assert(got.b.some((m) => m.type === 'secret' && m.body.text === 'только для b'), 'личное сообщение дошло до адресата');
assert(!got.eve.some((m) => m.type === 'secret'), 'личное сообщение не досталось третьему');
assert(!got.eve.some((m) => m.from === a.id && m.type === 'secret'), 'третий не видит даже, кто кому писал');
assert(got.b.some((m) => m.type === 'big' && m.body.big.length === 12000), 'большое сообщение 12 КБ дошло');
assert(gotX.length === 0, 'без ключа комнаты сообщения не читаются');
[chA, chB, chE, chX].forEach((c) => c.stop());
console.log('ВСЁ ПРОШЛО');
process.exit(0);
