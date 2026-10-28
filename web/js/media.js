// Свои камера, микрофон и экран.
// Выключенная камера по-настоящему отпускается: гаснет её лампочка.
// Выключенный микрофон не отправляет ни одного пакета.

import { native } from './native.js';

const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

export class LocalMedia extends EventTarget {
  constructor() {
    super();
    this.mic = null;
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
    return { mic: !!(this.mic && this.micOn), cam: !!(this.cam && this.camOn), screen: !!this.screen };
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
    return this.micId ? { ...AUDIO, deviceId: { exact: this.micId } } : AUDIO;
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
      this._setMic(s.getAudioTracks()[0]);
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

  _setMic(t) {
    if (this.mic && this.mic !== t) this.mic.stop();
    this.mic = t;
    if (t) t.enabled = this.micOn;
    this._analyse();
  }

  _setCam(t) {
    if (this.cam && this.cam !== t) this.cam.stop();
    this.cam = t;
    if (t) {
      t.contentHint = 'motion';
      t.onended = () => { if (this.cam === t) { this.cam = null; this.camOn = false; this.changed(); } };
    }
  }

  async setMic(on) {
    this.micOn = on;
    if (on && !this.mic) await this._openMic();
    if (this.mic) this.mic.enabled = on;
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
      if (this.mic) { this.mic.stop(); this.mic = null; }
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
      const ctx = this.ctx || (this.ctx = new AudioContext());
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
    this.mic?.stop();
    this.cam?.stop();
    this.mic = null;
    this.cam = null;
    try { this.analyser?.src.disconnect(); this.ctx?.close(); } catch {}
    this.analyser = null;
    this.ctx = null;
  }
}
