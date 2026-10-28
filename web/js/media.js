// Свои камера, микрофон и экран.
// Выключенная камера по-настоящему отпускается: гаснет её лампочка.
// Выключенный микрофон не отправляет ни одного пакета.

import { native } from './native.js';
import { RnnoiseWorkletNode, loadRnnoise } from './vendor/noise/index.js';

// Шумодав: 'off' — выключен, 'browser' — встроенный в браузер, 'strong' — нейросеть RNNoise на устройстве.
export const NOISE_MODES = ['off', 'browser', 'strong'];
const NOISE_DIR = new URL('./vendor/noise/', import.meta.url).href;
let rnnoiseWasm = null;

export class LocalMedia extends EventTarget {
  constructor() {
    super();
    this.mic = null; // то, что уходит собеседникам (после шумодава)
    this.rawMic = null; // то, что даёт микрофон
    this.noise = 'strong';
    this.noiseActive = null; // какой шумодав реально работает
    this.ns = null;
    this.cam = null;
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
    if (slot === 1) return this.camOn ? this.cam : null;
    if (slot === 2) return this.screen;
    if (slot === 3) return this.screenAudio;
    return null;
  }

  get camStream() { return this.cam ? new MediaStream([this.cam]) : null; }

  videoConstraints() {
    const v = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } };
    if (this.camId) v.deviceId = { exact: this.camId };
    else v.facingMode = this.facing;
    return v;
  }

  audioConstraints() {
    // Сильный режим = встроенный шумодав браузера (лучше давит ровный гул) + нейросеть RNNoise (рваные шумы).
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
    this.mic = raw;
    this.noiseActive = this.noise === 'strong' ? 'browser' : this.noise;
    if (this.noise === 'strong') {
      try {
        this.mic = await this._rnnoise(raw);
        this.noiseActive = 'strong';
      } catch (e) {
        console.warn('шумодав RNNoise не запустился', e);
        this.errors.noise = e.name || 'error';
      }
    }
    this._analyse();
  }

  // Микрофон -> RNNoise (AudioWorklet + WebAssembly) -> дорожка для звонка. Всё на устройстве.
  async _rnnoise(raw) {
    if (!window.AudioWorkletNode || !window.WebAssembly) throw new Error('unsupported');
    const ctx = this._ctx();
    if (!rnnoiseWasm) rnnoiseWasm = loadRnnoise({ url: NOISE_DIR + 'rnnoise.wasm', simdUrl: NOISE_DIR + 'rnnoise_simd.wasm' });
    const wasmBinary = await rnnoiseWasm;
    if (!this.workletReady) {
      await ctx.audioWorklet.addModule(NOISE_DIR + 'rnnoise-worklet.js');
      this.workletReady = true;
    }
    const src = ctx.createMediaStreamSource(new MediaStream([raw]));
    const node = new RnnoiseWorkletNode(ctx, { wasmBinary, maxChannels: 1 });
    const dest = ctx.createMediaStreamDestination();
    src.connect(node).connect(dest);
    this.ns = { src, node, dest };
    return dest.stream.getAudioTracks()[0];
  }

  _ctx() {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      this.workletReady = false;
    }
    return this.ctx;
  }

  _releaseMic() {
    if (this.ns) {
      try { this.ns.src.disconnect(); this.ns.node.disconnect(); this.ns.node.destroy?.(); } catch {}
      this.ns.dest.stream.getTracks().forEach((t) => t.stop());
      this.ns = null;
    }
    this.rawMic?.stop();
    if (this.mic && this.mic !== this.rawMic) this.mic.stop();
    this.rawMic = null;
    this.mic = null;
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
      t.onended = () => { if (this.cam === t) { this.cam = null; this.camOn = false; this.changed(); } };
      t.onmute = t.onunmute = () => { if (this.cam === t) this.changed(); };
    }
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
    else if (this.cam) { this.cam.stop(); this.cam = null; }
    if (on && !this.cam) this.camOn = false;
    this.changed();
  }

  async flipCamera() {
    this.facing = this.facing === 'user' ? 'environment' : 'user';
    this.camId = '';
    if (this.cam) { this.cam.stop(); this.cam = null; }
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
      if (this.cam) { this.cam.stop(); this.cam = null; }
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
      };
    } catch { return { mics: [], cams: [] }; }
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
    this.stopScreen();
    this._releaseMic();
    this.cam?.stop();
    this.cam = null;
    try { this.analyser?.src.disconnect(); this.ctx?.close(); } catch {}
    this.analyser = null;
    this.ctx = null;
  }
}
