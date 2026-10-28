// Экраны приложения «Свои»: главный, подготовка, ожидание, звонок, конец.

import { h, icon, replace, clear, initials } from './dom.js';
import * as C from './crypto.js';
import { Room, MAX_MEMBERS, SLOT } from './room.js';
import { LocalMedia } from './media.js';
import { prefs, rooms, session, keys } from './store.js';
import { makeLink, parseLink } from './link.js';
import { native } from './native.js';
import qrcode from './vendor/qrcode.js';

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
        on: { click: async () => { if (await confirmModal('Удалить комнату?', 'Ссылка перестанет работать навсегда. Это нельзя отменить.', 'Удалить')) { rooms.remove(r.hostId); home(); } } },
      }, icon('trash')),
    ))),
  ) : null;

  show(h('main', { class: 'screen' }, h('div', { class: 'home' },
    h('header', { class: 'brand' },
      h('h1', { text: 'Свои' }),
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
      h('p', { class: 'hint', text: isHost
        ? 'Вы хозяин. Гости попросятся войти, и вы сами решите, кого впустить.'
        : 'Хозяин увидит ваше имя и код проверки. Потом решит, впустить ли вас.' }),
      h('label', { class: 'field' }, h('span', { text: 'Ваше имя' }), nameInput),
      isHost ? h('label', { class: 'field' }, h('span', { text: 'Название встречи' }), titleInput, h('small', { class: 'hint', text: 'Название увидят только те, кого вы впустите.' })) : null,
      devices,
      err,
      go,
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
      if (isHost) await startAsHost(ctx.record, name, titleInput.value.trim());
      else await startAsGuest(ctx.link, name);
    } catch (e) {
      console.error(e);
      go.disabled = false;
      err.hidden = false;
      err.textContent = 'Не получилось начать: ' + (e.message || 'неизвестная ошибка');
      media.addEventListener('change', paint);
    }
  };
}

async function fillDevices(box, compact = false) {
  const { mics, cams } = await media.devices();
  clear(box);
  const mk = (label, list, kind, current) => {
    if (list.length < 2) return null;
    const sel = h('select', { class: 'input' }, list.map((d, i) => h('option', { value: d.deviceId, raw: d.label || `${label} ${i + 1}` })));
    const active = kind === 'audioinput' ? media.mic?.getSettings?.().deviceId : media.cam?.getSettings?.().deviceId;
    sel.value = current || active || list[0].deviceId;
    sel.onchange = () => media.useDevice(kind, sel.value);
    return h('label', { class: 'field' }, h('span', { text: label }), sel);
  };
  box.append(...[mk('Микрофон', mics, 'audioinput', media.micId), mk('Камера', cams, 'videoinput', media.camId)].filter(Boolean));
  if (compact && !box.childElementCount) box.append(h('p', { class: 'hint', text: 'Другие микрофоны и камеры не найдены.' }));
}

async function startAsHost(record, name, title) {
  let rec = record;
  if (!rec) {
    const k = await C.createKeys();
    const id = await C.loadIdentity(k);
    await keys.put('host:' + id.id, k);
    rec = { secret: C.b64u(C.newRoomSecret()), hostId: id.id, title, created: Date.now(), turn: prefs.net.turn || null, saved: null };
    rooms.save(rec);
  } else {
    rooms.update(rec.hostId, { title });
    rec = rooms.get(rec.hostId);
  }
  const k = await keys.get('host:' + rec.hostId);
  if (!k?.sig) throw new Error('ключи этой комнаты не найдены на устройстве. Создайте новую комнату.');
  const identity = await C.loadIdentity(k);
  if (identity.id !== rec.hostId) throw new Error('ключи комнаты повреждены');
  const secret = C.unb64u(rec.secret);
  const inviteTurn = prefs.net.turn || rec.turn || null;
  startCall({ isHost: true, secret, hostId: rec.hostId, identity, name, title, turn: inviteTurn, inviteTurn, saved: rec.saved });
}

async function startAsGuest(link, name) {
  const slot = 'guest:' + C.b64u(await C.sha256(link.secret)).slice(0, 22);
  let k = await keys.get(slot);
  if (!k?.sig) { k = await C.createKeys(); await keys.put(slot, k); }
  const identity = await C.loadIdentity(k);
  // В режиме «только через ретранслятор» гость идёт через свой, а не через ретранслятор хозяина:
  // иначе владелец чужого ретранслятора увидит его IP-адрес.
  const net = prefs.net;
  const turn = net.relayOnly && net.turn ? net.turn : (link.turn || net.turn);
  startCall({ isHost: false, secret: link.secret, hostId: link.hostId, identity, name, title: '', turn, inviteTurn: link.turn });
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
    signalDownSince: 0,
  };

  room.addEventListener('phase', (e) => onPhase(e.detail));
  room.addEventListener('members', () => onMembers());
  room.addEventListener('peer', () => scheduleRender());
  room.addEventListener('local', () => { scheduleRender(); native.callActive(true, media.state()); });
  room.addEventListener('knocks', (e) => onKnocks(e.detail));
  room.addEventListener('chat', (e) => onChat(e.detail));
  room.addEventListener('levels', (e) => onLevels(e.detail));
  room.addEventListener('host', () => renderBanners());
  room.addEventListener('code', () => { if (call && !call.screen) showWaiting(); });
  room.addEventListener('signal', (e) => {
    call.signalDownSince = e.detail.online ? 0 : Date.now();
    setTimeout(() => renderBanners(), 6500);
    renderBanners();
  });
  room.addEventListener('persist', (e) => rooms.update(opts.hostId, { saved: e.detail }));

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
  if (phase === 'left') return;
  if (phase === 'denied' && call.screen) { teardown(); return endScreen(reason === 'kicked' ? 'kicked' : 'denied'); }
  if (!call.screen) showWaiting();
}

