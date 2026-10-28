// Сборка интерфейса без innerHTML: только узлы и textContent.
// Так чужой текст (имя, сообщение в чате) не может стать кодом на странице.

// Короткие слова приклеиваются к следующему неразрывным пробелом, чтобы не висели в конце строки.
const SHORT = /(^|[\s(«])(в|во|и|с|со|к|ко|о|об|у|а|на|не|ни|по|за|до|от|из|без|для|что|или|но|же|ли|бы|его|её|их|это|при|про|под|над)\s/giu;
export const nb = (s) => String(s).replace(SHORT, (m, a, w) => `${a}${w} `).replace(SHORT, (m, a, w) => `${a}${w} `);

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = nb(v);
    else if (k === 'raw') el.textContent = v; // чужой текст: без обработки
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'style') Object.assign(el.style, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(nb(c)));
  }
}

export function clear(el) { while (el.firstChild) el.firstChild.remove(); return el; }

export function replace(el, ...children) { clear(el); append(el, children); return el; }

const SVG = 'http://www.w3.org/2000/svg';
const PATHS = {
  mic: ['M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z', 'M19 11a7 7 0 0 1-14 0', 'M12 18v3'],
  image: ['M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z', 'm4 16 5-5 4 4 2-2 5 5', 'M15 8.5h.01'],
  smile: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M8.5 14.5s1.3 2 3.5 2 3.5-2 3.5-2', 'M9 9.5h.01', 'M15 9.5h.01'],
  signal: ['M5 20v-3', 'M10 20v-7', 'M15 20V9', 'M20 20V4'],
  download: ['M12 4v11', 'm7 10 5 5 5-5', 'M5 20h14'],
  chevron: ['m6 9 6 6 6-6'],
  volume: ['M11 5 6 9H3v6h3l5 4V5z', 'M15.5 8.5a5 5 0 0 1 0 7', 'M18.5 5.5a9 9 0 0 1 0 13'],
  volumeOff: ['M11 5 6 9H3v6h3l5 4V5z', 'M22 9l-6 6', 'M16 9l6 6'],
  micOff: ['M15 9.3V6a3 3 0 0 0-5.7-1.3', 'M9 9v3a3 3 0 0 0 4.6 2.5', 'M19 11a7 7 0 0 1-1.2 3.9', 'M5 11a7 7 0 0 0 10.6 6', 'M12 18v3', 'M3 3l18 18'],
  cam: ['M4 7h10a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z', 'M15 11l6-3v8l-6-3'],
  camOff: ['M9 7h5a1 1 0 0 1 1 1v5', 'M15 16.5V16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h1', 'M15 11l6-3v8l-3-1.5', 'M3 3l18 18'],
  screen: ['M3 5h18v11H3z', 'M8 20h8', 'M12 16v4', 'M12 13V8', 'M9.5 10.5L12 8l2.5 2.5'],
  people: ['M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M2 21a7 7 0 0 1 14 0', 'M16 3.5a4 4 0 0 1 0 7', 'M22 21a7 7 0 0 0-4.5-6.5'],
  chat: ['M4 5h16v11H9l-5 4z'],
  link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
  hang: ['M3 13.5c5-4.7 13-4.7 18 0l-2.4 2.6-3.6-1.6v-2.8a11 11 0 0 0-6 0v2.8L5.4 16.1z'],
  lock: ['M6 11h12v10H6z', 'M8 11V7a4 4 0 0 1 8 0v4'],
  unlock: ['M6 11h12v10H6z', 'M8 11V7a4 4 0 0 1 7.6-1.7'],
  flip: ['M4 12a8 8 0 0 1 14-5.3L20 9', 'M20 4v5h-5', 'M20 12a8 8 0 0 1-14 5.3L4 15', 'M4 20v-5h5'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  check: ['M5 12.5l4.5 4.5L19 7'],
  copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
  share: ['M12 3v12', 'M7.5 7.5L12 3l4.5 4.5', 'M5 13v7h14v-7'],
  sliders: ['M3 7h11', 'M18 7h3', 'M14 4.5v5', 'M3 17h3', 'M10 17h11', 'M10 14.5v5'],
  send: ['M4 12l16-8-6 16-2.5-6.5z', 'M11.5 13.5L20 4'],
  shield: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', 'M8.5 12l2.5 2.5 4.5-5'],
  bell: ['M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z', 'M10 21h4'],
  back: ['M15 5l-7 7 7 7'],
  expand: ['M4 9V4h5', 'M20 9V4h-5', 'M4 15v5h5', 'M20 15v5h-5'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'],
};

export function icon(name) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of PATHS[name] || []) {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}
