/* Inklet — free, client-side PDF editor.
 *
 * Rendering: pdf.js draws each page onto a canvas; an overlay canvas on top
 * holds the user's annotations. Export: pdf-lib rebuilds the document (page
 * order / rotation) and draws the annotations as real vector/text/image
 * content. Nothing ever leaves the browser.
 *
 * Coordinate system: annotations are stored in "base units" = PDF points in
 * the *displayed* orientation of the page (scale-1 pdf.js viewport with the
 * page's total rotation applied). At export time these are mapped back into
 * the page's unrotated user space — see displayToPdf().
 */
'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

/* ---------------------------------------------------------------- state */

const TEXT_ASCENT = 0.8;   // baseline offset as a fraction of font size
const TEXT_LINE = 1.25;    // line height as a fraction of font size
const FONT_STACK = 'Helvetica, Arial, sans-serif';
const SWATCH_COLORS = ['#1a1a1a', '#e8413c', '#2f7de1', '#22a75a', '#f5c518'];

const state = {
  sources: [],          // {bytes, doc(pdf.js)}
  pages: [],            // page objects, in document order
  fileName: 'document.pdf',
  tool: 'pan',
  zoom: 1,              // multiplier on top of fit-to-width
  colors: { pen: '#e8413c', highlight: '#f5c518', text: '#1a1a1a' },
  sizes: { pen: 3, highlight: 14 },
  fontSize: 16,
  selected: null,       // {page, annot}
  pendingStamp: null,   // {dataUrl, w, h} waiting for a tap to place
  undoStack: [],
};

let pageSeq = 0;
let fitScale = 1;       // css px per base unit at zoom 1
const activeTouches = new Map(); // touch pointers currently down inside the viewer
let abortActiveGesture = null;   // cancels an in-progress overlay gesture (set while one runs)

const $ = (id) => document.getElementById(id);
const viewer = $('viewer');
const pagesHost = $('pagesHost');
const thumbsHost = $('thumbs');
const measureCtx = document.createElement('canvas').getContext('2d');

/* ---------------------------------------------------------------- utils */

function toast(msg, isError) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  $('toastHost').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function busy(on, text) {
  $('busy').hidden = !on;
  if (text) $('busyText').textContent = text;
}

function hex01(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function norm360(deg) { return ((deg % 360) + 360) % 360; }

function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

function dataUrlBytes(dataUrl) {
  const bin = atob(dataUrl.split(',')[1]);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ------------------------------------------------------------ documents */

async function openPdfBytes(bytes, name, append) {
  busy(true, append ? 'Merging PDF…' : 'Opening PDF…');
  try {
    // pdf.js transfers the buffer to its worker, so hand it a copy
    const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    const srcId = state.sources.length;
    state.sources.push({ bytes, doc });
    const newPages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const pdfPage = await doc.getPage(i);
      const vp = pdfPage.getViewport({ scale: 1 });
      newPages.push({
        id: ++pageSeq,
        src: srcId,
        srcIndex: i - 1,
        pdfPage,
        intrinsicRot: norm360(pdfPage.rotate || 0),
        userRot: 0,
        baseW: vp.width,
        baseH: vp.height,
        annots: [],
      });
    }
    const fresh = !append || state.pages.length === 0;
    if (fresh) {
      state.pages = newPages;
      state.fileName = name || 'document.pdf';
      state.undoStack = [];
      state.selected = null;
      state.zoom = 1;
    } else {
      state.pages.push(...newPages);
    }
    documentChanged();
    if (!fresh) toast(`Added ${newPages.length} page${newPages.length > 1 ? 's' : ''}`);
  } catch (err) {
    console.error(err);
    toast(/password|encrypt/i.test(String(err && err.name || err))
      ? 'Password-protected PDFs are not supported.'
      : 'Could not open that file — is it a valid PDF?', true);
  } finally {
    busy(false);
  }
}

function newBlankDocument() {
  state.pages = [makeBlankPage()];
  state.sources = [];
  state.fileName = 'untitled.pdf';
  state.undoStack = [];
  state.selected = null;
  state.zoom = 1;
  documentChanged();
}

function makeBlankPage() {
  return {
    id: ++pageSeq,
    src: -1, srcIndex: -1, pdfPage: null,
    intrinsicRot: 0, userRot: 0,
    baseW: 612, baseH: 792, // US Letter
    annots: [],
  };
}

function documentChanged() {
  $('landing').hidden = state.pages.length > 0;
  $('btnSave').disabled = state.pages.length === 0;
  const docName = $('docName');
  docName.textContent = state.pages.length ? state.fileName : '';
  docName.title = state.fileName;
  updateUndoBtn();
  computeFitScale();
  buildShells();
  buildThumbs();
  requestAnimationFrame(updateCurrentThumb);
}

// mark the thumbnail of the page closest to the viewport centre
function updateCurrentThumb() {
  const mid = viewer.getBoundingClientRect().top + viewer.clientHeight / 2;
  let best = null, bestDist = Infinity;
  for (const p of state.pages) {
    if (!p.shell) continue;
    const r = p.shell.getBoundingClientRect();
    const d = Math.abs((r.top + r.bottom) / 2 - mid);
    if (d < bestDist) { bestDist = d; best = p; }
  }
  for (const p of state.pages) {
    if (p.thumbEl) p.thumbEl.classList.toggle('current', p === best);
  }
}

/* ------------------------------------------------------------ rendering */

function scaleNow() { return clamp(fitScale * state.zoom, 0.15, 8); }

function computeFitScale() {
  const maxW = Math.max(320, ...state.pages.map(p => p.baseW));
  const avail = viewer.clientWidth - 28;
  fitScale = clamp(avail / maxW, 0.15, 3);
  $('zoomLabel').textContent = Math.round(state.zoom * 100) + '%';
}

let pageObserver = null;

function buildShells() {
  if (pageObserver) pageObserver.disconnect();
  pagesHost.textContent = '';
  pageObserver = new IntersectionObserver(onPageIntersect, { root: viewer, rootMargin: '600px 0px' });
  const k = scaleNow();
  for (const p of state.pages) {
    const shell = document.createElement('div');
    shell.className = 'page-shell' + (state.tool === 'pan' ? ' pan-mode' : '');
    shell.style.width = (p.baseW * k) + 'px';
    shell.style.height = (p.baseH * k) + 'px';

    const pdfCanvas = document.createElement('canvas');
    pdfCanvas.className = 'pdf-layer';
    const overlay = document.createElement('canvas');
    overlay.className = 'overlay-layer';
    const loading = document.createElement('div');
    loading.className = 'page-loading';
    loading.textContent = 'Loading…';

    shell.append(pdfCanvas, loading, overlay);
    pagesHost.appendChild(shell);

    p.shell = shell;
    p.pdfCanvas = pdfCanvas;
    p.overlay = overlay;
    p.renderedKey = null;
    p.rendering = false;
    shell._page = p;

    attachOverlayEvents(p);
    pageObserver.observe(shell);
  }
}

function onPageIntersect(entries) {
  for (const e of entries) {
    if (e.isIntersecting) renderPage(e.target._page);
  }
}

// Backing-store scale, capped so huge zooms / iOS canvas limits don't blow up
function backingScale(p) {
  const k = scaleNow() * (window.devicePixelRatio || 1);
  const capped = Math.min(k, 4);
  const px = p.baseW * capped * p.baseH * capped;
  return px > 16e6 ? capped * Math.sqrt(16e6 / px) : capped;
}

async function renderPage(p) {
  const key = `${scaleNow().toFixed(4)}:${p.userRot}`;
  if (p.renderedKey === key || p.rendering) return;
  p.rendering = true;
  try {
    const bk = backingScale(p);
    const k = scaleNow();
    p.pdfCanvas.width = Math.round(p.baseW * bk);
    p.pdfCanvas.height = Math.round(p.baseH * bk);
    p.pdfCanvas.style.width = (p.baseW * k) + 'px';
    p.pdfCanvas.style.height = (p.baseH * k) + 'px';
    const ctx = p.pdfCanvas.getContext('2d');
    if (p.pdfPage) {
      const vp = p.pdfPage.getViewport({ scale: bk, rotation: norm360(p.intrinsicRot + p.userRot) });
      await p.pdfPage.render({ canvasContext: ctx, viewport: vp }).promise;
    } else {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, p.pdfCanvas.width, p.pdfCanvas.height);
    }
    p.renderedKey = key;
    const loading = p.shell.querySelector('.page-loading');
    if (loading) loading.remove();
  } catch (err) {
    if (!(err && err.name === 'RenderingCancelledException')) console.error(err);
  } finally {
    p.rendering = false;
  }
  // scale or rotation changed while we were rendering — go again
  if (p.renderedKey && p.renderedKey !== `${scaleNow().toFixed(4)}:${p.userRot}`) {
    renderPage(p);
    return;
  }
  renderOverlay(p);
}

