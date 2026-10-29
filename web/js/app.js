// Экраны приложения «Свои»: главный, подготовка, ожидание, звонок, конец.

import { h, icon, replace, clear, initials } from './dom.js';
import * as C from './crypto.js';
import { Room, MAX_MEMBERS, SLOT, REACTIONS, IMG_MAX } from './room.js';
import { LocalMedia } from './media.js';
import { prefs, rooms, session, keys } from './store.js';
import { makeLink, parseLink } from './link.js';
import { native } from './native.js';
import qrcode from './vendor/qrcode.js';
import { checkBroker, checkStun, BROKERS, STUN } from './diag.js';
import { clearRetained } from './signal.js';

const app = document.getElementById('app');
const isTouch = matchMedia('(pointer: coarse)').matches;
let media = null;
let call = null;

function show(node) {
  replace(app, node);
  window.scrollTo(0, 0);
}

// ---------- запуск ----------

function boot() {
  // Страницу нельзя встраивать в чужой сайт: так её не подсунут под чужие кнопки.
  if (window.top !== window.self) {
    return show(h('main', { class: 'screen' }, h('div', { class: 'waiting' },
      h('h1', { text: 'Откройте ссылку напрямую' }),
      h('p', { class: 'hint', text: 'Звонок нельзя открыть внутри другого сайта. Скопируйте адрес и откройте его в новой вкладке.' }))));
  }
  if (!window.isSecureContext || !globalThis.crypto?.subtle || !window.RTCPeerConnection) return show(unsupported());
  keys.prune();
  const fromHash = location.hash.length > 1 ? parseLink(location.hash) : null;
  if (location.hash) history.replaceState(null, '', location.pathname + location.search); // секрет не остаётся в истории
  if (fromHash) return openLink(fromHash);
  const saved = parseLink(session.get());
  if (saved) return openLink(saved);
  home();
}

// Ссылку вставили в адресную строку уже открытой страницы.
window.addEventListener('hashchange', () => {
  const l = location.hash.length > 1 ? parseLink(location.hash) : null;
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  if (l && !call) openLink(l);
});

// Звонок свёрнут в окошко поверх других приложений: показываем одного человека, без кнопок и панелей.
native.onPip((on) => {
  document.documentElement.classList.toggle('pip-mode', on);
  if (!call) return;
  call.pipMode = on;
  if (on) closeReactions();
  scheduleRender();
});
native.onPipAction((a) => {
  if (!media || !call) return;
  if (a === 'mic') media.setMic(!media.state().mic);
  if (a === 'cam') media.setCam(!media.state().cam);
  prefs.media = { mic: media.micOn, cam: media.camOn };
});
native.onReady(() => native.setVideoSound(prefs.videoSound));

native.onLink((url) => {
  const l = parseLink(url);
  if (l && !call) openLink(l);
});

function openLink(link) {
  session.set(makeLink(link));
  const mine = rooms.get(link.hostId);
  if (mine && mine.secret === C.b64u(link.secret)) prejoin({ mode: 'host', record: mine });
  else prejoin({ mode: 'guest', link });
}

function unsupported() {
  return h('main', { class: 'screen' }, h('div', { class: 'waiting' },
    h('h1', { text: 'Этот браузер не подходит' }),
    h('p', { class: 'hint', text: 'Нужен современный браузер и защищённый адрес https. Откройте ссылку в Chrome, Safari, Firefox или Edge последней версии.' }),
  ));
}

// ---------- главный экран ----------

function home() {
  session.clear();
  stopMedia();
  const linkInput = h('input', { class: 'input mono', placeholder: 'Вставьте ссылку-приглашение', autocomplete: 'off', spellcheck: 'false' });
  const linkErr = h('p', { class: 'error', hidden: true });

  const create = () => prejoin({ mode: 'host', record: null });
  const join = () => {
    const l = parseLink(linkInput.value);
    if (!l) { linkErr.hidden = false; linkErr.textContent = 'Это не похоже на ссылку-приглашение. Скопируйте её целиком.'; return; }
    openLink(l);
  };
  linkInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

  const list = rooms.list();
  const roomList = list.length ? h('div', { class: 'block' },
    h('h2', { text: 'Ваши комнаты' }),
    h('p', { class: 'hint', text: 'Комната живёт по той же ссылке, пока вы её не удалите.' }),
    h('ul', { class: 'rooms' }, list.map((r) => h('li', {},
      h('div', { class: 'name' }, h('b', { raw: r.title || 'Встреча без названия' }), h('small', { text: 'создана ' + new Date(r.created).toLocaleDateString('ru-RU') })),
      h('button', { class: 'btn small', on: { click: () => prejoin({ mode: 'host', record: r }) } }, 'Открыть'),
      h('button', {
        class: 'btn small ghost', 'aria-label': 'Удалить комнату', title: 'Удалить комнату',
        on: { click: async () => { if (await confirmModal('Удалить комнату?', 'Ссылка перестанет работать навсегда. Это нельзя отменить.', 'Удалить')) {
          if (r.hostCode) C.roomKeys(C.unb64u(r.secret)).then((k) => clearRetained(k.topic)).catch(() => {});
          rooms.remove(r.hostId); home();
        } } },
      }, icon('trash')),
    ))),
  ) : null;

  show(h('main', { class: 'screen' }, h('div', { class: 'home' },
    h('header', { class: 'brand' },
      // Название прокручивается по кругу: «Свои» ↔ «Хорнет». Экранный диктор читает просто «Свои».
      h('h1', { 'aria-label': 'Свои' }, h('span', { class: 'brand-word', 'aria-hidden': 'true' }, h('span', { raw: 'Свои' }), h('span', { raw: 'Хорнет' }))),
      h('p', { text: 'Видеозвонки только для своих. Хозяин сам впускает каждого гостя.' }),
    ),
    h('div', { class: 'home-grid' },
      h('div', { class: 'stack' },
        h('section', { class: 'block' },
          h('h2', { text: 'Новая встреча' }),
          h('p', { class: 'hint', text: 'Вы станете хозяином комнаты и получите ссылку для гостей.' }),
          h('button', { class: 'btn primary wide', on: { click: create } }, 'Создать комнату'),
        ),
        h('div', { class: 'divider' }),
        h('section', { class: 'block' },
          h('h2', { text: 'Есть ссылка?' }),
          linkInput,
          linkErr,
          h('div', { class: 'row' },
            h('button', { class: 'btn', on: { click: join } }, 'Войти по ссылке'),
            native.available ? h('button', { class: 'btn ghost', on: { click: async () => { linkInput.value = await native.readClipboard(); } } }, 'Вставить') : null,
          ),
        ),
        roomList,
      ),
      h('section', { class: 'block' },
        h('h2', { text: 'Как это защищено' }),
        securityFacts(),
        h('div', { class: 'footer-links' },
          h('button', { class: 'link', on: { click: () => securityModal() } }, 'Подробнее о защите'),
          h('button', { class: 'link', on: { click: () => networkModal() } }, 'Настройки соединения'),
          h('button', { class: 'link', on: { click: () => diagModal() } }, 'Проверка связи'),
        ),
      ),
    ),
  )));
}

function securityFacts() {
  const facts = [
    'Видео, звук и экран идут напрямую между участниками. Своего сервера у звонка нет.',
    'Ключ комнаты хранится только в ссылке, в части после #. Эта часть не уходит ни на какой сервер.',
    'Одной ссылки мало: хозяин видит запрос и впускает каждого сам.',
    'Код проверки из девяти цифр показывает, что на связи именно тот человек.',
  ];
  return h('ul', { class: 'facts' }, facts.map((f) => h('li', {}, icon('check'), h('span', { text: f }))));
}

// ---------- подготовка ко входу ----------

async function ensureMedia() {
  if (media) return media;
  media = new LocalMedia();
  media.noise = prefs.noise;
  media.echo = prefs.echo;
  await media.start(prefs.media);
  return media;
}

function stopMedia() {
  media?.stopAll();
  media = null;
}

async function prejoin(ctx) {
  const isHost = ctx.mode === 'host';
  const nameInput = h('input', { class: 'input', autocomplete: 'nickname', maxlength: '40', placeholder: 'Как вас зовут', value: prefs.name });
  const titleInput = isHost ? h('input', { class: 'input', maxlength: '80', placeholder: 'Например, созвон дизайнеров', value: ctx.record?.title || '' }) : null;
  const err = h('p', { class: 'error', hidden: true });
  const video = h('video', { autoplay: true, playsInline: true, muted: true });
  video.muted = true;
  const off = h('div', { class: 'preview-off' });
  const micBtn = h('button', { class: 'ctl' });
  const camBtn = h('button', { class: 'ctl' });
  const devices = h('div', { class: 'stack' });
  const go = h('button', { class: 'btn primary wide' }, isHost ? (ctx.record ? 'Открыть комнату' : 'Создать и войти') : 'Попроситься войти');
  const savedCode = ctx.record?.saved?.entryCode || '';
  const entryInput = h('input', { class: 'input mono', maxlength: '40', autocomplete: 'off', spellcheck: 'false',
    placeholder: isHost ? 'Например, 4815' : 'Если хозяин дал код', value: isHost ? savedCode : (session.entryCode || '') });
  const hostCodeInput = h('input', { class: 'input mono', type: 'password', maxlength: '80', autocomplete: 'new-password', placeholder: 'Не короче 8 знаков' });
  let entryMode = ctx.record?.saved?.openLink ? 'link' : 'ask';
  const entryField = h('label', { class: 'field' }, h('span', { text: 'Код входа' }), entryInput,
    h('small', { class: 'hint', text: 'С этим кодом гости входят сразу, без вашего «Впустить».' }));
  const lead = h('p', { class: 'hint' });
  const syncOpen = () => {
    entryField.hidden = entryMode === 'link';
    lead.textContent = isHost
      ? (entryMode === 'link' ? 'Вы хозяин. Кто откроет ссылку, сразу окажется в звонке.' : 'Вы хозяин. Гости попросятся войти, и вы сами решите, кого впустить.')
      : 'Хозяин увидит ваше имя и код проверки. Потом решит, впустить ли вас.';
  };
  const entryChoice = isHost ? choiceGroup('Кто может войти', 'entry-new', [
    ['link', 'Все, у кого есть ссылка', 'Входят сразу. Ссылка и есть пропуск, пересылайте её только своим.'],
    ['ask', 'Те, кого вы впустите', 'Каждый просится войти, вы нажимаете «Впустить».'],
  ], entryMode, (v) => { entryMode = v; syncOpen(); }) : null;
  syncOpen();
  const codeFields = isHost
    ? [
      entryChoice,
      disclosure('Коды входа и хозяина', !!savedCode, [entryField,
      ctx.record
        ? (ctx.record.hostCode ? h('p', { class: 'hint', text: 'У комнаты есть код хозяина. С ним можно стать хозяином на другом устройстве.' }) : null)
        : h('label', { class: 'field' }, h('span', { text: 'Код хозяина' }), hostCodeInput,
          h('small', { class: 'hint', text: 'С ним вы или друг станете хозяином на другом устройстве. Задаётся один раз, сейчас. Лучше три-четыре слова.' })),
      ]),
    ]
    : [h('label', { class: 'field' }, h('span', { text: 'Код входа (по желанию)' }), entryInput,
        h('small', { class: 'hint', text: 'С кодом хозяина вы войдёте сразу, без ожидания у двери.' }))];
  // «Я хозяин этой комнаты»: войти хозяином на этом устройстве по коду хозяина.
  const hostClaim = isHost ? null : (() => {
    const code = h('input', { class: 'input mono', type: 'password', maxlength: '80', autocomplete: 'off', placeholder: 'Код хозяина' });
    const btn = h('button', { class: 'btn small' }, 'Войти хозяином');
    const msg = h('p', { class: 'hint', hidden: true });
    const box = h('div', { class: 'stack', hidden: true }, code, h('div', { class: 'row' }, btn), msg);
    const toggle = h('button', { class: 'link', on: { click: () => { box.hidden = !box.hidden; if (!box.hidden) code.focus(); } } }, 'Я хозяин этой комнаты');
    btn.onclick = async () => {
      const name = nameInput.value.trim();
      if (!name) { msg.hidden = false; msg.textContent = 'Сначала напишите имя.'; nameInput.focus(); return; }
      btn.disabled = true;
      msg.hidden = false;
      msg.textContent = 'Проверяем код. Это занимает пару секунд: так код труднее подобрать.';
      try {
        const ok = await startAsHostByCode(ctx.link, name, code.value);
        if (!ok) { msg.textContent = 'Код не подошёл.'; btn.disabled = false; }
      } catch (e) { msg.textContent = 'Не получилось: ' + (e.message || 'ошибка'); btn.disabled = false; }
    };
    return h('div', { class: 'stack', style: { gap: '8px' } }, toggle, box);
  })();

  const paint = () => {
    const s = media.state();
    replace(micBtn, icon(s.mic ? 'mic' : 'micOff'));
    replace(camBtn, icon(s.cam ? 'cam' : 'camOff'));
    micBtn.classList.toggle('off', !s.mic);
    camBtn.classList.toggle('off', !s.cam);
    micBtn.setAttribute('aria-label', s.mic ? 'Выключить микрофон' : 'Включить микрофон');
    camBtn.setAttribute('aria-label', s.cam ? 'Выключить камеру' : 'Включить камеру');
    const stream = media.camStream;
    if (video.srcObject?.getVideoTracks()[0] !== media.cam) video.srcObject = stream;
    video.hidden = !s.cam;
    const e = media.errors;
    off.textContent = e.all ? 'Браузер не даёт доступ к камере и микрофону.'
      : e.cam && media.camOn !== false ? 'Нет доступа к камере. Разрешите его в настройках браузера или войдите без видео.'
      : s.cam ? '' : 'Камера выключена';
    off.hidden = s.cam;
  };

  show(h('main', { class: 'screen' }, h('div', { class: 'prejoin' },
    h('div', { class: 'stack' },
      h('div', { class: 'topback' },
        h('button', { class: 'btn small ghost', on: { click: () => home() } }, icon('back'), 'Назад'),
        h('button', { class: 'secure', on: { click: () => securityModal() } }, h('i'), 'Сквозное шифрование'),
      ),
      h('div', { class: 'preview' }, video, off, h('div', { class: 'preview-ctl' }, micBtn, camBtn)),
    ),
    h('div', { class: 'stack' },
      h('h1', { text: isHost ? (ctx.record ? 'Ваша комната' : 'Новая комната') : 'Вход в комнату' }),
      lead,
      h('label', { class: 'field' }, h('span', { text: 'Ваше имя' }), nameInput),
      isHost ? h('label', { class: 'field' }, h('span', { text: 'Название встречи' }), titleInput, h('small', { class: 'hint', text: 'Название увидят только те, кого вы впустите.' })) : null,
      codeFields,
      disclosure('Микрофон, шумодав и анти-эхо', false, [devices, noiseField(), echoField()]),
      err,
      go,
      hostClaim,
    ),
  )));

  const mediaReady = ensureMedia().then(() => {
    if (!app.contains(go)) return;
    paint();
    media.addEventListener('change', paint);
    micBtn.onclick = async () => { await media.setMic(!media.state().mic); prefs.media = { mic: media.micOn, cam: media.camOn }; };
    camBtn.onclick = async () => { await media.setCam(!media.state().cam); prefs.media = { mic: media.micOn, cam: media.camOn }; };
    fillDevices(devices);
  });
  nameInput.focus({ preventScroll: true });
  // Кнопка работает сразу, даже если камера ещё включается.
  go.onclick = async () => {
    const name = nameInput.value.trim();
    if (!name) { err.hidden = false; err.textContent = 'Напишите имя: по нему вас узнают.'; nameInput.focus(); return; }
    prefs.name = name;
    go.disabled = true;
    await mediaReady;
    media.removeEventListener('change', paint);
    media.resumeAudio();
    try {
      if (isHost) {
        const hostCode = hostCodeInput.value;
        if (!ctx.record && hostCode && C.normalizeCode(hostCode).length < 8) throw new Error('код хозяина короче 8 знаков');
        await startAsHost(ctx.record, name, titleInput.value.trim(), { entryCode: entryMode === 'link' ? '' : entryInput.value, hostCode, openLink: entryMode === 'link' });
      } else {
        session.entryCode = entryInput.value.trim();
        await startAsGuest(ctx.link, name, entryInput.value);
      }
    } catch (e) {
      console.error(e);
      go.disabled = false;
      err.hidden = false;
      err.textContent = 'Не получилось начать: ' + (e.message || 'неизвестная ошибка');
      media.addEventListener('change', paint);
    }
  };
}

