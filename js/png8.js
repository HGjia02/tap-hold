/* ===== PNG8 索引色编码器（浏览器本地，无依赖） =====
 * 输入 RGBA ImageData，做 256 色量化（含逐项 alpha），输出索引色 PNG8 字节。
 *
 * 画质相关：
 *  - A：4D（R,G,B,A）中位切分，每个调色板项的 alpha 写进 tRNS（0-255 连续），
 *       不再是「a<=128 判全透明 / 其余全不透明」的二值化。
 *  - B：中位切分后跑 k-means 精修，同样 256 项内色板误差更小。
 *  - D：IDAT 优先走 CompressionStream('deflate')（真压缩）；环境不支持时退回 stored 块。
 */
(function () {
  const PNG8 = {};

  // ---- CRC32 ----
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ---- Adler32 (zlib) ----
  function adler32(data) {
    let a = 1, b = 0;
    for (let i = 0; i < data.length; i++) {
      a = (a + data[i]) % 65521;
      b = (b + a) % 65521;
    }
    return ((b << 16) | a) >>> 0;
  }

  // 兜底：stored-deflate zlib 块（不用压缩，兼容任何环境）
  function zlibStore(data) {
    const blocks = [];
    const head = new Uint8Array([0x78, 0x01]);
    let offset = 0;
    while (offset < data.length) {
      const chunk = data.subarray(offset, offset + 65535);
      const isLast = offset + chunk.length >= data.length;
      const len = chunk.length;
      const nlen = ~len & 0xffff;
      const block = new Uint8Array(1 + 2 + 2 + len);
      block[0] = isLast ? 1 : 0;
      block[1] = len & 0xff; block[2] = (len >> 8) & 0xff;
      block[3] = nlen & 0xff; block[4] = (nlen >> 8) & 0xff;
      block.set(chunk, 5);
      blocks.push(block);
      offset += len;
    }
    const total = 2 + blocks.reduce((s, b) => s + b.length, 0) + 4;
    const out = new Uint8Array(total);
    let p = 0;
    out.set(head, p); p += 2;
    for (const b of blocks) { out.set(b, p); p += b.length; }
    const adler = adler32(data);
    out[p++] = (adler >>> 24) & 0xff;
    out[p++] = (adler >>> 16) & 0xff;
    out[p++] = (adler >>> 8) & 0xff;
    out[p++] = adler & 0xff;
    return out;
  }

  // 真压缩：zlib 包裹的 deflate（PNG IDAT 要的就是这个）
  async function zlibCompress(data) {
    if (typeof CompressionStream === 'function') {
      try {
        const cs = new CompressionStream('deflate');
        const writer = cs.writable.getWriter();
        writer.write(data);
        writer.close();
        const buf = await new Response(cs.readable).arrayBuffer();
        const out = new Uint8Array(buf);
        if (out.length > 8) return out;
      } catch (e) {
        /* 落到 stored 兜底 */
      }
    }
    return zlibStore(data);
  }

  function chunk(type, data) {
    const len = new Uint8Array(4);
    len[0] = (data.length >>> 24) & 0xff; len[1] = (data.length >>> 16) & 0xff;
    len[2] = (data.length >>> 8) & 0xff; len[3] = data.length & 0xff;
    const typeB = new Uint8Array(type.length);
    for (let i = 0; i < type.length; i++) typeB[i] = type.charCodeAt(i);
    const crcInput = new Uint8Array(typeB.length + data.length);
    crcInput.set(typeB, 0); crcInput.set(data, typeB.length);
    const crc = crc32(crcInput);
    const crcB = new Uint8Array(4);
    crcB[0] = (crc >>> 24) & 0xff; crcB[1] = (crc >>> 16) & 0xff;
    crcB[2] = (crc >>> 8) & 0xff; crcB[3] = crc & 0xff;
    const c = new Uint8Array(4 + typeB.length + data.length + 4);
    c.set(len, 0); c.set(typeB, 4); c.set(data, 4 + typeB.length); c.set(crcB, 4 + typeB.length + data.length);
    return c;
  }

  /* ---- 量化：4D 中位切分 + k-means 精修 ---- */
  const A_MIN = 8;          // alpha 低于此值归入「全透明」索引
  const MAX_COLORS = 255;   // 255 实色项 + 1 全透明项 = 256，正好填满 PLTE
  const SAMPLE_MAX = 120000; // 建模采样上限，兼顾质量与速度

  function quantize(rgba, w, h) {
    const N = w * h;
    const opaque = [];
    for (let i = 0; i < N; i++) {
      if (rgba[i * 4 + 3] >= A_MIN) opaque.push(i);
    }
    if (opaque.length === 0) {
      return { palette: [[0, 0, 0, 0]], index: new Uint8Array(N).fill(0), transIndex: 0 };
    }

    // 采样（等间隔，保持全图色彩分布）
    const step = Math.max(1, Math.floor(opaque.length / SAMPLE_MAX));
    const sample = [];
    for (let k = 0; k < opaque.length; k += step) sample.push(opaque[k]);

    const R = i => rgba[i * 4], G = i => rgba[i * 4 + 1], B = i => rgba[i * 4 + 2], A = i => rgba[i * 4 + 3];

    function ranges(box) {
      let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0, amin = 255, amax = 0;
      for (let k = 0; k < box.length; k++) {
        const i = box[k];
        const r = R(i), g = G(i), b = B(i), a = A(i);
        if (r < rmin) rmin = r; if (r > rmax) rmax = r;
        if (g < gmin) gmin = g; if (g > gmax) gmax = g;
        if (b < bmin) bmin = b; if (b > bmax) bmax = b;
        if (a < amin) amin = a; if (a > amax) amax = a;
      }
      return [rmax - rmin, gmax - gmin, bmax - bmin, amax - amin];
    }

    // ---- 4D 中位切分：每次挑「单轴跨度最大」的盒子，沿该轴对半分 ----
    let boxes = [sample];
    while (boxes.length < MAX_COLORS) {
      let bi = -1, bestSpread = -1, axis = 0;
      for (let bi2 = 0; bi2 < boxes.length; bi2++) {
        const box = boxes[bi2];
        if (box.length < 2) continue;
        const rng = ranges(box);
        const m = Math.max(rng[0], rng[1], rng[2], rng[3]);
        if (m > bestSpread) { bestSpread = m; bi = bi2; axis = rng.indexOf(m); }
      }
      if (bi < 0) break;
      const box = boxes[bi];
      const get = axis === 0 ? R : axis === 1 ? G : axis === 2 ? B : A;
      const sorted = box.slice().sort((x, y) => get(x) - get(y));
      const mid = Math.floor(sorted.length / 2);
      boxes.splice(bi, 1, sorted.slice(0, mid), sorted.slice(mid));
    }

    // 初始色板 = 每个盒子的四维均值
    let palette = boxes.map(box => {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < box.length; k++) {
        const i = box[k];
        r += R(i); g += G(i); b += B(i); a += A(i);
      }
      const n = box.length || 1;
      return [Math.round(r / n), Math.round(g / n), Math.round(b / n), Math.round(a / n)];
    });

    // ---- k-means 精修（2 轮，采样上跑）：色板往真实像素重心收敛，减小色带 ----
    const ITERS = 2;
    for (let it = 0; it < ITERS && palette.length > 1; it++) {
      const acc = [];
      for (let c = 0; c < palette.length; c++) acc.push([0, 0, 0, 0, 0]);
      for (let k = 0; k < sample.length; k++) {
        const i = sample[k];
        const r = R(i), g = G(i), b = B(i), a = A(i);
        let best = 0, bestD = Infinity;
        for (let c = 0; c < palette.length; c++) {
          const p = palette[c];
          const dr = r - p[0], dg = g - p[1], db = b - p[2], da = a - p[3];
          const d = dr * dr + dg * dg + db * db + da * da;
          if (d < bestD) { bestD = d; best = c; }
        }
        const s = acc[best];
        s[0] += r; s[1] += g; s[2] += b; s[3] += a; s[4]++;
      }
      for (let c = 0; c < palette.length; c++) {
        const s = acc[c];
        if (s[4] > 0) {
          palette[c] = [
            Math.round(s[0] / s[4]), Math.round(s[1] / s[4]),
            Math.round(s[2] / s[4]), Math.round(s[3] / s[4]),
          ];
        }
      }
    }

    // 透明索引放在最后
    const transIndex = palette.length;
    palette.push([0, 0, 0, 0]);

    // ---- 全图映射：5bit RGBA 分桶缓存，避免每个像素都跑 255 次距离 ----
    const index = new Uint8Array(N);
    const nPal = transIndex; // 不含透明项
    const cache = new Int16Array(1 << 20).fill(-1);
    for (let i = 0; i < N; i++) {
      const a = rgba[i * 4 + 3];
      if (a < A_MIN) { index[i] = transIndex; continue; }
      const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
      const key = ((r >> 3) << 15) | ((g >> 3) << 10) | ((b >> 3) << 5) | (a >> 3);
      let v = cache[key];
      if (v >= 0) { index[i] = v; continue; }
      let best = 0, bestD = Infinity;
      for (let c = 0; c < nPal; c++) {
        const p = palette[c];
        const dr = r - p[0], dg = g - p[1], db = b - p[2], da = a - p[3];
        const d = dr * dr + dg * dg + db * db + da * da;
        if (d < bestD) { bestD = d; best = c; }
      }
      cache[key] = best;
      index[i] = best;
    }

    return { palette, index, transIndex };
  }

  // 主入口：ImageData -> Promise<PNG8 Blob>
  PNG8.encode = async function (imageData) {
    const { width: w, height: h, data: rgba } = imageData;
    const { palette, index, transIndex } = quantize(rgba, w, h);
    if (palette.length > 256) throw new Error('PNG8 调色板超过 256 项');

    // IHDR：颜色类型 3 = 索引色，位深 8
    const ihdr = new Uint8Array(13);
    ihdr[0] = (w >>> 24) & 0xff; ihdr[1] = (w >>> 16) & 0xff; ihdr[2] = (w >>> 8) & 0xff; ihdr[3] = w & 0xff;
    ihdr[4] = (h >>> 24) & 0xff; ihdr[5] = (h >>> 16) & 0xff; ihdr[6] = (h >>> 8) & 0xff; ihdr[7] = h & 0xff;
    ihdr[8] = 8;
    ihdr[9] = 3;
    ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

    // PLTE
    const plte = new Uint8Array(palette.length * 3);
    for (let c = 0; c < palette.length; c++) {
      plte[c * 3] = palette[c][0]; plte[c * 3 + 1] = palette[c][1]; plte[c * 3 + 2] = palette[c][2];
    }

    // tRNS：逐项 alpha（0-255），这是 A 步的关键
    const trns = new Uint8Array(palette.length);
    let maxAlphaUsed = 0;
    for (let c = 0; c < palette.length; c++) {
      trns[c] = palette[c][3];
      if (trns[c] > maxAlphaUsed) maxAlphaUsed = trns[c];
    }
    // tRNS 全 255 没有意义，省掉这个块（标准允许缺省）
    const useTrns = palette.some((p, c) => p[3] !== 255);

    // IDAT：每行前置 filter byte(0)
    const raw = new Uint8Array(h * (w + 1));
    for (let y = 0; y < h; y++) {
      raw[y * (w + 1)] = 0;
      for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = index[y * w + x];
    }
    const idat = await zlibCompress(raw);

    // 组装
    const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const parts = [sig, chunk('IHDR', ihdr), chunk('PLTE', plte)];
    if (useTrns) parts.push(chunk('tRNS', trns));
    parts.push(chunk('IDAT', idat), chunk('IEND', new Uint8Array(0)));
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let p2 = 0;
    for (const pt of parts) { out.set(pt, p2); p2 += pt.length; }
    return new Blob([out], { type: 'image/png' });
  };

  window.PNG8 = PNG8;
})();
