/* ===== Tap Hold 编辑器主逻辑（A+B 交换 / 隐藏单图 双通道完全隔离） =====
 * 设计要点：
 *  1) state.swap 与 state.hide 各自持有图片、参数、掩码、历史栈，互不共享引用。
 *  2) 渲染 / 导出始终按通道取数，切换模式不会串图、不会串参数。
 *  3) 两套通道都有自己的掩码：交换=擦除用，隐藏单图=保留区用。
 *  4) 导出算法与原版一致：未涂抹时逐像素输出完全相同。
 *     - buildSwap：alpha 解方程 + 掩码=0 处 alpha 置 0（掩码全 1 时与原版一致）
 *     - buildHide：棋盘格（原版）
 *     - PNG8.encode：原版
 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const SIZES = {
    '16:9': [1200, 675],
    '1:1': [1200, 1200],
    '4:5': [1080, 1350],
  };
  const HISTORY_LIMIT = 40;

  // ========== 全局状态：双模式完全隔离 ==========
  const state = {
    mode: (new URLSearchParams(location.search).get('mode') === 'swap') ? 'swap' : 'hide',
    sizePreset: '16:9',
    canvasW: 1200,
    canvasH: 675,
    split: 0.5, // 中间大预览的左右对比分界线（0-1，仅影响预览外观）
    brushSize: 40, // 画笔大小属于工具参数，两套模式共用同一个尺寸

    // ---- 通道一：A+B 交换（掩码默认全 1 = 全部显示，涂"擦除"变 0 = 该处透明） ----
    // 白底侧（图 A）与黑底侧（图 B）各有一套亮度/对比度：白侧调低压白雾，黑侧调高加深差异
    swap: {
      imgA: null,
      imgB: null,
      strength: 60,
      brightA: 100,
      contrastA: 100,
      brightB: 100,
      contrastB: 100,
      satur: 100,
      gray: 0,
      mask: null,
      maskW: 0,
      maskH: 0,
      brushMode: 'keep',
      history: [],
      historyIndex: -1,
    },

    // ---- 通道二：隐藏单图（掩码默认全 0 = 不保留，涂"保留"变 1 = 时间线直接显示） ----
    hide: {
      imgMain: null,
      strength: 60,
      brightness: 100,
      contrast: 100,
      satur: 100,
      gray: 0,
      checker: 1,
      mask: null,
      maskW: 0,
      maskH: 0,
      brushMode: 'keep',
      history: [],
      historyIndex: -1,
    },
  };

  // ========== DOM 缓存 ==========
  const dom = {
    modeSwapBtn: document.querySelector('#modeSeg [data-mode="swap"]'),
    modeHideBtn: document.querySelector('#modeSeg [data-mode="hide"]'),

    uploadAreaSwapA: document.querySelector('.upload-area-swap-a'),
    uploadAreaSwapB: document.querySelector('.upload-area-swap-b'),
    uploadAreaHideMain: document.querySelector('.upload-area-hide-main'),

    fileA: $('fileA'),
    fileB: $('fileB'),
    fileMain: $('fileMain'),
    labelA: $('labelA'),
    labelB: $('labelB'),
    labelMain: $('labelMain'),

    canvas: $('canvas'),
    prevWhite: $('prevWhite'),
    prevBlack: $('prevBlack'),
    cmpHandle: $('cmpHandle'),
    cmpLine: $('cmpLine'),
    cmpTagL: $('cmpTagL'),
    cmpTagR: $('cmpTagR'),
    cmpNote: $('cmpNote'),
    strengthCtrl: $('strengthCtrl'),

    sliderBrushSize: $('brushSize'),
    brushSizeVal: $('brushSizeVal'),
    sliderStrength: $('strength'),
    strengthVal: $('strengthVal'),
    sliderBrightness: $('bright'),
    brightVal: $('brightVal'),
    sliderContrast: $('contrast'),
    contrastVal: $('contrastVal'),
    sliderBrightA: $('brightA'),
    brightAVal: $('brightAVal'),
    sliderContrastA: $('contrastA'),
    contrastAVal: $('contrastAVal'),
    sliderBrightB: $('brightB'),
    brightBVal: $('brightBVal'),
    sliderContrastB: $('contrastB'),
    contrastBVal: $('contrastBVal'),
    splitCtrl: $('splitCtrl'),
    singleCtrl: $('singleCtrl'),
    checkerCtrl: $('checkerCtrl'),
    checkerBtns: document.querySelectorAll('#checkerSeg [data-checker]'),
    grayPresetBtn: $('grayPresetBtn'),
    sliderSatur: $('satur'),
    saturVal: $('saturVal'),
    saturCtrl: $('saturCtrl'),
    grayBtns: document.querySelectorAll('#graySeg [data-gray]'),

    btnKeep: document.querySelector('#paintSeg [data-paint="keep"]'),
    btnErase: document.querySelector('#paintSeg [data-paint="erase"]'),

    btnUndo: $('undoBtn'),
    btnRedo: $('redoBtn'),
    btnExport: $('exportBtn'),

    presetBtns: document.querySelectorAll('#sizeSeg [data-size]'),
    modeHint: $('modeHint'),
  };

  const ctxMain = dom.canvas.getContext('2d', { willReadFrequently: true });
  const prevWhiteCtx = dom.prevWhite.getContext('2d');
  const prevBlackCtx = dom.prevBlack.getContext('2d');

  function currentChannel() {
    return state.mode === 'swap' ? state.swap : state.hide;
  }
  function maskDefaultFor(mode) {
    // 交换模式：默认全部保留显示；隐藏单图：默认全部不保留
    return mode === 'swap' ? 1 : 0;
  }

  // ========== 掩码：两套通道各自一份，尺寸跟随画布 ==========
  function ensureMaskFor(ch, def, force) {
    const w = state.canvasW, hh = state.canvasH;
    if (!force && ch.mask && ch.maskW === w && ch.maskH === hh) return;
    const old = ch.mask, ow = ch.maskW, oh = ch.maskH;
    const next = new Uint8Array(w * hh);
    if (def === 1) next.fill(1);
    ch.mask = next;
    ch.maskW = w;
    ch.maskH = hh;
    if (old && ow > 0 && oh > 0) {
      // 尺寸预设切换：最近邻重采样，保留已涂抹的区域
      for (let y = 0; y < hh; y++) {
        const sy = Math.min(oh - 1, Math.floor(y * oh / hh));
        for (let x = 0; x < w; x++) {
          const sx = Math.min(ow - 1, Math.floor(x * ow / w));
          ch.mask[y * w + x] = old[sy * ow + sx];
        }
      }
    }
  }

  function ensureMasks(force) {
    ensureMaskFor(state.hide, 0, force);
    ensureMaskFor(state.swap, 1, force);
  }

  function resizeCanvas() {
    const [w, h] = SIZES[state.sizePreset];
    state.canvasW = w;
    state.canvasH = h;
    dom.canvas.width = w;
    dom.canvas.height = h;
    ensureMasks();
  }

  // ========== 工具：把图按 cover 画到指定尺寸（高质量重采样） ==========
  function drawCover(c, img, w, h) {
    const ir = img.width / img.height, cr = w / h;
    // 先算出 cover 需要的源图裁切框（保持原版构图：填满、居中、裁掉多余）
    let sx = 0, sy = 0, sw = img.width, sh = img.height;
    if (ir > cr) { sw = Math.round(img.height * cr); sx = Math.round((img.width - sw) / 2); }
    else { sh = Math.round(img.width / cr); sy = Math.round((img.height - sh) / 2); }

    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    if (sw > w * 2) {
      // 大图缩得很狠时先降到 2 倍，避免一次性缩小产生锯齿/丢细节
      const tmp = document.createElement('canvas');
      tmp.width = Math.round(w * 2);
      tmp.height = Math.round(h * 2);
      const tc = tmp.getContext('2d', { willReadFrequently: true });
      tc.imageSmoothingEnabled = true;
      tc.imageSmoothingQuality = 'high';
      tc.drawImage(img, sx, sy, sw, sh, 0, 0, tmp.width, tmp.height);
      c.drawImage(tmp, 0, 0, tmp.width, tmp.height, 0, 0, w, h);
    } else {
      c.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
    }
  }

  function getSourceImageData(img) {
    const w = state.canvasW, h = state.canvasH;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cc = c.getContext('2d', { willReadFrequently: true });
    cc.clearRect(0, 0, w, h);
    drawCover(cc, img, w, h);
    return cc.getImageData(0, 0, w, h);
  }

  // 饱和度 / 灰度 / 亮度 / 对比度（按通道参数）
  // satur：0=完全去色，100=原样，200=双倍饱和；gray=1 直接强制去色
  function adjust(idata, p) {
    const d = idata.data;
    const s = p.gray ? 0 : (p.satur == null ? 1 : p.satur / 100);
    const c = p.contrast / 100, b = p.brightness / 100;
    const clamp = v => (v < 0 ? 0 : v > 255 ? 255 : v);
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], bl = d[i + 2];
      if (s !== 1) {
        // 按亮度（Rec.709）做去色/加饱和，灰度开关等价于 s=0
        const y = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
        d[i] = clamp(y + (r - y) * s);
        d[i + 1] = clamp(y + (g - y) * s);
        d[i + 2] = clamp(y + (bl - y) * s);
      }
      for (let k = 0; k < 3; k++) {
        let v = d[i + k];
        v = (v - 128) * c + 128;
        v = v * b;
        d[i + k] = clamp(v);
      }
    }
    return idata;
  }

  // 源图缓存（只影响性能，不改变输出像素）
  const srcCache = { swapA: null, swapB: null, hide: null };
  function invalidateSrcCache() {
    srcCache.swapA = null;
    srcCache.swapB = null;
    srcCache.hide = null;
  }
  function getAdjusted(key, img, p) {
    const hit = srcCache[key];
    if (hit && hit.img === img && hit.w === state.canvasW && hit.h === state.canvasH
      && hit.bright === p.brightness && hit.contrast === p.contrast
      && hit.satur === p.satur && hit.gray === p.gray) {
      return hit.data;
    }
    const data = adjust(getSourceImageData(img), p);
    srcCache[key] = {
      img, w: state.canvasW, h: state.canvasH,
      bright: p.brightness, contrast: p.contrast,
      satur: p.satur, gray: p.gray, data,
    };
    return data;
  }

  /* ===== 算法一：隐藏单图 —— 棋盘格 =====
   * 掩码=1 的区域实色；其余区域棋盘格（实色半透明/全透明交替），
   * 白底缩小被平均成淡雾，黑底实色浮现。
   * checker：棋盘块边长（1=细，3=粗；粗格在手机缩放下不易出摩尔纹）
   */
  function buildHide() {
    const w = state.canvasW, h = state.canvasH;
    const p = state.hide;
    ensureMaskFor(p, 0);
    const mask = p.mask;
    const src = getAdjusted('hide', p.imgMain, p);
    const out = ctxMain.createImageData(w, h);
    const s = src.data, o = out.data;
    const strength = p.strength / 100;
    const cs = p.checker && p.checker > 0 ? p.checker : 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const keep = mask[idx] === 1;
        const checker = ((Math.floor(x / cs) + Math.floor(y / cs)) % 2 === 0);
        const si = idx * 4;
        if (keep) {
          o[si] = s[si]; o[si + 1] = s[si + 1]; o[si + 2] = s[si + 2]; o[si + 3] = 255;
        } else if (checker) {
          o[si] = s[si]; o[si + 1] = s[si + 1]; o[si + 2] = s[si + 2];
          o[si + 3] = Math.round(255 * strength);
        } else {
          o[si + 3] = 0;
        }
      }
    }
    return out;
  }

  /* ===== 算法二：A/B 交换 —— 逐像素 alpha =====
   * 白底(255)显示 A，黑底(0)显示 B。
   * W = C*a + 255*(1-a); B = C*a  =>  a=(255-W)/(255-B), C=B/a
   * 高光保护：alpha 加到下界 max(B通道/255)，使 C=B/a 恒 <=255，
   * 从根上消除 C 溢出（溢出被截断时黑底会泛白、露出白底轮廓）。
   * 掩码为 0 的像素 alpha 直接置 0（擦除）。
   */
  function swapParamsFor(img) {
    const s = state.swap;
    const base = { satur: s.satur, gray: s.gray };
    if (img === s.imgA) {
      return Object.assign({ brightness: s.brightA, contrast: s.contrastA }, base);
    }
    return Object.assign({ brightness: s.brightB, contrast: s.contrastB }, base);
  }

  function buildSwap() {
    const w = state.canvasW, h = state.canvasH;
    const s = state.swap;
    ensureMaskFor(s, 1);
    const mask = s.mask;
    const A = getAdjusted('swapA', s.imgA, swapParamsFor(s.imgA)).data;
    const B = getAdjusted('swapB', s.imgB, swapParamsFor(s.imgB)).data;
    const out = ctxMain.createImageData(w, h);
    const o = out.data;
    for (let i = 0; i < w * h; i++) {
      const si = i * 4;
      const lW = 0.0722 * A[si] + 0.7152 * A[si + 1] + 0.2126 * A[si + 2];
      const lB = 0.0722 * B[si] + 0.7152 * B[si + 1] + 0.2126 * B[si + 2];
      const den = 255 - lB;
      let alpha = den <= 0 ? 1 : (255 - lW) / den;
      if (alpha < 0) alpha = 0;
      if (alpha > 1) alpha = 1;
      for (let k = 0; k < 3; k++) {
        const need = B[si + k] / 255;
        if (need > alpha) alpha = need;
      }
      if (alpha > 1) alpha = 1;
      if (alpha <= 0) {
        o[si] = 0; o[si + 1] = 0; o[si + 2] = 0; o[si + 3] = 0;
        continue;
      }
      for (let k = 0; k < 3; k++) {
        const C = Math.round(B[si + k] / alpha);
        o[si + k] = C > 255 ? 255 : C;
      }
      o[si + 3] = Math.round(alpha * 255);
      if (mask[i] === 0) o[si + 3] = 0;
    }
    return out;
  }

  // ========== 渲染 ==========
  let tmpCanvas = null;
  let renderPending = false;
  let lastOut = null; // 最近一次合成结果，拖动对比滑块时直接复用，不重算像素

  /* 中间大预览：
   *  - A+B 交换：左半白底（时间线缩略图）+ 右半黑底（长按查看器），中间可拖动对比
   *  - 隐藏单图：整张按白底显示（时间线观感），不留拖动区，避免 ⇄ 按钮挡画笔
   * 下面两个小预览始终按原样各自整张显示。 */
  function drawMainCompare() {
    const w = state.canvasW, h = state.canvasH;
    const hideMode = state.mode === 'hide';
    ctxMain.clearRect(0, 0, w, h);

    if (hideMode) {
      ctxMain.fillStyle = '#ffffff';
      ctxMain.fillRect(0, 0, w, h);
      if (tmpCanvas && lastOut) ctxMain.drawImage(tmpCanvas, 0, 0, w, h, 0, 0, w, h);
      return;
    }

    const splitX = Math.max(1, Math.min(w - 1, Math.round(w * state.split)));
    if (!tmpCanvas || !lastOut) {
      // 还没上齐图片：只画左右底色，方便看出滑块在哪
      ctxMain.fillStyle = '#ffffff';
      ctxMain.fillRect(0, 0, splitX, h);
      ctxMain.fillStyle = '#000000';
      ctxMain.fillRect(splitX, 0, w - splitX, h);
      return;
    }
    // 左：白底
    ctxMain.save();
    ctxMain.beginPath();
    ctxMain.rect(0, 0, splitX, h);
    ctxMain.clip();
    ctxMain.fillStyle = '#ffffff';
    ctxMain.fillRect(0, 0, w, h);
    ctxMain.drawImage(tmpCanvas, 0, 0, w, h, 0, 0, w, h);
    ctxMain.restore();
    // 右：黑底
    ctxMain.save();
    ctxMain.beginPath();
    ctxMain.rect(splitX, 0, w - splitX, h);
    ctxMain.clip();
    ctxMain.fillStyle = '#000000';
    ctxMain.fillRect(0, 0, w, h);
    ctxMain.drawImage(tmpCanvas, 0, 0, w, h, 0, 0, w, h);
    ctxMain.restore();
  }

  function positionCompare() {
    const pct = (state.split * 100).toFixed(2) + '%';
    if (dom.cmpHandle) dom.cmpHandle.style.left = pct;
    if (dom.cmpLine) dom.cmpLine.style.left = pct;
  }

  function drawPreview(out) {
    const w = state.canvasW, h = state.canvasH;
    if (!tmpCanvas) tmpCanvas = document.createElement('canvas');
    if (tmpCanvas.width !== w || tmpCanvas.height !== h) {
      tmpCanvas.width = w; tmpCanvas.height = h;
    }
    const tc = tmpCanvas.getContext('2d', { willReadFrequently: true });
    tc.clearRect(0, 0, w, h);
    tc.putImageData(out, 0, 0);
    prevWhiteCtx.fillStyle = '#ffffff';
    prevWhiteCtx.fillRect(0, 0, 400, 225);
    prevWhiteCtx.drawImage(tmpCanvas, 0, 0, 400, 225);
    prevBlackCtx.fillStyle = '#000000';
    prevBlackCtx.fillRect(0, 0, 400, 225);
    prevBlackCtx.drawImage(tmpCanvas, 0, 0, 400, 225);
  }

  function clearPreview() {
    prevWhiteCtx.fillStyle = '#ffffff';
    prevWhiteCtx.fillRect(0, 0, 400, 225);
    prevBlackCtx.fillStyle = '#000000';
    prevBlackCtx.fillRect(0, 0, 400, 225);
  }

  function renderSwapPreview() {
    ctxMain.clearRect(0, 0, state.canvasW, state.canvasH);
    const s = state.swap;
    if (!s.imgA || !s.imgB) { lastOut = null; clearPreview(); drawMainCompare(); return; }
    const out = buildSwap();
    lastOut = out;
    drawPreview(out);
    drawMainCompare();
  }

  function renderHidePreview() {
    ctxMain.clearRect(0, 0, state.canvasW, state.canvasH);
    const h = state.hide;
    if (!h.imgMain) { lastOut = null; clearPreview(); drawMainCompare(); return; }
    const out = buildHide();
    lastOut = out;
    drawPreview(out);
    drawMainCompare();
  }

  function render() {
    if (state.mode === 'swap') renderSwapPreview();
    else renderHidePreview();
    updateHistoryUI();
  }

  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      render();
    });
  }

  // ========== 历史：两套独立栈 ==========
  function channelOf(mode) {
    return mode === 'swap' ? state.swap : state.hide;
  }

  function snapshot(channel) {
    const ch = channelOf(channel);
    const base = {
      t: channel,
      strength: ch.strength,
      satur: ch.satur,
      gray: ch.gray,
      mask: ch.mask ? ch.mask.slice() : null,
      maskW: ch.maskW,
      maskH: ch.maskH,
    };
    if (channel === 'swap') {
      base.imgA = ch.imgA;
      base.imgB = ch.imgB;
      base.brightA = ch.brightA;
      base.contrastA = ch.contrastA;
      base.brightB = ch.brightB;
      base.contrastB = ch.contrastB;
    } else {
      base.imgMain = ch.imgMain;
      base.brightness = ch.brightness;
      base.contrast = ch.contrast;
      base.checker = ch.checker;
    }
    return base;
  }

  function pushHistory(channel) {
    const ch = channelOf(channel);
    ch.history = ch.history.slice(0, ch.historyIndex + 1);
    ch.history.push(snapshot(channel));
    if (ch.history.length > HISTORY_LIMIT) ch.history.shift();
    ch.historyIndex = ch.history.length - 1;
    updateHistoryUI();
  }

  function applySnapshot(snap) {
    const ch = channelOf(snap.t);
    if (snap.t === 'swap') {
      ch.imgA = snap.imgA;
      ch.imgB = snap.imgB;
      ch.brightA = snap.brightA;
      ch.contrastA = snap.contrastA;
      ch.brightB = snap.brightB;
      ch.contrastB = snap.contrastB;
    } else {
      ch.imgMain = snap.imgMain;
      ch.brightness = snap.brightness;
      ch.contrast = snap.contrast;
      ch.checker = snap.checker == null ? 1 : snap.checker;
    }
    ch.strength = snap.strength;
    ch.satur = snap.satur == null ? 100 : snap.satur;
    ch.gray = snap.gray || 0;
    ch.mask = snap.mask ? snap.mask.slice() : null;
    ch.maskW = snap.maskW;
    ch.maskH = snap.maskH;
    if (ch.maskW !== state.canvasW || ch.maskH !== state.canvasH) {
      // 尺寸变过，按当前画布重建（内部会做重采样）
      ensureMaskFor(ch, maskDefaultFor(snap.t), true);
    }
    updateLabels();
    syncControlPanel();
    render();
  }

  function undo() {
    const ch = channelOf(state.mode);
    if (ch.historyIndex <= 0) return;
    ch.historyIndex--;
    applySnapshot(ch.history[ch.historyIndex]);
  }

  function redo() {
    const ch = channelOf(state.mode);
    if (ch.historyIndex >= ch.history.length - 1) return;
    ch.historyIndex++;
    applySnapshot(ch.history[ch.historyIndex]);
  }

  function updateHistoryUI() {
    const ch = channelOf(state.mode);
    dom.btnUndo.disabled = ch.historyIndex <= 0;
    dom.btnRedo.disabled = ch.historyIndex >= ch.history.length - 1;
  }

  // ========== UI 同步 ==========
  function syncControlPanel() {
    const isSwap = state.mode === 'swap';
    const p = currentChannel();
    dom.sliderStrength.value = p.strength;
    dom.strengthVal.textContent = p.strength;

    if (isSwap) {
      dom.sliderBrightA.value = p.brightA;
      dom.sliderContrastA.value = p.contrastA;
      dom.sliderBrightB.value = p.brightB;
      dom.sliderContrastB.value = p.contrastB;
      dom.brightAVal.textContent = p.brightA;
      dom.contrastAVal.textContent = p.contrastA;
      dom.brightBVal.textContent = p.brightB;
      dom.contrastBVal.textContent = p.contrastB;
    } else {
      dom.sliderBrightness.value = p.brightness;
      dom.sliderContrast.value = p.contrast;
      dom.brightVal.textContent = p.brightness;
      dom.contrastVal.textContent = p.contrast;
      dom.checkerBtns.forEach(b => b.classList.toggle('active', Number(b.dataset.checker) === (p.checker || 1)));
    }
    if (dom.sliderSatur) {
      dom.sliderSatur.value = p.satur == null ? 100 : p.satur;
      dom.saturVal.textContent = p.gray ? '灰度' : (p.satur == null ? 100 : p.satur);
      dom.grayBtns.forEach(b => b.classList.toggle('active', Number(b.dataset.gray) === (p.gray ? 1 : 0)));
      // 灰度打开时饱和度滑块失效，视觉上压暗提示
      if (dom.saturCtrl) dom.saturCtrl.classList.toggle('disabled', !!p.gray);
    }
    dom.sliderBrushSize.value = state.brushSize;
    dom.brushSizeVal.textContent = state.brushSize;
    dom.btnKeep.classList.toggle('active', p.brushMode === 'keep');
    dom.btnErase.classList.toggle('active', p.brushMode === 'erase');
    if (dom.modeHint) {
      dom.modeHint.textContent = isSwap
        ? '当前：A+B 交换 —— 白底看图 A，黑底看图 B；用“擦除”抹掉不想出现的区域（导出为透明），“涂抹保留”可涂回来。'
        : '当前：隐藏单图 —— 涂白（保留）区域在时间线里直接显示，“擦除”取消该区域的保留。';
    }
    updateHistoryUI();
  }

  function updateLabels() {
    dom.labelA.textContent = state.swap.imgA ? '图 A 已就绪 ✓' : '上传图 A（时间线显示）';
    dom.labelB.textContent = state.swap.imgB ? '图 B 已就绪 ✓' : '上传图 B（长按显示）';
    dom.labelMain.textContent = state.hide.imgMain ? '主图已就绪 ✓' : '上传主图（隐藏单图用）';
  }

  // 按模式切换「界面层」的显隐：死参数藏掉、只在有用的模式里露出拖动对比
  function syncModeChrome() {
    const isSwap = state.mode === 'swap';

    // 显示强度只作用于隐藏单图的棋盘格；A+B 交换的 alpha 解方程不读它
    if (dom.strengthCtrl) dom.strengthCtrl.style.display = isSwap ? 'none' : '';

    // 参数面板分组：交换模式给两侧各一套，单图模式给一套 + 棋盘格粒度
    if (dom.splitCtrl) dom.splitCtrl.style.display = isSwap ? '' : 'none';
    if (dom.singleCtrl) dom.singleCtrl.style.display = isSwap ? 'none' : '';
    if (dom.checkerCtrl) dom.checkerCtrl.style.display = isSwap ? 'none' : '';

    // 拖动对比只在交换模式提供；隐藏单图整张白底显示，避免 ⇄ 按钮挡住画笔
    [dom.cmpHandle, dom.cmpLine, dom.cmpTagL, dom.cmpTagR].forEach(el => {
      if (el) el.style.display = isSwap ? '' : 'none';
    });
    if (dom.cmpNote) {
      dom.cmpNote.textContent = isSwap
        ? '拖动中间的滑块对比：左边 = 时间线缩略图（白底），右边 = 长按查看器（黑底）。'
        : '中间预览按白底显示（时间线缩略图的观感）；黑底的长按效果看下方“黑底 · 长按”小图。';
    }
  }

  function switchMode(targetMode) {
    state.mode = (targetMode === 'swap') ? 'swap' : 'hide';
    const isSwap = state.mode === 'swap';
    dom.modeSwapBtn.classList.toggle('active', isSwap);
    dom.modeHideBtn.classList.toggle('active', !isSwap);

    dom.uploadAreaSwapA.style.display = isSwap ? 'block' : 'none';
    dom.uploadAreaSwapB.style.display = isSwap ? 'block' : 'none';
    dom.uploadAreaHideMain.style.display = isSwap ? 'none' : 'block';

    ensureMasks();
    syncModeChrome();
    syncControlPanel();
    updateLabels();
    render();
  }

  // ========== 上传 ==========
  function loadImage(file, cb) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { cb(img); URL.revokeObjectURL(url); };
    img.onerror = () => { URL.revokeObjectURL(url); alert('图片读取失败，请换一张试试'); };
    img.src = url;
  }

  function afterLoad(f, which) {
    loadImage(f, img => {
      if (which === 'A') {
        state.swap.imgA = img;
        pushHistory('swap');
      } else if (which === 'B') {
        state.swap.imgB = img;
        pushHistory('swap');
      } else {
        // 隐藏单图通道的主图，与 swap 的 A/B 完全独立
        state.hide.imgMain = img;
        pushHistory('hide');
      }
      updateLabels();
      if ((which === 'MAIN' && state.mode === 'hide') || (which !== 'MAIN' && state.mode === 'swap')) {
        render();
      }
    });
  }

  function bindUpload(box, input, which) {
    if (!box || !input) return;
    box.addEventListener('click', () => input.click());
    box.addEventListener('dragover', e => { e.preventDefault(); box.classList.add('drag'); });
    box.addEventListener('dragleave', () => box.classList.remove('drag'));
    box.addEventListener('drop', e => {
      e.preventDefault();
      box.classList.remove('drag');
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) afterLoad(f, which);
    });
    input.addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      if (f) afterLoad(f, which);
      e.target.value = '';
    });
  }

  // ========== 涂抹：两套模式都能画，各写各的掩码 ==========
  let isDrawing = false;

  function canvasPos(e) {
    const rect = dom.canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (state.canvasW / rect.width);
    const y = (e.clientY - rect.top) * (state.canvasH / rect.height);
    return { x, y };
  }

  function paintAt(x, y) {
    const ch = currentChannel();
    ensureMaskFor(ch, maskDefaultFor(state.mode));
    const w = state.canvasW, hh = state.canvasH;
    const r = state.brushSize;
    const val = ch.brushMode === 'keep' ? 1 : 0;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const px = Math.round(x + dx), py = Math.round(y + dy);
        if (px < 0 || py < 0 || px >= w || py >= hh) continue;
        ch.mask[py * w + px] = val;
      }
    }
  }

  function hasCurrentImage() {
    return state.mode === 'swap'
      ? !!(state.swap.imgA && state.swap.imgB)
      : !!state.hide.imgMain;
  }

  dom.canvas.addEventListener('pointerdown', e => {
    if (!hasCurrentImage()) return;
    e.preventDefault();
    isDrawing = true;
    ensureMaskFor(currentChannel(), maskDefaultFor(state.mode));
    const { x, y } = canvasPos(e);
    paintAt(x, y);
    scheduleRender();
    if (dom.canvas.setPointerCapture) {
      try { dom.canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    }
  });

  dom.canvas.addEventListener('pointermove', e => {
    if (!isDrawing) return;
    const { x, y } = canvasPos(e);
    paintAt(x, y);
    scheduleRender();
  });

  function endStroke() {
    if (!isDrawing) return;
    isDrawing = false;
    // 一笔画完才落历史：撤销回到这一笔之前，重做回到这一笔之后
    pushHistory(state.mode);
    render();
  }
  dom.canvas.addEventListener('pointerup', endStroke);
  dom.canvas.addEventListener('pointercancel', endStroke);
  dom.canvas.addEventListener('pointerleave', e => {
    if (isDrawing && e.buttons === 0) endStroke();
  });

  // ========== 中间大预览的对比滑块（只动观感，不动图片/掩码） ==========
  function bindCompareDrag() {
    if (!dom.cmpHandle) return;
    let dragging = false;

    function setFrom(e) {
      const rect = dom.canvas.getBoundingClientRect();
      if (!rect.width) return;
      const v = (e.clientX - rect.left) / rect.width;
      state.split = Math.max(0.02, Math.min(0.98, v));
      positionCompare();
      drawMainCompare();
    }

    dom.cmpHandle.addEventListener('pointerdown', e => {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      try { dom.cmpHandle.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    });
    dom.cmpHandle.addEventListener('pointermove', e => {
      if (!dragging) return;
      e.preventDefault();
      setFrom(e);
    });
    const stop = () => { dragging = false; };
    dom.cmpHandle.addEventListener('pointerup', stop);
    dom.cmpHandle.addEventListener('pointercancel', stop);
    dom.cmpHandle.addEventListener('pointerleave', e => { if (dragging && e.buttons === 0) stop(); });
    // 双击回到正中间
    dom.cmpHandle.addEventListener('dblclick', () => {
      state.split = 0.5;
      positionCompare();
      drawMainCompare();
    });
  }

  // ========== 滑块绑定（按当前通道写入各自参数） ==========
  function bindRange(slider, valEl, target, key) {
    slider.addEventListener('input', () => {
      const p = target();
      p[key] = Number(slider.value);
      if (valEl) valEl.textContent = slider.value;
      scheduleRender();
    });
    // 松手时才落历史，撤销就是回到上一次参数
    slider.addEventListener('change', () => {
      if (key === 'brushSize') return;
      pushHistory(state.mode);
    });
  }

  function bindSliders() {
    bindRange(dom.sliderBrushSize, dom.brushSizeVal, () => state, 'brushSize');
    bindRange(dom.sliderStrength, dom.strengthVal, () => currentChannel(), 'strength');
    // 交换模式：白底侧 / 黑底侧各一套，直接写进 state.swap，不随模式切换串值
    bindRange(dom.sliderBrightA, dom.brightAVal, () => state.swap, 'brightA');
    bindRange(dom.sliderContrastA, dom.contrastAVal, () => state.swap, 'contrastA');
    bindRange(dom.sliderBrightB, dom.brightBVal, () => state.swap, 'brightB');
    bindRange(dom.sliderContrastB, dom.contrastBVal, () => state.swap, 'contrastB');
    // 单图模式
    bindRange(dom.sliderBrightness, dom.brightVal, () => currentChannel(), 'brightness');
    bindRange(dom.sliderContrast, dom.contrastVal, () => currentChannel(), 'contrast');
    if (dom.sliderSatur) bindRange(dom.sliderSatur, dom.saturVal, () => currentChannel(), 'satur');

    dom.checkerBtns.forEach(btn => {
      btn.onclick = () => {
        state.hide.checker = Number(btn.dataset.checker) || 1;
        syncControlPanel();
        pushHistory('hide');
        render();
      };
    });

    if (dom.grayPresetBtn) {
      dom.grayPresetBtn.onclick = () => {
        const p = currentChannel();
        p.gray = 1;
        if (state.mode === 'swap') {
          // 白侧退离 255、黑侧加深差异：消白雾的同时保住暗部
          p.brightA = 100; p.contrastA = 95;
          p.brightB = 100; p.contrastB = 125;
        } else {
          p.brightness = 100; p.contrast = 120;
        }
        syncControlPanel();
        pushHistory(state.mode);
        render();
      };
    }

    dom.grayBtns.forEach(btn => {
      btn.onclick = () => {
        const p = currentChannel();
        p.gray = Number(btn.dataset.gray) === 1 ? 1 : 0;
        syncControlPanel();
        pushHistory(state.mode);
        render();
      };
    });

    dom.btnKeep.onclick = () => {
      currentChannel().brushMode = 'keep';
      syncControlPanel();
    };
    dom.btnErase.onclick = () => {
      currentChannel().brushMode = 'erase';
      syncControlPanel();
    };
  }

  // ========== 模式切换点击绑定 ==========
  dom.modeSwapBtn.onclick = () => switchMode('swap');
  dom.modeHideBtn.onclick = () => switchMode('hide');
  dom.btnUndo.onclick = undo;
  dom.btnRedo.onclick = redo;

  // 尺寸预设
  dom.presetBtns.forEach(btn => {
    btn.onclick = () => {
      const key = btn.dataset.size;
      if (!SIZES[key]) return;
      dom.presetBtns.forEach(b => b.classList.toggle('active', b === btn));
      state.sizePreset = key;
      resizeCanvas();
      invalidateSrcCache();
      render();
    };
  });

  // ========== 导出：原版逻辑保留，只出 PNG；alpha 分级 + 真压缩 ==========
  async function triggerDownload(out, tag) {
    let blob;
    try {
      blob = await PNG8.encode(out);
    } catch (e) {
      alert('导出失败：' + (e && e.message ? e.message : e));
      return;
    }
    if (blob.size > 5 * 1024 * 1024) {
      alert('文件超过 5MB，X 会重编码。请换小尺寸预设或降低复杂度。');
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tap-hold-' + (tag ? tag + '-' : '') + state.sizePreset.replace(':', 'x') + '.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function exportSwapPNG8() {
    const s = state.swap;
    if (!s.imgA || !s.imgB) { alert('请先上传图 A 和图 B'); return; }
    const out = buildSwap();
    await triggerDownload(out, 'swap');
  }

  async function exportHidePNG8() {
    const h = state.hide;
    if (!h.imgMain) { alert('请先上传主图'); return; }
    const out = buildHide();
    await triggerDownload(out, 'hide');
  }

  dom.btnExport.onclick = async () => {
    dom.btnExport.disabled = true;
    try {
      if (state.mode === 'swap') await exportSwapPNG8();
      else await exportHidePNG8();
    } finally {
      dom.btnExport.disabled = false;
    }
  };

  // ========== 启动初始化 ==========
  bindUpload(dom.uploadAreaSwapA, dom.fileA, 'A');
  bindUpload(dom.uploadAreaSwapB, dom.fileB, 'B');
  bindUpload(dom.uploadAreaHideMain, dom.fileMain, 'MAIN');

  bindSliders();
  bindCompareDrag();
  resizeCanvas();
  invalidateSrcCache();
  positionCompare();
  // 两条通道各建一个基线历史点
  pushHistory('swap');
  pushHistory('hide');
  switchMode(state.mode);
})();
