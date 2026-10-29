// Смешные голоса. Микрофон обрабатывается на этом устройстве, собеседникам уходит уже изменённый голос.
// Это для смеха, не для анонимности: интонации и манеру речи никакой эффект не спрячет.

export const VOICES = [
  { id: 'normal', emoji: '🙂', name: 'Свой', hint: 'Голос как есть.' },
  { id: 'chipmunk', emoji: '🐿️', name: 'Бурундук', hint: 'Как будто вдохнули гелий из шарика.' },
  { id: 'giant', emoji: '🗿', name: 'Великан', hint: 'Низко и солидно. Спорить с вами станет сложнее.' },
  { id: 'robot', emoji: '🤖', name: 'Робот', hint: 'Синтезатор речи из старого фильма про будущее.' },
  { id: 'radio', emoji: '📻', name: 'Рация', hint: 'Приём, приём. Как слышно, Петрович?' },
  { id: 'cave', emoji: '🦇', name: 'Пещера', hint: 'Эхо, как в пустом подъезде. Пойте осторожно.' },
  { id: 'seasick', emoji: '🤢', name: 'Укачало', hint: 'Голос плывёт, как на палубе в шторм.' },
];
export const VOICE_IDS = VOICES.map((v) => v.id);
export const voiceOf = (id) => VOICES.find((v) => v.id === id) || VOICES[0];
// Все эффекты голоса по отдельности: для значков и подписи «Бурундук + Пещера».
export const voiceParts = (voice) => parseVoice(voice).map(voiceOf);

const WORKLET = new URL('./voice-worklet.js', import.meta.url).href;

// Голос — набор эффектов через «+», например 'chipmunk+cave'. Свой голос — 'normal'.
// Эффекты складываются. Бурундук и великан — нет: голос не бывает выше и ниже сразу.
const PITCH = ['chipmunk', 'giant'];
const ORDER = ['chipmunk', 'giant', 'seasick', 'robot', 'radio', 'cave']; // сначала высота, эхо — последним

export function parseVoice(v) {
  const set = new Set(String(v || '').split('+').filter((id) => ORDER.includes(id)));
  if (set.has('chipmunk') && set.has('giant')) set.delete('giant');
  return ORDER.filter((id) => set.has(id));
}
export const voiceKey = (list) => (list.length ? list.join('+') : 'normal');

// Нажали на эффект: включить или выключить его, не трогая остальные. «Свой» — сбросить всё.
export function toggleVoice(current, id) {
  if (id === 'normal') return 'normal';
  const list = parseVoice(current);
  if (list.includes(id)) return voiceKey(list.filter((x) => x !== id));
  const next = PITCH.includes(id) ? list.filter((x) => !PITCH.includes(x)) : list;
  return voiceKey(parseVoice([...next, id].join('+')));
}

// Цепочка звуковых узлов для голоса: { input, output, stop() }. Для своего голоса — null.
export async function buildVoice(ctx, voice) {
  const list = parseVoice(voice);
  if (!list.length) return null;
  const nodes = [];
  const keep = (n) => { nodes.push(n); return n; };
  const stop = () => { for (const n of nodes) { try { n.stop?.(); } catch {} try { n.disconnect(); } catch {} } };
  const input = keep(ctx.createGain());
  let tail = input;
  try {
    for (const id of list) tail = await EFFECTS[id](ctx, tail, keep);
  } catch (e) {
    stop();
    throw e;
  }
  return { input, output: tail, stop };
}

// Каждый эффект берёт звук из from и возвращает узел, где звук уже обработан.
const EFFECTS = {
  async chipmunk(ctx, from, keep) { return pitch(ctx, from, keep, 1.6, 'highshelf', 3000, 3); },
  async giant(ctx, from, keep) { return pitch(ctx, from, keep, 0.7, 'lowshelf', 250, 5); },

  robot(ctx, from, keep) {
    // Кольцевая модуляция: голос умножается на синус 50 Гц. Плюс короткое металлическое эхо.
    const ring = keep(ctx.createGain());
    ring.gain.value = 0;
    const carrier = keep(ctx.createOscillator());
    carrier.frequency.value = 50;
    carrier.connect(ring.gain);
    carrier.start();
    const comb = keep(ctx.createDelay(0.05));
    comb.delayTime.value = 0.008;
    const fb = keep(ctx.createGain());
    fb.gain.value = 0.5;
    from.connect(ring);
    ring.connect(comb).connect(fb).connect(comb);
    const level = keep(ctx.createGain());
    level.gain.value = 1.6;
    ring.connect(level);
    comb.connect(level);
    return level;
  },

  radio(ctx, from, keep) {
    // Узкая полоса, как в рации, и лёгкий перегруз.
    const hp = keep(ctx.createBiquadFilter());
    hp.type = 'highpass';
    hp.frequency.value = 600;
    const lp = keep(ctx.createBiquadFilter());
    lp.type = 'lowpass';
    lp.frequency.value = 2600;
    const drive = keep(ctx.createWaveShaper());
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) { const x = (i / (curve.length - 1)) * 2 - 1; curve[i] = Math.tanh(3 * x); }
    drive.curve = curve;
    const pre = keep(ctx.createGain());
    pre.gain.value = 2.5;
    const level = keep(ctx.createGain());
    level.gain.value = 0.6;
    from.connect(hp).connect(lp).connect(pre).connect(drive).connect(level);
    return level;
  },

  cave(ctx, from, keep) {
    // Отзвук пещеры: шум с затуханием на полторы секунды как отклик помещения.
    const rev = keep(ctx.createConvolver());
    const len = Math.round(ctx.sampleRate * 1.5);
    const ir = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = ir.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    rev.buffer = ir;
    const wet = keep(ctx.createGain());
    wet.gain.value = 0.55;
    const dry = keep(ctx.createGain());
    dry.gain.value = 0.85;
    const out = keep(ctx.createGain());
    from.connect(dry).connect(out);
    from.connect(rev).connect(wet).connect(out);
    return out;
  },

  seasick(ctx, from, keep) {
    // Задержка, которая качается 5 раз в секунду: высота голоса плывёт вверх-вниз.
    const delay = keep(ctx.createDelay(0.1));
    delay.delayTime.value = 0.012;
    const lfo = keep(ctx.createOscillator());
    lfo.frequency.value = 5;
    const depth = keep(ctx.createGain());
    depth.gain.value = 0.0025;
    lfo.connect(depth).connect(delay.delayTime);
    lfo.start();
    from.connect(delay);
    return delay;
  },
};

async function pitch(ctx, from, keep, ratio, shelfType, freq, gain) {
  if (!ctx.__svoiPitch) ctx.__svoiPitch = ctx.audioWorklet.addModule(WORKLET);
  await ctx.__svoiPitch;
  const node = keep(new AudioWorkletNode(ctx, 'svoi-pitch', { processorOptions: { ratio } }));
  // Великану — чуть больше низов, бурундуку — звонкости.
  const shelf = keep(ctx.createBiquadFilter());
  shelf.type = shelfType;
  shelf.frequency.value = freq;
  shelf.gain.value = gain;
  from.connect(node).connect(shelf);
  return shelf;
}
