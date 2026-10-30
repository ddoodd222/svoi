// Карточные игры в настоящем звонке: трое садятся за стол и доигрывают партии до конца кликами, как люди.
// Запуск: python3 -m http.server 8787 --directory web, потом node tests/games-e2e.test.mjs

import puppeteer from 'puppeteer-core';

const URL = process.env.SVOI_URL || 'http://localhost:8787/';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let failed = 0;
const ok = (cond, what) => { console.log((cond ? 'ok  ' : 'FAIL') + ' ' + what); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-first-run'] });
const errors = [];
async function open(name, mobile = false) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport(mobile ? { width: 390, height: 844, isMobile: true, hasTouch: true } : { width: 1200, height: 800 });
  p.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
  p.on('dialog', (d) => d.accept());
  p.tag = name;
  return p;
}
const norm = (s) => s.replace(/ /g, ' ');
async function clickText(p, sel, text) {
  await p.waitForFunction((s, t) => [...document.querySelectorAll(s)].some((b) => b.textContent.replace(/ /g, ' ').includes(t) && !b.disabled), { timeout: 30000 }, sel, text);
  await p.evaluate((s, t) => [...document.querySelectorAll(s)].find((b) => b.textContent.replace(/ /g, ' ').includes(t) && !b.disabled).click(), sel, text);
}
async function type(p, ph, v) { await p.waitForSelector(`input[placeholder="${ph}"]`); await p.type(`input[placeholder="${ph}"]`, v); }
async function waitFor(p, fn, what, timeout = 30000, ...args) {
  try { await p.waitForFunction(fn, { timeout, polling: 200 }, ...args); ok(true, what); return true; } catch { ok(false, `${what} (${p.tag})`); return false; }
}
const status = (p) => p.evaluate(() => (document.querySelector('.game .g-status p')?.textContent || '').replace(/ /g, ' '));

// Один ход: что-то из доступного на экране — карта, цель на столе, кнопка, масть, колода.
const ACT = () => {
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const q = (s) => [...document.querySelectorAll(s)];
  const suits = q('.game .g-suits button');
  if (suits.length) { pick(suits).click(); return 'suit'; }
  const targets = q('.game .pair.target');
  if (targets.length) { targets[0].click(); return 'target'; }
  const cards = q('.game .g-hand button.card:not(:disabled)');
  const buttons = q('.game .g-actions button:not(:disabled)');
  const deck = q('.game .g-deck.as-btn:not(:disabled)');
  // Карты — чаще, чем «Беру»/«Пас»: так партии похожи на настоящие и не тянутся вечно.
  if (cards.length && (Math.random() < 0.8 || !buttons.length)) { pick(cards).click(); return 'card'; }
  if (buttons.length) { pick(buttons).click(); return 'button'; }
  if (deck.length) { deck[0].click(); return 'draw'; }
  return null;
};

async function playToEnd(pages, label, maxSteps = 4000) {
  let steps = 0, idle = 0;
  while (steps < maxSteps) {
    let acted = false;
    for (const p of pages) {
      const st = await status(p);
      if (/Дурак —|Ничья|Победа/.test(st)) return { steps, over: true };
      const r = await p.evaluate(ACT);
      if (r) { acted = true; steps++; await sleep(40); }
    }
    idle = acted ? 0 : idle + 1;
    if (idle > 60) return { steps, over: false, stuck: true };
    if (!acted) await sleep(100);
  }
  return { steps, over: false };
}

