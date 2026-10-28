// Хранение на этом устройстве. На сервер отсюда не уходит ничего.
//  - localStorage: имя, настройки соединения, комнаты, которые вы создали;
//  - IndexedDB: ключи участника. Закрытые ключи неизвлекаемые: их можно использовать, но нельзя прочитать.

const LS = {
  get(k, def = null) {
    try { const v = localStorage.getItem(k); return v === null ? def : JSON.parse(v); } catch { return def; }
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
  },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

const SS = {
  get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { sessionStorage.removeItem(k); } catch {} },
};

export const prefs = {
  get name() { return LS.get('svoi.name', ''); },
  set name(v) { LS.set('svoi.name', v); },
  get media() { return LS.get('svoi.media', { mic: true, cam: true }); },
  set media(v) { LS.set('svoi.media', v); },
  get noise() { return LS.get('svoi.noise', 'strong'); },
  get echo() { return LS.get('svoi.echo', 'normal'); },
  set echo(v) { LS.set('svoi.echo', v); },
  set noise(v) { LS.set('svoi.noise', v); },
  // Громкость каждого собеседника у себя: id участника -> 0…1. Собеседник об этом не знает.
  get volumes() { const v = LS.get('svoi.volumes', {}); return v && typeof v === 'object' ? v : {}; },
  set volumes(v) { LS.set('svoi.volumes', v); },
  get videoSound() { return LS.get('svoi.videoSound', true) !== false; },
  set videoSound(v) { LS.set('svoi.videoSound', !!v); },
  get speaker() { return LS.get('svoi.speaker', ''); },
  set speaker(v) { LS.set('svoi.speaker', v); },
  get net() { return LS.get('svoi.net', { turn: null, relayOnly: false }); },
  set net(v) { LS.set('svoi.net', v); },
};

// Комнаты, созданные на этом устройстве. Хозяин может открыть их снова по той же ссылке.
export const rooms = {
  list() { return LS.get('svoi.rooms', []).filter((r) => r && r.secret && r.hostId); },
  get(hostId) { return this.list().find((r) => r.hostId === hostId) || null; },
  save(room) {
    const all = this.list().filter((r) => r.hostId !== room.hostId);
    all.unshift(room);
    LS.set('svoi.rooms', all.slice(0, 8));
  },
  update(hostId, patch) {
    const r = this.get(hostId);
    if (r) this.save({ ...r, ...patch });
  },
  remove(hostId) {
    LS.set('svoi.rooms', this.list().filter((r) => r.hostId !== hostId));
    keys.del('host:' + hostId).catch(() => {});
  },
};

// Текущий вход: переживает перезагрузку вкладки, но не закрытие браузера.
export const session = {
  get() { return SS.get('svoi.join'); },
  set(v) { SS.set('svoi.join', v); },
  clear() { SS.del('svoi.join'); SS.del('svoi.code'); },
  // Код входа, который ввёл гость: нужен при перезагрузке вкладки.
  get entryCode() { return SS.get('svoi.code') || ''; },
  set entryCode(v) { SS.set('svoi.code', v); },
};

// ---------- IndexedDB для ключей ----------

let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('svoi', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('keys');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

function tx(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction('keys', mode);
    const r = fn(t.objectStore('keys'));
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  }));
}

export const keys = {
  get: (k) => tx('readonly', (s) => s.get(k)).catch(() => null),
  put: (k, v) => tx('readwrite', (s) => s.put({ ...v, at: Date.now() }, k)).catch(() => null),
  del: (k) => tx('readwrite', (s) => s.delete(k)),
  // Ключи гостя живут полгода: по ним хозяин узнаёт знакомых и пускает без вопроса.
  async prune() {
    try {
      const d = await db();
      const t = d.transaction('keys', 'readwrite');
      const s = t.objectStore('keys');
      const req = s.openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        if (String(c.key).startsWith('guest:') && Date.now() - (c.value?.at || 0) > 180 * 864e5) c.delete();
        c.continue();
      };
    } catch {}
  },
};
