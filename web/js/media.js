// Свои камера, микрофон и экран.
// Выключенная камера по-настоящему отпускается: гаснет её лампочка.
// Выключенный микрофон не отправляет ни одного пакета.

import { native } from './native.js';
import { RnnoiseWorkletNode, loadRnnoise } from './vendor/noise/index.js';
import { beautify, canBeautify } from './beauty.js';
import { buildVoice, VOICE_IDS } from './voices.js';

export { canBeautify };
const IS_TOUCH = globalThis.matchMedia?.('(pointer: coarse)').matches;

// Шумодав: 'off' — выключен, 'browser' — встроенный в браузер, 'strong' — нейросеть RNNoise на устройстве.
export const NOISE_MODES = ['off', 'browser', 'strong'];
// Анти-эхо: 'normal' — эхоподавление браузера по всему звуку компьютера; 'strong' — плюс приглушение
// микрофона, пока говорят другие (как у спикерфона в переговорке).
export const ECHO_MODES = ['normal', 'strong'];
const NOISE_DIR = new URL('./vendor/noise/', import.meta.url).href;
let rnnoiseWasm = null;

export class LocalMedia extends EventTarget {
  constructor() {
    super();
    this.mic = null; // то, что уходит собеседникам (после шумодава)
    this.rawMic = null; // то, что даёт микрофон
    this.noise = 'strong';
    this.echo = 'normal';
    this.duckUntil = 0;
    this.noiseActive = null; // какой шумодав реально работает
    this.voice = 'normal'; // смешной голос: живёт до конца звонка, потом снова свой
    this.ns = null;
    this.cam = null; // сырая камера
    this.fx = null; // обработка: сглаживание кожи и белые зубы
    this.beauty = { smooth: 0, teeth: 0 };
    this.screen = null;
    this.screenAudio = null;
    this.micOn = true;
    this.camOn = true;
    this.facing = 'user';
    this.micId = '';
    this.camId = '';
    this.errors = {};
    this.analyser = null;
  }

  changed() { this.dispatchEvent(new Event('change')); }

  state() {
    // Свёрнутый браузер на телефоне останавливает камеру: тогда собеседники видят аватар, а не застывший кадр.
    return { mic: !!(this.mic && this.micOn), cam: !!(this.cam && this.camOn && !this.cam.muted), screen: !!this.screen };
  }

  track(slot) {
    if (slot === 0) return this.micOn ? this.mic : null;
    if (slot === 1) return this.camOn ? this.camOut : null;
    if (slot === 2) return this.screen;
    if (slot === 3) return this.screenAudio;
    return null;
  }

  // То, что видят собеседники и вы в своём окошке: камера после обработки, если она включена.
  get camOut() { return this.cam ? (this.fx?.track || this.cam) : null; }

  get camStream() { return this.cam ? new MediaStream([this.camOut]) : null; }

  // Сглаживание кожи и белые зубы: { smooth: 0…1, teeth: 0…1 }. Ноль у обоих — обработка выключается совсем.
  setBeauty(b) {
    this.beauty = { smooth: Math.max(0, Math.min(1, +b.smooth || 0)), teeth: Math.max(0, Math.min(1, +b.teeth || 0)) };
    const before = this.camOut;
    this._syncFx();
    if (this.camOut !== before) this.changed();
  }

  _syncFx() {
    const want = canBeautify && this.cam && (this.beauty.smooth > 0 || this.beauty.teeth > 0);
    if (want && this.fx?.src === this.cam) return;
    this._stopFx();
    if (!want) return;
    try {
      this.fx = beautify(this.cam, () => this.beauty, { maxWidth: IS_TOUCH ? 960 : 1280 });
      if (this.fx) this.fx.src = this.cam;
      else this.errors.beauty = 'webgl';
    } catch (e) {
      console.warn('обработка камеры не запустилась', e);
      this.errors.beauty = e.name || 'error';
      this.fx = null;
    }
  }

  _stopFx() {
    this.fx?.stop();
    this.fx = null;
  }