try {
  // ---------- звонок втроём ----------
  const host = await open('Аня');
  await host.goto(URL);
  await clickText(host, 'button', 'Создать комнату');
  await type(host, 'Как вас зовут', 'Аня');
  await host.evaluate(() => document.querySelector('input[name="entry-new"][value="link"]').click());
  await clickText(host, 'button', 'Создать и войти');
  await host.waitForSelector('.linkbox', { timeout: 30000 });
  const link = await host.$eval('.linkbox', (e) => e.textContent);
  const others = [];
  for (const [name, mobile] of [['Петя', true], ['Вика', false]]) {
    const p = await open(name, mobile);
    await p.goto(link);
    await type(p, 'Как вас зовут', name);
    await clickText(p, 'button', 'Попроситься войти');
    await p.waitForSelector('.call', { timeout: 40000 });
    others.push(p);
  }
  const [petya, vika] = others;
  const all = [host, petya, vika];
  for (const p of all) await p.waitForFunction(() => [...document.querySelectorAll('.tile.remote video')].filter((v) => v.videoWidth > 0).length >= 2, { timeout: 60000 });
  await host.evaluate(() => document.querySelector('.panel button[aria-label="Закрыть"]')?.click());
  ok(true, 'звонок втроём собран');

  // ---------- дурак: приглашение, отказ, согласие ----------
  await host.click('.ctl[aria-label="Реакции и голоса"]');
  await host.waitForSelector('.react-pop .games-row button[data-game="durak"]');
  await host.click('.react-pop .games-row button[data-game="durak"]');
  await waitFor(host, () => document.querySelector('.game .g-lobby'), 'Аня позвала в дурака — у неё лобби');
  ok(await host.evaluate(() => document.querySelector('.stage.present .main .game') && document.querySelectorAll('.stage .strip .tile').length >= 3), 'стол крупно, видео всех — полосой рядом');
  for (const p of others) await waitFor(p, () => document.querySelector('.toast.game-invite'), 'приглашение пришло: ' + p.tag);
  ok(norm(await petya.$eval('.toast.game-invite b', (e) => e.textContent)) === 'Аня зовёт в дурака', 'текст приглашения: «Аня зовёт в дурака»');
  await clickText(vika, '.toast.game-invite button', 'Не сейчас');
  ok(await vika.evaluate(() => !document.querySelector('.toast.game-invite') && !document.querySelector('.game .g-lobby')), 'Вика отказалась — приглашение пропало, стола нет');
  await clickText(petya, '.toast.game-invite button', 'Играть');
  await waitFor(host, () => document.querySelectorAll('.game .g-seats li').length === 2, 'Петя сел за стол — у Ани двое');
  await clickText(host, '.game button', 'Начать');
  await waitFor(petya, () => document.querySelectorAll('.game .g-hand .card').length === 6, 'раздали: у Пети 6 карт');
  ok(await host.evaluate(() => document.querySelectorAll('.game .g-hand .card').length === 6), 'у Ани 6 карт');
  const handsDiffer = await host.evaluate(() => [...document.querySelectorAll('.game .g-hand .card')].map((c) => c.dataset.card).join())
    !== await petya.evaluate(() => [...document.querySelectorAll('.game .g-hand .card')].map((c) => c.dataset.card).join());
  ok(handsDiffer, 'руки у игроков разные');
  const leak = await petya.evaluate(() => document.querySelector('.game').outerHTML);
  const aniaCards = await host.evaluate(() => [...document.querySelectorAll('.game .g-hand .card')].map((c) => c.dataset.card));
  const trump = await petya.evaluate(() => document.querySelector('.game .card.trump')?.dataset.card || '');
  ok(aniaCards.every((c) => c === trump || !leak.includes(`data-card="${c}"`)), 'на экране Пети нет ни одной карты Ани');
  ok(await vika.evaluate(() => !document.querySelector('.game .g-hand')), 'у Вики (не играет) стола нет, звонок как был');
  const r1 = await playToEnd([host, petya], 'дурак');
  ok(r1.over, `дурак вдвоём доигран до конца: ${r1.steps} ходов${r1.stuck ? ' (ЗАСТРЯЛО)' : ''}`);
  const s1 = await status(host), s2 = await status(petya);
  ok(/Дурак —|Ничья/.test(s1) && /Дурак —|Ничья/.test(s2), `итог у обоих: «${s1}» / «${s2}»`);
  ok(await vika.evaluate(() => !document.querySelector('.toast.game-invite')), 'отказавшуюся Вику повторно не зовут, хотя приглашение повторяется для новых');
  ok((s1.includes('Дурак — вы') && s2.includes('Дурак — Аня')) || (s2.includes('Дурак — вы') && s1.includes('Дурак — Петя')) || (s1.includes('Ничья') && s2.includes('Ничья')), 'итог совпадает у обоих');

  // ---------- ещё раз, потом закрыть стол ----------
  await clickText(host, '.game button', 'Ещё раз');
  await waitFor(petya, () => document.querySelectorAll('.game .g-hand .card').length === 6 && !/Дурак —|Ничья/.test(document.querySelector('.game .g-status p')?.textContent || ''), '«Ещё раз»: новая раздача тем же составом');
  await clickText(host, '.game button', 'Выйти из игры');
  await clickText(host, '.modal button', 'Закрыть');
  await waitFor(petya, () => (document.querySelector('.game .g-note p')?.textContent || '').includes('Ведущий закрывает стол'), 'Аня закрыла стол посреди партии — Петя видит почему');
  await waitFor(host, () => !document.querySelector('.stage.present'), 'у Ани стол убран, снова обычная сетка');
  await clickText(petya, '.game .g-note button', 'Закрыть');
  await waitFor(petya, () => !document.querySelector('.stage.present .game'), 'Петя закрыл надпись — стол убран');

  // ---------- восьмёрки втроём ----------
  await vika.click('.ctl[aria-label="Реакции и голоса"]');
  await vika.waitForSelector('.react-pop .games-row button[data-game="eights"]');
  await vika.click('.react-pop .games-row button[data-game="eights"]');
  for (const p of [host, petya]) { await waitFor(p, () => document.querySelector('.toast.game-invite'), 'приглашение в восьмёрки: ' + p.tag); await clickText(p, '.toast.game-invite button', 'Играть'); }
  await waitFor(vika, () => document.querySelectorAll('.game .g-seats li').length === 3, 'за столом трое');
  await clickText(vika, '.game button', 'Начать');
  for (const p of all) await waitFor(p, () => document.querySelectorAll('.game .g-hand .card').length === 5, 'по 5 карт: ' + p.tag);
  const r2 = await playToEnd(all, 'восьмёрки');
  ok(r2.over, `восьмёрки втроём доиграны: ${r2.steps} ходов${r2.stuck ? ' (ЗАСТРЯЛО)' : ''}`);
  const finals = await Promise.all(all.map(status));
  ok(finals.every((t) => /Победа/.test(t)) && finals.filter((t) => t.includes('Победа ваша')).length === 1, `один победитель у всех: ${finals.map((t) => t.slice(0, 30)).join(' | ')}`);

  // ---------- игрок уходит посреди партии ----------
  await clickText(vika, '.game button', 'Ещё раз');
  await waitFor(host, () => document.querySelectorAll('.game .g-hand .card').length === 5, 'новая партия восьмёрок');
  await clickText(petya, '.game button', 'Выйти из игры');
  await clickText(petya, '.modal button', 'Выйти');
  for (const p of [host, vika]) await waitFor(p, () => (document.querySelector('.game .g-note p')?.textContent || '').replace(/ /g, ' ').includes('Петя встаёт из-за стола'), 'Петя вышел — партия прервана у ' + p.tag);

  // ---------- дурак втроём: подкидывают двое ----------
  await clickText(host, '.game .g-note button', 'Закрыть');
  await clickText(vika, '.game .g-note button', 'Закрыть');
  await vika.click('.ctl[aria-label="Реакции и голоса"]');
  await vika.waitForSelector('.react-pop .games-row button[data-game="durak"]');
  await vika.click('.react-pop .games-row button[data-game="durak"]');
  for (const p of [host, petya]) { await waitFor(p, () => document.querySelector('.toast.game-invite'), 'дурак втроём, приглашение: ' + p.tag); await clickText(p, '.toast.game-invite button', 'Играть'); }
  await waitFor(vika, () => document.querySelectorAll('.game .g-seats li').length === 3, 'дурак: за столом трое');
  await clickText(vika, '.game button', 'Начать');
  for (const p of all) await waitFor(p, () => document.querySelectorAll('.game .g-hand .card').length === 6, 'дурак втроём, по 6 карт: ' + p.tag);
  const r3 = await playToEnd(all, 'дурак втроём');
  ok(r3.over, `дурак втроём доигран до конца: ${r3.steps} ходов${r3.stuck ? ' (ЗАСТРЯЛО)' : ''}`);
  const f3 = await Promise.all(all.map(status));
  const loserSelf = f3.filter((t) => t.includes('Дурак — вы')).length;
  ok(f3.every((t) => /Дурак —|Ничья/.test(t)) && (loserSelf === 1 || f3.every((t) => t.includes('Ничья'))), `один дурак у всех: ${f3.map((t) => t.slice(0, 22)).join(' | ')}`);
  for (const p of [host, petya]) await clickText(p, '.game button', 'Встать из-за стола');
  await waitFor(vika, () => !document.querySelector('.game .g-bar button.primary') && (document.querySelector('.game .g-bar .hint')?.textContent || '').replace(/\u00a0/g, ' ').includes('нужен ещё хотя бы один игрок'),
    'все встали — у ведущей вместо «Ещё раз» объяснение, что играть не с кем');
  if (!await waitFor(host, () => !document.querySelector('.stage.present .game'), 'вставшая из-за стола Аня — снова в обычном звонке', 8000)) {
    console.log('ДИАГНОСТИКА', await host.evaluate(() => JSON.stringify({ stage: document.querySelector('.stage').className, kids: [...document.querySelector('.stage').children].map((c) => c.className), game: document.querySelector('.game')?.innerText.slice(0, 200), hidden: document.hidden })));
  }
  await clickText(vika, '.game button', 'Закрыть стол');

  // ---------- перезагрузка посреди партии: игрок вернулся в звонок быстро, стол не висит ----------
  await host.click('.ctl[aria-label="Реакции и голоса"]');
  await host.waitForSelector('.react-pop .games-row button[data-game="durak"]');
  await host.click('.react-pop .games-row button[data-game="durak"]');
  await waitFor(petya, () => document.querySelector('.toast.game-invite'), 'перезагрузка: Пете приглашение');
  await clickText(petya, '.toast.game-invite button', 'Играть');
  await waitFor(host, () => document.querySelectorAll('.game .g-seats li').length === 2, 'перезагрузка: Петя за столом');
  await clickText(host, '.game button', 'Начать');
  await waitFor(petya, () => document.querySelectorAll('.game .g-hand .card').length === 6, 'перезагрузка: раздали');
  await petya.reload();
  await clickText(petya, 'button', 'Попроситься войти');
  await waitFor(petya, () => document.querySelector('.call'), 'Петя перезагрузил страницу и вернулся в звонок', 40000);
  await waitFor(host, () => (document.querySelector('.game .g-note p')?.textContent || '').includes('партия прервана'), 'у Ани партия честно прервана, а не ждёт хода Пети вечно', 30000);
  ok(await petya.evaluate(() => !document.querySelector('.stage.present .game')), 'у вернувшегося Пети нет стола-призрака');
  await clickText(host, '.game .g-note button', 'Закрыть');

  // ---------- перезагрузка ведущего: у игрока стол закрывается ----------
  await petya.click('.ctl[aria-label="Реакции и голоса"]');
  await petya.waitForSelector('.react-pop .games-row button[data-game="eights"]');
  await petya.click('.react-pop .games-row button[data-game="eights"]');
  await waitFor(host, () => document.querySelector('.toast.game-invite'), 'Ане приглашение от Пети');
  await clickText(host, '.toast.game-invite button', 'Играть');
  await waitFor(petya, () => document.querySelectorAll('.game .g-seats li').length === 2, 'Аня за столом у Пети');
  await clickText(petya, '.game button', 'Начать');
  await waitFor(host, () => document.querySelectorAll('.game .g-hand .card').length === 7, 'восьмёрки вдвоём: по 7 карт');
  await petya.reload();
  await clickText(petya, 'button', 'Попроситься войти');
  await waitFor(petya, () => document.querySelector('.call'), 'ведущий Петя перезагрузил страницу и вернулся', 40000);
  await waitFor(host, () => (document.querySelector('.game .g-note p')?.textContent || '').includes('стол закрыт'), 'у Ани стол Пети закрылся сам, без зависшей партии', 40000);
  await clickText(host, '.game .g-note button', 'Закрыть');

  // ---------- ведущий уходит из звонка ----------
  await host.click('.ctl[aria-label="Реакции и голоса"]');
  await host.waitForSelector('.react-pop .games-row button[data-game="durak"]');
  await host.click('.react-pop .games-row button[data-game="durak"]');
  await waitFor(vika, () => document.querySelector('.toast.game-invite'), 'Вике новое приглашение');
  await clickText(vika, '.toast.game-invite button', 'Играть');
  await clickText(host, '.game button', 'Начать');
  await waitFor(vika, () => document.querySelectorAll('.game .g-hand .card').length === 6, 'Аня и Вика играют');
  await host.close();
  await waitFor(vika, () => (document.querySelector('.game .g-note p')?.textContent || '').includes('стол закрыт'), 'ведущая закрыла вкладку — у Вики «стол закрыт», без зависшей партии', 60000);

  ok(!errors.length, 'ошибок на страницах нет' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
} catch (e) {
  console.error('ОШИБКА ТЕСТА', e);
  failed++;
} finally {
  await browser.close();
}
console.log(failed ? `\nПРОВАЛОВ: ${failed}` : '\nВСЁ ПРОШЛО');
process.exit(failed ? 1 : 0);
