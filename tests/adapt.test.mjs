// Лестница качества видео под слабую связь: без браузера, на придуманных замерах канала.
// Запуск: node tests/adapt.test.mjs

import { newAdapt, stepAdapt, wantedLevel, LADDER, PAUSE } from '../web/js/adapt.js';

let failed = 0;
const ok = (cond, what) => { console.log((cond ? 'ok  ' : 'FAIL') + ' ' + what); if (!cond) failed++; };

// Что тянет канал
ok(wantedLevel(3000000, 0) === 0, 'широкий канал — полное качество');
ok(wantedLevel(700000, 0) === 1, '700 кбит/с — картинка меньше в полтора раза');
ok(wantedLevel(350000, 0) === 2, '350 кбит/с — вдвое меньше, 15 кадров');
ok(wantedLevel(200000, 0) === 3, '200 кбит/с — втрое меньше, 12 кадров');
ok(wantedLevel(120000, 0) === PAUSE, '120 кбит/с — видео на паузе, звук идёт');
ok(wantedLevel(3000000, 0.35) === PAUSE, 'потери больше 30% — пауза даже на широком канале');
ok(wantedLevel(3000000, 0.15) === 2, 'потери 15% — не выше второй ступеньки');
ok(wantedLevel(null, null) === 0, 'замера нет — ничего не трогаем');
ok(LADDER[PAUSE].pause && !LADDER[0].pause, 'пауза только на последней ступеньке');

// Вниз сразу, вверх постепенно
let t = 0;
const st = newAdapt();
const tick = (bwe, loss) => { t += 4000; return stepAdapt(st, { bwe, loss }, t); };
ok(tick(150000, 0.02) === PAUSE, 'канал просел — сразу пауза, без ожидания');
const ups = [];
for (let i = 0; i < 12; i++) ups.push(tick(3000000, 0));
ok(ups[0] === PAUSE && ups[1] === PAUSE, 'вверх не сразу: сначала три чистых замера и выдержка');
ok(ups.includes(3) && ups.includes(2), 'вверх по одной ступеньке');
ok(ups.at(-1) === 0, 'за минуту хорошей связи качество вернулось полностью');

// Подъём сорвался — следующая попытка позже
const st2 = newAdapt();
let t2 = 0;
const tick2 = (bwe, loss) => { t2 += 4000; return stepAdapt(st2, { bwe, loss }, t2); };
tick2(150000, 0);
let firstUp = null;
for (let i = 0; i < 10 && firstUp === null; i++) if (tick2(3000000, 0) < PAUSE) firstUp = t2;
tick2(150000, 0.4); // сразу после подъёма снова плохо
const holdAfterFail = st2.hold;
ok(holdAfterFail > 12000, `сорвался подъём — выдержка выросла (${holdAfterFail / 1000} с)`);
let secondUp = null;
for (let i = 0; i < 30 && secondUp === null; i++) if (tick2(3000000, 0) < PAUSE) secondUp = t2;
ok(secondUp !== null && secondUp - t2 <= 0 && secondUp > firstUp, 'вторая попытка тоже случилась, но позже');

// После шага вверх браузер разгоняется: оценке канала первые 8 секунд не верим, потерям — верим
const st4 = newAdapt();
st4.level = 2; st4.upAt = 100000;
ok(stepAdapt(st4, { bwe: 300000, loss: 0 }, 104000) === 2, 'сразу после подъёма низкая оценка канала не роняет качество');
ok(stepAdapt(st4, { bwe: 300000, loss: 0.4 }, 106000) === PAUSE, 'а большие потери роняют и тогда');

// Потери без падения канала
const st3 = newAdapt();
ok(stepAdapt(st3, { bwe: 3000000, loss: 0.08 }, 4000) === 1, 'потери 8% — ступенькой ниже');
ok(stepAdapt(st3, { bwe: 3000000, loss: 0.08 }, 8000) === 1, 'потери держатся — вверх не идём');

console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nВСЁ ПРОШЛО');
process.exit(failed ? 1 : 0);
