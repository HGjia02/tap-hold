/* ===== Tap Hold 编辑器主逻辑 ===== */
(function () {
  const $ = id => document.getElementById(id);
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const prevWhite = $('prevWhite').getContext('2d');
  const prevBlack = $('prevBlack').getContext('2d');

  // 尺寸预设
  const SIZES = {
    '16:9': [1200, 675],
    '1:1': [1200, 1200],
    '4:5': [1080, 1350],
  };

  // 状态
  const state = {
    mode: new URLSearchParams(location.search).get('mode') || 'hide',
    sizeKey: '16:9',
    imgA: null,       // Image 对象
    imgB: null,
    mask: null,       // Uint8Array 保留掩码（1=保留显示），仅 hide 模式
    brushSize: 40,
    strength: 60,
    bright: 100,
    contrast: 100,
    paintMode: 'keep',
    history: [],
    redoStack: [],
    drawing: false,
  };

  // ---- 工具：把图按 cover 画到指定尺寸 ----
  function drawCover(ctx, img, w, h) {
    const ir = img.width / img.height, cr = w / h;
    let dw, dh, dx, dy;
    if (ir > cr) { dh = h; dw = h * ir; dx = (w - dw) / 2; dy = 0; }
    else { dw = w; dh = w / ir; dx = 0; dy = (h - dh) / 2; }
    ctx.drawImage(img, dx, dy, dw, dh);
  }

  function setSize(key) {
    state.sizeKey = key;
    const [w, h] = SIZES[key];
    canvas.width = w; canvas.height = h;
    if (!state.mask) state.mask = new Uint8Array(w * h);
    render();
  }

  // ---- 上传 ----
  function loadImage(file, cb) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { cb(img); URL.revokeObjectURL(url); };
    img.src = url;
  }

  function bindUpload(boxId, inputId, labelId, which) {
    const box = $(boxId), input = $(inputId), label = $(labelId);
    box.addEventListener('click', () => input.click());
    box.addEventListener('dragover', e => { e.preventDefault(); box.classList.add('drag'); });
    box.addEventListener('dragleave', () => box.classList.remove('drag'));
    box.addEventListener('drop', e => {
      e.preventDefault(); box.classList.remove('drag');
      const f = e.dataTransfer.files[0];
      if (f) afterLoad(f, which, label);
    });
    input.addEventListener('change', e => {
      const f = e.target.files[0];
      if (f) afterLoad(f, which, label);
    });
  }
  function afterLoad(f, which, label) {
    loadImage(f, img => {
      if (which === 'A') { state.imgA = img; label.textContent = '图 A 已就绪 ✓'; }
      else { state.imgB = img; label.textContent = '图 B 已就绪 ✓'; }
      state.history = []; state.redoStack = [];
      render();
    });
  }

  bindUpload('uploadA', 'fileA', 'labelA', 'A');
  bindUpload('uploadB', 'fileB', 'labelB', 'B');

  // ---- 涂抹（hide 模式，掩码） ----
  function canvasPos(e) {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);
    return { x, y };
  }
  function paintAt(x, y) {
    const [w, h] = [canvas.width, canvas.height];
    const r = state.brushSize;
    const val = state.paintMode === 'keep' ? 1 : 0;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const px = Math.round(x + dx), py = Math.round(y + dy);
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        state.mask[py * w + px] = val;
      }
    }
  }
  function pushHistory() {
    state.history.push(state.mask ? state.mask.slice() : null);
    if (state.history.length > 40) state.history.shift();
    state.redoStack = [];
  }
  canvas.addEventListener('pointerdown', e => {
    if (state.mode !== 'hide') return;
    state.drawing = true;
    pushHistory();
    const { x, y } = canvasPos(e);
    paintAt(x, y); render();
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', e => {
    if (!state.drawing || state.mode !== 'hide') return;
    const { x, y } = canvasPos(e);
    paintAt(x, y); render();
  });
  canvas.addEventListener('pointerup', () => { state.drawing = false; });

  $('undoBtn').addEventListener('click', () => {
    if (!state.history.length) return;
    state.redoStack.push(state.mask.slice());
    state.mask = state.history.pop();
    render();
  });
  $('redoBtn').addEventListener('click', () => {
    if (!state.redoStack.length) return;
    state.history.push(state.mask.slice());
    state.mask = state.redoStack.pop();
    render();
  });

  // ---- 参数控件 ----
  function bindRange(id, key, labelId) {
    const el = $(id);
    el.addEventListener('input', () => {
      state[key] = Number(el.value);
      $(labelId).textContent = el.value;
      render();
    });
  }
  bindRange('brushSize', 'brushSize', 'brushSizeVal');
  bindRange('strength', 'strength', 'strengthVal');
  bindRange('bright', 'bright', 'brightVal');
  bindRange('contrast', 'contrast', 'contrastVal');

  // 模式切换
  $('modeSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    state.mode = b.dataset.mode;
    [...$('modeSeg').children].forEach(x => x.classList.toggle('active', x === b));
    $('uploadB').style.display = state.mode === 'swap' ? 'block' : 'none';
    if (state.mode === 'hide' && !state.mask) state.mask = new Uint8Array(canvas.width * canvas.height);
    render();
  });
  $('paintSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    state.paintMode = b.dataset.paint;
    [...$('paintSeg').children].forEach(x => x.classList.toggle('active', x === b));
  });
  $('sizeSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    [...$('sizeSeg').children].forEach(x => x.classList.toggle('active', x === b));
    setSize(b.dataset.size);
  });

  // ===== 渲染算法 =====
  // 取原图 RGBA
  function getSourceImageData(img) {
    const w = canvas.width, h = canvas.height;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cc = c.getContext('2d');
    drawCover(cc, img, w, h);
    return cc.getImageData(0, 0, w, h);
  }

  // 亮度/对比度/强度调整
  function adjust(idata) {
    const d = idata.data;
    const c = state.contrast / 100, b = state.bright / 100;
    for (let i = 0; i < d.length; i += 4) {
      for (let k = 0; k < 3; k++) {
        let v = d[i + k];
        v = (v - 128) * c + 128;
        v = v * b;
        d[i + k] = Math.max(0, Math.min(255, v));
      }
    }
    return idata;
  }

  /* 模式一：隐藏单图 —— 棋盘格
   * 掩码=保留的区域实色；其余区域棋盘格（实色/透明交替），
   * 白底缩小被平均成淡雾，黑底实色浮现。
   */
  function buildHide() {
    const { width: w, height: h } = canvas;
    const src = adjust(getSourceImageData(state.imgA));
    const out = ctx.createImageData(w, h);
    const s = src.data, o = out.data;
    const strength = state.strength / 100;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const keep = state.mask[idx] === 1;
        const checker = ((x + y) % 2 === 0); // 棋盘格交替
        const si = idx * 4;
        if (keep) {
          o[si] = s[si]; o[si + 1] = s[si + 1]; o[si + 2] = s[si + 2]; o[si + 3] = 255;
        } else if (checker) {
          // 实色半透明（受强度控制），黑底可见
          o[si] = s[si]; o[si + 1] = s[si + 1]; o[si + 2] = s[si + 2];
          o[si + 3] = Math.round(255 * strength);
        } else {
          // 完全透明
          o[si + 3] = 0;
        }
      }
    }
    return out;
  }

  /* 模式二：A/B 交换 —— 逐像素 alpha
   * 白底(255)显示 A，黑底(0)显示 B。
   * W = C*a + 255*(1-a); B = C*a  =>  a=(255-W)/(255-B), C=B/a
   */
  function buildSwap() {
    const { width: w, height: h } = canvas;
    const A = adjust(getSourceImageData(state.imgA)).data;
    const B = adjust(getSourceImageData(state.imgB)).data;
    const out = ctx.createImageData(w, h);
    const o = out.data;
    for (let i = 0; i < w * h; i++) {
      const si = i * 4;
      for (let k = 0; k < 3; k++) {
        const W = A[si + k], Bl = B[si + k];
        let alpha = (255 - W) / (255 - Bl);
        alpha = Math.max(0, Math.min(1, alpha));
        let C = Bl / alpha;
        C = Math.max(0, Math.min(255, C));
        o[si + k] = C;
        o[si + 3] = Math.round(alpha * 255);
      }
    }
    return out;
  }

  // ---- 主渲染：画布 + 双预览 ----
  function render() {
    if (state.mode === 'hide') {
      if (!state.imgA) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
      const out = buildHide();
      ctx.putImageData(out, 0, 0);
      drawPreview(out);
    } else {
      if (!state.imgA || !state.imgB) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
      const out = buildSwap();
      ctx.putImageData(out, 0, 0);
      drawPreview(out);
    }
  }

  // 白底预览：透明压平到白；黑底预览：透明透黑
  function drawPreview(out) {
    const w = canvas.width, h = canvas.height;
    // 白底
    prevWhite.fillStyle = '#ffffff';
    prevWhite.fillRect(0, 0, 400, 225);
    // 把 out 画到临时 canvas 再缩放
    const tmp = document.createElement('canvas'); tmp.width = w; tmp.height = h;
    tmp.getContext('2d').putImageData(out, 0, 0);
    prevWhite.drawImage(tmp, 0, 0, 400, 225);
    // 黑底
    prevBlack.fillStyle = '#000000';
    prevBlack.fillRect(0, 0, 400, 225);
    prevBlack.drawImage(tmp, 0, 0, 400, 225);
  }

  // ---- 导出 ----
  $('exportBtn').addEventListener('click', () => {
    let out;
    if (state.mode === 'hide') {
      if (!state.imgA) { alert('请先上传图 A'); return; }
      out = buildHide();
    } else {
      if (!state.imgA || !state.imgB) { alert('请先上传图 A 和图 B'); return; }
      out = buildSwap();
    }
    const blob = PNG8.encode(out);
    if (blob.size > 5 * 1024 * 1024) {
      alert('文件超过 5MB，X 会重编码。请换小尺寸预设或降低复杂度。');
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tap-hold-' + state.sizeKey.replace(':', 'x') + '.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });

  // 初始化
  setSize('16:9');
})();