  videoConstraints() {
    const v = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };
    if (this.camId) v.deviceId = { exact: this.camId };
    else v.facingMode = this.facing;
    return v;
  }

  audioConstraints() {
    // Сильный режим = встроенный шумодав браузера (лучше давит ровный гул) + нейросеть RNNoise (рваные шумы).
    // echoCancellation: 'all' (вычитать весь звук компьютера) не ставим: на части микрофонов Chrome
    // с ним отдаёт тишину. Обычное эхоподавление вычитает голоса собеседников.
    const a = { echoCancellation: true, autoGainControl: true, noiseSuppression: this.noise !== 'off' };
    if (this.micId) a.deviceId = { exact: this.micId };
    return a;
  }

  async start({ mic = true, cam = true } = {}) {
    this.micOn = mic;
    this.camOn = cam;
    if (!navigator.mediaDevices?.getUserMedia) { this.errors.all = 'unsupported'; return; }
    await Promise.all([this._openMic(), cam ? this._openCam() : null]);
    this.changed();
  }

  async _openMic() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: this.audioConstraints() });
      await this._setMic(s.getAudioTracks()[0]);
      delete this.errors.mic;
    } catch (e) {
      this.errors.mic = e.name || 'error';
      if (this.micId) { this.micId = ''; return this._openMic(); }
    }
  }

  async _openCam() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: this.videoConstraints() });
      this._setCam(s.getVideoTracks()[0]);
      delete this.errors.cam;
    } catch (e) {
      this.errors.cam = e.name || 'error';
      if (this.camId) { this.camId = ''; return this._openCam(); }
    }
  }

  async _setMic(raw) {
    this._releaseMic();
    this.rawMic = raw;
    raw.enabled = this.micOn;
    await this._buildGraph();
  }

  // Обработка звука нужна для сильного шумодава, сильного анти-эха и смешного голоса. Иначе микрофон идёт как есть.
  async _buildGraph() {
    const raw = this.rawMic;
    this._dropGraph();
    if (!raw) return;
    this.mic = raw;
    this.noiseActive = this.noise === 'strong' ? 'browser' : this.noise;
    if (this.noise === 'strong' || this.echo === 'strong' || this.voice !== 'normal') {
      try {
        await this._graph(raw);
        this._ctxState();
      } catch (e) {
        console.warn('обработка звука не запустилась', e);
        this.errors.noise = e.name || 'error';
      }
    }
    this._analyse();
  }

  // Смешной голос меняется без переоткрытия микрофона: пересобирается только обработка.
  async setVoice(id) {
    if (!VOICE_IDS.includes(id) || id === this.voice) return;
    this.voice = id;
    delete this.errors.voice;
    if (this.rawMic) await this._buildGraph();
    this.changed();
  }

  // Микрофон -> [RNNoise] -> громкость (приглушение анти-эха) -> дорожка для звонка. Всё на устройстве.
  async _graph(raw) {
    const ctx = this._ctx();
    const src = ctx.createMediaStreamSource(new MediaStream([raw]));
    let tail = src;
    let node = null;
    if (this.noise === 'strong') {
      try {
        if (!window.AudioWorkletNode || !window.WebAssembly) throw new Error('unsupported');
        if (!rnnoiseWasm) rnnoiseWasm = loadRnnoise({ url: NOISE_DIR + 'rnnoise.wasm', simdUrl: NOISE_DIR + 'rnnoise_simd.wasm' });
        const wasmBinary = await rnnoiseWasm;
        if (!this.workletReady) {
          await ctx.audioWorklet.addModule(NOISE_DIR + 'rnnoise-worklet.js');
          this.workletReady = true;
        }
        node = new RnnoiseWorkletNode(ctx, { wasmBinary, maxChannels: 1 });
        tail.connect(node);
        tail = node;
      } catch (e) {
        console.warn('шумодав RNNoise не запустился', e);
        this.errors.noise = e.name || 'error';
        node = null;
      }
    }
    let voice = null;
    if (this.voice !== 'normal') {
      try {
        voice = await buildVoice(ctx, this.voice);
        if (voice) { tail.connect(voice.input); tail = voice.output; }
      } catch (e) {
        console.warn('голос не запустился', e);
        this.errors.voice = e.name || 'error';
      }
    }
    const gain = ctx.createGain();
    tail.connect(gain);
    const meter = ctx.createAnalyser(); // свой голос до приглушения: чтобы можно было перебить
    meter.fftSize = 512;
    src.connect(meter);
    const dest = ctx.createMediaStreamDestination();
    gain.connect(dest);
    this.ns = { src, node, voice, gain, meter, dest, buf: new Float32Array(512), track: dest.stream.getAudioTracks()[0], lastGain: 1 };
  }

  // Анти-эхо «сильное»: пока говорят собеседники, ваш микрофон тише в пять раз.
  // Их голос из ваших динамиков почти не возвращается к ним эхом. Перебить можно, если говорить громко.
  duck(remote) {
    const ns = this.ns;
    if (this.echo !== 'strong' || !ns || this.mic !== ns.track || !this.ctx) return;
    ns.meter.getFloatTimeDomainData(ns.buf);
    let sum = 0;
    for (const v of ns.buf) sum += v * v;
    const local = Math.sqrt(sum / ns.buf.length) * 4;
    const now = Date.now();
    const interrupting = local > 0.35 && local > remote * 3;
    if (remote > 0.03 && !interrupting) this.duckUntil = now + 450;
    const g = now < this.duckUntil && !interrupting ? 0.2 : 1;
    if (globalThis.__svoiDebug) console.debug('duck', JSON.stringify({ remote: +remote.toFixed(3), local: +local.toFixed(3), g }));
    if (ns.lastGain !== g) {
      ns.gain.gain.setTargetAtTime(g, this.ctx.currentTime, g < 1 ? 0.02 : 0.12);
      ns.lastGain = g;
    }
  }

  // Свёрнутый браузер может усыпить звуковой движок. Тогда шумодав молчит, и собеседник вас не слышит.
  // Поэтому, пока движок спит, в звонок идёт голос в обход шумодава, а как проснётся — снова через него.
  _ctxState() {
    if (!this.ns || !this.rawMic) return;
    const running = this.ctx?.state === 'running';
    const want = running ? this.ns.track : this.rawMic;
    this.noiseActive = running && this.ns.node ? 'strong' : (this.noise === 'off' ? 'off' : 'browser');
    if (this.mic !== want) { this.mic = want; this._analyse(); this.changed(); }
    if (!running) this.ctx?.resume?.().catch(() => {});
  }

  _ctx() {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      this.ctx.onstatechange = () => this._ctxState();
      this.workletReady = false;
    }
    return this.ctx;
  }

  _dropGraph() {
    if (!this.ns) return;
    try { this.ns.src.disconnect(); this.ns.gain.disconnect(); this.ns.node?.disconnect(); this.ns.node?.destroy?.(); } catch {}
    this.ns.voice?.stop();
    this.ns.dest.stream.getTracks().forEach((t) => t.stop());
    this.ns = null;
  }

  _releaseMic() {
    this._dropGraph();
    this._dropSense();
    this.rawMic?.stop();
    this.rawMic = null;
    this.mic = null;
  }

  async setEcho(mode) {
    if (!ECHO_MODES.includes(mode) || mode === this.echo) return;
    this.echo = mode;
    if (this.rawMic) {
      this._releaseMic();
      await this._openMic();
    }
    this.changed();
  }

  async setNoise(mode) {
    if (!NOISE_MODES.includes(mode) || mode === this.noise) return;
    this.noise = mode;
    delete this.errors.noise;
    if (this.rawMic) {
      this._releaseMic();
      await this._openMic();
    }
    this.changed();
  }

  _setCam(t) {
    if (this.cam && this.cam !== t) this.cam.stop();
    this.cam = t;
    if (t) {
      t.contentHint = 'motion';
      t.onended = () => { if (this.cam === t) { this._stopFx(); this.cam = null; this.camOn = false; this.changed(); } };
      t.onmute = t.onunmute = () => { if (this.cam === t) this.changed(); };
    }
    this._syncFx();
  }

  async setMic(on) {
    this.micOn = on;
    if (on && !this.rawMic) await this._openMic();
    if (this.rawMic) this.rawMic.enabled = on;
    this.changed();
  }

  async setCam(on) {
    this.camOn = on;
    if (on) { if (!this.cam) await this._openCam(); }
    else if (this.cam) { this._stopFx(); this.cam.stop(); this.cam = null; }
    if (on && !this.cam) this.camOn = false;
    this.changed();
  }

  async flipCamera() {
    this.facing = this.facing === 'user' ? 'environment' : 'user';
    this.camId = '';
    if (this.cam) { this._stopFx(); this.cam.stop(); this.cam = null; }
    if (this.camOn) await this._openCam();
    this.changed();
  }

  async useDevice(kind, id) {
    if (kind === 'audioinput') {
      this.micId = id;
      this._releaseMic();
      await this._openMic();
    } else {
      this.camId = id;
      if (this.cam) { this._stopFx(); this.cam.stop(); this.cam = null; }
      if (this.camOn) await this._openCam();
    }
    this.changed();
  }

  async devices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      return {
        mics: all.filter((d) => d.kind === 'audioinput' && d.deviceId),
        cams: all.filter((d) => d.kind === 'videoinput' && d.deviceId),
        outs: all.filter((d) => d.kind === 'audiooutput' && d.deviceId),
      };
    } catch { return { mics: [], cams: [], outs: [] }; }
  }

  canShareScreen() {
    return native.available ? native.canShareScreen : !!navigator.mediaDevices?.getDisplayMedia;
  }

  async startScreen() {
    if (this.screen) return;
    let video, audio = null;
    if (native.available) {
      native.onScreenStopped = () => this.stopScreen();
      video = await native.startScreen();
    } else {
      const s = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15, max: 30 }, width: { max: 1920 }, height: { max: 1080 } },
        audio: true,
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
        systemAudio: 'include',
      });
      video = s.getVideoTracks()[0];
      audio = s.getAudioTracks()[0] || null;
    }
    if (!video) return;
    video.contentHint = 'detail';
    video.onended = () => this.stopScreen();
    this.screen = video;
    this.screenAudio = audio;
    this.changed();
  }

  stopScreen() {
    if (!this.screen) return;
    this.screen.onended = null;
    this.screen.stop();
    this.screenAudio?.stop();
    if (native.available) native.stopScreen();
    this.screen = null;
    this.screenAudio = null;
    this.changed();
  }

  // Уровень своего голоса для подсветки «говорит».
  _analyse() {
    try {
      this.analyser?.src.disconnect();
      if (!this.mic) { this.analyser = null; return; }
      const ctx = this._ctx();
      const src = ctx.createMediaStreamSource(new MediaStream([this.mic]));
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      this.analyser = { src, an, buf: new Float32Array(an.fftSize) };
    } catch { this.analyser = null; }
  }

  // Человек говорит в выключенный микрофон? Слушает копия микрофона, только на этом устройстве:
  // в звонок она не уходит. Пока микрофон включён, копии нет.
  mutedLevel() {
    if (this.micOn || !this.rawMic || this.rawMic.readyState !== 'live') { this._dropSense(); return 0; }
    if (!this.sense) {
      try {
        const t = this.rawMic.clone();
        t.enabled = true;
        const ctx = this._ctx();
        const src = ctx.createMediaStreamSource(new MediaStream([t]));
        const an = ctx.createAnalyser();
        an.fftSize = 512;
        src.connect(an);
        this.sense = { t, src, an, buf: new Float32Array(an.fftSize) };
      } catch { return 0; }
    }
    const s = this.sense;
    s.an.getFloatTimeDomainData(s.buf);
    let sum = 0;
    for (const v of s.buf) sum += v * v;
    return Math.min(1, Math.sqrt(sum / s.buf.length) * 4);
  }

  _dropSense() {
    if (!this.sense) return;
    try { this.sense.src.disconnect(); } catch {}
    this.sense.t.stop();
    this.sense = null;
  }

  resumeAudio() { this.ctx?.resume?.().catch(() => {}); }

  level() {
    const a = this.analyser;
    if (!a || !this.micOn) return 0;
    a.an.getFloatTimeDomainData(a.buf);
    let sum = 0;
    for (const v of a.buf) sum += v * v;
    return Math.min(1, Math.sqrt(sum / a.buf.length) * 4);
  }

  stopAll() {
    this._dropSense();
    this.stopScreen();
    this._releaseMic();
    this._stopFx();
    this.cam?.stop();
    this.cam = null;
    try { this.analyser?.src.disconnect(); this.ctx?.close(); } catch {}
    this.analyser = null;
    this.ctx = null;
  }
}