// Выбор из нескольких вариантов карточками: все варианты видны сразу, с объяснением.
function choiceGroup(title, name, options, value, onPick) {
  const cards = options.map(([v, label, hint]) => {
    const input = h('input', { type: 'radio', name, value: v, checked: v === value });
    const card = h('label', { class: 'choice' + (v === value ? ' on' : '') }, input, h('span', {}, h('b', { text: label }), h('small', { text: hint })));
    input.addEventListener('change', () => {
      if (!input.checked) return;
      for (const c of cards) c.classList.toggle('on', c === card);
      onPick(v);
    });
    return card;
  });
  return h('fieldset', { class: 'choices' }, h('legend', { text: title }), cards);
}

// Свёрнутый блок «Ещё»: редкие настройки не мешают главному.
function disclosure(title, open, content) {
  return h('details', { class: 'more', open }, h('summary', {}, h('span', { text: title }), icon('chevron')), h('div', { class: 'stack' }, content));
}

// Переключатель в одну строку: Выключен | Обычный | Сильный.
function segmented(label, options, value, onPick) {
  const box = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label });
  const paint = (v) => { for (const b of box.children) b.setAttribute('aria-checked', b.dataset.v === v ? 'true' : 'false'); };
  for (const [v, text] of options) {
    box.append(h('button', { type: 'button', role: 'radio', 'data-v': v, on: { click: () => { if (box.dataset.busy) return; paint(v); onPick(v); } } }, text));
  }
  paint(value);
  box.paint = paint;
  return box;
}

// Поле, которое сохраняется само: по Enter или когда уходишь из поля. Рядом на секунду «Сохранено».
function autoField(label, input, save, hint) {
  const done = h('small', { class: 'saved', text: 'Сохранено' });
  let last = input.value;
  let timer = null;
  const commit = () => {
    if (input.value === last) return;
    last = input.value;
    save(input.value);
    done.classList.add('show');
    clearTimeout(timer);
    timer = setTimeout(() => done.classList.remove('show'), 1800);
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
  return h('label', { class: 'field' }, h('span', { class: 'field-head' }, h('span', { text: label }), done), input,
    hint ? h('small', { class: 'hint', text: hint }) : null);
}

async function fillDevices(box, compact = false) {
  const { mics, cams, outs = [] } = await media.devices();
  clear(box);
  const mk = (label, list, kind, current) => {
    if (list.length < 2) return null;
    const sel = h('select', { class: 'input' }, list.map((d, i) => h('option', { value: d.deviceId, raw: d.label || `${label} ${i + 1}` })));
    const active = kind === 'audioinput' ? media.mic?.getSettings?.().deviceId : media.cam?.getSettings?.().deviceId;
    sel.value = current || active || list[0].deviceId;
    sel.onchange = () => media.useDevice(kind, sel.value);
    return h('label', { class: 'field' }, h('span', { text: label }), sel);
  };
  // Динамики выбираются только там, где браузер это умеет (Chrome и Edge на компьютере).
  let speakers = null;
  if (compact && outs.length > 1 && 'setSinkId' in HTMLMediaElement.prototype) {
    const sel = h('select', { class: 'input' }, outs.map((d, i) => h('option', { value: d.deviceId, raw: d.label || `Динамики ${i + 1}` })));
    sel.value = outs.some((d) => d.deviceId === prefs.speaker) ? prefs.speaker : outs[0].deviceId;
    sel.onchange = () => { prefs.speaker = sel.value; for (const a of call?.audios.values() || []) applySpeaker(a); };
    speakers = h('label', { class: 'field' }, h('span', { text: 'Динамики' }), sel);
  }
  box.append(...[mk('Микрофон', mics, 'audioinput', media.micId), mk('Камера', cams, 'videoinput', media.camId), speakers].filter(Boolean));
  if (compact && !box.childElementCount) box.append(h('p', { class: 'hint', text: 'Других микрофонов и камер не нашлось.' }));
}

async function startAsHost(record, name, title, { entryCode = '', hostCode = '', openLink = false } = {}) {
  let rec = record;
  if (!rec) {
    const secret = C.newRoomSecret();
    // С кодом хозяина ключи выводятся из секрета и кода: так хозяином можно стать на другом устройстве.
    const k = hostCode ? await C.deriveHostKeys(secret, hostCode) : await C.createKeys();
    const id = await C.loadIdentity(k);
    await keys.put('host:' + id.id, k);
    rec = { secret: C.b64u(secret), hostId: id.id, title, created: Date.now(), turn: prefs.net.turn || null, saved: { entryCode: C.normalizeCode(entryCode), openLink: !!openLink }, hostCode: !!hostCode };
    rooms.save(rec);
  } else {
    const saved = { ...(rec.saved || {}), entryCode: C.normalizeCode(entryCode), openLink: !!openLink };
    rooms.update(rec.hostId, { title, saved });
    rec = rooms.get(rec.hostId);
  }
  const k = await keys.get('host:' + rec.hostId);
  if (!k?.sig) throw new Error('ключи этой комнаты не найдены на устройстве. Создайте новую комнату.');
  const identity = await C.loadIdentity(k);
  if (identity.id !== rec.hostId) throw new Error('ключи комнаты повреждены');
  const secret = C.unb64u(rec.secret);
  const inviteTurn = prefs.net.turn || rec.turn || null;
  const saved = rec.saved?.members ? rec.saved : null; // встреча продолжается после перезагрузки
  startCall({ isHost: true, secret, hostId: rec.hostId, identity, name, title, turn: inviteTurn, inviteTurn, saved: saved || (rec.saved ? { ...rec.saved, members: [] } : null), entryCode: rec.saved?.entryCode || '', shareState: !!rec.hostCode });
}

// Стать хозяином на этом устройстве по коду хозяина. Прежнее устройство хозяина уступит место само.
async function startAsHostByCode(link, name, code) {
  if (C.normalizeCode(code).length < 8) return false;
  const k = await C.deriveHostKeys(link.secret, code);
  const identity = await C.loadIdentity(k);
  if (identity.id !== link.hostId) return false;
  await keys.put('host:' + identity.id, k);
  const existing = rooms.get(identity.id);
  rooms.save(existing || { secret: C.b64u(link.secret), hostId: identity.id, title: '', created: Date.now(), turn: link.turn || null, saved: null, hostCode: true });
  const rec = rooms.get(identity.id);
  const inviteTurn = prefs.net.turn || rec.turn || null;
  startCall({ isHost: true, secret: link.secret, hostId: identity.id, identity, name, title: rec.title || '', turn: inviteTurn, inviteTurn, saved: null, entryCode: rec.saved?.entryCode || '', shareState: true });
  return true;
}

async function startAsGuest(link, name, entryCode = '') {
  const slot = 'guest:' + C.b64u(await C.sha256(link.secret)).slice(0, 22);
  let k = await keys.get(slot);
  if (!k?.sig) k = await C.createKeys();
  await keys.put(slot, k); // каждый вход продлевает жизнь ключа: хозяин узнаёт знакомых полгода с последнего визита
  const identity = await C.loadIdentity(k);
  // В режиме «только через ретранслятор» гость идёт через свой, а не через ретранслятор хозяина:
  // иначе владелец чужого ретранслятора увидит его IP-адрес.
  const net = prefs.net;
  const turn = net.relayOnly && net.turn ? net.turn : (link.turn || net.turn);
  startCall({ isHost: false, secret: link.secret, hostId: link.hostId, identity, name, title: '', turn, inviteTurn: link.turn, entryCode });
}

// ---------- звонок ----------

function startCall(opts) {
  const net = prefs.net;
  const room = new Room({ ...opts, media, relayOnly: net.relayOnly });
  const link = makeLink({ secret: opts.secret, hostId: opts.hostId, turn: opts.inviteTurn }); // свой TURN гостя в ссылку не попадает
  session.set(link);
  call = {
    room, link, isHost: opts.isHost, panel: null, pinned: null, chat: [], unread: 0,
    tiles: new Map(), audios: new Map(), toasts: new Map(), started: 0, prevMembers: new Set(),
    signalDownSince: 0, photoBoxes: new Map(),
  };

  room.addEventListener('phase', (e) => onPhase(e.detail));
  room.addEventListener('members', () => onMembers());
  room.addEventListener('peer', () => scheduleRender());
  room.addEventListener('local', () => { scheduleRender(); native.callActive(true, media.state()); syncMediaSession(); });
  room.addEventListener('knocks', (e) => onKnocks(e.detail));
  room.addEventListener('chat', (e) => onChat(e.detail));
  room.addEventListener('chat-update', (e) => onChatUpdate(e.detail));
  room.addEventListener('react', (e) => showReaction(e.detail));
  room.addEventListener('vpause', (e) => {
    const name = room.members.get(e.detail.id)?.name || 'Собеседник';
    toast(e.detail.on ? `${name}: связь слабая. Ваше видео на паузе, чтобы не пропадал звук.` : `${name}: связь получше. Видео снова идёт.`);
  });
  room.addEventListener('levels', (e) => onLevels(e.detail));
  room.addEventListener('host', () => renderBanners());
  room.addEventListener('code', () => { if (call && !call.screen) showWaiting(); });
  room.addEventListener('signal', (e) => {
    call.signalDownSince = e.detail.online ? 0 : Date.now();
    setTimeout(() => renderBanners(), 6500);
    renderBanners();
  });
  room.addEventListener('persist', (e) => rooms.update(opts.hostId, { saved: e.detail, ...(e.detail.title ? { title: e.detail.title } : {}) }));
  room.addEventListener('warn', (e) => toast(e.detail.text));
  room.addEventListener('deputy', (e) => {
    if (e.detail.on) toast('Хозяин вылетел. Пока его нет, временный хозяин — вы.');
    renderBanners(); renderControls();
    if (call?.panel === 'people') renderPanel();
  });
  // Хозяина нет 20 секунд. Если на этом устройстве есть ключ хозяина (вводили код хозяина), становимся хозяином.
  room.addEventListener('host-missing', () => promoteIfHostKeys());

  if (!opts.isHost) showWaiting();
  room.start().catch((e) => { console.error(e); endScreen('error'); });
}

function onPhase({ phase, reason }) {
  if (!call) return;
  if (phase === 'joined') {
    if (!call.screen) showCall();
    return;
  }
  if (phase === 'ended') return endScreen('ended');
  if (phase === 'replaced') return stayAsGuest();
  if (phase === 'left') return;
  if (phase === 'denied' && call.screen) { teardown(); return endScreen(reason === 'kicked' ? 'kicked' : 'denied'); }
  if (!call.screen) showWaiting();
}

// Хозяин открыл комнату на другом устройстве. Это устройство остаётся в звонке гостем:
// новому хозяину сразу уходит список, где оно уже записано, поэтому стучаться не нужно.
async function stayAsGuest() {
  const c = call;
  if (!c) return;
  const link = parseLink(c.link);
  const name = c.room.myName;
  try {
    const slot = 'guest:' + C.b64u(await C.sha256(link.secret)).slice(0, 22);
    let k = await keys.get(slot);
    if (!k?.sig) k = await C.createKeys();
    await keys.put(slot, k);
    const guest = await C.loadIdentity(k);
    await c.room.handOff({ id: guest.id, pk: guest.pk, name });
  } catch (e) { console.warn('передача хозяину', e); }
  teardown();
  pendingNotice = 'Хозяин теперь на другом устройстве. Вы остались в звонке гостем.';
  startAsGuest(link, name, session.entryCode || '');
}

let pendingNotice = '';

async function promoteIfHostKeys() {
  const c = call;
  if (!c || c.isHost) return;
  const room = c.room;
  const k = await keys.get('host:' + room.hostId);
  if (!k?.sig || call !== c || room.hostOnline) return;
  const identity = await C.loadIdentity(k);
  if (identity.id !== room.hostId) return;
  const link = parseLink(c.link);
  // Состав встречи берём из последнего списка: так никто не выпадет из звонка.
  const members = [...room.members.values()].filter((m) => m.id !== room.me.id && m.id !== room.hostId)
    .map((m) => ({ id: m.id, name: m.name, pk: m.pk, r: m.r || '' }));
  let rec = rooms.get(room.hostId);
  if (!rec) {
    rooms.save({ secret: C.b64u(link.secret), hostId: room.hostId, title: room.title || '', created: Date.now(), turn: link.turn || null, saved: null, hostCode: true });
    rec = rooms.get(room.hostId);
  }
  const name = room.myName;
  const title = room.title || rec.title || '';
  teardown();
  pendingNotice = 'Хозяин вылетел. У вас есть код хозяина, поэтому теперь хозяин вы.';
  const inviteTurn = prefs.net.turn || rec.turn || null;
  startCall({ isHost: true, secret: link.secret, hostId: room.hostId, identity, name, title, turn: inviteTurn, inviteTurn,
    saved: { ...(rec.saved || {}), members, locked: false }, entryCode: rec.saved?.entryCode || '', shareState: !!rec.hostCode });
}

// ---------- ожидание гостя ----------

// Голос интерфейса — добрая прожарка (решение владельца, см. DESIGN.md). Полезное всегда остаётся в тексте.
const WAIT_TEXT = {
  'connecting': ['Подключаемся', 'Ищем связь с посредником. Обычно это пара секунд.'],
  'waiting-host': ['Ищем хозяина комнаты', 'Хозяин опаздывает на свою же встречу. Как появится, запрос уйдёт сам.'],
  'knocking': ['Ждём, пока вас впустят', 'Хозяин видит, что это вы. И всё равно думает.'],
  'locked': ['Вход закрыт', 'Хозяин закрылся изнутри, как в туалете. Откроет — запрос уйдёт сам.'],
  'full': ['Комната заполнена', `Внутри уже ${MAX_MEMBERS} человек, это предел. Девятый ждёт в коридоре, запрос уйдёт сам.`],
  'denied': ['Вас не впустили', 'Хозяин посмотрел на вас и не открыл. Бывает.'],
};

async function showWaiting() {
  const { room } = call;
  const [title, text] = WAIT_TEXT[room.phase] || WAIT_TEXT.connecting;
  const final = room.phase === 'denied';
  const code = room.myCode;
  show(h('main', { class: 'screen' }, h('div', { class: 'waiting' },
    h('div', { class: 'row' }, final ? null : h('span', { class: 'pulse-dot' }), h('span', { class: 'hint', text: final ? 'Запрос закрыт' : 'Запрос отправлен' })),
    h('h1', { text: title }),
    h('p', { class: 'hint', text }),
    final || !code ? null : h('div', { class: 'receipt' }, h('small', { text: 'Ваш код проверки' }), h('b', { raw: code })),
    room.badCode && !final ? h('p', { class: 'error', text: 'Код входа не подошёл. Ждём, пока хозяин впустит вручную.' }) : null,
    final ? null : h('p', { class: 'hint', text: code
      ? 'Хозяин может позвонить и спросить код. Назовите эти цифры: так он убедится, что это вы.'
      : 'Код проверки появится, когда хозяин получит запрос.' }),
    h('button', { class: 'btn wide', on: { click: async () => { await call?.room.leave(); teardown(); home(); } } }, final ? 'На главную' : 'Отменить'),
  )));
}

// ---------- экран звонка ----------

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  const run = () => { renderQueued = false; if (call?.screen) { renderStage(); renderControls(); if (call.panel === 'people') renderPanel(); } };
  // В фоновой вкладке кадры не рисуются, а звук нового собеседника подключается именно здесь — поэтому таймер.
  if (document.hidden) setTimeout(run, 50); else requestAnimationFrame(run);
}

