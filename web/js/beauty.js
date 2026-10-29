// Сглаживание кожи и белые зубы: камера → шейдер на видеокарте → новая видеодорожка.
// Всё считается на этом устройстве. Собеседники получают уже обработанное видео.
//
// Кожа ищется по цвету (Cb и Cr в пространстве YCbCr), без распознавания лица:
// нейросеть была бы точнее, но тяжелее для телефона. Размытие «двустороннее»: соседняя точка
// похожего цвета усредняется, а точка другого цвета (глаз, бровь, губа, волос) — нет. Поэтому
// поры и неровности тона уходят, а черты лица остаются резкими.
// Зубы — светлые точки почти без цвета и без красноты, рядом с кожей и с заметно тёмным (губы, рот, усы).
// У них убирается желтизна и чуть поднимается яркость. Светлая кожа и блики на лбу не трогаются:
// у кожи есть краснота, а вокруг блика нет ничего заметно темнее. Светлая стена тоже: рядом нет кожи.

export const canBeautify = typeof MediaStreamTrackProcessor === 'function' && typeof MediaStreamTrackGenerator === 'function'
  && typeof VideoFrame === 'function' && typeof OffscreenCanvas === 'function';

const VERT = `
attribute vec2 p;
varying vec2 uv;
void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 uv;
uniform sampler2D img;
uniform vec2 near;    // радиус сглаживания в долях кадра
uniform vec2 far;     // радиус, на котором ищем кожу вокруг зубов
uniform float smoothAmt;
uniform float teethAmt;
const float GOLDEN = 2.39996323;

vec3 ycc(vec3 c) {
  return vec3(dot(c, vec3(0.299, 0.587, 0.114)),
              0.5 + dot(c, vec3(-0.168736, -0.331264, 0.5)),
              0.5 + dot(c, vec3(0.5, -0.418688, -0.081312)));
}
vec3 rgb(vec3 y) {
  float cb = y.y - 0.5, cr = y.z - 0.5;
  return vec3(y.x + 1.402 * cr, y.x - 0.344136 * cb - 0.714136 * cr, y.x + 1.772 * cb);
}
float skinOf(vec3 y) {
  return smoothstep(0.28, 0.32, y.y) * (1.0 - smoothstep(0.50, 0.54, y.y))
       * smoothstep(0.53, 0.56, y.z) * (1.0 - smoothstep(0.71, 0.75, y.z)) // у кожи всегда есть краснота
       * smoothstep(0.10, 0.22, y.x);
}

void main() {
  vec3 c = texture2D(img, uv).rgb;
  vec3 cy = ycc(c);
  vec3 o = c;

  if (smoothAmt > 0.0) {
    float skin = skinOf(cy);
    vec3 sum = c;
    float wsum = 1.0;
    for (int i = 0; i < 20; i++) {
      float fi = float(i);
      float r = sqrt((fi + 0.5) / 20.0);
      float a = fi * GOLDEN;
      vec3 s = texture2D(img, uv + vec2(cos(a), sin(a)) * r * near).rgb;
      vec3 d = s - c;
      float w = exp(-dot(d, d) * 60.0) * (1.0 - 0.5 * r);
      sum += s * w;
      wsum += w;
    }
    float k = smoothAmt * skin;
    o = mix(c, sum / wsum, k); // ни осветления, ни тёплого оттенка: светлая кожа от них желтеет
  }

  if (teethAmt > 0.0) {
    // Зуб: светлый, почти без цвета и без красноты (у кожи, даже светлой, краснота всегда есть).
    float chroma = length(cy.yz - 0.5);
    float red = cy.z - 0.5;
    float bright = smoothstep(0.45, 0.6, cy.x) * (1.0 - smoothstep(0.09, 0.14, chroma)) * (1.0 - smoothstep(0.035, 0.055, red));
    if (bright > 0.0) {
      // Вокруг зуба — кожа и губы, и среди них есть заметно тёмное: губы, рот, усы.
      // Вокруг блика на лбу кожа темнее лишь слегка, поэтому блик не считается зубом.
      // Три кольца по 8 точек и мягкие пороги: граница зуба не идёт полосами.
      float skinNear = 0.0;
      float darkNear = 0.0;
      for (int i = 0; i < 24; i++) {
        float ring = i < 8 ? 0.6 : (i < 16 ? 1.0 : 1.6);
        float a = float(i) * 0.7853982 + (i < 8 ? 0.0 : (i < 16 ? 0.3926991 : 0.1963495));
        vec3 sy = ycc(texture2D(img, uv + vec2(cos(a), sin(a)) * far * ring).rgb);
        skinNear += skinOf(sy);
        darkNear += smoothstep(0.2, 0.3, cy.x - sy.x);
      }
      float t = teethAmt * bright * smoothstep(0.05, 0.2, skinNear / 24.0) * smoothstep(0.08, 0.25, darkNear / 24.0);
      vec3 oy = ycc(o);
      oy.y = mix(oy.y, 0.5, t);         // убрать желтизну
      oy.z = mix(oy.z, 0.5, t * 0.5);
      oy.x = min(1.0, oy.x + 0.03 * t); // чуть ярче, без блеска
      o = rgb(oy);
    }
  }
  gl_FragColor = vec4(clamp(o, 0.0, 1.0), 1.0);
}`;

