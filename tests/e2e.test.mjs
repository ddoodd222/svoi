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
  ok(link.startsWith(URL + '#'), `приглашение ведёт на этот же сайт (${link.split('#')[0]})`);
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

  // ---------- Повторное открытие: знакомые входят сами ----------
  await clickText(host, 'button', 'Открыть комнату снова');
  await clickText(host, 'button', 'Открыть комнату');
  await host.waitForSelector('.call', { timeout: 20000 });
  await g1.goto(link);
  await clickText(g1, 'button', 'Попроситься войти');
  await waitFor(g1, () => document.querySelector('.call'), 'знакомая Маша входит в новую встречу без «Впустить»', 40000);
  ok(await host.evaluate(() => !document.querySelector('.toast .receipt')), 'хозяйку не спрашивали про знакомую');

  // ---------- Код входа ----------
  await openPanel(host, 'Участники');
  await typeInto(host, 'Пусто — без кода', 'Сезам 42');
  await clickText(host, '.panel button', 'Сохранить');
  const g5 = await open('g5');
  await g5.goto(link);
  await typeInto(g5, 'Как вас зовут', 'С кодом');
  await typeInto(g5, 'Если хозяин дал код', '  сезам 42 ');
  await clickText(g5, 'button', 'Попроситься войти');
  await waitFor(g5, () => document.querySelector('.call'), 'гость с верным кодом входа входит сразу', 40000);
  const g6 = await open('g6');
  await g6.goto(link);
  await typeInto(g6, 'Как вас зовут', 'Угадайка');
  await typeInto(g6, 'Если хозяин дал код', 'сезам 43');
  await clickText(g6, 'button', 'Попроситься войти');
  await waitFor(g6, () => document.body.textContent.replace(/\u00a0/g, ' ').includes('Код входа не подошёл'), 'с неверным кодом гость видит «Код входа не подошёл»');
  await waitFor(host, () => [...document.querySelectorAll('.panel .knock')].some((k) => k.textContent.includes('Угадайка')), 'а хозяйка видит его запрос как обычно');

  // ---------- Код хозяина: стать хозяином на другом устройстве ----------
  const h1 = await open('h1');
  await h1.goto(URL);
  await clickText(h1, 'button', 'Создать комнату');
  await typeInto(h1, 'Как вас зовут', 'Первый');
  await typeInto(h1, 'Например, созвон дизайнеров', 'Передача');
  await typeInto(h1, 'Не короче 8 знаков', 'зелёный слон пьёт чай');
  await clickText(h1, 'button', 'Создать и войти');
  await h1.waitForSelector('.linkbox', { timeout: 30000 });
  const link2 = await h1.$eval('.linkbox', (el) => el.textContent);
  const gx = await open('gx');
  await joinAsGuest(gx, link2, 'Гость');
  await waitFor(h1, () => document.querySelector('.toast .receipt b'), 'первый хозяин видит гостя');
  await clickText(h1, '.toast button', 'Впустить');
  await waitFor(gx, () => document.querySelector('.call'), 'гостя впустили к первому хозяину');
  const h2 = await open('h2');
  await h2.goto(link2);
  await typeInto(h2, 'Как вас зовут', 'Второй');
  await clickText(h2, 'button', 'Я хозяин этой комнаты');
  await typeInto(h2, 'Код хозяина', 'неверный код тут');
  await clickText(h2, 'button', 'Войти хозяином');
  await waitFor(h2, () => document.body.textContent.replace(/\u00a0/g, ' ').includes('Код не подошёл'), 'неверный код хозяина не пускает');
  await h2.$eval('input[placeholder="Код хозяина"]', (el) => { el.value = ''; });
  await h2.type('input[placeholder="Код хозяина"]', 'Зелёный  слон пьёт чай');
  await clickText(h2, 'button', 'Войти хозяином');
  await waitFor(h2, () => document.querySelector('.call'), 'по верному коду второе устройство стало хозяином', 30000);
  await waitFor(h1, () => document.querySelector('.call') && document.querySelector('.ctl[aria-label="Выйти"]'), 'первое устройство осталось в звонке гостем, без стука', 45000);
  await waitFor(h2, () => document.querySelector('.topbar .title')?.textContent === 'Передача', 'название встречи переехало на новое устройство', 30000);
  await waitFor(gx, () => [...document.querySelectorAll('.tile.remote video')].some((v) => v.videoWidth > 0 && !v.hidden), 'гость снова видит хозяина — уже на новом устройстве', 60000);
  ok(await gx.evaluate(() => !!document.querySelector('.call')), 'гостя при смене хозяина не выкинуло');
  await waitFor(gx, () => [...document.querySelectorAll('.tile.remote .label')].some((l) => l.textContent.includes('Первый')), 'гость видит прежнего хозяина среди участников', 45000);

  // ---------- Хозяин вылетел, а код хозяина есть у первого устройства ----------
  await h2.close(); // вылетел: вкладка закрылась без «Завершить»
  await waitFor(h1, () => document.querySelector('.ctl[aria-label="Завершить встречу"]'), 'устройство с кодом хозяина само стало хозяином', 60000);
  ok(await gx.evaluate(() => !!document.querySelector('.call')), 'гость остался в звонке, пока менялся хозяин');
  await waitFor(gx, () => [...document.querySelectorAll('.tile.remote video')].some((v) => v.videoWidth > 0 && !v.hidden), 'гость видит нового хозяина', 60000);

  // ---------- Хозяин вылетел, кода ни у кого нет: временный хозяин ----------
  const hd = await open('hd');
  await hd.goto(URL);
  await clickText(hd, 'button', 'Создать комнату');
  await typeInto(hd, 'Как вас зовут', 'Вылетающий');
  await clickText(hd, 'button', 'Создать и войти');
  await hd.waitForSelector('.linkbox', { timeout: 30000 });
  const link3 = await hd.$eval('.linkbox', (el) => el.textContent);
  const da = await open('da');
  await joinAsGuest(da, link3, 'Аня');
  await waitFor(hd, () => document.querySelector('.toast .receipt b'), 'хозяин видит Аню');
  await clickText(hd, '.toast button', 'Впустить');
  await waitFor(da, () => document.querySelector('.call'), 'Аню впустили');
  const db = await open('db');
  await joinAsGuest(db, link3, 'Боря');
  await waitFor(hd, () => document.querySelector('.toast .receipt b'), 'хозяин видит Борю');
  await clickText(hd, '.toast button', 'Впустить');
  await waitFor(db, () => document.querySelector('.call'), 'Борю впустили');
  await waitFor(db, () => [...document.querySelectorAll('.tile.remote video')].filter((v) => v.videoWidth > 0 && !v.hidden).length >= 2, 'втроём видят друг друга', 45000);
  await hd.close();
  await waitFor(da, () => document.body.textContent.replace(/\u00a0/g, ' ').includes('временный хозяин — вы'), 'первая впущенная Аня стала временным хозяином', 70000);
  await waitFor(db, () => document.body.textContent.replace(/\u00a0/g, ' ').includes('гостей впускает Аня'), 'Боря видит, что впускает Аня', 30000);
  const dc = await open('dc');
  await joinAsGuest(dc, link3, 'Вика');
  await waitFor(da, () => document.querySelector('.toast .receipt b'), 'временный хозяин видит, что Вика просится', 45000);
  await clickText(da, '.toast button', 'Впустить');
  await waitFor(dc, () => document.querySelector('.call'), 'временный хозяин впустил Вику', 30000);
  await waitFor(dc, () => [...document.querySelectorAll('.tile.remote video')].filter((v) => v.videoWidth > 0 && !v.hidden).length >= 2, 'Вика видит Аню и Борю', 60000);
  ok(await db.evaluate(() => !!document.querySelector('.call')), 'Борю не выкинуло');
} catch (e) {
  console.error('ОШИБКА ТЕСТА', e);
  failed++;
} finally {
  await browser.close();
}
console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nВСЁ ПРОШЛО');
process.exit(failed ? 1 : 0);
