// Звук в звонке и шумодав: голос доходит во всех режимах, шум в сильном режиме подавлен.
// Нужен macOS (речь синтезирует команда say). Запуск: сначала поднять страницу на 8787, потом node tests/audio.test.mjs

import puppeteer from 'puppeteer-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const URL = process.env.SVOI_URL || 'http://localhost:8787/';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Песочница Chrome не даёт читать файлы из папки проекта, поэтому файлы звука — в домашней папке.
const DIR = join(homedir(), '.svoi-test');
mkdirSync(DIR, { recursive: true });

let failed = 0;
const ok = (cond, what) => { console.log((cond ? 'ok  ' : 'FAIL') + ' ' + what); if (!cond) failed++; };

// Простой WAV: 48 кГц, 16 бит, моно. Другие варианты Chrome не читает.
function wav(path, samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(48000, 24);
  h.writeUInt32LE(96000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([h, data]));
}

const speech = join(DIR, 'speech.wav');
const noise = join(DIR, 'noise.wav');
const echo = join(DIR, 'echo.wav'); // та же речь вчетверо тише — как остатки чужого голоса из динамиков
if (!existsSync(speech)) {
  const aiff = join(DIR, 'speech.aiff');
  const raw = join(DIR, 'speech-raw.wav');
  execFileSync('say', ['-v', 'Milena', '-o', aiff, 'Привет! Это проверка шумодава. Если ты меня слышишь, голос проходит. Раз, два, три, четыре, пять.']);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@48000', '-c', '1', aiff, raw]);
  const b = readFileSync(raw);
  const at = b.indexOf('data') + 8;
  const s = [];
  for (let i = at; i + 1 < b.length; i += 2) s.push(b.readInt16LE(i) / 32767);
  wav(speech, s);
}
if (!existsSync(echo)) {
  const b = readFileSync(speech);
  const s = [];
  for (let i = 44; i + 1 < b.length; i += 2) s.push((b.readInt16LE(i) / 32767) * 0.25);
  wav(echo, s);
}
if (!existsSync(noise)) {
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const s = [];
  for (let i = 0; i < 48000 * 20; i++) s.push((rnd() + rnd() + rnd() - 1.5) * 0.24);
  wav(noise, s);
}

