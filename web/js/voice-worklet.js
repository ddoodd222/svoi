// Сдвиг высоты голоса для «Бурундука» и «Великана». Работает в звуковом потоке браузера.
//
// Две «читающие головки» бегут по свежему звуку быстрее (выше голос) или медленнее (ниже),
// чем он пишется. Когда головке пора перескочить, её заглушает плавное окно, а вторая,
// сдвинутая на полокна, в это время звучит в полную силу. Сумма окон sin² + cos² всегда равна 1,
// поэтому громкость не скачет.

class Pitch extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ratio = options?.processorOptions?.ratio || 1;
    this.W = Math.round(0.05 * sampleRate); // окно 50 мс
    this.N = 1 << 14;
    this.buf = new Float32Array(this.N);
    this.w = 0;
    this.phase = 0;
  }

  process(inputs, outputs) {
    const inp = inputs[0]?.[0];
    const outs = outputs[0];
    const out = outs?.[0];
    if (!out) return true;
    const mask = this.N - 1;
    const W = this.W;
    const step = (1 - this.ratio) / W;
    for (let i = 0; i < out.length; i++) {
      this.buf[this.w] = inp ? inp[i] : 0;
      let y = 0;
      for (let k = 0; k < 2; k++) {
        let ph = this.phase + k * 0.5;
        if (ph >= 1) ph -= 1;
        let r = this.w - (ph * W + 2);
        if (r < 0) r += this.N;
        const i0 = Math.floor(r);
        const f = r - i0;
        const s = this.buf[i0 & mask] * (1 - f) + this.buf[(i0 + 1) & mask] * f;
        const g = Math.sin(Math.PI * ph);
        y += s * g * g;
      }
      out[i] = y;
      this.w = (this.w + 1) & mask;
      this.phase += step;
      if (this.phase >= 1) this.phase -= 1;
      else if (this.phase < 0) this.phase += 1;
    }
    for (let c = 1; c < outs.length; c++) outs[c].set(out);
    return true;
  }
}

registerProcessor('svoi-pitch', Pitch);
