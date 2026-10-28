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
if (!existsSync(noise)) {
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const s = [];
  for (let i = 0; i < 48000 * 20; i++) s.push((rnd() + rnd() + rnd() - 1.5) * 0.24);
  wav(noise, s);
}

async function call(file, mode, measure) {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${file}`,
      '--no-sandbox', '--no-first-run', '--autoplay-policy=no-user-gesture-required'],
  });
  const click = (p, t) => p.evaluate((t) => [...document.querySelectorAll('button')].find((b) => b.textContent.replace(/ /g, ' ').includes(t)).click(), t);
  const open = async () => {
    const c = await browser.createBrowserContext();
    const p = await c.newPage();
    p.on('dialog', (d) => d.accept());
    await p.evaluateOnNewDocument((m) => localStorage.setItem('svoi.noise', JSON.stringify(m)), mode);
    return p;
  };
  try {
    const host = await open();
    await host.goto(URL);
    await click(host, 'Создать комнату');
    await host.waitForSelector('input[placeholder="Как вас зовут"]');
    await host.type('input[placeholder="Как вас зовут"]', 'Хозяин');
    await click(host, 'Создать и войти');
    await host.waitForSelector('.linkbox');
    const link = await host.$eval('.linkbox', (e) => e.textContent);
    const g = await open();
    await g.goto(link);
    await g.waitForSelector('input[placeholder="Как вас зовут"]');
    await g.type('input[placeholder="Как вас зовут"]', 'Гость');
    await click(g, 'Попроситься войти');
    await host.waitForSelector('.toast .receipt', { timeout: 30000 });
    await click(host, 'Впустить');
    await g.waitForSelector('.call', { timeout: 30000 });
    return await measure(host);
  } finally {
    await browser.close();
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
const noiseOff = await call(noise, 'off', loudness);
const noiseStrong = await call(noise, 'strong', loudness);
ok(noiseOff > 0.02, `без шумодава шум слышен (${noiseOff.toFixed(4)})`);
ok(noiseStrong < noiseOff / 4, `сильный шумодав глушит шум минимум вчетверо (${noiseStrong.toFixed(4)})`);

console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nВСЁ ПРОШЛО');
process.exit(failed ? 1 : 0);