const launch = (file) => puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${file}`,
    '--no-sandbox', '--no-first-run', '--autoplay-policy=no-user-gesture-required'],
});

// file — что «говорит» микрофон; можно дать хозяину и гостю разное: { host, guest }. prefs — настройки звука гостя.
async function call(file, mode, measure, { afterJoin, guestPrefs = {}, hostPrefs = {} } = {}) {
  const files = typeof file === 'string' ? { host: file, guest: file } : file;
  const browser = await launch(files.host);
  const guestBrowser = files.guest === files.host ? browser : await launch(files.guest);
  const click = (p, t) => p.evaluate((t) => [...document.querySelectorAll('button')].find((b) => b.textContent.replace(/ /g, ' ').includes(t)).click(), t);
  const open = async (b, extra) => {
    const c = await b.createBrowserContext();
    const p = await c.newPage();
    p.on('dialog', (d) => d.accept());
    await p.evaluateOnNewDocument((m, extra) => {
      localStorage.setItem('svoi.noise', JSON.stringify(m));
      for (const [k, v] of Object.entries(extra)) localStorage.setItem('svoi.' + k, JSON.stringify(v));
      // Запоминаем звуковые движки страницы, чтобы тест мог их «усыпить», как свёрнутый браузер.
      const Orig = window.AudioContext;
      window.__ctxs = [];
      window.AudioContext = class extends Orig { constructor(...a) { super(...a); window.__ctxs.push(this); } };
    }, mode, extra);
    return p;
  };
  try {
    const host = await open(browser, hostPrefs);
    await host.goto(URL);
    await click(host, 'Создать комнату');
    await host.waitForSelector('input[placeholder="Как вас зовут"]');
    await host.type('input[placeholder="Как вас зовут"]', 'Хозяин');
    await click(host, 'Создать и войти');
    await host.waitForSelector('.linkbox');
    const link = await host.$eval('.linkbox', (e) => e.textContent);
    const g = await open(guestBrowser, guestPrefs);
    await g.goto(link);
    await g.waitForSelector('input[placeholder="Как вас зовут"]');
    await g.type('input[placeholder="Как вас зовут"]', 'Гость');
    await click(g, 'Попроситься войти');
    await host.waitForSelector('.toast .receipt', { timeout: 30000 });
    await click(host, 'Впустить');
    await g.waitForSelector('.call', { timeout: 30000 });
    if (afterJoin) await afterJoin(g);
    return await measure(host);
  } finally {
    await browser.close();
    if (guestBrowser !== browser) await guestBrowser.close();
  }
}

const heard = (host) => host.waitForFunction(() => document.querySelector('.tile.remote.speaking'), { timeout: 25000, polling: 250 }).then(() => true, () => false);
const loudness = async (host) => {
  await new Promise((r) => setTimeout(r, 6000));
  return host.evaluate(async () => {
    const a = document.querySelector('audio');
    const ctx = new AudioContext();
    const an = ctx.createAnalyser();
    ctx.createMediaStreamSource(a.srcObject).connect(an);
    let sum = 0;
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const b = new Float32Array(2048);
      an.getFloatTimeDomainData(b);
      sum += Math.sqrt(b.reduce((x, v) => x + v * v, 0) / b.length);
    }
    return sum / 15;
  });
};

for (const mode of ['off', 'browser', 'strong']) ok(await call(speech, mode, heard), `голос доходит, шумодав «${mode}»`);
// Свёрнутый браузер усыпил звуковой движок у гостя: голос должен пойти в обход шумодава.
const sleepEngine = async (g) => {
  await new Promise((r) => setTimeout(r, 3000));
  await g.evaluate(() => Promise.all(window.__ctxs.map((c) => { c.resume = () => Promise.resolve(); return c.suspend(); })));
};
const voiceAsleep = await call(speech, 'strong', loudness, { afterJoin: sleepEngine });
ok(voiceAsleep > 0.005, `звуковой движок уснул — голос всё равно доходит (${voiceAsleep.toFixed(4)})`);
// Анти-эхо «сильное»: хозяин говорит без пауз (шум), у гостя в микрофоне тихое эхо — его слышно намного тише.
// Громкую речь гостя приглушение пропускает нарочно: так можно перебить.
const duckFiles = { host: noise, guest: echo };
const echoNormal = await call(duckFiles, 'off', loudness, { guestPrefs: { echo: 'normal' } });
const echoStrong = await call(duckFiles, 'off', loudness, { guestPrefs: { echo: 'strong' } });
ok(echoStrong < echoNormal * 0.5, `сильное анти-эхо глушит тихое эхо, пока говорит хозяин (${echoNormal.toFixed(4)} → ${echoStrong.toFixed(4)})`);
// Хозяин выключил микрофон и продолжает говорить: приложение подсказывает включить.
const mutedHint = await call(speech, 'browser', async (host) => {
  await host.waitForSelector('.ctl[aria-label="Выключить микрофон"]');
  await host.click('.ctl[aria-label="Выключить микрофон"]');
  return host.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('выключенный микрофон')), { timeout: 20000, polling: 250 }).then(() => true, () => false);
});
ok(mutedHint, 'говорят в выключенный микрофон — появляется подсказка «Включить»');
// Смешные голоса: «Бурундук» выше своего, «Великан» ниже. Меряем «центр тяжести» спектра у хозяина.
const centroid = async (host) => {
  await new Promise((r) => setTimeout(r, 5000));
  return host.evaluate(async () => {
    const a = document.querySelector('audio');
    const ctx = new AudioContext();
    const an = ctx.createAnalyser();
    an.fftSize = 4096;
    ctx.createMediaStreamSource(a.srcObject).connect(an);
    const bins = new Float32Array(an.frequencyBinCount);
    let num = 0, den = 0;
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 200));
      an.getFloatFrequencyData(bins);
      bins.forEach((db, k) => { const p = Math.pow(10, db / 10); const f = k * ctx.sampleRate / an.fftSize; if (f > 80 && f < 8000) { num += f * p; den += p; } });
    }
    return den ? num / den : 0;
  });
};
const setVoice = (id) => async (g) => { await g.evaluate(async (id) => {
  document.querySelector('.ctl[aria-label="Реакции и голоса"]').click();
  await new Promise((r) => setTimeout(r, 300));
  document.querySelector(`.react-pop .voices button[data-voice="${id}"]`).click();
}, id); };
const cNormal = await call(speech, 'off', centroid);
const cChip = await call(speech, 'off', centroid, { afterJoin: setVoice('chipmunk') });
const cGiant = await call(speech, 'off', centroid, { afterJoin: setVoice('giant') });
ok(cChip > cNormal * 1.15, `«Бурундук» звучит выше: ${Math.round(cNormal)} → ${Math.round(cChip)} Гц`);
ok(cGiant < cNormal * 0.92, `«Великан» звучит ниже: ${Math.round(cNormal)} → ${Math.round(cGiant)} Гц`);
const robotLoud = await call(speech, 'off', loudness, { afterJoin: setVoice('robot') });
ok(robotLoud > 0.005, `«Робот» слышно (${robotLoud.toFixed(4)})`);
// Громкость собеседника у себя: 200% на выходе заметно громче 50%, и ограничитель не даёт хрипеть.
const volumeLevels = await call(speech, 'off', async (host) => {
  await host.waitForSelector('button[aria-label="Участники"]');
  await host.evaluate(() => document.querySelector('button[aria-label="Участники"]').click());
  await host.waitForSelector('input[aria-label="Громкость: Гость"]', { timeout: 30000 });
  const level = (pct) => host.evaluate(async (pct) => {
    const el = document.querySelector('input[aria-label="Громкость: Гость"]');
    el.value = String(pct);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const a = [...document.querySelectorAll('audio')].find((x) => x._route);
    if (!a) return -1;
    const an = a._route.ctx.createAnalyser();
    an.fftSize = 2048;
    a._route.limit.connect(an);
    let sum = 0, peak = 0;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const b = new Float32Array(2048);
      an.getFloatTimeDomainData(b);
      sum += Math.sqrt(b.reduce((x, v) => x + v * v, 0) / b.length);
      peak = Math.max(peak, ...b.map(Math.abs));
    }
    a._route.limit.disconnect(an);
    return { rms: sum / 20, peak };
  }, pct);
  await new Promise((r) => setTimeout(r, 3000));
  return { half: await level(50), double: await level(200) };
});
ok(volumeLevels.double.rms > volumeLevels.half.rms * 2.5, `200% громче 50%: ${volumeLevels.half.rms.toFixed(4)} → ${volumeLevels.double.rms.toFixed(4)}`);
ok(volumeLevels.double.peak <= 1.0, `усиленный звук не уходит в хрип (пик ${volumeLevels.double.peak.toFixed(2)})`);
const noiseOff = await call(noise, 'off', loudness);
const noiseStrong = await call(noise, 'strong', loudness);
ok(noiseOff > 0.02, `без шумодава шум слышен (${noiseOff.toFixed(4)})`);
ok(noiseStrong < noiseOff / 4, `сильный шумодав глушит шум минимум вчетверо (${noiseStrong.toFixed(4)})`);

console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nВСЁ ПРОШЛО');
process.exit(failed ? 1 : 0);
