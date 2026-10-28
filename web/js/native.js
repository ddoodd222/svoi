// Мост к приложению для Android. В обычном браузере моста нет, и всё здесь молчит.
//
// Приложение открывает мост только для своей встроенной страницы
// (https://appassets.androidplatform.net), чужой сайт его не увидит.
// Показ экрана в Android: приложение снимает экран системным MediaProjection
// и передаёт кадры сюда, а страница превращает их в обычную видеодорожку.

const bridge = globalThis.SvoiNative || null;

const listeners = new Map();
const on = (ev, fn) => listeners.set(ev, fn);
const fire = (ev, data) => listeners.get(ev)?.(data);

function post(cmd, extra = {}) {
  if (!bridge) return;
  try { bridge.postMessage(JSON.stringify({ cmd, ...extra })); } catch {}
}

// ---- кадры экрана -> видеодорожка ----
let canvas = null, ctx2d = null, busy = false, screenTrack = null;
let lastBmp = null, lastDraw = 0, keepTimer = null;

// Неподвижный экран не даёт новых кадров. Раз в секунду перерисовываем последний,
// чтобы вошедший позже участник сразу увидел картинку, а не чёрный прямоугольник.
function keepAlive(on) {
  clearInterval(keepTimer);
  keepTimer = on ? setInterval(() => {
    if (canvas && lastBmp && Date.now() - lastDraw > 900) { ctx2d.drawImage(lastBmp, 0, 0); lastDraw = Date.now(); }
  }, 1000) : null;
  if (!on) { lastBmp?.close?.(); lastBmp = null; }
}

async function drawFrame(data) {
  if (busy || !canvas) return; // не успеваем — пропускаем кадр, а не копим очередь
  busy = true;
  try {
    let bytes = data;
    if (typeof data === 'string') {
      const bin = atob(data.slice(1));
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    }
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    if (canvas.width !== bmp.width || canvas.height !== bmp.height) { canvas.width = bmp.width; canvas.height = bmp.height; }
    ctx2d.drawImage(bmp, 0, 0);
    lastBmp?.close?.();
    lastBmp = bmp;
    lastDraw = Date.now();
  } catch {} finally { busy = false; }
}

if (bridge) {
  bridge.onmessage = (event) => {
    const data = event.data;
    if (data instanceof ArrayBuffer) return drawFrame(new Uint8Array(data));
    if (typeof data !== 'string') return;
    if (data.charCodeAt(0) === 70 /* F */) return drawFrame(data);
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.ev === 'hello') { native.canShareScreen = !!msg.screen; native.canPickImage = !!msg.images; native.version = msg.version || null; fire('ready'); }
    else if (msg.ev === 'image') fire('image', msg);
    else if (msg.ev === 'saved') fire('saved', !!msg.ok);
    else if (msg.ev === 'screen-started') fire('screen', true);
    else if (msg.ev === 'screen-denied') fire('screen', false);
    else if (msg.ev === 'screen-stopped') { fire('screen', false); fire('screen-stopped'); }
    else if (msg.ev === 'link' && typeof msg.url === 'string') fire('link', msg.url);
    else if (msg.ev === 'clipboard') fire('clipboard', String(msg.text || ''));
  };
  post('hello');
}

export const native = {
  available: !!bridge,
  canShareScreen: false,
  canPickImage: false,
  version: null,

  onReady(fn) { on('ready', fn); },
  onLink(fn) { on('link', fn); },

  share(text) { post('share', { text }); },
  openExternal(url) { post('open', { url }); },
  callActive(active, { mic = false, cam = false } = {}) { post('call', { active, mic, cam }); },

  readClipboard() {
    return new Promise((resolve) => {
      on('clipboard', resolve);
      post('clipboard');
      setTimeout(() => resolve(''), 1500);
    });
  },

  startScreen() {
    return new Promise((resolve) => {
      canvas = document.createElement('canvas');
      canvas.width = 1280; canvas.height = 720;
      ctx2d = canvas.getContext('2d', { alpha: false });
      ctx2d.fillStyle = '#000';
      ctx2d.fillRect(0, 0, canvas.width, canvas.height);
      on('screen', (ok) => {
        on('screen', () => {});
        if (!ok) { canvas = null; return resolve(null); }
        screenTrack = canvas.captureStream(12).getVideoTracks()[0];
        keepAlive(true);
        resolve(screenTrack);
      });
      on('screen-stopped', () => { const t = screenTrack; screenTrack = null; canvas = null; keepAlive(false); native.onScreenStopped?.(t); });
      post('screen-start');
    });
  },

  stopScreen() {
    screenTrack = null;
    canvas = null;
    keepAlive(false);
    post('screen-stop');
  },

  onScreenStopped: null,

  // Фото из галереи телефона: приложение само уменьшает его и убирает метки места.
  pickImage() {
    return new Promise((resolve) => {
      on('image', (msg) => {
        if (!msg || msg.cancel || msg.error || typeof msg.data !== 'string') return resolve(msg?.error ? { error: true } : null);
        try {
          const bin = atob(msg.data);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          resolve({ blob: new Blob([bytes], { type: 'image/jpeg' }), w: msg.w | 0, h: msg.h | 0 });
        } catch { resolve({ error: true }); }
      });
      post('pick-image');
    });
  },

  async saveImage(blob, name) {
    const data = await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => resolve('');
      r.readAsDataURL(blob);
    });
    return new Promise((resolve) => {
      on('saved', resolve);
      post('save-image', { data, mime: blob.type, name });
      setTimeout(() => resolve(false), 15000);
    });
  },
};