// track — сырая камера; get() — текущие силы { smooth: 0…1, teeth: 0…1 }; maxWidth — потолок ширины кадра.
export function beautify(track, get, { maxWidth = 1280 } = {}) {
  const canvas = new OffscreenCanvas(2, 2);
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
  if (!gl) return null;
  const prog = program(gl, VERT, FRAG);
  if (!prog) return null;
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  const u = (n) => gl.getUniformLocation(prog, n);
  const uNear = u('near'), uFar = u('far'), uSmooth = u('smoothAmt'), uTeeth = u('teethAmt');

  const processor = new MediaStreamTrackProcessor({ track });
  const generator = new MediaStreamTrackGenerator({ kind: 'video' });
  const abort = new AbortController();
  const fx = {
    track: generator,
    ms: 0, // сколько миллисекунд уходит на кадр — чтобы понять, тянет ли устройство
    stop() { abort.abort(); try { generator.stop(); } catch {} },
  };
  const transform = new TransformStream({
    transform(frame, controller) {
      const { smooth, teeth } = get();
      if ((smooth <= 0 && teeth <= 0) || gl.isContextLost()) { controller.enqueue(frame); return; }
      const t0 = performance.now();
      let out = null;
      try {
        const k = Math.min(1, maxWidth / frame.displayWidth);
        const w = Math.round(frame.displayWidth * k), h = Math.round(frame.displayHeight * k);
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
        // Радиус в точках растёт с размером кадра: на 720p сильное сглаживание берёт ~10 точек вокруг.
        const px = (3 + 7 * smooth) * (h / 720);
        gl.uniform2f(uNear, px / w, px / h);
        const farPx = 0.035 * h;
        gl.uniform2f(uFar, farPx / w, farPx / h);
        gl.uniform1f(uSmooth, smooth);
        gl.uniform1f(uTeeth, teeth);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        out = new VideoFrame(canvas, { timestamp: frame.timestamp });
      } catch {
        out = null;
      }
      if (out) { frame.close(); controller.enqueue(out); } else controller.enqueue(frame);
      fx.ms = fx.ms * 0.9 + (performance.now() - t0) * 0.1;
    },
  });
  processor.readable.pipeThrough(transform, { signal: abort.signal }).pipeTo(generator.writable, { signal: abort.signal }).catch(() => {});
  return fx;
}

function program(gl, vs, fs) {
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn('шейдер', gl.getShaderInfoLog(s)); return null; }
    return s;
  };
  const v = sh(gl.VERTEX_SHADER, vs), f = sh(gl.FRAGMENT_SHADER, fs);
  if (!v || !f) return null;
  const p = gl.createProgram();
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  return gl.getProgramParameter(p, gl.LINK_STATUS) ? p : null;
}
