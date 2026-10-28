// Звонок, где гость сидит без VPN (его сигналы режет провайдер), а хозяин — через прокси.
// Аргумент — адрес сайта (по умолчанию локальная копия с новым кодом).
// Смысл есть только в сети, которая режет соединения с зарубежными серверами (Россия без VPN).
// Запуск: python3 -m http.server 8799 --directory web, потом node tests/throttle.test.mjs
import puppeteer from 'puppeteer-core';

const URL = process.argv[2] || 'http://localhost:8799/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-first-run'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)} с]`, ...a);

const bHost = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ARGS });
const bGuest = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: [...ARGS, '--no-proxy-server'] });
const page = async (b, tag) => { const p = await b.newPage(); await p.setViewport({ width: 1100, height: 760 }); p.on('pageerror', (e) => log(tag, 'pageerror', e.message)); return p; };
const clickText = async (p, sel, text) => {
  await p.waitForFunction((s, t) => [...document.querySelectorAll(s)].some((b) => b.textContent.replace(/ /g, ' ').includes(t) && !b.disabled), { timeout: 30000 }, sel, text);
  await p.evaluate((s, t) => [...document.querySelectorAll(s)].find((b) => b.textContent.replace(/ /g, ' ').includes(t) && !b.disabled).click(), sel, text);
};
const typeInto = async (p, ph, v) => { const s = `input[placeholder="${ph}"]`; await p.waitForSelector(s); await p.$eval(s, (e) => { e.value = ''; }); await p.type(s, v); };
const video = (p) => p.evaluate(() => [...document.querySelectorAll('.tile.remote video')].some((v) => v.videoWidth > 0 && !v.hidden));

let result = 'НЕ СОЕДИНИЛИСЬ';
try {
  const host = await page(bHost, 'host');
  await host.goto(URL);
  await clickText(host, 'button', 'Создать комнату');
  await typeInto(host, 'Как вас зовут', 'Хозяйка');
  await clickText(host, 'button', 'Создать и войти');
  await host.waitForSelector('.linkbox', { timeout: 20000 });
  const link = await host.$eval('.linkbox', (e) => e.textContent);
  log('комната создана');

  const guest = await page(bGuest, 'guest');
  await guest.goto(link.replace('https://ddoodd222.github.io/svoi/', URL));
  await typeInto(guest, 'Как вас зовут', 'Денчик');
  await clickText(guest, 'button', 'Попроситься войти');
  await host.waitForFunction(() => document.querySelector('.toast .receipt b'), { timeout: 60000 });
  log('хозяйка видит стук');
  await clickText(host, '.toast button', 'Впустить');
  await guest.waitForSelector('.call', { timeout: 60000 });
  log('гостя впустили');
  for (let i = 0; i < 90; i++) {
    const [a, b] = [await video(host), await video(guest)];
    if (a && b) { result = 'СОЕДИНИЛИСЬ'; log('видео идёт в обе стороны'); break; }
    await sleep(1000);
  }
  if (result === 'СОЕДИНИЛИСЬ') {
    await sleep(60000);
    const still = (await video(host)) && (await video(guest));
    log('через минуту звонок', still ? 'держится' : 'РАЗВАЛИЛСЯ');
    const st = await guest.evaluate(() => null);
    if (st) log('у гостя посредники', JSON.stringify(st));
  }
} catch (e) { log('ошибка', e.message); }
log(result);
await bHost.close(); await bGuest.close();
process.exit(result === 'СОЕДИНИЛИСЬ' ? 0 : 1);