// ---------- ожидание гостя ----------

const WAIT_TEXT = {
  'connecting': ['Подключаемся', 'Ищем связь с посредником. Обычно это пара секунд.'],
  'waiting-host': ['Ищем хозяина комнаты', 'Хозяин пока не в сети. Когда он откроет комнату, запрос уйдёт сам.'],
  'knocking': ['Ждём, пока вас впустят', 'Хозяин видит ваше имя и код проверки.'],
  'locked': ['Вход закрыт', 'Хозяин закрыл комнату для новых гостей. Когда он откроет вход, запрос уйдёт сам.'],
  'full': ['Комната заполнена', `В комнате уже ${MAX_MEMBERS} человек, это предел. Как только место освободится, запрос уйдёт сам.`],
  'denied': ['Вас не впустили', 'Хозяин отклонил запрос.'],
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
  requestAnimationFrame(() => { renderQueued = false; if (call?.screen) { renderStage(); renderControls(); if (call.panel === 'people') renderPanel(); } });
}

function showCall() {
  const c = call;
  c.started = Date.now();
  const titleEl = h('div', { class: 'title' });
  const timer = h('span', { class: 'timer' }, '00:00');
  const banners = h('div');
  const stage = h('div', { class: 'stage' });
  const body = h('div', { class: 'body' }, stage);
  const controls = h('nav', { class: 'controls', 'aria-label': 'Управление звонком' });
  const toasts = h('div', { class: 'toasts', 'aria-live': 'polite' });
  const audioBox = h('div', { hidden: true });
  const root = h('main', { class: 'call' },
    h('header', { class: 'topbar' }, titleEl,
      h('button', { class: 'secure', on: { click: () => openPanel('security') } }, h('i'), 'Защищено'),
      timer),
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
  buildControls();
  onMembers();
  renderBanners();
  native.callActive(true, media.state());
  keepAwake();
  window.addEventListener('beforeunload', beforeUnload);
  if (c.isHost && c.room.members.size <= 1) openPanel('invite');
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
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && call?.screen) keepAwake(); });