function showCall() {
  const c = call;
  c.started = Date.now();
  const titleEl = h('div', { class: 'title' });
  const timer = h('span', { class: 'timer' }, '00:00');
  const banners = h('div', { class: 'banners' });
  const stage = h('div', { class: 'stage' });
  const body = h('div', { class: 'body' }, stage);
  const controls = h('nav', { class: 'controls', 'aria-label': 'Управление звонком' });
  const toasts = h('div', { class: 'toasts', 'aria-live': 'polite' });
  const audioBox = h('div', { hidden: true });
  const root = h('main', { class: 'call' },
    h('header', { class: 'topbar' }, titleEl,
      h('button', { class: 'secure', on: { click: () => openPanel('security') } }, h('i'), 'Защищено'),
      timer,
      h('button', { class: 'icon-btn settings-btn', 'aria-label': 'Настройки', title: 'Настройки', on: { click: () => togglePanel('settings') } }, icon('sliders'))),
    h('div', { class: 'middle' }, banners, body),
    controls, toasts, audioBox);
  c.screen = { root, titleEl, timer, banners, stage, body, controls, toasts, audioBox, panelEl: null };
  show(root);

  c.timerId = setInterval(() => {
    const s = Math.floor((Date.now() - c.started) / 1000);
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    timer.textContent = (hh ? hh + ':' : '') + String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
  }, 1000);
  new ResizeObserver(() => layoutGrid()).observe(stage);
  // Фото можно перетащить прямо на звонок: оно уйдёт в чат.
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  root.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); root.classList.add('dropping'); });
  root.addEventListener('dragleave', (e) => { if (e.target === root || !root.contains(e.relatedTarget)) root.classList.remove('dropping'); });
  root.addEventListener('drop', (e) => {
    root.classList.remove('dropping');
    if (!hasFiles(e)) return;
    e.preventDefault();
    sendPhotos([...e.dataTransfer.files]);
  });
  buildControls();
  onMembers();
  renderBanners();
  native.callActive(true, media.state());
  mediaSession(true);
  keepAwake();
  window.addEventListener('beforeunload', beforeUnload);
  if (c.isHost && c.room.members.size <= 1) openPanel('invite');
  if (pendingNotice) { toast(pendingNotice); pendingNotice = ''; }
}

function beforeUnload(e) {
  if (call?.screen) { e.preventDefault(); e.returnValue = ''; }
}

async function keepAwake() {
  try {
    if (!navigator.wakeLock || !call) return;
    call.wake = await navigator.wakeLock.request('screen');
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !call) return;
  call.room.nudge();
  media?.resumeAudio();
  for (const a of call.audios.values()) if (a.paused) a.play().catch(() => {});
  if (call.screen) { keepAwake(); scheduleRender(); }
});

function onMembers() {
  const c = call;
  if (!c?.screen) return;
  const { room } = c;
  c.screen.titleEl.textContent = room.title || (c.isHost ? 'Ваша встреча' : 'Встреча');
  const now = new Set(room.members.keys());
  if (c.prevMembers.size) {
    for (const id of now) if (!c.prevMembers.has(id) && id !== room.me.id) toast(`${room.members.get(id).name} в комнате. Наконец-то.`);
    for (const id of c.prevMembers) if (!now.has(id) && id !== room.me.id) toast(`${c.names?.get(id) || 'Участник'} уходит как лох. Любим всё равно.`);
  }
  c.prevMembers = now;
  c.names = new Map([...room.members.values()].map((m) => [m.id, m.name]));
  scheduleRender();
  if (c.panel === 'people') renderPanel();
}

// ----- плитки -----

function tileFor(key, kind) {
  let t = call.tiles.get(key);
  if (t) return t;
  const video = h('video', { autoplay: true, playsInline: true, muted: true });
  video.muted = true;
  const avatarText = h('span');
  const avatar = h('div', { class: 'avatar' }, avatarText);
  const label = h('div', { class: 'label' });
  const state = h('div', { class: 'state' });
  const corner = h('div', { class: 'corner' });
  const el = h('div', { class: 'tile' + (kind === 'screen' ? ' share' : '') }, video, avatar, state, label, corner);
  // Нажатие на окошко делает человека крупным, нажатие на крупное возвращает всех.
  el.addEventListener('click', () => {
    const c = call;
    if (!c?.screen || el.classList.contains('pip') || c.screen.body.classList.contains('duo')) return;
    const box = el.parentElement;
    if (box?.classList.contains('main')) c.pinned = null;
    else if (box?.classList.contains('strip') || box?.classList.contains('grid')) c.pinned = key;
    else return;
    scheduleRender();
  });
  t = { key, kind, el, video, avatar, avatarText, label, state, corner, track: null };
  call.tiles.set(key, t);
  return t;
}

function setTrack(t, track) {
  if (t.track === track) return;
  t.track = track;
  t.video.srcObject = track ? new MediaStream([track]) : null;
  if (track) t.video.play().catch(() => {});
}

function audioFor(key, track) {
  let a = call.audios.get(key);
  if (!track) { if (a) { a.srcObject = null; a.remove(); call.audios.delete(key); } return; }
  if (!a) { a = h('audio', { autoplay: true }); call.screen.audioBox.append(a); call.audios.set(key, a); }
  if (a.srcObject?.getAudioTracks()[0] !== track) { a.srcObject = new MediaStream([track]); a.play().catch(() => {}); }
  a.volume = volOf(key.split(':')[1]);
  applySpeaker(a);
}

function applySpeaker(a) {
  const id = prefs.speaker;
  if (id && a.setSinkId && a.sinkId !== id) a.setSinkId(id).catch(() => {});
}

// ---------- громкость собеседников (только у себя) ----------

let volumes = null;
const volOf = (id) => { volumes ??= prefs.volumes; const v = volumes[id]; return typeof v === 'number' && v >= 0 && v <= 1 ? v : 1; };
const volText = (p) => (p === 0 ? 'выкл' : p + '%');

function setVolume(id, v) {
  volumes ??= prefs.volumes;
  if (v >= 1) delete volumes[id]; else volumes[id] = v;
  const ids = Object.keys(volumes);
  if (ids.length > 200) delete volumes[ids[0]];
  prefs.volumes = volumes;
  for (const key of ['mic:' + id, 'sa:' + id]) { const a = call?.audios.get(key); if (a) a.volume = volOf(id); }
}