function renderOverlay(p) {
  if (!p.overlay) return;
  const bk = backingScale(p);
  const k = scaleNow();
  p.overlay.width = Math.round(p.baseW * bk);
  p.overlay.height = Math.round(p.baseH * bk);
  p.overlay.style.width = (p.baseW * k) + 'px';
  p.overlay.style.height = (p.baseH * k) + 'px';
  const ctx = p.overlay.getContext('2d');
  ctx.setTransform(bk, 0, 0, bk, 0, 0);
  drawAnnots(ctx, p, true);
  drawSelection(ctx, p);
}

function drawAnnots(ctx, p, editor) {
  for (const a of p.annots) {
    if (a._editing) continue;
    if (a.type === 'ink') {
      ctx.save();
      ctx.globalAlpha = a.opacity;
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const pts = a.points;
      ctx.beginPath();
      if (pts.length === 1) {
        ctx.fillStyle = a.color;
        ctx.arc(pts[0].x, pts[0].y, a.width / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length - 1; i++) {
          const mx = (pts[i].x + pts[i + 1].x) / 2;
          const my = (pts[i].y + pts[i + 1].y) / 2;
          ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
        }
        ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
        ctx.stroke();
      }
      ctx.restore();
    } else if (a.type === 'rect') {
      ctx.save();
      ctx.fillStyle = a.color;
      ctx.fillRect(a.x, a.y, a.w, a.h);
      // patches are seamless everywhere except while the whiteout tool is
      // active, where a faint dashed outline keeps them findable
      if (editor && state.tool === 'whiteout') {
        ctx.strokeStyle = 'rgba(79, 124, 255, .5)';
        ctx.lineWidth = 1 / scaleNow();
        ctx.setLineDash([4 / scaleNow(), 3 / scaleNow()]);
        ctx.strokeRect(a.x, a.y, a.w, a.h);
      }
      ctx.restore();
    } else if (a.type === 'text') {
      ctx.save();
      ctx.fillStyle = a.color;
      ctx.font = `${a.size}px ${FONT_STACK}`;
      ctx.textBaseline = 'alphabetic';
      const lines = a.text.split('\n');
      lines.forEach((line, i) => {
        ctx.fillText(line, a.x, a.y + TEXT_ASCENT * a.size + i * TEXT_LINE * a.size);
      });
      ctx.restore();
    } else if (a.type === 'image') {
      const img = imageElFor(a, p);
      if (img) ctx.drawImage(img, a.x, a.y, a.w, a.h);
    }
  }
}

const imageElCache = new Map();
function imageElFor(a, page) {
  let img = imageElCache.get(a.dataUrl);
  if (!img) {
    img = new Image();
    img.onload = () => { renderOverlay(page); updateThumb(page); };
    img.src = a.dataUrl;
    imageElCache.set(a.dataUrl, img);
  }
  return img.complete && img.naturalWidth ? img : null;
}

