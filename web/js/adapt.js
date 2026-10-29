// Видео под слабую связь: лестница качества для каждого собеседника отдельно.
//
// Плохой канал — не повод для каши из квадратиков. Лучше честно уменьшить картинку и частоту кадров:
// маленькое видео браузер растягивает мягко, а сжатое в мыло большое рассыпается на блоки.
// Звук важнее видео: когда канала не хватает даже на маленькую картинку, видео встаёт на паузу.
//
// Вниз по лестнице — сразу, как только канал просел. Вверх — по одной ступеньке, после 12 секунд
// без потерь. Если подъём тут же оборвался, следующая попытка ждёт вдвое дольше (до минуты).
// На паузе подъём — это и есть проверка канала: без пробы браузер не узнает, что связь стала лучше.

export const LADDER = [
  { bitrate: Infinity, scale: 1, fps: 30, screenFps: 15 }, // хорошая связь
  { bitrate: 500000, scale: 1.5, fps: 24, screenFps: 10 },
  { bitrate: 250000, scale: 2, fps: 15, screenFps: 8 },
  { bitrate: 120000, scale: 3, fps: 12, screenFps: 5 },
  { bitrate: 60000, scale: 4, fps: 8, screenFps: 3, pause: true }, // только звук
];
export const PAUSE = LADDER.length - 1;

const UP_AFTER = 3; // столько замеров подряд (по 4 с) без потерь — и можно на ступеньку выше
const HOLD_MIN = 12000;
const HOLD_MAX = 60000;
const GRACE = 8000;

export function newAdapt() {
  return { level: 0, good: 0, hold: HOLD_MIN, holdUntil: 0, upAt: -Infinity };
}

// Какую ступеньку тянет канал: оценка пропускной способности (бит/с) и доля потерянных пакетов видео.
export function wantedLevel(bwe, loss) {
  let want = 0;
  if (typeof bwe === 'number') {
    const budget = bwe * 0.85 - 60000; // 60 кбит/с оставляем звуку
    want = budget > 700000 ? 0 : budget > 380000 ? 1 : budget > 180000 ? 2 : budget > 90000 ? 3 : PAUSE;
  }
  if (typeof loss === 'number') {
    if (loss > 0.3) want = PAUSE;
    else if (loss > 0.12) want = Math.max(want, 2);
    else if (loss > 0.05) want = Math.max(want, 1);
  }
  return want;
}

// Один замер раз в 4 секунды. Возвращает новую ступеньку (или ту же).
export function stepAdapt(st, { bwe, loss }, now = Date.now()) {
  // Первые 8 секунд после шага вверх оценке канала не верим: браузер ещё разгоняется. Верим только потерям.
  const want = now - st.upAt < GRACE ? wantedLevel(null, loss) : wantedLevel(bwe, loss);
  if (want > st.level) {
    // Подъём оборвался почти сразу — значит, рано: в следующий раз ждём дольше.
    st.hold = now - st.upAt < 20000 ? Math.min(st.hold * 2, HOLD_MAX) : HOLD_MIN;
    st.holdUntil = now + st.hold;
    st.level = want;
    st.good = 0;
    return st.level;
  }
  const clean = typeof loss !== 'number' || loss < 0.03;
  st.good = clean ? st.good + 1 : 0;
  if (st.level > 0 && st.good >= UP_AFTER && now >= st.holdUntil) {
    st.level -= 1;
    st.good = 0;
    st.upAt = now;
  }
  return st.level;
}