// Ползунок в списке участников. Пока его тянут, список не перерисовывается: иначе ползунок выскользнет из пальца.
function volumeRow(m) {
  const pct = Math.round(volOf(m.id) * 100);
  const out = h('small', { text: volText(pct) });
  const input = h('input', {
    type: 'range', min: '0', max: '100', step: '5', value: String(pct), 'data-vol': m.id, 'aria-label': 'Громкость: ' + m.name,
    on: {
      input: () => { setVolume(m.id, Number(input.value) / 100); out.textContent = volText(Number(input.value)); },
      change: () => scheduleRender(),
      pointerdown: () => {
        call.volHold = true;
        window.addEventListener('pointerup', releaseVol, { once: true });
        window.addEventListener('pointercancel', releaseVol, { once: true });
      },
    },
  });
  return h('div', { class: 'vol' }, icon('volume'), input, out);
}

function releaseVol() {
  if (!call?.volHold) return;
  call.volHold = false;
  if (call.volPending) { call.volPending = false; renderPanel(); }
}

function renderStage() {
  const c = call;
  const { room } = c;
  const { stage } = c.screen;
  const seen = new Set();
  const camTiles = [];
  const screenTiles = [];
  const meSt = media.state();

  for (const m of room.members.values()) {
    const me = m.id === room.me.id;
    const conn = room.conns.get(m.id);
    const st = me ? meSt : (conn?.remote || { mic: false, cam: false, screen: false });
    const t = tileFor('cam:' + m.id, 'cam');
    seen.add(t.key);
    t.memberId = m.id;
    t.el.classList.toggle('mirror', me && media.facing === 'user');
    t.el.classList.toggle('remote', !me);
    t.el.classList.toggle('self', me);
    const paused = !me && conn?.remotePaused;
    const track = me ? (meSt.cam ? media.cam : null) : (st.cam && !paused ? conn?.tracks[SLOT.cam] : null);
    setTrack(t, track || null);
    t.video.hidden = !track;
    t.avatar.hidden = !!track;
    t.avatarText.textContent = initials(m.name);
    const quiet = !me && volOf(m.id) === 0 ? h('span', { class: 'quiet', title: 'У вас звук этого человека выключен' }, icon('volumeOff')) : null;
    const q = !me && conn?.state === 'connected' ? conn.q : null;
    const net = q === 'weak' || q === 'bad' ? h('span', { class: 'net ' + q, title: q === 'bad' ? 'Плохая связь: картинка может замирать' : 'Слабая связь' }, icon('signal')) : null;
    replace(t.label, st.mic ? null : icon('micOff'), quiet, net, h('b', { raw: m.name + (me ? ' (вы)' : '') }));
    let stateText = '';
    let bad = false;
    if (!me && conn) {
      if (conn.state === 'connecting') stateText = 'Соединяемся…';
      if (conn.state === 'failed') { stateText = 'Не удаётся соединиться напрямую'; bad = true; }
      if (conn.state !== 'connected' && room.channel?.isLegacy(m.id)) { stateText = 'У собеседника старая версия. Пусть обновит приложение'; bad = true; }
      if (conn.state === 'connected' && st.cam && conn.remotePaused) stateText = 'Видео на паузе: слабая связь. Звук идёт';
      else if (conn.state === 'connected' && conn.frozen) stateText = 'Видео подтормаживает: слабая связь';
    }
    t.el.classList.toggle('stale', !me && !!conn?.frozen && !paused);
    replace(t.state, stateText ? h('span', { class: bad ? 'bad' : '', text: stateText }) : null);
    // Сменить камеру — кнопка на своём окошке, как в Telegram: на телефоне так не теснятся кнопки внизу.
    replace(t.corner, me && isTouch && meSt.cam ? h('button', {
      class: 'icon-btn', 'aria-label': 'Сменить камеру', title: 'Сменить камеру',
      on: { click: (e) => { e.stopPropagation(); media.flipCamera(); } },
    }, icon('flip')) : null);
    if (!me) {
      audioFor('mic:' + m.id, conn?.tracks[SLOT.mic] || null);
      audioFor('sa:' + m.id, st.screen ? conn?.tracks[SLOT.screenAudio] : null);
    }
    camTiles.push(t);

    const screenTrack = me ? media.screen : (st.screen ? conn?.tracks[SLOT.screen] : null);
    if (screenTrack) {
      const s = tileFor('scr:' + m.id, 'screen');
      seen.add(s.key);
      s.memberId = m.id;
      setTrack(s, screenTrack);
      s.avatar.hidden = true;
      replace(s.label, icon('screen'), h('b', { raw: me ? 'Ваш экран' : 'Экран: ' + m.name }));
      s.label.firstChild.style.color = 'var(--amber)';
      replace(s.corner, h('button', {
        class: 'icon-btn', 'aria-label': 'Во весь экран', title: 'Во весь экран',
        on: { click: (e) => { e.stopPropagation(); s.el.requestFullscreen?.().catch(() => {}); } },
      }, icon('expand')));
      screenTiles.push(s);
    }
  }
  for (const [key, t] of c.tiles) if (!seen.has(key)) { setTrack(t, null); t.el.remove(); c.tiles.delete(key); }
  for (const [key] of c.audios) {
    const id = key.split(':')[1];
    if (!room.members.has(id)) audioFor(key, null);
  }

  // Раскладка. Своё окошко всегда последнее: смотрят на других, а не на себя.
  camTiles.sort((a, b) => (a.memberId === room.me.id) - (b.memberId === room.me.id));
  stage.className = 'stage';
  c.screen.body.classList.remove('duo');
  for (const t of camTiles) t.el.classList.remove('pip');
  let inGrid = [];
  const pinnedCam = camTiles.find((t) => t.key === c.pinned);
  if (c.pipMode) {
    // В маленьком окошке один человек: показ экрана, иначе тот, кто говорит, иначе первый собеседник.
    const remote = camTiles.filter((t) => t.memberId !== room.me.id);
    const one = screenTiles[screenTiles.length - 1] || remote.find((t) => t.memberId === c.lastSpeaker) || remote[0] || camTiles[0];
    const grid = stage.querySelector(':scope > .grid') || h('div', { class: 'grid' });
    c.screen.body.classList.add('duo');
    if (one) { syncChildren(grid, [one.el]); inGrid = [one]; }
    syncChildren(stage, [grid]);
  } else if (screenTiles.length || pinnedCam) {
    const all = [...screenTiles, ...camTiles];
    let main = all.find((t) => t.key === c.pinned);
    if (!main) { main = screenTiles[screenTiles.length - 1]; c.pinned = null; }
    stage.classList.add('present');
    const mainBox = stage.querySelector(':scope > .main') || h('div', { class: 'main' });
    const strip = stage.querySelector(':scope > .strip') || h('div', { class: 'strip' });
    syncChildren(mainBox, [main.el]);
    syncChildren(strip, all.filter((t) => t !== main).map((t) => t.el));
    syncChildren(stage, [mainBox, strip]);
  } else {
    const grid = stage.querySelector(':scope > .grid') || h('div', { class: 'grid' });
    const remote = camTiles.filter((t) => t.memberId !== room.me.id);
    const self = camTiles.find((t) => t.memberId === room.me.id);
    // На телефоне втроём-вчетвером своё окошко тоже уходит в угол: иначе оно отнимает целую строку.
    const narrow = stage.clientWidth > 0 && stage.clientWidth < 600;
    if (remote.length === 1 && self) {
      // Вдвоём: собеседник на весь экран, я в углу.
      c.screen.body.classList.add('duo');
      self.el.classList.add('pip');
      inGrid = [remote[0]];
      syncChildren(grid, [remote[0].el]);
      syncChildren(stage, [grid, self.el]);
    } else if (narrow && self && remote.length >= 2 && remote.length <= 3) {
      self.el.classList.add('pip');
      inGrid = remote;
      syncChildren(grid, remote.map((t) => t.el));
      syncChildren(stage, [grid, self.el]);
    } else {
      inGrid = camTiles;
      syncChildren(grid, camTiles.map((t) => t.el));
      const hint = remote.length ? null : h('div', { class: 'empty-hint' },
        h('p', { text: c.isHost ? 'Вы пока одни. Позовите хоть кого-нибудь.' : 'Вы пока одни в комнате. Остальные, видимо, ищут наушники.' }),
        c.isHost ? h('button', { class: 'btn primary small', on: { click: () => openPanel('invite') } }, icon('link'), 'Пригласить') : null);
      const oldHint = stage.querySelector(':scope > .empty-hint');
      syncChildren(stage, hint ? [grid, oldHint || hint] : [grid]);
    }
  }
  for (const t of c.tiles.values()) if (!inGrid.includes(t)) { t.el.style.width = ''; t.el.style.height = ''; }
  for (const t of c.tiles.values()) {
    const box = t.el.parentElement;
    t.el.title = t.el.classList.contains('pip') || c.screen.body.classList.contains('duo') ? ''
      : box?.classList.contains('main') ? (t.kind === 'cam' ? 'Нажмите, чтобы вернуть всех' : '') : 'Нажмите, чтобы сделать крупно';
    t.el.classList.toggle('pinned', t.key === c.pinned && box?.classList.contains('main'));
  }
  layoutGrid();
  for (const t of c.tiles.values()) if (t.track && t.video.paused) t.video.play().catch(() => {});
}

function syncChildren(parent, kids) {
  const same = parent.children.length === kids.length && kids.every((k, i) => parent.children[i] === k);
  if (!same) parent.replaceChildren(...kids);
}

// Подбор числа колонок, при котором плитки самые крупные.
function layoutGrid() {
  const c = call;
  if (!c?.screen) return;
  const grid = c.screen.stage.querySelector(':scope > .grid');
  if (!grid) return;
  const tiles = [...grid.children];
  const n = tiles.length;
  const W = grid.clientWidth, H = grid.clientHeight, gap = 8;
  if (!n || !W || !H) return;
  if (c.screen.body.classList.contains('duo')) { tiles.forEach((t) => { t.style.width = '100%'; t.style.height = '100%'; }); return; }
  let best = { area: 0, w: W, h: H };
  // На широком экране окошки не уже 4:3: камера снимает горизонтально, и в узком окошке режутся лица.
  const minRatio = W > H * 1.1 ? 4 / 3 : 3 / 4;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    let w = (W - gap * (cols - 1)) / cols;
    let hh = (H - gap * (rows - 1)) / rows;
    if (w / hh > 16 / 9) w = hh * 16 / 9;
    if (w / hh < minRatio) hh = w / minRatio;
    if (w * hh > best.area) best = { area: w * hh, w, h: hh };
  }
  tiles.forEach((t) => { t.style.width = Math.floor(best.w) + 'px'; t.style.height = Math.floor(best.h) + 'px'; });
}

function onLevels(levels) {
  const c = call;
  if (!c?.screen) return;
  for (const t of c.tiles.values()) {
    if (t.kind !== 'cam') continue;
    const v = levels[t.memberId] || 0;
    t.el.classList.toggle('speaking', v > 0.06);
  }
  // В окошке поверх других приложений показываем того, кто говорит. Меняем не чаще раза в 2 секунды.
  if (c.pipMode) {
    const [id, v] = Object.entries(levels).filter(([k]) => k !== c.room.me.id).sort((a, b) => b[1] - a[1])[0] || [];
    if (id && v > 0.08 && id !== c.lastSpeaker && Date.now() - (c.speakerAt || 0) > 2000) {
      c.lastSpeaker = id;
      c.speakerAt = Date.now();
      scheduleRender();
    }
  }
  // Говорят полторы секунды при выключенном микрофоне — подсказать. Не чаще раза в 45 секунд.
  const loud = media.mutedLevel() > 0.1;
  c.mutedTalk = loud ? (c.mutedTalk || 0) + 1 : Math.max(0, (c.mutedTalk || 0) - 1);
  if (c.mutedTalk >= 6 && Date.now() - (c.mutedHintAt || 0) > 45000) {
    c.mutedHintAt = Date.now();
    c.mutedTalk = 0;
    mutedHint();
  }
}

function mutedHint() {
  const c = call;
  if (!c?.screen || media.state().mic) return;
  const el = h('div', { class: 'toast plain action', role: 'status' },
    h('span', { text: 'Вы говорите в выключенный микрофон. Пока это слышит только ваш кот.' }),
    h('button', { class: 'btn small primary', on: { click: () => { media.setMic(true); el.remove(); } } }, 'Включить'));
  c.screen.toasts.append(el);
  setTimeout(() => el.remove(), 6000);
}

// ----- кнопки -----