function annotBBox(a) {
  if (a.type === 'text') {
    measureCtx.font = `${a.size}px ${FONT_STACK}`;
    const lines = a.text.split('\n');
    let w = 8;
    for (const line of lines) w = Math.max(w, measureCtx.measureText(line).width);
    return { x: a.x, y: a.y, w, h: lines.length * TEXT_LINE * a.size };
  }
  if (a.type === 'image' || a.type === 'rect') return { x: a.x, y: a.y, w: a.w, h: a.h };
  // ink
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (const pt of a.points) {
    minX = Math.min(minX, pt.x); minY = Math.min(minY, pt.y);
    maxX = Math.max(maxX, pt.x); maxY = Math.max(maxY, pt.y);
  }
  const pad = a.width / 2;
  return { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
}

function drawSelection(ctx, p) {
  const sel = state.selected;
  if (!sel || sel.page !== p) return;
  const b = annotBBox(sel.annot);
  const k = scaleNow();
  ctx.save();
  ctx.strokeStyle = '#4f7cff';
  ctx.lineWidth = 1.5 / k;
  ctx.setLineDash([5 / k, 4 / k]);
  ctx.strokeRect(b.x - 3 / k, b.y - 3 / k, b.w + 6 / k, b.h + 6 / k);
  if (sel.annot.type !== 'ink') {
    ctx.setLineDash([]);
    ctx.fillStyle = '#4f7cff';
    const h = 10 / k;
    ctx.fillRect(b.x + b.w + 3 / k - h / 2, b.y + b.h + 3 / k - h / 2, h, h);
  }
  ctx.restore();
}

/* ------------------------------------------------------------ thumbnails */

let thumbObserver = null;

function buildThumbs() {
  if (thumbObserver) thumbObserver.disconnect();
  thumbsHost.textContent = '';
  thumbObserver = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) paintThumb(e.target._page);
  }, { root: thumbsHost, rootMargin: '300px 0px' });

  state.pages.forEach((p, idx) => {
    const el = document.createElement('div');
    el.className = 'thumb';
    const wrap = document.createElement('div');
    wrap.className = 'thumb-canvas-wrap';
    const canvas = document.createElement('canvas');
    const num = document.createElement('span');
    num.className = 'thumb-num';
    num.textContent = idx + 1;
    wrap.append(canvas, num);
    wrap.addEventListener('click', () => {
      p.shell.scrollIntoView({ behavior: 'smooth', block: 'start' });
      closeSidebar();
    });

    const tools = document.createElement('div');
    tools.className = 'thumb-tools';
    tools.innerHTML = `
      <button class="icon-btn" data-act="up" title="Move up"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M7 14l5-5 5 5z"/></svg></button>
      <button class="icon-btn" data-act="down" title="Move down"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg></button>
      <button class="icon-btn" data-act="rot" title="Rotate"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/></svg></button>
      <button class="icon-btn danger" data-act="del" title="Delete page"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>`;
    tools.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      pageAction(p, btn.dataset.act);
    });

    el.append(wrap, tools);
    thumbsHost.appendChild(el);
    p.thumbEl = el;
    p.thumbCanvas = canvas;
    p.thumbKey = null;
    el._page = p;
    thumbObserver.observe(el);
  });
}

async function paintThumb(p) {
  const key = `${p.userRot}:${p.annots.length}`;
  const w = 150;
  const k = w / p.baseW;
  p.thumbCanvas.width = w;
  p.thumbCanvas.height = Math.round(p.baseH * k);
  const ctx = p.thumbCanvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, p.thumbCanvas.width, p.thumbCanvas.height);
  if (p.pdfPage) {
    try {
      const vp = p.pdfPage.getViewport({ scale: k, rotation: norm360(p.intrinsicRot + p.userRot) });
      await p.pdfPage.render({ canvasContext: ctx, viewport: vp }).promise;
    } catch (e) { /* thumb render is best-effort */ }
  }
  ctx.setTransform(k, 0, 0, k, 0, 0);
  drawAnnots(ctx, p);
  p.thumbKey = key;
}

function updateThumb(p) {
  if (p.thumbCanvas) paintThumb(p);
}

function pageAction(p, act) {
  commitTextEditor();
  const idx = state.pages.indexOf(p);
  if (act === 'del') {
    if (state.pages.length === 1) { toast('A document needs at least one page.', true); return; }
    if (!confirm(`Delete page ${idx + 1}?`)) return;
    state.pages.splice(idx, 1);
    if (state.selected && state.selected.page === p) state.selected = null;
    state.undoStack = state.undoStack.filter(u => u.page !== p);
    updateUndoBtn();
    documentChanged();
  } else if (act === 'up' || act === 'down') {
    const to = act === 'up' ? idx - 1 : idx + 1;
    if (to < 0 || to >= state.pages.length) return;
    state.pages.splice(idx, 1);
    state.pages.splice(to, 0, p);
    documentChanged();
  } else if (act === 'rot') {
    rotatePage(p);
  }
}

function rotatePage(p) {
  commitTextEditor();
  // rotate the page 90° clockwise; ink rotates with the content, while
  // text/images keep their orientation but follow their centre point
  const oldH = p.baseH;
  const mapPt = (x, y) => ({ x: oldH - y, y: x });
  for (const a of p.annots) {
    if (a.type === 'ink') {
      a.points = a.points.map(pt => mapPt(pt.x, pt.y));
    } else if (a.type === 'rect') {
      // a cover patch turns with the content it hides
      const c = mapPt(a.x, a.y + a.h);
      [a.x, a.y, a.w, a.h] = [c.x, c.y, a.h, a.w];
    } else {
      const b = annotBBox(a);
      const c = mapPt(a.x + b.w / 2, a.y + b.h / 2);
      a.x = c.x - b.w / 2;
      a.y = c.y - b.h / 2;
    }
  }
  [p.baseW, p.baseH] = [p.baseH, p.baseW];
  p.userRot = norm360(p.userRot + 90);
  computeFitScale();
  updateShellSizes();
  updateThumb(p);
}

/* ------------------------------------------------------------ zoom & resize */

function setZoom(z, keepCenter = true) {
  const prev = scaleNow();
  state.zoom = clamp(z, 0.25, 6);
  const centerRatio = keepCenter
    ? (viewer.scrollTop + viewer.clientHeight / 2) / Math.max(1, pagesHost.scrollHeight)
    : 0;
  computeFitScale();
  updateShellSizes();
  if (keepCenter && prev !== scaleNow()) {
    viewer.scrollTop = centerRatio * pagesHost.scrollHeight - viewer.clientHeight / 2;
  }
}

function updateShellSizes() {
  const k = scaleNow();
  for (const p of state.pages) {
    if (!p.shell) continue;
    const w = (p.baseW * k) + 'px';
    const h = (p.baseH * k) + 'px';
    p.shell.style.width = w;
    p.shell.style.height = h;
    // stretch the current bitmaps immediately so the layout never shows
    // gaps mid-zoom; the crisp re-render below replaces them
    p.pdfCanvas.style.width = w;
    p.pdfCanvas.style.height = h;
    p.overlay.style.width = w;
    p.overlay.style.height = h;
    p.renderedKey = null;
  }
  // re-render whatever is on screen now
  for (const p of state.pages) {
    if (!p.shell) continue;
    const r = p.shell.getBoundingClientRect();
    if (r.bottom > -600 && r.top < innerHeight + 600) renderPage(p);
  }
}

/* --- zoom anchoring: keep the content under your fingers/cursor in place --- */

// which page is under a client point, and where on it (as fractions)
function anchorInfo(clientX, clientY) {
  let best = null, bestDist = Infinity;
  for (const p of state.pages) {
    if (!p.shell) continue;
    const r = p.shell.getBoundingClientRect();
    const d = clientY < r.top ? r.top - clientY : clientY > r.bottom ? clientY - r.bottom : 0;
    if (d < bestDist) {
      bestDist = d;
      best = { p, fx: (clientX - r.left) / r.width, fy: (clientY - r.top) / r.height };
    }
    if (d === 0) break;
  }
  return best;
}