function onMembers() {
  const c = call;
  if (!c?.screen) return;
  const { room } = c;
  c.screen.titleEl.textContent = room.title || (c.isHost ? 'Ваша встреча' : 'Встреча');
  const now = new Set(room.members.keys());
  if (c.prevMembers.size) {
    for (const id of now) if (!c.prevMembers.has(id) && id !== room.me.id) toast(`${room.members.get(id).name} в комнате`);
    for (const id of c.prevMembers) if (!now.has(id) && id !== room.me.id) toast(`${c.names?.get(id) || 'Участник'} вышел из комнаты`);
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
  el.addEventListener('click', () => {
    if (el.parentElement?.classList.contains('strip')) { call.pinned = key; scheduleRender(); }
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
    const track = me ? (meSt.cam ? media.cam : null) : (st.cam ? conn?.tracks[SLOT.cam] : null);
    setTrack(t, track || null);
    t.video.hidden = !track;
    t.avatar.hidden = !!track;
    t.avatarText.textContent = initials(m.name);
    replace(t.label, st.mic ? null : icon('micOff'), h('b', { raw: m.name + (me ? ' (вы)' : '') }));
    let stateText = '';
    let bad = false;
    if (!me && conn) {
      if (conn.state === 'connecting') stateText = 'Соединяемся…';
      if (conn.state === 'failed') { stateText = 'Не удаётся соединиться напрямую'; bad = true; }
    }
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

  // Раскладка
  stage.className = 'stage';
  c.screen.body.classList.remove('duo');
  for (const t of camTiles) t.el.classList.remove('pip');
  let inGrid = [];
  if (screenTiles.length) {
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
    if (remote.length === 1 && self) {
      // Вдвоём: собеседник на весь экран, я в углу.
      c.screen.body.classList.add('duo');
      self.el.classList.add('pip');
      inGrid = [remote[0]];
      syncChildren(grid, [remote[0].el]);
      syncChildren(stage, [grid, self.el]);
    } else {
      inGrid = camTiles;
      syncChildren(grid, camTiles.map((t) => t.el));
      const hint = remote.length ? null : h('div', { class: 'empty-hint' },
        h('p', { text: c.isHost ? 'Вы пока одни. Отправьте ссылку тем, кого ждёте.' : 'Вы пока одни в комнате.' }),
        c.isHost ? h('button', { class: 'btn primary small', on: { click: () => openPanel('invite') } }, icon('link'), 'Пригласить') : null);
      const oldHint = stage.querySelector(':scope > .empty-hint');
      syncChildren(stage, hint ? [grid, oldHint || hint] : [grid]);
    }
  }
  for (const t of c.tiles.values()) if (!inGrid.includes(t)) { t.el.style.width = ''; t.el.style.height = ''; }
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
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    let w = (W - gap * (cols - 1)) / cols;
    let hh = (H - gap * (rows - 1)) / rows;
    if (w / hh > 16 / 9) w = hh * 16 / 9;
    if (w / hh < 3 / 4) hh = w * 4 / 3;
    if (w * hh > best.area) best = { area: w * hh, w, h: hh };
  }
  tiles.forEach((t) => { t.style.width = Math.floor(best.w) + 'px'; t.style.height = Math.floor(best.h) + 'px'; });
}

function onLevels(levels) {
  if (!call?.screen) return;
  for (const t of call.tiles.values()) {
    if (t.kind !== 'cam') continue;
    const v = levels[t.memberId] || 0;
    t.el.classList.toggle('speaking', v > 0.06);
  }
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
    mk('inviteBtn', 'Пригласить', () => togglePanel('invite')),
    h('span', { class: 'ctl-sep' }),
    mk('hangBtn', c.isHost ? 'Завершить встречу' : 'Выйти', hangUp),
  );
  c.screen.hangBtn.classList.add('hang');
  c.screen.inviteBtn.classList.add('invite');
  replace(c.screen.hangBtn, icon('hang'));
  replace(c.screen.peopleBtn, icon('people'));
  replace(c.screen.chatBtn, icon('chat'));
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
  badge(c.screen.peopleBtn, c.isHost ? c.room.knocks.size : 0);
  badge(c.screen.chatBtn, c.unread);
  for (const [k, b] of [['people', c.screen.peopleBtn], ['chat', c.screen.chatBtn], ['invite', c.screen.inviteBtn]]) {
    b.setAttribute('aria-pressed', c.panel === k ? 'true' : 'false');
    b.classList.toggle('on-air', c.panel === k);
  }
}

function badge(btn, n) {
  let b = btn.querySelector('.badge');
  if (!n) { b?.remove(); return; }
  if (!b) { b = h('span', { class: 'badge' }); btn.append(b); }
  b.textContent = n > 9 ? '9+' : String(n);
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
    const ok = await confirmModal('Завершить встречу?', 'Звонок закончится у всех. Ссылка продолжит работать, и вы сможете открыть комнату снова.', 'Завершить');
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
  call = null;
  session.clear();
}

function endScreen(reason, record = null) {
  if (call) teardown();
  stopMedia();
  const texts = {
    'ended': ['Встреча завершена', 'Хозяин завершил встречу для всех.'],
    'left': ['Вы вышли из встречи', 'Чтобы вернуться, откройте ссылку-приглашение ещё раз.'],
    'host-left': ['Встреча завершена', 'Ссылка продолжает работать. Комнату можно открыть снова с главного экрана.'],
    'kicked': ['Вас удалили из встречи', 'Хозяин удалил вас из комнаты.'],
    'denied': ['Вас не впустили', 'Хозяин отклонил запрос.'],
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
  if (!c.isHost && c.room.hostOnline === false) list.push('Хозяин не в сети. Связь между остальными сохраняется, но новых гостей впустить некому.');
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

function toast(text) {
  if (!call?.screen) return;
  const el = h('div', { class: 'toast plain', role: 'status' }, h('span', { raw: text }));
  call.screen.toasts.append(el);
  setTimeout(() => el.remove(), 3000);
}

// ----- чат -----

function onChat(msg) {
  const c = call;
  if (!c) return;
  c.chat.push(msg);
  if (c.chat.length > 300) c.chat.shift();
  if (c.panel === 'chat' && c.screen?.chatList?.isConnected) {
    c.screen.chatList.querySelector('.hint')?.remove();
    c.screen.chatList.append(chatItem(msg));
    const box = c.screen.chatList.parentElement;
    box.scrollTop = box.scrollHeight;
  } else if (!msg.me) {
    c.unread++;
    renderControls();
    toast(`${msg.name}: ${msg.text.length > 80 ? msg.text.slice(0, 80) + '…' : msg.text}`);
  }
}

// ----- панели -----

function togglePanel(name) {
  if (call.panel === name) closePanel();
  else openPanel(name);
}

function openPanel(name) {
  call.panel = name;
  if (name === 'chat') call.unread = 0;
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
  const content = h('div', { class: 'content' });
  let footer = null;
  const panel = h('aside', { class: 'panel ' + c.panel, 'aria-label': PANEL_TITLES[c.panel] },
    h('header', {}, h('h2', { text: PANEL_TITLES[c.panel] }),
      h('div', { class: 'row' },
        c.panel === 'security' ? null : h('button', { class: 'icon-btn', 'aria-label': 'Настройки', title: 'Настройки', on: { click: () => openPanel('settings') } }, icon('sliders')),
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
  requestAnimationFrame(layoutGrid);
}

function peoplePanel(box) {
  const { room, isHost } = call;
  box.append(h('button', { class: 'btn small', style: { justifySelf: 'start' }, on: { click: () => openPanel('invite') } }, icon('link'), 'Пригласить'));
  if (isHost && room.knocks.size) {
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
      if (m.host) status = (status ? status + ' · ' : '') + 'хозяин';
      return h('li', {},
        h('div', { class: 'who' }, h('b', { raw: m.name }), h('small', { text: status })),
        isHost && !m.me ? h('button', { class: 'btn small ghost', on: { click: () => kick(m) } }, 'Удалить') : h('span'),
        h('span', { class: 'code', raw: m.code }));
    })),
  ));
  if (isHost) {
    box.append(h('section', { class: 'stack' },
      h('button', { class: 'btn wide', on: { click: () => room.setLocked(!room.locked) } }, icon(room.locked ? 'unlock' : 'lock'), room.locked ? 'Открыть вход' : 'Закрыть вход'),
      h('p', { class: 'hint', text: room.locked ? 'Вход закрыт. Новые гости даже не смогут попроситься.' : 'Закройте вход, когда все собрались. Новые гости не смогут даже попроситься.' })));
  }
}

async function kick(m) {
  if (await confirmModal(`Удалить ${m.name}?`, 'Человек сразу выйдет из звонка и не сможет попроситься обратно в эту встречу.', 'Удалить')) call?.room.kick(m.id);
}

function chatPanel(box) {
  const c = call;
  const list = h('div', { class: 'chat-list' });
  if (!c.chat.length) list.append(h('p', { class: 'hint', text: 'Сообщения идут напрямую участникам и не сохраняются. Кто войдёт позже, их не увидит.' }));
  for (const m of c.chat) list.append(chatItem(m));
  c.screen.chatList = list;
  box.append(list);
  const input = h('input', { class: 'input', placeholder: 'Сообщение', maxlength: '2000', autocomplete: 'off', 'aria-label': 'Сообщение' });
  const send = () => { if (c.room.sendChat(input.value)) { input.value = ''; } input.focus(); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
  if (!isTouch) setTimeout(() => input.focus(), 50);
  return h('form', { class: 'chat-form', on: { submit: (e) => { e.preventDefault(); send(); } } },
    input, h('button', { class: 'ctl', type: 'submit', 'aria-label': 'Отправить', title: 'Отправить', style: { width: '44px', height: '44px' } }, icon('send')));
}

function chatItem(m) {
  return h('div', { class: 'chat-msg' + (m.me ? ' me' : '') },
    h('small', { raw: (m.me ? 'Вы' : m.name) + ' · ' + new Date(m.ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) }),
    h('p', { raw: m.text }));
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
  const conns = [...room.conns.values()];
  if (conns.length) {
    const ul = h('ul', { class: 'people' });
    box.append(h('section', { class: 'stack' }, h('h3', { text: 'Путь звонка' }), ul));
    conns.forEach(async (conn) => {
      const st = await conn.stats().catch(() => null);
      const name = room.members.get(conn.id)?.name || 'Участник';
      const text = conn.state !== 'connected' ? 'ещё нет соединения' : st?.relay ? 'через ретранслятор, зашифровано' : 'напрямую, зашифровано';
      ul.append(h('li', {}, h('div', { class: 'who' }, h('b', { raw: name }), h('small', { text })), h('span')));
    });
  }
}

function settingsPanel(box) {
  const devices = h('div', { class: 'stack' });
  fillDevices(devices, true);
  const net = prefs.net;
  box.append(
    h('section', { class: 'stack' }, h('h3', { text: 'Устройства' }), devices),
    h('section', { class: 'stack' }, h('h3', { text: 'Соединение' }),
      h('p', { class: 'hint', text: call.room.turn?.urls
        ? 'Подключён TURN-ретранслятор. Он помогает, когда прямое соединение не получается.'
        : 'TURN-ретранслятор не подключён. Его можно добавить на главном экране в настройках соединения.' }),
      net.relayOnly && call.room.turn?.urls ? h('p', { class: 'hint', text: 'Звонок идёт только через ретранслятор: собеседники не видят ваш IP-адрес.' }) : null),
  );
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