function buildControls() {
  const c = call;
  const mk = (key, label, fn) => {
    const b = h('button', { class: 'ctl', 'aria-label': label, title: label, on: { click: fn } });
    c.screen[key] = b;
    return b;
  };
  replace(c.screen.controls,
    mk('micBtn', 'Микрофон', () => media.setMic(!media.state().mic)),
    mk('camBtn', 'Камера', () => media.setCam(!media.state().cam)),
    media.canShareScreen() ? mk('scrBtn', 'Показать экран', toggleScreen) : null,
    h('span', { class: 'ctl-sep' }),
    mk('peopleBtn', 'Участники', () => togglePanel('people')),
    mk('chatBtn', 'Чат', () => togglePanel('chat')),
    mk('reactBtn', 'Реакция', () => toggleReactions()),
    mk('inviteBtn', 'Пригласить', () => togglePanel('invite')),
    h('span', { class: 'ctl-sep' }),
    mk('hangBtn', c.isHost ? 'Завершить встречу' : 'Выйти', hangUp),
  );
  c.screen.hangBtn.classList.add('hang');
  c.screen.inviteBtn.classList.add('invite');
  replace(c.screen.hangBtn, icon('hang'));
  replace(c.screen.peopleBtn, icon('people'));
  replace(c.screen.chatBtn, icon('chat'));
  replace(c.screen.reactBtn, icon('smile'));
  replace(c.screen.inviteBtn, icon('link'));
  renderControls();
}

function renderControls() {
  const c = call;
  if (!c?.screen?.micBtn) return;
  const s = media.state();
  const set = (b, on, iconOn, iconOff, labelOn, labelOff) => {
    replace(b, icon(on ? iconOn : iconOff));
    b.classList.toggle('off', !on);
    b.setAttribute('aria-label', on ? labelOn : labelOff);
    b.title = on ? labelOn : labelOff;
  };
  set(c.screen.micBtn, s.mic, 'mic', 'micOff', 'Выключить микрофон', 'Включить микрофон');
  set(c.screen.camBtn, s.cam, 'cam', 'camOff', 'Выключить камеру', 'Включить камеру');
  if (c.screen.scrBtn) {
    replace(c.screen.scrBtn, icon('screen'));
    c.screen.scrBtn.classList.toggle('on-air', s.screen);
    c.screen.scrBtn.title = s.screen ? 'Остановить показ экрана' : 'Показать экран';
    c.screen.scrBtn.setAttribute('aria-label', c.screen.scrBtn.title);
  }
  badge(c.screen.peopleBtn, c.room.canAdmit ? c.room.knocks.size : 0);
  badge(c.screen.chatBtn, c.unread);
  for (const [k, b] of [['people', c.screen.peopleBtn], ['chat', c.screen.chatBtn], ['invite', c.screen.inviteBtn]]) {
    b.setAttribute('aria-pressed', c.panel === k ? 'true' : 'false');
    b.classList.toggle('on-air', c.panel === k);
  }
  c.screen.reactBtn.setAttribute('aria-expanded', c.reactPop ? 'true' : 'false');
  const gear = c.screen.root.querySelector('.settings-btn');
  gear?.setAttribute('aria-pressed', c.panel === 'settings' ? 'true' : 'false');
  gear?.classList.toggle('on-air', c.panel === 'settings');
  c.screen.reactBtn.classList.toggle('on-air', !!c.reactPop);
}

function badge(btn, n) {
  let b = btn.querySelector('.badge');
  if (!n) { b?.remove(); return; }
  if (!b) { b = h('span', { class: 'badge' }); btn.append(b); }
  b.textContent = n > 9 ? '9+' : String(n);
}

// ----- реакции -----

const REACTION_NAMES = ['Класс', 'Ржу', 'Люблю', 'Огонь', 'Браво', 'Ну такое'];

function toggleReactions() {
  const c = call;
  if (c.reactPop) { closeReactions(); return; }
  const pop = h('div', { class: 'react-pop', role: 'toolbar', 'aria-label': 'Реакции' },
    REACTIONS.map((e, i) => h('button', { type: 'button', title: REACTION_NAMES[i], 'aria-label': REACTION_NAMES[i], on: { click: () => { c.room.sendReaction(i); armReactions(); } } }, e)));
  const r = c.screen.reactBtn.getBoundingClientRect();
  pop.style.bottom = Math.round(window.innerHeight - r.top + 10) + 'px';
  c.reactPop = pop;
  c.screen.root.append(pop);
  // Над кнопкой, но не за краем экрана: на телефоне кнопка стоит у правого края.
  const half = pop.offsetWidth / 2, edge = 8;
  pop.style.left = Math.round(Math.min(Math.max(r.left + r.width / 2, half + edge), window.innerWidth - half - edge)) + 'px';
  c.reactAway = (e) => { if (!pop.contains(e.target) && !c.screen.reactBtn.contains(e.target)) closeReactions(); };
  c.reactKey = (e) => { if (e.key === 'Escape') closeReactions(); };
  document.addEventListener('pointerdown', c.reactAway);
  document.addEventListener('keydown', c.reactKey);
  armReactions();
  renderControls();
}

// Панель реакций сама прячется через 8 секунд без нажатий.
function armReactions() {
  clearTimeout(call.reactTimer);
  call.reactTimer = setTimeout(closeReactions, 8000);
}

function closeReactions() {
  const c = call;
  if (!c?.reactPop) return;
  clearTimeout(c.reactTimer);
  c.reactPop.remove();
  c.reactPop = null;
  document.removeEventListener('pointerdown', c.reactAway);
  document.removeEventListener('keydown', c.reactKey);
  renderControls();
}

// Реакция всплывает над окошком того, кто её отправил.
function showReaction({ from, e }) {
  const c = call;
  if (!c?.screen) return;
  const t = c.tiles.get('cam:' + from);
  const host = t?.el.isConnected && t.el.offsetWidth ? t.el : c.screen.stage;
  const fly = h('span', { class: 'fly', 'aria-hidden': 'true' }, REACTIONS[e]);
  fly.style.left = (20 + Math.random() * 60).toFixed(0) + '%';
  host.append(fly);
  setTimeout(() => fly.remove(), 2400);
}

async function toggleScreen() {
  try {
    if (media.state().screen) media.stopScreen();
    else await media.startScreen();
  } catch (e) {
    if (e?.name !== 'NotAllowedError' && e?.name !== 'AbortError') toast('Не удалось показать экран');
  }
}

async function hangUp() {
  const c = call;
  if (c.isHost && c.room.members.size > 1) {
    const ok = await confirmModal('Завершить встречу?', 'Звонок закончится у всех, даже у тех, кто не договорил. Ссылка продолжит работать, комнату можно открыть снова.', 'Завершить');
    if (!ok) return;
  }
  const record = c.isHost ? rooms.get(c.room.hostId) : null;
  await c.room.leave();
  teardown();
  endScreen(c.isHost ? 'host-left' : 'left', record);
}

function teardown() {
  const c = call;
  if (!c) return;
  clearInterval(c.timerId);
  window.removeEventListener('beforeunload', beforeUnload);
  try { c.wake?.release(); } catch {}
  c.room.stop();
  for (const a of c.audios.values()) a.srcObject = null;
  for (const t of c.tiles.values()) t.video.srcObject = null;
  native.callActive(false);
  mediaSession(false);
  closeReactions();
  for (const m of c.chat) if (m.url) URL.revokeObjectURL(m.url);
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  call = null;
  session.clear();
}

function endScreen(reason, record = null) {
  if (call) teardown();
  stopMedia();
  const texts = {
    'ended': ['Встреча завершена', 'Хозяин всех разогнал. По домам.'],
    'left': ['Вы вышли из встречи', 'Без вас уже скучно. Чтобы вернуться, откройте ссылку-приглашение ещё раз.'],
    'host-left': ['Встреча завершена', 'Ссылка продолжает работать. Комнату можно открыть снова с главного экрана.'],
    'kicked': ['Вас удалили из встречи', 'Хозяин удалил вас из комнаты. Обнимаем издалека.'],
    'replaced': ['Хозяин теперь на другом устройстве', 'Кто-то вошёл по коду хозяина, и эта вкладка уступила место. Надеемся, это вы.'],
    'denied': ['Вас не впустили', 'Хозяин посмотрел на вас и не открыл. Бывает.'],
    'error': ['Что-то пошло не так', 'Обновите страницу и попробуйте ещё раз.'],
  };
  const [title, text] = texts[reason] || texts.left;
  show(h('main', { class: 'screen' }, h('div', { class: 'waiting' },
    h('h1', { text: title }),
    h('p', { class: 'hint', text }),
    h('button', { class: 'btn primary wide', on: { click: () => home() } }, 'На главную'),
    record ? h('button', { class: 'btn wide', on: { click: () => prejoin({ mode: 'host', record: rooms.get(record.hostId) }) } }, 'Открыть комнату снова') : null,
  )));
}

function renderBanners() {
  const c = call;
  if (!c?.screen) return;
  const list = [];
  const dep = c.room.deputyId && c.room.members.get(c.room.deputyId);
  if (c.room.deputy) list.push('Хозяин вылетел. Пока его нет, временный хозяин — вы: впускайте гостей. Вернётся — передадим ему.');
  else if (!c.isHost && c.room.hostOnline === false && dep) list.push(`Хозяин вылетел. Пока его нет, гостей впускает ${dep.name}.`);
  else if (!c.isHost && c.room.hostOnline === false) list.push('Хозяин не в сети. Связь между остальными сохраняется. Через полминуты кто-то из вас станет временным хозяином.');
  if (!c.isHost && c.room.orphan) list.push('Хозяин сменился. Вы в звонке, ждём, пока новый хозяин вас подтвердит. Знакомых он пускает сам.');
  if (c.signalDownSince && Date.now() - c.signalDownSince > 6000) list.push('Нет связи с посредником. Текущий звонок идёт, но новые участники пока не смогут войти.');
  replace(c.screen.banners, list.map((t) => h('div', { class: 'banner', text: t })));
}

// ----- стук в дверь -----

function onKnocks({ added } = {}) {
  const c = call;
  if (!c?.screen) return;
  renderControls();
  if (c.panel === 'people') renderPanel();
  // Всплывающие запросы показываем, только когда список участников закрыт.
  for (const [id, el] of c.toasts) if (!c.room.knocks.has(id) || c.panel === 'people') { el.remove(); c.toasts.delete(id); }
  if (c.panel === 'people') return;
  for (const k of c.room.knocks.values()) {
    if (c.toasts.has(k.id) || c.toasts.size >= 3) continue;
    const el = h('div', { class: 'toast', role: 'alertdialog', 'aria-label': 'Запрос на вход' },
      h('div', { class: 'head' }, h('span', { class: 'bell' }, icon('bell')),
        h('div', {}, h('b', { raw: k.name }), h('small', { text: 'просится войти' }))),
      h('div', { class: 'receipt mini' }, h('small', { text: 'Код гостя' }), h('b', { raw: k.code })),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary small', on: { click: () => c.room.admit(k.id) } }, 'Впустить'),
        h('button', { class: 'btn small', on: { click: () => c.room.deny(k.id) } }, 'Отказать'),
      ));
    c.toasts.set(k.id, el);
    c.screen.toasts.append(el);
  }
  if (added) chime();
  if (added && document.hidden) notifyTitle();
}

// Два тихих тона, как у домофона. Звучит, когда гость просится войти.
function chime() {
  try {
    const ctx = chime.ctx || (chime.ctx = new AudioContext());
    const t = ctx.currentTime;
    [[880, 0], [660, 0.18]].forEach(([f, d]) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t + d);
      g.gain.linearRampToValueAtTime(0.12, t + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.5);
      o.connect(g).connect(ctx.destination);
      o.start(t + d);
      o.stop(t + d + 0.55);
    });
  } catch {}
}

function notifyTitle() {
  const orig = 'Свои';
  document.title = 'Стучатся · Свои';
  const back = () => { document.title = orig; document.removeEventListener('visibilitychange', back); };
  document.addEventListener('visibilitychange', back);
}

function toast(text, { kind = '' } = {}) {
  if (!call?.screen) return;
  // Сообщения чата не копятся стопкой: новое заменяет прошлое.
  if (kind) call.screen.toasts.querySelectorAll('.toast.' + kind).forEach((t) => t.remove());
  const el = h('div', { class: 'toast plain' + (kind ? ' ' + kind : ''), role: 'status' }, h('span', { raw: text }));
  call.screen.toasts.append(el);
  setTimeout(() => el.remove(), 3000);
}

// ----- чат -----

function onChat(msg) {
  const c = call;
  if (!c) return;
  const prev = c.chat[c.chat.length - 1];
  c.chat.push(msg);
  if (c.chat.length > 300) { const old = c.chat.shift(); if (old.url) URL.revokeObjectURL(old.url); }
  if (c.panel === 'chat' && c.screen?.chatList?.isConnected) {
    c.screen.chatList.querySelector('.hint')?.remove();
    c.screen.chatList.append(chatItem(msg, prev));
    const box = c.screen.chatList.parentElement;
    box.scrollTop = box.scrollHeight;
  } else if (!msg.me) {
    c.unread++;
    renderControls();
    const text = msg.kind === 'img' ? 'фото' : msg.text.length > 80 ? msg.text.slice(0, 80) + '…' : msg.text;
    toast(`${msg.name}: ${text}`, { kind: 'chat' });
  }
}