// after a relayout, scroll so anchor's page-point sits at the target client point
function scrollToAnchor(anchor, targetClientX, targetClientY) {
  if (!anchor || !anchor.p.shell) return;
  const r = anchor.p.shell.getBoundingClientRect();
  viewer.scrollLeft += (r.left + anchor.fx * r.width) - targetClientX;
  viewer.scrollTop += (r.top + anchor.fy * r.height) - targetClientY;
}

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { computeFitScale(); updateShellSizes(); }, 150);
});

/* ------------------------------------------------------------ undo */

function pushUndo(entry) {
  state.undoStack.push(entry);
  if (state.undoStack.length > 100) state.undoStack.shift();
  updateUndoBtn();
}

function updateUndoBtn() {
  $('btnUndo').disabled = state.undoStack.length === 0;
}

function undo() {
  commitTextEditor();
  const u = state.undoStack.pop();
  updateUndoBtn();
  if (!u) return;
  const { page } = u;
  if (u.kind === 'add') {
    const i = page.annots.indexOf(u.annot);
    if (i >= 0) page.annots.splice(i, 1);
  } else if (u.kind === 'del') {
    page.annots.splice(Math.min(u.index, page.annots.length), 0, u.annot);
  } else if (u.kind === 'mod') {
    Object.assign(u.annot, u.before);
  }
  if (state.selected && state.selected.page === page &&
      !page.annots.includes(state.selected.annot)) state.selected = null;
  renderOverlay(page);
  updateThumb(page);
}

/* ------------------------------------------------------------ tools & input */

