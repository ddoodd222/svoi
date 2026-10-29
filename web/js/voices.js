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

const WORKLET = new URL('./voice-worklet.js', import.meta.url).href;

// Цепочка звуковых узлов для голоса: { input, output, stop() }. Для своего голоса — null.
export async function buildVoice(ctx, id) {
  const nodes = [];
  const keep = (n) => { nodes.push(n); return n; };
  const stop = () => { for (const n of nodes) { try { n.stop?.(); } catch {} try { n.disconnect(); } catch {} } };
  const input = keep(ctx.createGain());
  const output = keep(ctx.createGain());

  if (id === 'chipmunk' || id === 'giant') {
    if (!ctx.__svoiPitch) ctx.__svoiPitch = ctx.audioWorklet.addModule(WORKLET);
    await ctx.__svoiPitch;
    const pitch = keep(new AudioWorkletNode(ctx, 'svoi-pitch', { processorOptions: { ratio: id === 'chipmunk' ? 1.6 : 0.7 } }));
    // Великану — чуть больше низов, бурундуку — звонкости.
    const shelf = keep(ctx.createBiquadFilter());
    shelf.type = id === 'chipmunk' ? 'highshelf' : 'lowshelf';
    shelf.frequency.value = id === 'chipmunk' ? 3000 : 250;
    shelf.gain.value = id === 'chipmunk' ? 3 : 5;
    input.connect(pitch).connect(shelf).connect(output);
  } else if (id === 'robot') {
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
    input.connect(ring);
    ring.connect(comb).connect(fb).connect(comb);
    const level = keep(ctx.createGain());
    level.gain.value = 1.6;
    ring.connect(level);
    comb.connect(level);
    level.connect(output);
  } else if (id === 'radio') {
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
    input.connect(hp).connect(lp).connect(pre).connect(drive).connect(level).connect(output);
  } else if (id === 'cave') {
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
    input.connect(dry).connect(output);
    input.connect(rev).connect(wet).connect(output);
  } else if (id === 'seasick') {
    // Задержка, которая качается 5 раз в секунду: высота голоса плывёт вверх-вниз.
    const delay = keep(ctx.createDelay(0.1));
    delay.delayTime.value = 0.012;
    const lfo = keep(ctx.createOscillator());
    lfo.frequency.value = 5;
    const depth = keep(ctx.createGain());
    depth.gain.value = 0.0025;
    lfo.connect(depth).connect(delay.delayTime);
    lfo.start();
    input.connect(delay).connect(output);
  } else {
    stop();
    return null;
  }
  return { input, output, stop };
}