function onChatUpdate(u) {
  const c = call;
  if (!c) return;
  const m = c.chat.find((x) => x.id === u.id && x.from === u.from && x.kind === 'img');
  if (!m) { if (u.url) URL.revokeObjectURL(u.url); return; }
  if (u.url && !m.url) { m.url = u.url; m.blob = u.blob; }
  if (typeof u.progress === 'number') m.progress = u.progress;
  if (u.failed) m.failed = true;
  if (typeof u.sent === 'number') { m.sent = u.sent; m.total = u.total; }
  const box = c.photoBoxes.get(m.from + ':' + m.id);
  if (box?.isConnected) fillPhoto(box, m);
  if (c.panel === 'chat' && u.url && c.screen?.chatList) { const sc = c.screen.chatList.parentElement; sc.scrollTop = sc.scrollHeight; }
}

// Фото из файла: уменьшаем до 2048 точек и пересжимаем. Заодно из файла пропадают метки места и модель телефона.
async function preparePhoto(file) {
  if (!file || (file.type && !file.type.startsWith('image/'))) throw new Error('type');
  if (file.size > 40 * 1024 * 1024) throw new Error('big');
  if (file.type === 'image/gif' && file.size <= IMG_MAX) {
    // GIF уходит как есть, иначе пропадёт анимация.
    const bmp = await createImageBitmap(file);
    const r = { blob: file, w: bmp.width, h: bmp.height };
    bmp.close();
    return r;
  }
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const k = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k));
  const hh = Math.max(1, Math.round(bmp.height * k));
  const canvas = h('canvas', { width: w, height: hh });
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, w, hh);
  g.drawImage(bmp, 0, 0, w, hh);
  bmp.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
  if (!blob) throw new Error('encode');
  return { blob, w, h: hh };
}

async function sendPhotos(files) {
  const c = call;
  if (!c) return;
  const list = files.filter((f) => !f.type || f.type.startsWith('image/')).slice(0, 5);
  if (!list.length) { if (files.length) toast('В чат уходят только фото. Остальное несите в мессенджер.'); return; }
  if (c.panel !== 'chat') openPanel('chat');
  for (const f of list) {
    try {
      const p = await preparePhoto(f);
      await c.room.sendImage(p.blob, p);
    } catch {
      toast('Это фото не открывается. Пришлите JPG или PNG.');
    }
  }
}

async function pickPhotos(input) {
  if (native.available && native.canPickImage) {
    const r = await native.pickImage();
    if (r?.error) toast('Это фото не открывается. Попробуйте другое.');
    else if (r?.blob) await call?.room.sendImage(r.blob, r);
    return;
  }
  input.click();
}

// ----- панели -----

function togglePanel(name) {
  if (call.panel === name) closePanel();
  else openPanel(name);
}

function openPanel(name) {
  call.panel = name;
  if (name === 'chat') { call.unread = 0; call.screen?.toasts.querySelectorAll('.toast.chat').forEach((t) => t.remove()); }
  renderPanel();
  renderControls();
  onKnocks();
}

function closePanel() {
  call.panel = null;
  call.screen.panelEl?.remove();
  call.screen.panelEl = null;
  renderControls();
  onKnocks();
  requestAnimationFrame(layoutGrid);
}

const PANEL_TITLES = { people: 'Участники', chat: 'Чат', invite: 'Пригласить', security: 'Защита', settings: 'Настройки' };

function renderPanel() {
  const c = call;
  if (!c?.screen || !c.panel) return;
  if (c.panel === 'people' && c.volHold) { c.volPending = true; return; }
  const focusVol = document.activeElement?.dataset?.vol;
  const content = h('div', { class: 'content' });
  let footer = null;
  const panel = h('aside', { class: 'panel ' + c.panel, 'aria-label': PANEL_TITLES[c.panel] },
    h('header', {}, h('h2', { text: PANEL_TITLES[c.panel] }),
      h('div', { class: 'row' },
        h('button', { class: 'icon-btn', 'aria-label': 'Закрыть', title: 'Закрыть', on: { click: closePanel } }, icon('close')))),
    content);

  if (c.panel === 'people') peoplePanel(content);
  if (c.panel === 'chat') footer = chatPanel(content);
  if (c.panel === 'invite') invitePanel(content);
  if (c.panel === 'security') securityPanel(content);
  if (c.panel === 'settings') settingsPanel(content);
  if (footer) panel.append(footer);

  const old = c.screen.panelEl;
  const keepScroll = old && old.classList.contains(c.panel) ? old.querySelector('.content')?.scrollTop : 0;
  if (old) old.replaceWith(panel);
  else c.screen.body.append(panel);
  if (old) panel.style.animation = 'none';
  c.screen.panelEl = panel;
  if (keepScroll) content.scrollTop = keepScroll;
  if (c.panel === 'chat') content.scrollTop = content.scrollHeight;
  if (focusVol) [...panel.querySelectorAll('[data-vol]')].find((el) => el.dataset.vol === focusVol)?.focus();
  requestAnimationFrame(layoutGrid);
}

function peoplePanel(box) {
  const { room, isHost } = call;
  const canAdmit = room.canAdmit;
  box.append(h('button', { class: 'btn small', style: { justifySelf: 'start' }, on: { click: () => openPanel('invite') } }, icon('link'), 'Пригласить'));
  if (canAdmit && room.knocks.size) {
    box.append(h('section', { class: 'stack' },
      h('h3', { text: 'Просятся войти' }),
      h('div', {}, [...room.knocks.values()].map((k) => h('div', { class: 'knock' },
        h('div', { class: 'who' }, h('b', { raw: k.name })),
        h('div', { class: 'receipt mini' }, h('small', { text: 'Код гостя. Сверьте его по телефону' }), h('b', { raw: k.code })),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary small', on: { click: () => room.admit(k.id) } }, 'Впустить'),
          h('button', { class: 'btn small', on: { click: () => room.deny(k.id) } }, 'Отказать')))))));
  }
  const list = room.memberList();
  box.append(h('section', { class: 'stack' },
    h('h3', { text: `В комнате: ${list.length} из ${MAX_MEMBERS}` }),
    h('ul', { class: 'people' }, list.map((m) => {
      let status = m.me ? 'это вы' : '';
      if (!m.me && m.conn) status = { connecting: 'соединяемся', connected: 'на связи', failed: 'нет прямого соединения' }[m.conn.state] || '';
      if (!m.me && m.conn?.state === 'connected' && m.conn.q === 'weak') status += ', связь слабая';
      if (!m.me && m.conn?.state === 'connected' && m.conn.q === 'bad') status += ', связь плохая';
      if (m.host) status = (status ? status + ' · ' : '') + 'хозяин';
      return h('li', {},
        h('div', { class: 'who' }, h('b', { raw: m.name }), h('small', { text: status })),
        isHost && !m.me ? h('button', { class: 'btn small ghost', on: { click: () => kick(m) } }, 'Удалить') : h('span'),
        h('span', { class: 'code', raw: m.code }),
        m.me ? null : volumeRow(m));
    })),
    list.length > 1 ? h('p', { class: 'hint', text: 'Громкость меняется только у вас. Человек не узнает, что его притушили. Чавкает — смело в ноль.' }) : null,
  ));
  if (isHost) {
    const how = room.locked ? 'Вход закрыт: новые не войдут даже по ссылке.' : room.openLink ? 'Входят все, у кого есть ссылка. Собрались — закройте вход.' : 'Каждого гостя впускаете вы. Собрались — закройте вход.';
    box.append(h('section', { class: 'stack' },
      h('p', { class: 'hint', text: how }),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', on: { click: () => room.setLocked(!room.locked) } }, icon(room.locked ? 'unlock' : 'lock'), room.locked ? 'Открыть вход' : 'Закрыть вход'),
        h('button', { class: 'btn small ghost', on: { click: () => { call.settingsTab = 'room'; openPanel('settings'); } } }, icon('sliders'), 'Кто может войти'))));
  }
}

async function kick(m) {
  if (await confirmModal(`Удалить ${m.name}?`, 'Человек сразу выйдет из звонка и не сможет попроситься обратно в эту комнату. Жёстко, но справедливо.', 'Удалить')) call?.room.kick(m.id);
}

function chatPanel(box) {
  const c = call;
  const list = h('div', { class: 'chat-list' });
  if (!c.chat.length) list.append(h('p', { class: 'hint', text: 'Сообщения и фото идут напрямую участникам и нигде не хранятся. Кто опоздал, тот не узнает.' }));
  c.chat.forEach((m, i) => list.append(chatItem(m, c.chat[i - 1])));
  c.screen.chatList = list;
  box.append(list);
  const input = h('input', { class: 'input', placeholder: 'Сообщение', maxlength: '2000', autocomplete: 'off', 'aria-label': 'Сообщение' });
  const send = () => { if (c.room.sendChat(input.value)) { input.value = ''; } input.focus(); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
  // Вставить скриншот из буфера — сразу отправить его как фото.
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); sendPhotos(files); }
  });
  const file = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true,
    on: { change: () => { sendPhotos([...file.files]); file.value = ''; } } });
  if (!isTouch) setTimeout(() => input.focus(), 50);
  return h('form', { class: 'chat-form', on: { submit: (e) => { e.preventDefault(); send(); } } },
    file,
    h('button', { class: 'ctl small', type: 'button', 'aria-label': 'Отправить фото', title: 'Отправить фото', on: { click: () => pickPhotos(file) } }, icon('image')),
    input, h('button', { class: 'ctl small', type: 'submit', 'aria-label': 'Отправить', title: 'Отправить' }, icon('send')));
}

const hhmm = (ts) => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

// Подряд от одного человека за три минуты — без повтора имени, как в мессенджерах.
function chatItem(m, prev) {
  const cont = prev && prev.from === m.from && m.ts - prev.ts < 3 * 60000;
  return h('div', { class: 'chat-msg' + (m.me ? ' me' : '') + (cont ? ' cont' : '') },
    cont ? null : h('small', { raw: (m.me ? 'Вы' : m.name) + ' · ' + hhmm(m.ts) }),
    m.kind === 'img' ? photoBox(m) : h('p', {}, linkify(m.text)));
}