function setTool(tool) {
  commitTextEditor();
  if (tool !== 'stamp') state.pendingStamp = null;
  state.tool = tool;
  document.querySelectorAll('.tool-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tool === tool));
  document.querySelectorAll('.page-shell').forEach(s =>
    s.classList.toggle('pan-mode', tool === 'pan'));
  if (tool !== 'select' && state.selected) {
    const p = state.selected.page;
    state.selected = null;
    renderOverlay(p);
  }
  // whiteout outlines appear/disappear with the tool
  for (const p of state.pages) {
    if (p.shell && p.annots.some(a => a.type === 'rect')) renderOverlay(p);
  }
  updateToolOptions();
}

function toolFamily() {
  return state.tool === 'highlight' ? 'highlight' : state.tool === 'text' ? 'text' : 'pen';
}

function updateToolOptions() {
  const t = state.tool;
  const selType = t === 'select' && state.selected ? state.selected.annot.type : null;
  const showColors = t === 'pen' || t === 'highlight' || t === 'text' ||
    selType === 'text' || selType === 'rect';
  $('swatches').style.display = showColors ? '' : 'none';
  $('customColor').style.display = showColors ? '' : 'none';
  $('sizeOption').hidden = !(t === 'pen' || t === 'highlight');
  $('fontOption').hidden = !(t === 'text' ||
    (t === 'select' && state.selected && state.selected.annot.type === 'text'));

  const slider = $('strokeSize');
  if (t === 'highlight') { slider.min = 6; slider.max = 40; slider.value = state.sizes.highlight; }
  else { slider.min = 1; slider.max = 24; slider.value = state.sizes.pen; }

  const color = state.colors[toolFamily()];
  document.querySelectorAll('.swatch').forEach(s =>
    s.classList.toggle('active', s.dataset.color === color));
  $('customColor').value = color;
}

function eventToBase(p, e) {
  const rect = p.overlay.getBoundingClientRect();
  const k = scaleNow();
  return {
    x: clamp((e.clientX - rect.left) / k, 0, p.baseW),
    y: clamp((e.clientY - rect.top) / k, 0, p.baseH),
  };
}

function hitAnnot(p, pt) {
  for (let i = p.annots.length - 1; i >= 0; i--) {
    const a = p.annots[i];
    if (a._editing) continue;
    if (a.type === 'ink') {
      const tol = Math.max(a.width / 2 + 3, 6);
      const pts = a.points;
      if (pts.length === 1) {
        if (Math.hypot(pt.x - pts[0].x, pt.y - pts[0].y) <= tol) return a;
        continue;
      }
      for (let j = 1; j < pts.length; j++) {
        if (distToSegment(pt, pts[j - 1], pts[j]) <= tol) return a;
      }
    } else {
      const b = annotBBox(a);
      if (pt.x >= b.x - 3 && pt.x <= b.x + b.w + 3 && pt.y >= b.y - 3 && pt.y <= b.y + b.h + 3) return a;
    }
  }
  return null;
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function attachOverlayEvents(p) {
  const ov = p.overlay;
  let gesture = null; // {mode, ...}

  ov.addEventListener('contextmenu', e => e.preventDefault());

  // throw away a half-made gesture (e.g. when a second finger starts a pinch)
  const abort = () => {
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    abortActiveGesture = null;
    if (g.mode === 'draw' || g.mode === 'rectdraw') {
      const i = p.annots.indexOf(g.annot);
      if (i >= 0) p.annots.splice(i, 1);
    } else if ((g.mode === 'drag' || g.mode === 'resize') && g.before) {
      Object.assign(g.annot, g.before);
    }
    renderOverlay(p);
  };

  ov.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    // a second finger means pinch/pan, never a second stroke
    if (e.pointerType === 'touch' && activeTouches.size > 1) return;
    const pt = eventToBase(p, e);
    const tool = state.tool;
    commitTextEditor();

    if (tool === 'pen' || tool === 'highlight') {
      const fam = tool === 'highlight' ? 'highlight' : 'pen';
      const annot = {
        type: 'ink',
        points: [pt],
        color: state.colors[fam],
        width: state.sizes[fam],
        opacity: tool === 'highlight' ? 0.4 : 1,
      };
      p.annots.push(annot);
      gesture = { mode: 'draw', annot, last: pt };
    } else if (tool === 'whiteout') {
      const annot = { type: 'rect', x: pt.x, y: pt.y, w: 0, h: 0, color: '#ffffff' };
      p.annots.push(annot);
      gesture = { mode: 'rectdraw', annot, start: pt };
    } else if (tool === 'eraser') {
      gesture = { mode: 'erase' };
      eraseAt(p, pt);
    } else if (tool === 'text') {
      const hit = hitAnnot(p, pt);
      if (hit && hit.type === 'text') openTextEditor(p, hit);
      else openTextEditor(p, null, pt);
      return; // no capture needed
    } else if (tool === 'stamp') {
      placeStamp(p, pt);
      return;
    } else if (tool === 'select') {
      const sel = state.selected;
      if (sel && sel.page === p && sel.annot.type !== 'ink') {
        const b = annotBBox(sel.annot);
        const k = scaleNow();
        const hs = 14 / k;
        if (Math.abs(pt.x - (b.x + b.w)) < hs && Math.abs(pt.y - (b.y + b.h)) < hs) {
          gesture = { mode: 'resize', annot: sel.annot, start: pt, before: clone(sel.annot), bbox: b };
          abortActiveGesture = abort;
          ov.setPointerCapture(e.pointerId);
          e.preventDefault();
          return;
        }
      }
      const hit = hitAnnot(p, pt);
      if (hit) {
        state.selected = { page: p, annot: hit };
        gesture = { mode: 'drag', annot: hit, start: pt, before: clone(hit), moved: false };
      } else {
        state.selected = null;
      }
      renderOverlay(p);
      updateToolOptions();
    }
    if (gesture) {
      abortActiveGesture = abort;
      ov.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
  });

  ov.addEventListener('pointermove', (e) => {
    if (!gesture) return;
    const pt = eventToBase(p, e);
    if (gesture.mode === 'draw') {
      const last = gesture.last;
      if (Math.hypot(pt.x - last.x, pt.y - last.y) < 1.2) return;
      gesture.annot.points.push(pt);
      gesture.last = pt;
      // quick incremental segment; full redraw happens on release
      const ctx = p.overlay.getContext('2d');
      ctx.save();
      ctx.globalAlpha = gesture.annot.opacity;
      ctx.strokeStyle = gesture.annot.color;
      ctx.lineWidth = gesture.annot.width;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(pt.x, pt.y);
      ctx.stroke();
      ctx.restore();
      // (transform already set on the context from renderOverlay)
    } else if (gesture.mode === 'rectdraw') {
      const a = gesture.annot, s = gesture.start;
      a.x = Math.min(s.x, pt.x);
      a.y = Math.min(s.y, pt.y);
      a.w = Math.abs(pt.x - s.x);
      a.h = Math.abs(pt.y - s.y);
      renderOverlay(p);
    } else if (gesture.mode === 'erase') {
      eraseAt(p, pt);
    } else if (gesture.mode === 'drag') {
      const dx = pt.x - gesture.start.x, dy = pt.y - gesture.start.y;
      if (Math.abs(dx) + Math.abs(dy) > 0.5) gesture.moved = true;
      moveAnnot(gesture.annot, gesture.before, dx, dy);
      renderOverlay(p);
    } else if (gesture.mode === 'resize') {
      const a = gesture.annot;
      const b = gesture.bbox;
      const factor = clamp((pt.x - b.x) / Math.max(8, b.w), 0.1, 20);
      if (a.type === 'image') {
        a.w = gesture.before.w * factor;
        a.h = gesture.before.h * factor;
      } else if (a.type === 'rect') {
        a.w = Math.max(4, pt.x - a.x);
        a.h = Math.max(4, pt.y - a.y);
      } else if (a.type === 'text') {
        a.size = clamp(gesture.before.size * factor, 6, 200);
      }
      renderOverlay(p);
    }
  });

  const finish = (e) => {
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    abortActiveGesture = null;
    if (g.mode === 'draw') {
      pushUndo({ kind: 'add', page: p, annot: g.annot });
      renderOverlay(p);
      updateThumb(p);
    } else if (g.mode === 'rectdraw') {
      if (g.annot.w < 3 || g.annot.h < 3) {
        p.annots.splice(p.annots.indexOf(g.annot), 1); // just a click — discard
      } else {
        pushUndo({ kind: 'add', page: p, annot: g.annot });
        updateThumb(p);
        if (!state._whiteoutHint) {
          state._whiteoutHint = true;
          toast('Covered! Now use the Text tool to type over it.');
        }
      }
      renderOverlay(p);
    } else if (g.mode === 'drag' && g.moved) {
      pushUndo({ kind: 'mod', page: p, annot: g.annot, before: g.before });
      updateThumb(p);
    } else if (g.mode === 'resize') {
      pushUndo({ kind: 'mod', page: p, annot: g.annot, before: g.before });
      updateThumb(p);
    }
  };
  ov.addEventListener('pointerup', finish);
  ov.addEventListener('pointercancel', finish);

  // double-click / double-tap with select tool edits a text annotation
  let lastTap = 0;
  ov.addEventListener('pointerup', (e) => {
    if (state.tool !== 'select') return;
    const now = performance.now();
    if (now - lastTap < 350) {
      const pt = eventToBase(p, e);
      const hit = hitAnnot(p, pt);
      if (hit && hit.type === 'text') openTextEditor(p, hit);
    }
    lastTap = now;
  });
}

function moveAnnot(a, before, dx, dy) {
  if (a.type === 'ink') {
    a.points = before.points.map(pt => ({ x: pt.x + dx, y: pt.y + dy }));
  } else {
    a.x = before.x + dx;
    a.y = before.y + dy;
  }
}

function eraseAt(p, pt) {
  const hit = hitAnnot(p, pt);
  if (!hit) return;
  const index = p.annots.indexOf(hit);
  p.annots.splice(index, 1);
  if (state.selected && state.selected.annot === hit) state.selected = null;
  pushUndo({ kind: 'del', page: p, annot: hit, index });
  renderOverlay(p);
  updateThumb(p);
}

/* ------------------------------------------------------------ text editing */

let activeEditor = null; // {ta, page, annot(null if new), x, y}

function openTextEditor(p, annot, pt) {
  commitTextEditor();
  const k = scaleNow();
  const size = annot ? annot.size : state.fontSize;
  const color = annot ? annot.color : state.colors.text;
  const x = annot ? annot.x : pt.x;
  const y = annot ? annot.y : pt.y;

  const ta = document.createElement('textarea');
  ta.className = 'text-editor';
  ta.value = annot ? annot.text : '';
  ta.style.left = (x * k) + 'px';
  ta.style.top = (y * k) + 'px';
  ta.style.fontSize = (size * k) + 'px';
  ta.style.lineHeight = TEXT_LINE;
  ta.style.color = color;
  ta.setAttribute('autocapitalize', 'off');
  ta.spellcheck = false;

  if (annot) { annot._editing = true; renderOverlay(p); }
  p.shell.appendChild(ta);
  activeEditor = { ta, page: p, annot, x, y, size, color };

  const resize = () => {
    measureCtx.font = `${size * k}px ${FONT_STACK}`;
    const lines = ta.value.split('\n');
    let w = 24;
    for (const line of lines) w = Math.max(w, measureCtx.measureText(line).width);
    ta.style.width = (w + 16) + 'px';
    ta.style.height = (Math.max(1, lines.length) * TEXT_LINE * size * k + 8) + 'px';
  };
  resize();
  ta.addEventListener('input', resize);
  ta.addEventListener('blur', () => commitTextEditor());
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); cancelTextEditor(); }
    e.stopPropagation();
  });
  requestAnimationFrame(() => ta.focus());
}

