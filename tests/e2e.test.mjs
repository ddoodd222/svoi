// Звонок втроём в настоящем Chrome с поддельной камерой и микрофоном.
// Сигнал идёт через настоящие публичные посредники, видео — напрямую между вкладками.
// Запуск: сначала поднять страницу (python3 -m http.server 8787 --directory web), потом node tests/e2e.test.mjs

import puppeteer from 'puppeteer-core';

const URL = process.env.SVOI_URL || 'http://localhost:8787/';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HEADLESS = process.env.HEADFUL ? false : 'new';

let failed = 0;
const ok = (cond, what) => { console.log((cond ? 'ok  ' : 'FAIL') + ' ' + what); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: HEADLESS,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--auto-select-tab-capture-source-by-title=Свои',
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--window-size=1100,800',
  ],
});

async function open(name) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1100, height: 760 });
  page.on('pageerror', (e) => { console.log(`[${name}] pageerror`, e.message); failed++; });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[${name}] console.error`, m.text()); });
  page.on('dialog', (d) => d.accept()); // «Покинуть звонок?» при перезагрузке
  page.tag = name;
  return page;
}

async function clickText(page, selector, text) {
  // В интерфейсе короткие слова приклеены неразрывным пробелом — сравниваем без него.
  await page.waitForFunction((sel, t) => [...document.querySelectorAll(sel)].some((b) => b.textContent.replace(/\u00a0/g, ' ').includes(t) && !b.disabled), { timeout: 30000 }, selector, text);
  await page.evaluate((sel, t) => [...document.querySelectorAll(sel)].find((b) => b.textContent.replace(/\u00a0/g, ' ').includes(t) && !b.disabled).click(), selector, text);
}

// Открыть панель, только если она ещё не открыта (кнопка работает как переключатель).
async function openPanel(page, label) {
  await page.waitForSelector(`button[aria-label="${label}"]`);
  await page.evaluate((l) => { const b = document.querySelector(`button[aria-label="${l}"]`); if (b.getAttribute('aria-pressed') !== 'true') b.click(); }, label);
}

async function typeInto(page, placeholder, value) {
  const sel = `input[placeholder="${placeholder}"]`;
  await page.waitForSelector(sel);
  await page.$eval(sel, (el) => { el.value = ''; });
  await page.type(sel, value);
}

// Сколько чужих плиток показывают живое видео.
const liveRemoteVideos = (page) => page.evaluate(() =>
  [...document.querySelectorAll('.tile.remote video')].filter((v) => !v.hidden && v.videoWidth > 0 && !v.paused).length);

async function waitFor(page, fn, what, timeout = 40000, ...args) {
  try { await page.waitForFunction(fn, { timeout, polling: 300 }, ...args); ok(true, what); return true; }
  catch { ok(false, what + ` (${page.tag})`); return false; }
}

async function joinAsGuest(page, link, name, { waitCode = true } = {}) {
  await page.goto(link);
  await typeInto(page, 'Как вас зовут', name);
  await clickText(page, 'button', 'Попроситься войти');
  if (!waitCode) return null; // при закрытом входе хозяин не присылает добавку к коду
  await page.waitForSelector('.receipt b', { timeout: 30000 });
  return page.$eval('.receipt b', (el) => el.textContent);
}

try {
  // ---------- Хозяин ----------
  const host = await open('host');
  await host.goto(URL);
  await clickText(host, 'button', 'Создать комнату');
  await typeInto(host, 'Как вас зовут', 'Хозяйка');
  await typeInto(host, 'Например, созвон дизайнеров', 'Проверка связи');
  await clickText(host, 'button', 'Создать и войти');
  await host.waitForSelector('.linkbox', { timeout: 20000 });
  const link = await host.$eval('.linkbox', (el) => el.textContent);
  ok(/#k=[A-Za-z0-9_-]{43}&h=[A-Za-z0-9_-]{22}$/.test(link), 'ссылка-приглашение с ключом после #');
  ok(await host.evaluate(() => location.hash === ''), 'у хозяина секрета нет в адресной строке');

  // ---------- Гость 1 ----------
  const g1 = await open('g1');
  const code1 = await joinAsGuest(g1, link, 'Маша');
  ok(/^\d{3} \d{3} \d{3}$/.test(code1), 'гость видит свой код проверки ' + code1);
  ok(await g1.evaluate(() => location.hash === ''), 'у гостя секрет убран из адресной строки');
  await waitFor(host, () => document.querySelector('.toast .receipt b'), 'хозяин видит запрос «просится войти»');
  const shownCode = await host.$eval('.toast .receipt b', (el) => el.textContent);
  ok(shownCode === code1, 'код у хозяина совпадает с кодом гостя');
  await clickText(host, '.toast button', 'Впустить');
  await waitFor(g1, () => document.querySelector('.call'), 'гостя впустили в звонок');
  await waitFor(host, () => [...document.querySelectorAll('.tile.remote video')].some((v) => v.videoWidth > 0), 'хозяин видит видео Маши');
  await waitFor(g1, () => [...document.querySelectorAll('.tile.remote video')].some((v) => v.videoWidth > 0), 'Маша видит видео хозяйки');
  ok(await g1.evaluate(() => document.querySelector('.topbar .title').textContent) === 'Проверка связи', 'название встречи дошло до гостя');
  ok(await host.evaluate(() => !!document.querySelector('.tile.pip')), 'вдвоём: своё окошко в углу');

  // ---------- Гость 2 ----------
  const g2 = await open('g2');
  const code2 = await joinAsGuest(g2, link, 'Петя');
  await openPanel(host, 'Участники');
  await waitFor(host, () => document.querySelector('.panel .knock'), 'запрос Пети в списке участников');
  await clickText(host, '.panel .knock button', 'Впустить');
  await waitFor(g2, () => document.querySelector('.call'), 'Петю впустили');
  for (const p of [host, g1, g2]) await waitFor(p, () => [...document.querySelectorAll('.tile.remote video')].filter((v) => v.videoWidth > 0 && !v.hidden).length >= 2, `втроём: два живых видео у ${p.tag}`, 45000);
  ok(await host.evaluate(() => [...document.querySelectorAll('.panel h3')].some((h) => h.textContent.replace(/\u00a0/g, ' ').includes('3 из 8'))), 'в списке «3 из 8»');
  ok(await host.evaluate((c) => [...document.querySelectorAll('.people .code')].some((e) => e.textContent === c), code2), 'код Пети в списке участников');

  // ---------- Чат ----------
  await openPanel(g2, 'Чат');
  await typeInto(g2, 'Сообщение', 'Привет <b>всем</b>');
  await g2.keyboard.press('Enter');
  await waitFor(g1, () => document.querySelector('.ctl .badge'), 'у Маши значок непрочитанного');
  await openPanel(g1, 'Чат');
  await waitFor(g1, () => [...document.querySelectorAll('.chat-msg p')].some((p) => p.textContent === 'Привет <b>всем</b>'), 'сообщение пришло как текст, без разметки');

  // ---------- Микрофон ----------
  await g1.click('.ctl[aria-label="Выключить микрофон"]');
  await waitFor(host, () => [...document.querySelectorAll('.tile.remote .label')].some((l) => l.textContent.includes('Маша') && l.querySelector('svg')), 'хозяйка видит, что Маша выключила микрофон');

  // ---------- Показ экрана ----------
  await host.bringToFront();
  const shared = await host.evaluate(async () => {
    const b = document.querySelector('.ctl[aria-label="Показать экран"]');
    if (!b) return 'нет кнопки';
    b.click();
    await new Promise((r) => setTimeout(r, 3000));
    return document.querySelector('.ctl.on-air[aria-label="Остановить показ экрана"]') ? 'ok' : 'не запустился';
  });
  if (shared === 'ok') {
    ok(true, 'хозяйка показывает экран');
    await waitFor(g1, () => document.querySelector('.stage.present .main .tile.share video')?.videoWidth > 0, 'Маша видит экран хозяйки крупно');
    await host.click('.ctl.on-air[aria-label="Остановить показ экрана"]');
    await waitFor(g1, () => !document.querySelector('.stage.present'), 'показ экрана остановлен у Маши');
  } else {
    console.log('skip показ экрана в безголовом Chrome:', shared);
  }

  // ---------- Удаление и закрытый вход ----------
  await openPanel(host, 'Участники');
  await waitFor(host, () => document.querySelector('.panel .people'), 'список участников открыт');
  await host.evaluate(() => { [...document.querySelectorAll('.people li')].find((li) => li.textContent.includes('Петя')).querySelector('button').click(); });
  await clickText(host, '.modal button', 'Удалить');
  await waitFor(g2, () => document.body.textContent.includes('Вас удалили'), 'Петю удалили из встречи');
  await waitFor(g1, () => [...document.querySelectorAll('.tile.remote')].length === 1, 'у Маши осталась одна чужая плитка');

  await host.evaluate(() => [...document.querySelectorAll('.panel button')].find((b) => b.textContent.includes('Закрыть вход')).click());
  const g3 = await open('g3');
  await joinAsGuest(g3, link, 'Незнакомец', { waitCode: false });
  await waitFor(g3, () => document.body.textContent.includes('Вход закрыт'), 'при закрытом входе гость видит «Вход закрыт»', 30000);
  ok(await host.evaluate(() => !document.querySelector('.knock') && !document.querySelector('.toast .receipt')), 'хозяйку не беспокоят запросами при закрытом входе');
  ok(await g3.evaluate(() => !document.querySelector('.receipt')), 'незнакомец при закрытом входе не получает даже кода');

  // ---------- Перезагрузка гостя ----------
  await g1.reload();
  await clickText(g1, 'button', 'Попроситься войти');
  await waitFor(g1, () => document.querySelector('.call'), 'Маша вернулась после перезагрузки без нового запроса', 40000);

  // ---------- Завершение ----------
  await clickText(host, 'button[aria-label="Завершить встречу"]', '');
  await clickText(host, '.modal button', 'Завершить');
  await waitFor(g1, () => document.body.textContent.includes('Встреча завершена'), 'Маша видит «Встреча завершена»');
  await waitFor(host, () => document.body.textContent.includes('Открыть комнату снова'), 'хозяйка может открыть комнату снова');

  // ---------- Повторное открытие: прошлые гости заново просятся ----------
  await clickText(host, 'button', 'Открыть комнату снова');
  await clickText(host, 'button', 'Открыть комнату');
  await host.waitForSelector('.call', { timeout: 20000 });
  await g1.goto(link);
  await clickText(g1, 'button', 'Попроситься войти');
  await waitFor(host, () => document.querySelector('.toast .receipt b'), 'после новой встречи Маша снова стучится, а не входит сама');
  ok(await g1.evaluate(() => !document.querySelector('.call')), 'Маша ждёт допуска');
} catch (e) {
  console.error('ОШИБКА ТЕСТА', e);
  failed++;
} finally {
  await browser.close();
}
console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nВСЁ ПРОШЛО');
process.exit(failed ? 1 : 0);