// Ссылки в сообщении становятся нажимаемыми. Остальной текст — просто текст, без разметки.
function linkify(text) {
  const out = [];
  let last = 0;
  for (const mt of text.matchAll(/https?:\/\/[^\s<>"«»]+/gi)) {
    const url = mt[0].replace(/[.,!?;:)\]}'"]+$/, '');
    if (mt.index > last) out.push(document.createTextNode(text.slice(last, mt.index)));
    let ok = false;
    try { ok = /^https?:$/.test(new URL(url).protocol); } catch {}
    out.push(ok ? h('a', {
      href: url, target: '_blank', rel: 'noopener noreferrer nofollow', raw: url,
      on: { click: (e) => { if (native.available && url.startsWith('https:')) { e.preventDefault(); native.openExternal(url); } } },
    }) : document.createTextNode(url));
    last = mt.index + url.length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

function photoBox(m) {
  const box = h('button', { class: 'photo', type: 'button', 'aria-label': 'Открыть фото', on: { click: () => { if (m.url) photoViewer(m); } } });
  if (m.w && m.h) box.style.aspectRatio = `${m.w} / ${m.h}`;
  call.photoBoxes.set(m.from + ':' + m.id, box);
  fillPhoto(box, m);
  return box;
}

function fillPhoto(box, m) {
  const note = (text) => h('span', { class: 'photo-note', text });
  box.disabled = !m.url;
  if (m.failed && !m.url) { replace(box, note('Фото не дошло. Попросите прислать ещё раз.')); return; }
  if (!m.url) { replace(box, note(`Фото · ${Math.round((m.progress || 0) * 100)}%`)); return; }
  let status = null;
  if (m.me && (m.progress || 0) < 1) status = `Отправляется · ${Math.round((m.progress || 0) * 100)}%`;
  else if (m.me && m.total === 0) status = 'Некому отправить: вы одни';
  else if (m.me && m.sent < m.total) status = 'Дошло не всем';
  const img = box.querySelector('img') || h('img', { src: m.url, alt: m.me ? 'Ваше фото' : 'Фото от: ' + m.name, decoding: 'async' });
  replace(box, img, status ? note(status) : null);
}

function photoViewer(m) {
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const img = h('img', { src: m.url, alt: m.me ? 'Ваше фото' : 'Фото от: ' + m.name });
  const back = h('div', { class: 'viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Фото',
    on: { click: (e) => { if (e.target === back || e.target.classList.contains('viewer-img')) close(); } } },
    h('header', {},
      h('div', { class: 'who' }, h('b', { raw: m.me ? 'Вы' : m.name }), h('small', { text: hhmm(m.ts) })),
      m.blob ? h('button', { class: 'btn small', on: { click: () => savePhoto(m) } }, icon('download'), 'Сохранить') : null,
      h('button', { class: 'icon-btn', 'aria-label': 'Закрыть', title: 'Закрыть', on: { click: close } }, icon('close'))),
    h('div', { class: 'viewer-img' }, img));
  document.addEventListener('keydown', onKey);
  document.body.append(back);
}

async function savePhoto(m) {
  const ext = { 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }[m.blob.type] || 'jpg';
  const d = new Date(m.ts);
  const name = `svoi-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}.${ext}`;
  if (native.available && native.canPickImage) {
    const ok = await native.saveImage(m.blob, name);
    toast(ok ? 'Фото в галерее, в папке Svoi' : 'Не удалось сохранить. Сохранение работает на Android 10 и новее.');
    return;
  }
  const a = h('a', { href: m.url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
}

function invitePanel(box) {
  const { link, isHost } = call;
  const canvas = h('canvas', { width: 200, height: 200, 'aria-label': 'QR-код ссылки' });
  drawQr(canvas, link);
  const copyBtn = h('button', { class: 'btn small', on: { click: async () => { await copyText(link); toast('Ссылка скопирована'); } } }, icon('copy'), 'Скопировать');
  const canShare = native.available || !!navigator.share;
  box.append(
    h('p', { class: 'hint', text: isHost
      ? 'Отправьте ссылку тем, кого ждёте. Каждого вы впустите сами.'
      : 'Ссылку можно переслать. Хозяин всё равно сам решит, кого впустить.' }),
    h('div', { class: 'linkbox', raw: link }),
    h('div', { class: 'row' }, copyBtn,
      canShare ? h('button', { class: 'btn small', on: { click: () => shareLink(link) } }, icon('share'), 'Отправить') : null),
    h('div', { class: 'qr' }, canvas),
    h('p', { class: 'hint', text: 'Наведите камеру телефона на код, чтобы открыть ссылку.' }),
    h('p', { class: 'hint', text: 'Ссылка работает как ключ от комнаты. Не выкладывайте её в открытые чаты и соцсети.' }),
  );
}

function securityPanel(box) {
  const { room } = call;
  box.append(
    h('div', { class: 'receipt' }, h('small', { text: 'Ваш код проверки' }), h('b', { raw: room.myCode || '' })),
    h('p', { class: 'hint', text: 'Как сверить: попросите собеседника назвать его код. Он должен совпасть с кодом в списке участников.' }),
    securityFacts(),
    h('p', { class: 'hint', text: 'Запись экрана на чужом устройстве шифрование не остановит. Впускайте только тех, кому доверяете.' }),
  );
  const st = room.channel?.status() || [];
  box.append(h('section', { class: 'stack' }, h('h3', { text: 'Серверы для просьб войти' }),
    h('ul', { class: 'people' }, st.map((b) => h('li', {}, h('div', { class: 'who' }, h('b', { raw: b.name }), h('small', { text: b.ready ? 'на связи' : 'нет связи' })), h('span'))))));
  const conns = [...room.conns.values()];
  if (conns.length) {
    const ul = h('ul', { class: 'people' });
    box.append(h('section', { class: 'stack' }, h('h3', { text: 'Путь звонка' }), ul));
    conns.forEach(async (conn) => {
      const st = await conn.stats().catch(() => null);
      const name = room.members.get(conn.id)?.name || 'Участник';
      const text = conn.state !== 'connected' ? 'ещё нет соединения' : st?.relay ? 'через ретранслятор, зашифровано' : 'напрямую, зашифровано';
      const tech = `адреса: свои ${[...conn.info.local].join(', ') || 'нет'}; собеседника ${[...conn.info.remote].join(', ') || 'нет'}; попыток ${conn.attempt}, сбоев ${conn.failures}`;
      ul.append(h('li', {}, h('div', { class: 'who' }, h('b', { raw: name }), h('small', { text }), h('small', { raw: tech })), h('span')));
    });
  }
}

// Настройки разложены по вкладкам: что меняется у всех (комната) — отдельно от того, что только у вас.
const SETTINGS_TABS = [['room', 'Комната'], ['av', 'Звук и видео'], ['net', 'Связь']];

function settingsPanel(box) {
  const c = call;
  const tabs = SETTINGS_TABS.filter(([k]) => k !== 'room' || c.isHost);
  if (!tabs.some(([k]) => k === c.settingsTab)) c.settingsTab = tabs[0][0];
  box.append(segmented('Раздел настроек', tabs, c.settingsTab, (v) => { c.settingsTab = v; renderPanel(); }));
  box.firstChild.classList.add('tabs');
  if (c.settingsTab === 'room') box.append(roomSettings());
  if (c.settingsTab === 'av') box.append(avSettings());
  if (c.settingsTab === 'net') box.append(netSettings());
}

function avSettings() {
  const devices = h('div', { class: 'stack' });
  fillDevices(devices, true);
  return h('div', { class: 'stack' },
    h('p', { class: 'hint', text: 'Это меняется только у вас.' }),
    devices, noiseField(), echoField(),
    native.available ? videoSoundField() : null,
    document.pictureInPictureEnabled && !native.available ? h('div', { class: 'field' }, h('span', { text: 'Окно поверх других' }),
      h('button', { class: 'btn small', style: { justifySelf: 'start' }, on: { click: () => enterPip() } }, 'Включить'),
      h('small', { class: 'hint', text: 'Собеседник остаётся на экране, пока вы в другой программе.' })) : null);
}

function videoSoundField() {
  const box = h('input', { type: 'checkbox', checked: prefs.videoSound, on: { change: () => { prefs.videoSound = box.checked; native.setVideoSound(box.checked); } } });
  return h('label', { class: 'check' }, box, h('span', {},
    h('span', { text: 'Громкое видео, пока звонок свёрнут' }), h('br'),
    h('small', { class: 'hint', text: 'Сверните звонок, и он уйдёт в окошко. YouTube и другие приложения будут звучать как обычно. Без наушников друзья тоже услышат видео.' })));
}

function netSettings() {
  const net = prefs.net;
  const turn = call.room.turn?.urls;
  return h('div', { class: 'stack' },
    h('div', { class: 'field' }, h('span', { text: 'Проверка связи' }),
      h('button', { class: 'btn small', style: { justifySelf: 'start' }, on: { click: () => diagModal() } }, 'Проверить'),
      h('small', { class: 'hint', text: 'Покажет, пропускает ли ваш интернет звонок. Снимок результата можно прислать тому, кто разбирается.' })),
    h('div', { class: 'field' }, h('span', { text: 'Ретранслятор' }),
      h('p', { class: 'hint', text: turn
        ? (net.relayOnly ? 'Подключён. Звонок идёт только через него: собеседники не видят ваш IP-адрес.' : 'Подключён. Помогает, когда напрямую не соединиться.')
        : 'Не подключён. Добавить можно на главном экране, в настройках соединения.' })),
    h('div', { class: 'field' }, h('span', { text: 'Звонок в фоне' }),
      h('p', { class: 'hint', text: native.available
        ? 'Приложение держит звонок, даже когда свёрнуто.'
        : 'На телефоне браузер может приглушить свёрнутый звонок, чтобы беречь заряд. Надёжнее звонить из приложения для Android.' })));
}

// Настройки комнаты: меняются у всех, поэтому их меняет только хозяин.
function roomSettings() {
  const { room } = call;
  const mode = room.locked ? 'closed' : room.openLink ? 'link' : 'ask';
  const titleInput = h('input', { class: 'input', maxlength: '80', placeholder: 'Например, созвон дизайнеров', value: room.title });
  const parts = [
    h('p', { class: 'hint', text: 'Это меняется у всех участников.' }),
    autoField('Название встречи', titleInput, (v) => room.setTitle(v)),
    choiceGroup('Кто может войти', 'entry', [
      ['link', 'Все, у кого есть ссылка', 'Входят сразу. Ссылка и есть пропуск.'],
      ['ask', 'Те, кого вы впустите', 'Каждый просится войти, вы нажимаете «Впустить».'],
      ['closed', 'Никто, вход закрыт', 'Новые не войдут даже по ссылке. Кто внутри, тот остаётся.'],
    ], mode, (v) => {
      if (v === 'closed') room.setLocked(true);
      else { room.setLocked(false); room.setOpenLink(v === 'link'); }
      toast({ link: 'Теперь все со ссылкой входят сразу', ask: 'Теперь каждого гостя впускаете вы', closed: 'Вход закрыт' }[v]);
      renderPanel();
    }),
  ];
  if (mode === 'ask') {
    const codeInput = h('input', { class: 'input mono', maxlength: '40', autocomplete: 'off', spellcheck: 'false', placeholder: 'Пусто — без кода', value: room.entryCode });
    const auto = h('input', { type: 'checkbox', checked: room.autoKnown, on: { change: () => room.setAutoKnown(auto.checked) } });
    parts.push(h('div', { class: 'stack sub' },
      autoField('Код входа', codeInput, (v) => room.setEntryCode(v), 'С этим кодом гости входят сразу, без «Впустить».'),
      h('label', { class: 'check' }, auto, h('span', {}, h('span', { text: 'Знакомые входят сами' }), h('br'),
        h('small', { class: 'hint', text: `Те, кого вы уже впускали: ${room.known.size}.` }))),
      room.known.size ? h('button', { class: 'btn small', style: { justifySelf: 'start' }, on: { click: () => { room.forgetKnown(); toast('Знакомые забыты. Теперь каждый снова стучится.'); renderPanel(); } } }, 'Забыть знакомых') : null));
  }
  const rec = rooms.get(room.hostId);
  parts.push(h('div', { class: 'field' }, h('span', { text: 'Код хозяина' }),
    h('p', { class: 'hint', text: rec?.hostCode || room.shareState
      ? 'Задан. С ним можно стать хозяином на другом устройстве.'
      : 'Не задан. Его можно задать только при создании комнаты.' })));
  return h('div', { class: 'stack' }, parts);
}

// ---------- окна ----------

function confirmModal(title, text, okText) {
  return new Promise((resolve) => {
    const done = (v) => { back.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') done(false); };
    const ok = h('button', { class: 'btn danger', on: { click: () => done(true) } }, okText);
    const back = h('div', { class: 'modal-back', on: { click: (e) => { if (e.target === back) done(false); } } },
      h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('h2', { raw: title }), h('p', { text }),
        h('div', { class: 'row' }, ok, h('button', { class: 'btn', on: { click: () => done(false) } }, 'Отмена'))));
    document.addEventListener('keydown', onKey);
    document.body.append(back);
    ok.focus();
  });
}

function sheetModal(title, ...content) {
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const back = h('div', { class: 'modal-back', on: { click: (e) => { if (e.target === back) close(); } } },
    h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, style: { maxHeight: '86dvh', overflowY: 'auto', width: 'min(560px, 100%)' } },
      h('div', { class: 'topback' }, h('h2', { text: title }), h('button', { class: 'icon-btn', 'aria-label': 'Закрыть', on: { click: () => close() } }, icon('close'))),
      ...content));
  document.addEventListener('keydown', onKey);
  document.body.append(back);
  return close;
}

function securityModal() {
  const items = [
    ['Прямая связь', 'Звук, видео, экран и чат идут напрямую между устройствами участников. Они зашифрованы протоколом DTLS-SRTP, как в Google Meet и Signal. Своего сервера у звонка нет.'],
    ['Ключ в ссылке', 'Секрет комнаты из 256 бит хранится только в ссылке, после знака #. Браузер не отправляет эту часть адреса на сервер. GitHub, где лежит страница, её не видит.'],
    ['Посредник ничего не узнаёт', 'Чтобы найти друг друга, устройства обмениваются короткими служебными сообщениями через публичные посредники MQTT. Каждое сообщение зашифровано AES-256 и подписано. Посредник видит только шум.'],
    ['Без подмены', 'Каждое служебное сообщение подписано ключом отправителя. Отпечатки ключей шифрования звонка передаются в подписанных личных конвертах. Встать посередине и подслушать нельзя.'],
    ['Хозяин решает', 'Метка хозяина зашита в ссылку. Список участников принимается только с его подписью. Одной ссылки мало: пока хозяин не впустит, войти нельзя.'],
    ['Код проверки', 'Когда гость стучится, хозяин добавляет к его коду случайную часть. Поэтому код нельзя подобрать заранее. Хозяин просит гостя назвать код голосом. Совпал — значит, это он.'],
    ['Никто не видит, кто стучится', 'Запрос гостя и ответ хозяина запечатаны лично для получателя. Даже человек со ссылкой не видит, кто просится войти и кто уже в комнате.'],
    ['Что защита не закрывает', 'Если чужой человек получил доступ к вашему телефону, или участник записывает экран, шифрование не поможет. Собеседники видят IP-адреса друг друга. Скрыть его можно через TURN-ретранслятор в настройках соединения.'],
  ];
  sheetModal('Как устроена защита', ...items.map(([t, d]) => h('section', { class: 'stack', style: { gap: '4px' } }, h('b', { text: t }), h('p', { class: 'hint', text: d }))));
}

function networkModal() {
  const net = prefs.net;
  const urls = h('input', { class: 'input mono', placeholder: 'turn:example.com:3478', value: (net.turn?.urls || []).join(' '), autocomplete: 'off', spellcheck: 'false' });
  const user = h('input', { class: 'input mono', placeholder: 'логин', value: net.turn?.username || '', autocomplete: 'off' });
  const pass = h('input', { class: 'input mono', type: 'password', placeholder: 'пароль', value: net.turn?.credential || '', autocomplete: 'off' });
  const relay = h('input', { type: 'checkbox', checked: !!net.relayOnly });
  const err = h('p', { class: 'error', hidden: true });
  let close;
  const save = () => {
    const list = urls.value.split(/[\s,]+/).filter(Boolean);
    if (list.some((u) => !/^turns?:[^\s]+$/.test(u))) { err.hidden = false; err.textContent = 'Адрес начинается с turn: или turns:'; return; }
    prefs.net = { turn: list.length ? { urls: list, username: user.value.trim(), credential: pass.value } : null, relayOnly: relay.checked && list.length > 0 };
    close();
  };
  close = sheetModal('Настройки соединения',
    h('p', { class: 'hint', text: 'Обычно устройства соединяются напрямую. Иногда в мобильных сетях это не получается. Тогда нужен TURN-ретранслятор: он пересылает уже зашифрованный звонок и не может его прочитать.' }),
    h('p', { class: 'hint', text: 'Бесплатный ретранслятор можно получить, например, в Metered или ExpressTURN. Сервис выдаст адрес, логин и пароль.' }),
    h('label', { class: 'field' }, h('span', { text: 'Адрес ретранслятора' }), urls),
    h('label', { class: 'field' }, h('span', { text: 'Логин' }), user),
    h('label', { class: 'field' }, h('span', { text: 'Пароль' }), pass),
    h('label', { class: 'check' }, relay, h('span', { text: 'Всегда через ретранслятор. Собеседники не увидят мой IP-адрес, но связь может стать медленнее.' })),
    h('p', { class: 'hint', text: 'Адрес и логин ретранслятора попадут в ссылки на новые комнаты: так гости тоже смогут им пользоваться.' }),
    err,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', on: { click: save } }, 'Сохранить'), h('button', { class: 'btn', on: { click: () => close() } }, 'Отмена')),
  );
}

// ---------- шумодав ----------

const NOISE_TEXT = {
  off: ['Выключен', 'Звук идёт как есть.'],
  browser: ['Обычный', 'Встроенный шумодав браузера. Убирает ровный гул.'],
  strong: ['Сильный', 'Нейросеть RNNoise на вашем устройстве. Убирает клавиатуру, вентилятор, улицу. Звук никуда не уходит.'],
};

function noiseField() {
  const hint = h('small', { class: 'hint' });
  const current = () => media?.noise || prefs.noise;
  const paint = () => {
    const failed = media?.noise === 'strong' && media.noiseActive !== 'strong' && media.rawMic;
    hint.textContent = failed ? 'Сильный шумодав не запустился на этом устройстве. Работает обычный.' : NOISE_TEXT[current()][1];
  };
  const seg = segmented('Шумодав', Object.entries(NOISE_TEXT).map(([v, [label]]) => [v, label]), current(), async (v) => {
    prefs.noise = v;
    seg.dataset.busy = '1';
    hint.textContent = NOISE_TEXT[v][1];
    await media?.setNoise(v);
    delete seg.dataset.busy;
    seg.paint(current());
    paint();
  });
  paint();
  return h('div', { class: 'field' }, h('span', { text: 'Шумодав' }), seg, hint);
}

const ECHO_TEXT = {
  normal: ['Обычное', 'Убирает из микрофона голоса собеседников. Лучшее анти-эхо — наушники.'],
  strong: ['Сильное', 'Для громкой связи: пока говорят другие, ваш микрофон тише. Перебить можно, но громче.'],
};

function echoField() {
  const hint = h('small', { class: 'hint' });
  const current = () => media?.echo || prefs.echo;
  const seg = segmented('Анти-эхо', Object.entries(ECHO_TEXT).map(([v, [label]]) => [v, label]), current(), async (v) => {
    prefs.echo = v;
    seg.dataset.busy = '1';
    hint.textContent = ECHO_TEXT[v][1];
    await media?.setEcho(v);
    delete seg.dataset.busy;
    seg.paint(current());
    hint.textContent = ECHO_TEXT[current()][1];
  });
  hint.textContent = ECHO_TEXT[current()][1];
  return h('div', { class: 'field' }, h('span', { text: 'Анти-эхо' }), seg, hint);
}

// Любое касание будит звук: браузер не даёт включить его без действия человека.
document.addEventListener('pointerdown', () => media?.resumeAudio(), { capture: true });

// ---------- звонок в фоне ----------

// Окно поверх других: видео собеседника (или показ экрана) в маленьком окне.
async function enterPip() {
  if (!document.pictureInPictureEnabled) return;
  const vids = [...document.querySelectorAll('.stage .tile.share video, .stage .tile.remote video')]
    .filter((v) => !v.hidden && v.readyState >= 1 && v.videoWidth > 0);
  if (!vids.length) { toast('Нет видео собеседника для окна поверх других'); return; }
  try { await vids[0].requestPictureInPicture(); } catch {}
}

// Кнопки в шторке телефона и в окне поверх других: микрофон, камера, завершить.
function mediaSession(on) {
  const ms = navigator.mediaSession;
  if (!ms) return;
  const set = (action, fn) => { try { ms.setActionHandler(action, on ? fn : null); } catch {} };
  try { ms.metadata = on && window.MediaMetadata ? new MediaMetadata({ title: call?.room.title || 'Звонок', artist: 'Свои' }) : null; } catch {}
  set('togglemicrophone', () => media?.setMic(!media.state().mic));
  set('togglecamera', () => media?.setCam(!media.state().cam));
  set('hangup', () => hangUp());
  set('enterpictureinpicture', () => enterPip()); // браузер сам откроет окно, когда вкладку свернут
  // «Играет» — так телефон считает вкладку звонком и реже усыпляет её.
  try { ms.playbackState = on ? 'playing' : 'none'; } catch {}
  if (on) syncMediaSession();
}

function syncMediaSession() {
  const s = media?.state();
  if (!s) return;
  try { navigator.mediaSession?.setMicrophoneActive?.(s.mic); navigator.mediaSession?.setCameraActive?.(s.cam); } catch {}
}

// ---------- проверка связи ----------

const kb = (n) => (n >= 1000 ? Math.round(n / 1000) + ' КБ' : '0,5 КБ');

function diagModal() {
  const out = h('div', { class: 'stack' });
  const rerun = h('button', { class: 'btn small', on: { click: () => run() } }, 'Проверить ещё раз');
  sheetModal('Проверка связи',
    h('p', { class: 'hint', text: 'Проверка займёт около 30 секунд. Потом сделайте снимок экрана и пришлите его.' }),
    out, rerun);

  async function run() {
    rerun.disabled = true;
    const brokerList = h('ul', { class: 'people' });
    const stunList = h('ul', { class: 'people' });
    const verdict = h('div', { class: 'stack' });
    replace(out,
      h('p', { class: 'hint', raw: `${navigator.userAgent.match(/(Android [\d.]+|Mac OS X [\d_]+|Windows NT [\d.]+|iPhone OS [\d_]+)/)?.[0] || 'устройство'} · ${(navigator.userAgent.match(/(Chrome|Firefox|Version)\/[\d.]+/) || [''])[0]} · ${native.available ? 'приложение' : 'браузер'} · ${new Date().toLocaleTimeString('ru-RU')}` }),
      h('h3', { text: 'Серверы для просьб войти' }), brokerList,
      h('h3', { text: 'Определение своего адреса (STUN)' }), stunList,
      verdict);

    const brokerRows = BROKERS.map((url) => {
      const row = h('li', {}, h('div', { class: 'who' }, h('b', { raw: url.split('/')[2].split(':')[0] }), h('small', { text: 'подключаемся…' })), h('span'));
      brokerList.append(row);
      return row;
    });
    const showBroker = (row, r) => {
      const parts = [r.connectMs === null ? 'не подключается' : `подключён за ${r.connectMs} мс`];
      if (r.sizes.length) parts.push(r.sizes.map((x) => `${kb(x.size)} ${x.ok ? 'дошло' : 'НЕ ДОШЛО'}`).join(' · '));
      row.querySelector('small').textContent = parts.join('. ');
    };
    const stunRows = STUN.map((u) => {
      const row = h('li', {}, h('div', { class: 'who' }, h('b', { raw: u.replace(/^stun:/, '') }), h('small', { text: 'проверяем…' })), h('span'));
      stunList.append(row);
      return row;
    });

    const net = prefs.net;
    const [brokers, stuns, turn] = await Promise.all([
      Promise.all(BROKERS.map((url, i) => checkBroker(url, (r) => showBroker(brokerRows[i], r)))),
      Promise.all(STUN.map(async (u, i) => {
        const r = await checkStun(u);
        stunRows[i].querySelector('small').textContent = r.publicMs !== null ? `адрес найден за ${r.publicMs} мс` : (r.types.length ? 'не отвечает' : 'браузер не выдал ни одного адреса');
        return r;
      })),
      net.turn?.urls ? checkStun(net.turn.urls, { username: net.turn.username, credential: net.turn.credential }) : null,
    ]);

    // Вывод простыми словами.
    const says = [];
    const anyBroker = brokers.some((b) => b.ok);
    const frozen = brokers.filter((b) => b.connectMs !== null && !b.ok);
    if (!brokers.some((b) => b.connectMs !== null)) says.push('Ни один сервер для просьб войти недоступен. Без них гости не смогут попроситься в комнату. Попробуйте другую сеть или VPN.');
    else if (frozen.length) says.push(`Сервер ${frozen.map((b) => b.name).join(', ')} подключается, но крупные посылки не доходят. Это ограничение провайдера.${anyBroker ? ' Другой сервер работает, звонок пройдёт через него.' : ' Приложение его обходит: сжимает сообщения и часто переподключается. Соединяться будет на несколько секунд дольше.'}`);
    else says.push('Серверы для просьб войти работают.');
    const allTypes = new Set(stuns.flatMap((s) => s.types));
    if (!allTypes.size) says.push('Браузер не выдаёт ни одного сетевого адреса. Так бывает, когда VPN-расширение включает защиту WebRTC. Выключите её для этого сайта или подключите ретранслятор.');
    else if (!stuns.some((s) => s.publicMs !== null)) says.push('Устройство не может узнать свой адрес в интернете. Звонок сработает только внутри одной сети Wi-Fi. Для звонков через интернет нужен ретранслятор.');
    else says.push('Своё место в интернете устройство определяет.');
    const seen = [...new Set(stuns.flatMap((s) => s.addrs || []))];
    if (seen.length) says.push(`Адрес, который видят собеседники при прямой связи: ${seen.join(', ')}. Сравните его с адресом в вашем VPN. Не совпадает — звонок идёт мимо VPN.`);
    if (turn) says.push(turn.publicMs !== null ? 'Ретранслятор отвечает.' : 'Ретранслятор из настроек не отвечает. Проверьте адрес, логин и пароль.');
    replace(verdict, h('h3', { text: 'Итог' }), says.map((t) => h('p', { class: 'hint', text: t })));
    rerun.disabled = false;
  }
  run();
}

// ---------- мелочи ----------

function drawQr(canvas, text) {
  try {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 2;
    const size = n + quiet * 2;
    canvas.width = size * 4;
    canvas.height = size * 4;
    const g = canvas.getContext('2d');
    g.fillStyle = '#F4EFE8';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = '#15120F';
    for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) if (qr.isDark(r, col)) g.fillRect((col + quiet) * 4, (r + quiet) * 4, 4, 4);
  } catch (e) { console.warn('qr', e); }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return; } catch {}
  const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  try { document.execCommand('copy'); } catch {}
  ta.remove();
}

async function shareLink(link) {
  const text = 'Приглашение на звонок в «Свои». Откройте ссылку и попроситесь войти:\n' + link;
  if (native.available) return native.share(text);
  try { await navigator.share({ title: 'Свои', text: 'Приглашение на звонок в «Свои»', url: link }); }
  catch (e) { if (e?.name !== 'AbortError') { await copyText(link); toast('Ссылка скопирована'); } }
}

boot();