function commitTextEditor() {
  if (!activeEditor) return;
  const { ta, page, annot, x, y, size, color } = activeEditor;
  activeEditor = null;
  const text = ta.value.replace(/\s+$/, '');
  ta.remove();
  if (annot) {
    delete annot._editing;
    if (!text) {
      const index = page.annots.indexOf(annot);
      page.annots.splice(index, 1);
      pushUndo({ kind: 'del', page, annot, index });
    } else if (text !== annot.text) {
      pushUndo({ kind: 'mod', page, annot, before: clone(annot) });
      annot.text = text;
    }
  } else if (text) {
    const a = { type: 'text', x, y, text, size, color };
    page.annots.push(a);
    pushUndo({ kind: 'add', page, annot: a });
  }
  renderOverlay(page);
  updateThumb(page);
}

function cancelTextEditor() {
  if (!activeEditor) return;
  const { ta, page, annot } = activeEditor;
  activeEditor = null;
  ta.remove();
  if (annot) delete annot._editing;
  renderOverlay(page);
}

/* ------------------------------------------------------------ stamps (images & signatures) */

function stampReady(dataUrl, natW, natH, label) {
  state.pendingStamp = { dataUrl, natW, natH };
  setTool('stamp');
  toast(`Tap the page to place your ${label}`);
}

function placeStamp(p, pt) {
  const s = state.pendingStamp;
  if (!s) { setTool('select'); return; }
  const maxW = p.baseW * 0.45;
  let w = Math.min(s.natW * 0.5, maxW);
  let h = w * (s.natH / s.natW);
  const a = {
    type: 'image',
    dataUrl: s.dataUrl,
    x: clamp(pt.x - w / 2, 0, p.baseW - w),
    y: clamp(pt.y - h / 2, 0, Math.max(0, p.baseH - h)),
    w, h,
  };
  p.annots.push(a);
  pushUndo({ kind: 'add', page: p, annot: a });
  state.pendingStamp = null;
  setTool('select');
  state.selected = { page: p, annot: a };
  renderOverlay(p);
  updateThumb(p);
  updateToolOptions();
}

function handleImageFile(file) {
  if (!file) return;
  if (!/^image\/(png|jpeg)$/.test(file.type)) {
    toast('Please choose a PNG or JPEG image.', true);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => stampReady(reader.result, img.naturalWidth, img.naturalHeight, 'image');
    img.onerror = () => toast('Could not read that image.', true);
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

/* ------------------------------------------------------------ signature pad */

const signPad = $('signPad');
const signCtx = signPad.getContext('2d');
let signStrokes = [];
let signColor = '#1a1a4b';

function openSignModal() {
  $('signModal').hidden = false;
  signStrokes = [];
  redrawSignPad();
}

function redrawSignPad() {
  signCtx.setTransform(1, 0, 0, 1, 0, 0);
  signCtx.clearRect(0, 0, signPad.width, signPad.height);
  signCtx.lineCap = 'round';
  signCtx.lineJoin = 'round';
  // guide line
  signCtx.strokeStyle = '#d8dee9';
  signCtx.lineWidth = 1.5;
  signCtx.setLineDash([6, 6]);
  signCtx.beginPath();
  signCtx.moveTo(30, signPad.height - 55);
  signCtx.lineTo(signPad.width - 30, signPad.height - 55);
  signCtx.stroke();
  signCtx.setLineDash([]);
  for (const s of signStrokes) {
    signCtx.strokeStyle = s.color;
    signCtx.lineWidth = 3.2;
    signCtx.beginPath();
    signCtx.moveTo(s.points[0].x, s.points[0].y);
    for (let i = 1; i < s.points.length - 1; i++) {
      const mx = (s.points[i].x + s.points[i + 1].x) / 2;
      const my = (s.points[i].y + s.points[i + 1].y) / 2;
      signCtx.quadraticCurveTo(s.points[i].x, s.points[i].y, mx, my);
    }
    const last = s.points[s.points.length - 1];
    signCtx.lineTo(last.x, last.y);
    signCtx.stroke();
  }
}

(function wireSignPad() {
  let stroke = null;
  const toPadPt = (e) => {
    const r = signPad.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (signPad.width / r.width),
      y: (e.clientY - r.top) * (signPad.height / r.height),
    };
  };
  signPad.addEventListener('pointerdown', (e) => {
    stroke = { color: signColor, points: [toPadPt(e)] };
    signStrokes.push(stroke);
    signPad.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  signPad.addEventListener('pointermove', (e) => {
    if (!stroke) return;
    stroke.points.push(toPadPt(e));
    redrawSignPad();
  });
  const end = () => { stroke = null; };
  signPad.addEventListener('pointerup', end);
  signPad.addEventListener('pointercancel', end);

  // signature ink colors
  const colors = ['#1a1a4b', '#1a1a1a', '#2f7de1'];
  const host = $('signColors');
  colors.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'swatch' + (i === 0 ? ' active' : '');
    b.style.background = c;
    b.dataset.color = c;
    b.addEventListener('click', () => {
      signColor = c;
      host.querySelectorAll('.swatch').forEach(s => s.classList.toggle('active', s === b));
    });
    host.appendChild(b);
  });

  $('btnSignClear').addEventListener('click', () => { signStrokes = []; redrawSignPad(); });
  $('btnSignClose').addEventListener('click', () => { $('signModal').hidden = true; });
  $('signModal').addEventListener('click', (e) => {
    if (e.target === $('signModal')) $('signModal').hidden = true;
  });
  $('btnSignUse').addEventListener('click', useSignature);
})();

function useSignature() {
  if (!signStrokes.length) { toast('Draw a signature first.', true); return; }
  // trim to ink bounding box (transparent background, no guide line)
  const tmp = document.createElement('canvas');
  tmp.width = signPad.width;
  tmp.height = signPad.height;
  const tctx = tmp.getContext('2d');
  tctx.lineCap = 'round';
  tctx.lineJoin = 'round';
  let minX = 1e9, minY = 1e9, maxX = 0, maxY = 0;
  for (const s of signStrokes) {
    tctx.strokeStyle = s.color;
    tctx.lineWidth = 3.2;
    tctx.beginPath();
    tctx.moveTo(s.points[0].x, s.points[0].y);
    for (const pt of s.points) {
      tctx.lineTo(pt.x, pt.y);
      minX = Math.min(minX, pt.x); minY = Math.min(minY, pt.y);
      maxX = Math.max(maxX, pt.x); maxY = Math.max(maxY, pt.y);
    }
    tctx.stroke();
  }
  const pad = 8;
  const sx = Math.max(0, minX - pad), sy = Math.max(0, minY - pad);
  const sw = Math.min(tmp.width, maxX + pad) - sx;
  const sh = Math.min(tmp.height, maxY + pad) - sy;
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(sw));
  out.height = Math.max(1, Math.round(sh));
  out.getContext('2d').drawImage(tmp, sx, sy, sw, sh, 0, 0, out.width, out.height);
  $('signModal').hidden = true;
  stampReady(out.toDataURL('image/png'), out.width, out.height, 'signature');
}

