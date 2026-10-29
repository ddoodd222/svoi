// Сглаживание кожи и белые зубы на искусственном кадре (лиц в тестах нет).
// Кадр: «кожа» с шумом (поры), тёмная полоска (граница черт лица), желтоватые «зубы» среди кожи,
// такой же желтоватый «кусок стены» на синем фоне. Кадр делает Python, файл лежит в ~/.svoi-test/skin.y4m.
// Запуск: python3 tests/make-skin-y4m.py, python3 -m http.server 8787 --directory web, потом node tests/beauty.test.mjs

import puppeteer from 'puppeteer-core';
import os from 'node:os';
import fs from 'node:fs';

const URL = process.env.SVOI_URL || 'http://localhost:8787/';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FILE = os.homedir() + '/.svoi-test/skin.y4m';
let failed = 0;
const ok = (cond, what) => { console.log((cond ? 'ok  ' : 'FAIL') + ' ' + what); if (!cond) failed++; };
if (!fs.existsSync(FILE)) { console.log('Нет ' + FILE + '. Сделайте его: python3 tests/make-skin-y4m.py'); process.exit(1); }

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${FILE}`, '--no-sandbox', '--no-first-run'],
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => { console.log('pageerror', e.message); failed++; });
  await page.goto(URL);
  const r = await page.evaluate(async () => {
    const { LocalMedia, canBeautify } = await import('/js/media.js');
    if (!canBeautify) return { unsupported: true };
    const m = new LocalMedia();
    m.beauty = { smooth: 0.8, teeth: 0.85 };
    await m.start({ mic: false, cam: true });
    const grab = async (track) => {
      const v = document.createElement('video');
      v.muted = true;
      v.srcObject = new MediaStream([track]);
      await v.play();
      await new Promise((res) => setTimeout(res, 1500));
      const c = document.createElement('canvas');
      c.width = 640; c.height = 480;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(v, 0, 0, 640, 480);
      return g.getImageData(0, 0, 640, 480).data;
    };
    const raw = await grab(m.cam);
    const out = await grab(m.camOut);
    const ms = m.fx?.ms || 0;
    const stats = (d, x0, y0, x1, y1) => {
      let n = 0, sy = 0, syy = 0, scb = 0, scr = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * 640 + x) * 4, R = d[i], G = d[i + 1], B = d[i + 2];
        const Y = 0.299 * R + 0.587 * G + 0.114 * B;
        sy += Y; syy += Y * Y; scb += 128 - 0.168736 * R - 0.331264 * G + 0.5 * B; scr += 128 + 0.5 * R - 0.418688 * G - 0.081312 * B; n++;
      }
      const mean = sy / n;
      return { mean, sd: Math.sqrt(syy / n - mean * mean), cb: scb / n, cr: scr / n };
    };
    const at = (d) => ({
      skin: stats(d, 40, 60, 180, 260),
      stripe: stats(d, 201, 100, 205, 250),
      beside: stats(d, 215, 100, 225, 250),
      teeth: stats(d, 310, 305, 350, 325),
      pale: stats(d, 390, 80, 460, 240),
      shine: stats(d, 92, 372, 108, 388),
      wall: stats(d, 550, 305, 590, 325),
      flipped: stats(d, 310, 155, 350, 175), // где были бы «зубы», если бы кадр перевернулся
    });
    const res = { raw: at(raw), out: at(out), ms, same: m.camOut === m.cam };
    m.setBeauty({ smooth: 0, teeth: 0 });
    res.offIsRaw = m.camOut === m.cam;
    m.stopAll();
    return res;
  });
  if (r.unsupported) { console.log('Этот Chrome не умеет обрабатывать видео — тест пропущен.'); process.exit(0); }
  const { raw, out } = r;
  const f = (v) => v.toFixed(1);
  ok(!r.same, 'при включённой красоте собеседникам уходит обработанная дорожка');
  ok(out.skin.sd < raw.skin.sd * 0.6, `кожа глаже: шум ${f(raw.skin.sd)} → ${f(out.skin.sd)}`);
  ok(out.beside.mean - out.stripe.mean > (raw.beside.mean - raw.stripe.mean) * 0.7, `граница черт лица осталась чёткой: ${f(raw.beside.mean - raw.stripe.mean)} → ${f(out.beside.mean - out.stripe.mean)}`);
  ok(out.skin.mean >= raw.skin.mean - 1, 'кожа не потемнела');
  ok(128 - out.teeth.cb < (128 - raw.teeth.cb) * 0.6, `зубы белее: желтизна ${f(128 - raw.teeth.cb)} → ${f(128 - out.teeth.cb)}`);
  ok(out.teeth.mean > raw.teeth.mean, `зубы ярче: ${f(raw.teeth.mean)} → ${f(out.teeth.mean)}`);
  // Оттенок кожи не плывёт: ни в жёлтый, ни в серый (владелец 2026-10-29: «кожа становится жёлтой»).
  for (const [k, name] of [['skin', 'обычная кожа'], ['pale', 'светлая кожа'], ['shine', 'блик на коже']]) {
    ok(Math.abs(out[k].cr - raw[k].cr) < 2 && Math.abs(out[k].cb - raw[k].cb) < 2,
      `${name}: оттенок тот же (Cb ${f(raw[k].cb)} → ${f(out[k].cb)}, Cr ${f(raw[k].cr)} → ${f(out[k].cr)})`);
  }
  ok(out.shine.mean - raw.shine.mean < 4, `блик на коже не ярче (владелец: «появляется блеск»): ${f(raw.shine.mean)} → ${f(out.shine.mean)}`);
  ok(Math.abs(out.wall.cb - raw.wall.cb) < 3, `такая же жёлтая стена вдали от лица не тронута: ${f(raw.wall.cb)} → ${f(out.wall.cb)}`);
  ok(out.teeth.mean > out.flipped.mean + 10, 'кадр не перевернулся');
  ok(r.offIsRaw, 'выключили красоту — уходит сырая камера, обработка не работает');
  ok(r.ms < 25, `обработка успевает: ${r.ms.toFixed(1)} мс на кадр`);
} finally {
  await browser.close();
}
console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nВСЁ ПРОШЛО');
process.exit(failed ? 1 : 0);