/* ------------------------------------------------------------ export */

async function exportPdf() {
  commitTextEditor();
  if (!state.pages.length) return;
  busy(true, 'Building PDF…');
  try {
    const { PDFDocument, StandardFonts, rgb, degrees, LineCapStyle } = PDFLib;
    const out = await PDFDocument.create();
    const srcDocs = new Map();
    for (const p of state.pages) {
      if (p.src >= 0 && !srcDocs.has(p.src)) {
        srcDocs.set(p.src, await PDFDocument.load(state.sources[p.src].bytes, { ignoreEncryption: true }));
      }
    }
    const font = await out.embedFont(StandardFonts.Helvetica);
    const imgCache = new Map();

    for (const p of state.pages) {
      let pg, R, box;
      if (p.src < 0) {
        // blank page: use the displayed dimensions directly, no rotation needed
        pg = out.addPage([p.baseW, p.baseH]);
        R = 0;
        box = { x: 0, y: 0, width: p.baseW, height: p.baseH };
      } else {
        [pg] = await out.copyPages(srcDocs.get(p.src), [p.srcIndex]);
        out.addPage(pg);
        const intrinsic = norm360(pg.getRotation().angle);
        R = norm360(intrinsic + p.userRot);
        pg.setRotation(degrees(R));
        box = pg.getCropBox();
      }
      const W = box.width, H = box.height;
      // display coords (rotated view, y down) -> unrotated PDF user space (y up)
      const conv = (dx, dy) => {
        let px, py;
        switch (R) {
          case 90:  px = dy;     py = dx;     break;
          case 180: px = W - dx; py = dy;     break;
          case 270: px = W - dy; py = H - dx; break;
          default:  px = dx;     py = H - dy; break;
        }
        return { x: px + box.x, y: py + box.y };
      };

      for (const a of p.annots) {
        const c = a.color ? hex01(a.color) : null;
        const color = c ? rgb(c.r, c.g, c.b) : undefined;
        if (a.type === 'ink') {
          const pts = a.points;
          if (pts.length === 1) {
            const ctr = conv(pts[0].x, pts[0].y);
            pg.drawCircle({ x: ctr.x, y: ctr.y, size: a.width / 2, color, opacity: a.opacity });
          } else {
            // one stroked path per stroke so translucent ink (highlighter)
            // doesn't double up where segments overlap
            const path = pts.map((pt, i) => {
              const c = conv(pt.x, pt.y);
              // drawSvgPath flips y, so pre-negate to land on the pdf point
              return `${i ? 'L' : 'M'}${c.x.toFixed(2)},${(-c.y).toFixed(2)}`;
            }).join(' ');
            pg.drawSvgPath(path, {
              x: 0, y: 0,
              borderColor: color,
              borderWidth: a.width,
              borderOpacity: a.opacity,
              borderLineCap: LineCapStyle.Round,
            });
          }
        } else if (a.type === 'rect') {
          // axis-aligned in display space stays axis-aligned under 90° steps:
          // convert two opposite corners and normalize
          const c1 = conv(a.x, a.y);
          const c2 = conv(a.x + a.w, a.y + a.h);
          pg.drawRectangle({
            x: Math.min(c1.x, c2.x),
            y: Math.min(c1.y, c2.y),
            width: Math.abs(c2.x - c1.x),
            height: Math.abs(c2.y - c1.y),
            color,
          });
        } else if (a.type === 'text') {
          const lines = a.text.split('\n');
          lines.forEach((line, i) => {
            if (!line) return;
            let safe = line;
            try { font.widthOfTextAtSize(safe, a.size); }
            catch { safe = safe.replace(/[^ -ÿ]/g, '?'); }
            const anchor = conv(a.x, a.y + TEXT_ASCENT * a.size + i * TEXT_LINE * a.size);
            try {
              pg.drawText(safe, { x: anchor.x, y: anchor.y, size: a.size, font, color, rotate: degrees(R) });
            } catch (err) {
              console.warn('Skipping unencodable text line', err);
            }
          });
        } else if (a.type === 'image') {
          let img = imgCache.get(a.dataUrl);
          if (!img) {
            const bytes = dataUrlBytes(a.dataUrl);
            img = a.dataUrl.startsWith('data:image/png')
              ? await out.embedPng(bytes)
              : await out.embedJpg(bytes);
            imgCache.set(a.dataUrl, img);
          }
          const anchor = conv(a.x, a.y + a.h); // pdf-lib anchors images at bottom-left
          pg.drawImage(img, { x: anchor.x, y: anchor.y, width: a.w, height: a.h, rotate: degrees(R) });
        }
      }
    }

    const bytes = await out.save();
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = state.fileName.replace(/\.pdf$/i, '') + '-edited.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast('PDF saved 🎉');
  } catch (err) {
    console.error(err);
    toast('Export failed: ' + (err && err.message || err), true);
  } finally {
    busy(false);
  }
}

/* ------------------------------------------------------------ sidebar (mobile drawer) */

function openSidebar() { $('sidebar').classList.add('open'); }
function closeSidebar() { $('sidebar').classList.remove('open'); }

/* ------------------------------------------------------------ pinch zoom & two-finger pan */

(function wireGestures() {
  let pinch = null;

  const midAndDist = () => {
    const [a, b] = [...activeTouches.values()];
    return {
      mx: (a.x + b.x) / 2,
      my: (a.y + b.y) / 2,
      d: Math.max(Math.hypot(a.x - b.x, a.y - b.y), 24),
    };
  };

  function startPinch() {
    commitTextEditor();
    if (abortActiveGesture) abortActiveGesture(); // a stroke in progress becomes a pan, not ink
    const { mx, my, d } = midAndDist();
    const hr = pagesHost.getBoundingClientRect();
    pinch = {
      d0: d,
      mx0: mx, my0: my,
      mx, my,
      zoom0: state.zoom,
      f: 1,
      // second finger cancels native scrolling only on annotation overlays,
      // so translate manually when both fingers are on them
      manual: [...activeTouches.values()].every(t => t.onOverlay),
      anchor: anchorInfo(mx, my),
    };
    pagesHost.style.transformOrigin = `${mx - hr.left}px ${my - hr.top}px`;
    pagesHost.style.willChange = 'transform';
  }

  function movePinch() {
    if (!pinch || activeTouches.size !== 2) return;
    const { mx, my, d } = midAndDist();
    pinch.f = clamp(d / pinch.d0, 0.25 / pinch.zoom0, 6 / pinch.zoom0);
    pinch.mx = mx;
    pinch.my = my;
    const dx = pinch.manual ? mx - pinch.mx0 : 0;
    const dy = pinch.manual ? my - pinch.my0 : 0;
    pagesHost.style.transform = `translate(${dx}px, ${dy}px) scale(${pinch.f})`;
  }

  function endPinch() {
    if (!pinch) return;
    const g = pinch;
    pinch = null;
    pagesHost.style.transform = '';
    pagesHost.style.transformOrigin = '';
    pagesHost.style.willChange = '';
    state.zoom = clamp(g.zoom0 * g.f, 0.25, 6);
    computeFitScale();
    updateShellSizes();
    scrollToAnchor(g.anchor, g.mx, g.my);
  }

  viewer.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    activeTouches.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
      onOverlay: e.target instanceof Element && e.target.classList.contains('overlay-layer'),
    });
    if (activeTouches.size === 2) startPinch();
    else if (activeTouches.size > 2) endPinch();
  }, true);

  viewer.addEventListener('pointermove', (e) => {
    const t = activeTouches.get(e.pointerId);
    if (!t) return;
    t.x = e.clientX;
    t.y = e.clientY;
    movePinch();
  }, true);

  const drop = (e) => {
    if (!activeTouches.delete(e.pointerId)) return;
    if (activeTouches.size < 2) endPinch();
  };
  viewer.addEventListener('pointerup', drop, true);
  viewer.addEventListener('pointercancel', drop, true);

  // desktop: trackpad pinch / ctrl+wheel zooms around the cursor
  viewer.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const anchor = anchorInfo(e.clientX, e.clientY);
    state.zoom = clamp(state.zoom * Math.exp(-e.deltaY * 0.0022), 0.25, 6);
    computeFitScale();
    updateShellSizes();
    scrollToAnchor(anchor, e.clientX, e.clientY);
  }, { passive: false });
})();

/* ------------------------------------------------------------ wiring */

function pickFile(input, cb) {
  input.value = '';
  input.onchange = () => cb(input.files[0]);
  input.click();
}

async function fileToBytes(file) {
  return new Uint8Array(await file.arrayBuffer());
}

function wireUI() {
  // tool buttons
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tool = btn.dataset.tool;
      if (tool === 'sign') { openSignModal(); return; }
      if (tool === 'image') {
        pickFile($('fileImage'), handleImageFile);
        return;
      }
      setTool(tool);
    });
  });

  // color swatches
  const swatchHost = $('swatches');
  SWATCH_COLORS.forEach(c => {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = c;
    b.dataset.color = c;
    b.title = c;
    b.addEventListener('click', () => applyColor(c));
    swatchHost.appendChild(b);
  });
  $('customColor').addEventListener('input', (e) => applyColor(e.target.value));

  $('strokeSize').addEventListener('input', (e) => {
    const v = +e.target.value;
    if (state.tool === 'highlight') state.sizes.highlight = v;
    else state.sizes.pen = v;
  });
  $('fontSize').addEventListener('input', (e) => {
    const v = +e.target.value;
    state.fontSize = v;
    $('fontSizeVal').textContent = v;
    const sel = state.selected;
    if (sel && sel.annot.type === 'text') {
      sel.annot.size = v;
      renderOverlay(sel.page);
      updateThumb(sel.page);
    }
  });

  // top bar
  const doOpen = () => pickFile($('fileOpen'), async (f) => {
    if (f) openPdfBytes(await fileToBytes(f), f.name, false);
  });
  $('btnOpen').addEventListener('click', doOpen);
  $('btnLandingOpen').addEventListener('click', doOpen);
  $('btnLandingNew').addEventListener('click', newBlankDocument);
  $('btnSave').addEventListener('click', exportPdf);
  $('btnUndo').addEventListener('click', undo);
  $('btnZoomIn').addEventListener('click', () => setZoom(state.zoom * 1.25));
  $('btnZoomOut').addEventListener('click', () => setZoom(state.zoom / 1.25));
  $('zoomLabel').addEventListener('click', () => setZoom(1));
  $('btnPages').addEventListener('click', openSidebar);
  $('btnCloseSidebar').addEventListener('click', closeSidebar);
  $('sidebarScrim').addEventListener('click', closeSidebar);

  // sidebar actions
  $('btnAddPage').addEventListener('click', () => {
    if (!state.pages.length) { newBlankDocument(); return; }
    state.pages.push(makeBlankPage());
    documentChanged();
    requestAnimationFrame(() => {
      const last = state.pages[state.pages.length - 1];
      if (last.shell) last.shell.scrollIntoView({ behavior: 'smooth' });
    });
  });
  $('btnMerge').addEventListener('click', () => {
    pickFile($('fileMerge'), async (f) => {
      if (f) openPdfBytes(await fileToBytes(f), f.name, true);
    });
    closeSidebar();
  });

  // drag & drop
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    const file = [...(e.dataTransfer.files || [])].find(f =>
      f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    if (file) openPdfBytes(await fileToBytes(file), file.name, state.pages.length > 0 && e.shiftKey);
    else if (e.dataTransfer.files.length) toast('Drop a PDF file to open it.', true);
  });

  // keyboard
  window.addEventListener('keydown', (e) => {
    if (activeEditor) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); exportPdf(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected) {
      e.preventDefault();
      const { page, annot } = state.selected;
      const index = page.annots.indexOf(annot);
      if (index >= 0) {
        page.annots.splice(index, 1);
        pushUndo({ kind: 'del', page, annot, index });
      }
      state.selected = null;
      renderOverlay(page);
      updateThumb(page);
    } else if (e.key === 'Escape' && state.selected) {
      const page = state.selected.page;
      state.selected = null;
      renderOverlay(page);
    }
  });

  // highlight current page in the thumbnail rail while scrolling
  let scrollTick = false;
  viewer.addEventListener('scroll', () => {
    if (scrollTick) return;
    scrollTick = true;
    requestAnimationFrame(() => {
      scrollTick = false;
      updateCurrentThumb();
    });
  });

  updateToolOptions();
}

function applyColor(c) {
  state.colors[toolFamily()] = c;
  const sel = state.selected;
  if (state.tool === 'select' && sel &&
      (sel.annot.type === 'text' || sel.annot.type === 'rect')) {
    sel.annot.color = c;
    renderOverlay(sel.page);
    updateThumb(sel.page);
  }
  updateToolOptions();
}

window.addEventListener('beforeunload', (e) => {
  if (state.undoStack.length > 0) {
    e.preventDefault();
    e.returnValue = '';
  }
});

wireUI();
