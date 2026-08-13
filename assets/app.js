/* 墨读阅读器 核心逻辑 */
(function () {
'use strict';

/* ================= 工具 ================= */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._tm); t._tm = setTimeout(() => t.classList.remove('show'), ms);
}
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

/* ================= 设置持久化 ================= */
// exe 中通过 Python 持久化到 %APPDATA%/ModuReader/settings.json
// 浏览器中用 localStorage
let _persistCache = null;
let _bridgeReady_persist = false;
let _persistLoaded = false; // load_settings 完成前禁止向 Python 保存，防止覆盖
const store = {
  _load() {
    if (_persistCache !== null) return _persistCache;
    try { _persistCache = JSON.parse(localStorage.getItem('mdr_all') || '{}'); } catch (e) { _persistCache = {}; }
    return _persistCache;
  },
  _flush() {
    try { localStorage.setItem('mdr_all', JSON.stringify(_persistCache)); } catch (e) {}
    // 仅在 load_settings 完成后才向 Python 保存，防止用不完整数据覆盖 settings.json
    if (_persistLoaded && window.pywebview && window.pywebview.api && window.pywebview.api.save_settings) {
      window.pywebview.api.save_settings(JSON.stringify(_persistCache));
    }
  },
  get(k, d) { const c = store._load(); return k in c ? c[k] : d; },
  set(k, v) { const c = store._load(); c[k] = v; _persistCache = c; store._flush(); }
};
// 异步从 Python 加载持久化数据（exe 环境下覆盖 localStorage）
function initPersist() {
  if (window.pywebview && window.pywebview.api && window.pywebview.api.load_settings) {
    window.pywebview.api.load_settings().then(function (jsonStr) {
      try {
        const data = JSON.parse(jsonStr || '{}');
        if (Object.keys(data).length) {
          _persistCache = data;
          try { localStorage.setItem('mdr_all', JSON.stringify(data)); } catch (e) {}
          Object.assign(settings, data.mdr_settings || {});
          Object.assign(aiCfg, data.mdr_ai || {});
          applySettings();
          if (homeVisible) renderHome();
        }
      } catch (e) {}
      // load_settings 完成，允许后续保存
      _persistLoaded = true;
      // 如有未保存的更改（如 applySettings 刚修改的），立即 flush 一次
      store._flush();
      // 无论是否有已存数据，都检查弹窗
      checkPopups();
      _bridgeReady_persist = true;
    }).catch(function () { _persistLoaded = true; checkPopups(); _bridgeReady_persist = true; });
  } else {
    // API 不可用或无 load_settings 方法：直接检查弹窗
    _persistLoaded = true;
    checkPopups();
    _bridgeReady_persist = true;
  }
}
const settings = Object.assign({ ff: '"Microsoft YaHei","微软雅黑",sans-serif', theme: 'white', fs: 17, lh: 19, fw: 400 }, store.get('mdr_settings', {}));
const aiCfg = Object.assign({ base: '', key: '', model: '', lang: '中文', proxy: '' }, store.get('mdr_ai', {}));

/* ================= 全局状态 ================= */
const tabs = [];          // {id,name,ext,kind,root,scroll,data?,...}
let activeId = null;
let annoMode = null;      // 'hl' | 'ul' | 'draw' | 'note' | 'eraser' | null
let editing = false;
let hlColor = 'yellow';
let tabSeq = 0;

const viewer = $('#viewer');
const welcome = $('#welcome');

function activeTab() { return tabs.find(t => t.id === activeId) || null; }
function docKey(t) { return 'mdr_doc_' + t.name + '_' + (t.size || 0); }
function progressKey(t) { return 'mdr_progress_' + t.name + '_' + (t.size || 0); }

/* ================= 阅读进度记忆 ================= */
let _progressTimer = null;
function saveProgress(t) {
  if (!t) return;
  try {
    const p = {};
    if (t.kind === 'html') {
      p.scrollTop = viewer.scrollTop;
    } else if (t.kind === 'pdf') {
      const vr = viewer.getBoundingClientRect();
      const mid = vr.top + vr.height / 2;
      let bestPage = 1;
      t.root.querySelectorAll('.pdf-page').forEach(pg => {
        const r = pg.getBoundingClientRect();
        if (r.top <= mid && r.bottom >= mid) bestPage = +pg.dataset.page;
      });
      p.page = bestPage;
      p.scrollTop = viewer.scrollTop;
    } else if (t.kind === 'epub' && t._lastCfi) {
      p.cfi = t._lastCfi;
    }
    if (Object.keys(p).length) store.set(progressKey(t), p);
  } catch (e) {}
}
function restoreProgress(t) {
  const p = store.get(progressKey(t), null);
  if (!p) return;
  try {
    if (t.kind === 'html') {
      if (p.scrollTop != null) viewer.scrollTop = p.scrollTop;
    } else if (t.kind === 'pdf') {
      if (p.page != null) {
        const pg = t.root.querySelector('.pdf-page[data-page="' + p.page + '"]');
        if (pg) pg.scrollIntoView({ block: 'start' });
        else if (p.scrollTop != null) viewer.scrollTop = p.scrollTop;
      } else if (p.scrollTop != null) viewer.scrollTop = p.scrollTop;
    } else if (t.kind === 'epub' && p.cfi && t.rendition) {
      t.rendition.display(p.cfi);
    }
  } catch (e) {}
}
function saveCurrentProgress() {
  clearTimeout(_progressTimer);
  _progressTimer = setTimeout(() => { saveProgress(activeTab()); }, 800);
}

/* ================= 阅读设置应用 ================= */
function applySettings() {
  document.body.dataset.theme = settings.theme;
  const v = viewer.style;
  v.setProperty('--reader-ff', settings.ff);
  v.setProperty('--reader-fs', settings.fs + 'px');
  v.setProperty('--reader-lh', settings.lh / 10);
  v.setProperty('--reader-fw', settings.fw);
  // 液态玻璃效果
  document.body.dataset.glass = settings.glass ? 'on' : 'off';
  // EPUB 主题同步
  tabs.forEach(t => { if (t.kind === 'epub' && t.rendition) { try { applyEpubTheme(t); } catch (e) {} } });
  // 控件状态
  $$('#rsFonts .rs-opt').forEach(b => b.classList.toggle('on', b.dataset.ff === settings.ff));
  $$('#rsThemes .rs-theme').forEach(b => b.classList.toggle('on', b.dataset.th === settings.theme));
  $('#rsFs').value = settings.fs; $('#rsFsV').textContent = settings.fs + 'px';
  $('#rsLh').value = settings.lh; $('#rsLhV').textContent = (settings.lh / 10).toFixed(1);
  $('#rsFw').value = settings.fw; $('#rsFwV').textContent = settings.fw;
  const gt = $('#glassToggle'); if (gt) gt.checked = !!settings.glass;
  store.set('mdr_settings', settings);
}
function themeColors() {
  const cs = getComputedStyle(document.body);
  return { bg: cs.getPropertyValue('--bg').trim(), ink: cs.getPropertyValue('--ink').trim() };
}
function applyEpubTheme(t) {
  const c = themeColors();
  const rules = {
    'html, body': {
      'height': 'auto !important',
      'min-height': '0 !important',
      'max-height': 'none !important',
      'display': 'block !important',
      'align-items': 'initial !important',
      'justify-content': 'initial !important',
      'margin': '0 !important',
      'position': 'static !important'
    },
    'body': {
      'color': c.ink + ' !important',
      'background': c.bg + ' !important',
      'font-family': settings.ff + ' !important',
      'font-size': settings.fs + 'px !important',
      'line-height': (settings.lh / 10) + ' !important',
      'font-weight': settings.fw + ' !important',
      'padding': '16px 12px !important',
      'overflow': 'visible !important'
    },
    'p,div,span,li': { 'color': c.ink + ' !important' },
    'p': { 'margin': '.6em 0 !important', 'text-indent': '2em !important' }
  };
  t.rendition.themes.register('custom', rules);
  t.rendition.themes.select('custom');
}

/* ================= 标签页 ================= */
function renderTabs() {
  const box = $('#tabs'); box.innerHTML = '';
  tabs.forEach(t => {
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === activeId ? ' active' : '');
    const icons = { pdf: '📕', epub: '📚', md: '📝', docx: '📄', txt: '📃', html: '🌐' };
    el.innerHTML = `<span class="ticon">${icons[t.ext] || '📄'}</span><span class="tname">${esc(t.name)}</span><span class="tclose">✕</span>`;
    el.title = t.name;
    el.addEventListener('click', (e) => { if (!e.target.classList.contains('tclose')) switchTab(t.id); });
    el.querySelector('.tclose').addEventListener('click', () => closeTab(t.id));
    box.appendChild(el);
  });
  welcome.classList.toggle('hidden', !(tabs.length === 0 || homeVisible));
  if (!welcome.classList.contains('hidden')) renderHome();
  updateToolbar();
}

function switchTab(id) {
  const cur = activeTab();
  if (cur) { exitEditMode(); cur.scroll = viewer.scrollTop; saveProgress(cur); cur.root.style.display = 'none'; }
  closeSearch();
  homeVisible = false;
  activeId = id;
  const t = activeTab();
  if (t) {
    t.root.style.display = '';
    viewer.scrollTop = t.scroll || 0;
    if (t.kind === 'epub' && t.rendition) setTimeout(() => { try { t.rendition.resize(); } catch (e) {} }, 50);
    $('#docInfo').textContent = t.info || '';
  }
  renderTabs();
  if ($('#tocPanel').classList.contains('open')) buildToc(t);
}

function closeTab(id) {
  const i = tabs.findIndex(t => t.id === id);
  if (i < 0) return;
  const t = tabs[i];
  if (t.dirty) { promptSave(t, () => doCloseTab(id)); return; }
  doCloseTab(id);
}

function doCloseTab(id) {
  const i = tabs.findIndex(t => t.id === id);
  if (i < 0) return;
  const t = tabs[i];
  if (t.kind === 'html') persistHtmlDoc(t);
  saveProgress(t);
  if (t.kind === 'epub' && t.book) { try { t.book.destroy(); } catch (e) {} }
  if (t._ro) { try { t._ro.disconnect(); } catch (e) {} }
  t.root.remove();
  tabs.splice(i, 1);
  if (activeId === id) {
    activeId = tabs.length ? tabs[Math.max(0, i - 1)].id : null;
    if (activeId) { const nt = activeTab(); nt.root.style.display = ''; }
    $('#docInfo').textContent = activeTab() ? (activeTab().info || '') : '';
    if ($('#tocPanel').classList.contains('open')) buildToc(activeTab());
  }
  renderTabs();
}

/* ================= 文件打开 ================= */
let pendingShelf = false; // 本次打开是否同时加入书架
$('#openBtn').addEventListener('click', () => openDialog(false));
$('#newTabBtn').addEventListener('click', () => openDialog(false));
$('#homeOpenBtn').addEventListener('click', () => openDialog(false));
$('#homeAddBtn').addEventListener('click', () => openDialog(true));
$('#dropHint').addEventListener('click', () => openDialog(false));
// 全局拖放：拖入窗口任意位置自动打开（含视觉反馈）
var _dragDepth = 0;
document.addEventListener('dragenter', function(e) {
  e.preventDefault();
  if (e.dataTransfer && e.dataTransfer.types && Array.from(e.dataTransfer.types).indexOf('Files') >= 0) {
    _dragDepth++;
    var ov = $('#dropOverlay'); if (ov) ov.classList.add('show');
  }
});
document.addEventListener('dragover', (e) => { e.preventDefault(); });
document.addEventListener('dragleave', function(e) {
  e.preventDefault();
  _dragDepth--;
  if (_dragDepth <= 0) {
    _dragDepth = 0;
    var ov = $('#dropOverlay'); if (ov) ov.classList.remove('show');
  }
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  _dragDepth = 0;
  var ov = $('#dropOverlay'); if (ov) ov.classList.remove('show');
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) openFiles(e.dataTransfer.files);
});
$('#fileInput').addEventListener('change', (e) => { openFiles(e.target.files); e.target.value = ''; });

function openDialog(addToShelf) {
  pendingShelf = addToShelf;
  if (bridge) {
    bridge.pick_files().then(list => {
      (list || []).forEach(r => {
        if (r && r.ok) openFromBridge(r, pendingShelf);
        else if (r && r.error) toast('打开失败：' + r.error);
      });
      pendingShelf = false;
    });
  } else {
    $('#fileInput').click();
  }
}

function openFiles(files) {
  Array.from(files).forEach(f => {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    if (!['pdf', 'md', 'markdown', 'epub', 'docx', 'txt', 'html', 'htm'].includes(ext)) { toast(`不支持的格式：${f.name}`); return; }
    const rd = new FileReader();
    rd.onload = () => createTab(f.name, ext === 'markdown' ? 'md' : ext, rd.result, f.size, null, pendingShelf);
    if (ext === 'md' || ext === 'markdown' || ext === 'txt' || ext === 'html' || ext === 'htm') rd.readAsText(f, 'utf-8');
    else rd.readAsArrayBuffer(f);
  });
  pendingShelf = false;
}

function createTab(name, ext, data, size, path, addToShelf) {
  const t = { id: ++tabSeq, name, ext, size, path: path || null, data, root: document.createElement('div'), scroll: 0, dirty: false };
  t.root.style.cssText = 'min-height:100%;';
  viewer.appendChild(t.root);
  tabs.push(t);
  addHistory({ name, ext, size, path: path || null, time: Date.now(), fav: !!addToShelf });
  switchTab(t.id);
  if (ext === 'pdf') renderPDF(t);
  else if (ext === 'epub') renderEPUB(t);
  else if (ext === 'docx') renderDOCX(t);
  else if (ext === 'html' || ext === 'htm') renderHTML(t);
  else renderTextual(t); // md / txt
  renderTabs();
}

/* ================= 文本文档 (MD / TXT) ================= */
function renderTextual(t) {
  const saved = store.get(docKey(t), null);
  const page = document.createElement('div');
  page.className = 'doc-page';
  page.style.position = 'relative';
  if (t.ext === 'md') {
    t.mdSource = saved && saved.mdSource ? saved.mdSource : t.data;
    page.innerHTML = saved && saved.html ? saved.html : marked.parse(t.mdSource);
    t.info = 'Markdown';
  } else {
    page.innerHTML = esc(t.data).split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
    t.info = 'TXT';
  }
  t.page = page;
  t.root.appendChild(page);
  t.kind = 'html';
  setupHtmlAnnoLayer(t);
  restoreHtmlExtras(t, saved);
  $('#docInfo').textContent = t.info;
  updateToolbar();
  restoreProgress(t);
}

/* ================= HTML 文件 ================= */
function renderHTML(t) {
  t.kind = 'html';
  const saved = store.get(docKey(t), null);
  const page = document.createElement('div');
  page.className = 'doc-page';
  page.style.position = 'relative';
  page.innerHTML = saved && saved.html ? saved.html : t.data;
  t.page = page;
  t.root.appendChild(page);
  t.info = 'HTML';
  setupHtmlAnnoLayer(t);
  restoreHtmlExtras(t, saved);
  $('#docInfo').textContent = t.info;
  updateToolbar();
  restoreProgress(t);
}

/* ================= Word (docx) ================= */
function renderDOCX(t) {
  t.kind = 'html';
  t.root.innerHTML = '<div style="padding:40px;text-align:center;color:var(--muted)">正在解析 Word 文档…</div>';
  mammoth.convertToHtml({ arrayBuffer: t.data })
    .then(res => {
      const saved = store.get(docKey(t), null);
      const page = document.createElement('div');
      page.className = 'doc-page'; page.style.position = 'relative';
      page.innerHTML = saved && saved.html ? saved.html : res.value;
      t.page = page;
      t.root.innerHTML = ''; t.root.appendChild(page);
      t.info = 'Word';
      setupHtmlAnnoLayer(t);
      restoreHtmlExtras(t, saved);
      updateToolbar();
      $('#docInfo').textContent = t.info;
      restoreProgress(t);
    })
    .catch(() => { t.root.innerHTML = '<div style="padding:40px;text-align:center">Word 解析失败</div>'; });
}

function persistHtmlDoc(t) {
  if (t.kind !== 'html' || !t.page) return;
  clearSearchMarks();
  const clone = t.page.cloneNode(true);
  const cvs = clone.querySelector('canvas.draw-canvas'); if (cvs) cvs.remove();
  const payload = { html: clone.innerHTML, draw: t.drawCanvas && t.drawCanvas.width ? t.drawCanvas.toDataURL() : null };
  if (t.ext === 'md') payload.mdSource = t.mdSource;
  store.set(docKey(t), payload);
}
function restoreHtmlExtras(t, saved) {
  if (saved && saved.draw && t.drawCanvas) {
    const img = new Image();
    img.onload = () => { sizeDrawCanvas(t); t.drawCanvas.getContext('2d').drawImage(img, 0, 0); };
    img.src = saved.draw;
  }
}

/* ================= PDF ================= */
try { if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = './_shared/js/pdf.worker.min.js'; } catch (e) {}
async function renderPDF(t) {
  t.kind = 'pdf';
  try {
    const pdf = await pdfjsLib.getDocument({ data: t.data }).promise;
    t.pdf = pdf;
    t.info = `PDF · ${pdf.numPages} 页`;
    $('#docInfo').textContent = t.info;
    const width = Math.min(viewer.clientWidth - 48, 900);
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const vp0 = page.getViewport({ scale: 1 });
      const scale = width / vp0.width;
      const vp = page.getViewport({ scale });
      const wrap = document.createElement('div');
      wrap.className = 'pdf-page'; wrap.dataset.page = i;
      wrap.style.setProperty('--scale-factor', scale);
      const cv = document.createElement('canvas');
      cv.width = vp.width; cv.height = vp.height;
      wrap.appendChild(cv);
      const tl = document.createElement('div'); tl.className = 'textLayer';
      wrap.appendChild(tl);
      const al = document.createElement('div'); al.className = 'pdf-anno-layer';
      wrap.appendChild(al);
      const dc = document.createElement('canvas'); dc.className = 'draw-canvas';
      dc.width = vp.width; dc.height = vp.height;
      wrap.appendChild(dc);
      t.root.appendChild(wrap);
      await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
      const tc = await page.getTextContent();
      pdfjsLib.renderTextLayer({ textContent: tc, container: tl, viewport: vp, textDivs: [] });
    }
    if ($('#tocPanel').classList.contains('open')) buildToc(t);
    restoreProgress(t);
  } catch (e) {
    t.root.innerHTML = '<div style="padding:40px;text-align:center">PDF 加载失败</div>';
  }
}

/* 给 PDF 选中区域添加批注矩形 */
function annotatePdfSelection(type) {
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const tl = (node.nodeType === 1 ? node : node.parentElement).closest('.textLayer');
  if (!tl) return false;
  const wrap = tl.parentElement;
  const wrect = wrap.getBoundingClientRect();
  const layer = wrap.querySelector('.pdf-anno-layer');
  Array.from(range.getClientRects()).forEach(r => {
    if (r.width < 2 || r.height < 2) return;
    const d = document.createElement('div');
    d.className = 'pdf-anno-rect ' + (type === 'ul' ? 'ul' : 'hl' + (hlColor !== 'yellow' ? ' ' + hlColor : ''));
    d.style.left = (r.left - wrect.left) + 'px';
    d.style.top = (r.top - wrect.top) + 'px';
    d.style.width = r.width + 'px';
    d.style.height = r.height + 'px';
    d.title = '批注（删除模式下点击可移除）';
    layer.appendChild(d);
  });
  sel.removeAllRanges();
  return true;
}

/* ================= EPUB ================= */
function renderEPUB(t) {
  t.kind = 'epub';
  const box = document.createElement('div');
  box.id = 'epubContainer_' + t.id; box.style.cssText = 'height:100%;display:flex;flex-direction:column;';
  const view = document.createElement('div'); view.style.cssText = 'flex:1;min-height:0;overflow:hidden;';
  const nav = document.createElement('div'); nav.className = 'epub-nav';
  nav.innerHTML = '<button data-a="prev">‹ 上一章</button><span class="loc"></span><button data-a="next">下一章 ›</button>';
  box.appendChild(view); box.appendChild(nav);
  t.root.style.height = '100%';
  t.root.appendChild(box);

  t.book = ePub(t.data);
  // 使用 scrolled-doc 模式：对中文 EPUB 兼容性更好，避免分页计算导致的上部空白和底部截断
  t.rendition = t.book.renderTo(view, { width: '100%', height: '100%', flow: 'scrolled-doc', spread: 'none', allowScriptedContent: true });
  applyEpubTheme(t);
  const savedProg = store.get(progressKey(t), null);
  const startCfi = savedProg && savedProg.cfi ? savedProg.cfi : undefined;
  t.rendition.display(startCfi);
  t.info = 'EPUB';
  $('#docInfo').textContent = t.info;
  nav.querySelector('[data-a=prev]').addEventListener('click', () => t.rendition.prev());
  nav.querySelector('[data-a=next]').addEventListener('click', () => t.rendition.next());
  t.rendition.on('relocated', (loc) => {
    const pct = loc && loc.start && loc.start.percentage != null ? Math.round(loc.start.percentage * 100) : null;
    nav.querySelector('.loc').textContent = pct != null ? `进度 ${pct}%` : '';
    if (loc && loc.start && loc.start.cfi) t._lastCfi = loc.start.cfi;
  });
  // 恢复批注
  (store.get('mdr_epub_' + t.name + '_' + t.size, []) || []).forEach(a => addEpubAnno(t, a, false));
  // EPUB 内选中文本
  t.rendition.on('selected', (cfiRange, contents) => {
    const text = t.rendition.getRange(cfiRange).toString();
    if (!text.trim()) return;
    const rect = contents.window.getSelection().getRangeAt(0).getBoundingClientRect();
    const ifr = view.querySelector('iframe').getBoundingClientRect();
    showSelBubble(ifr.left + rect.left + rect.width / 2, ifr.top + rect.top, text, { epub: t, cfiRange });
  });
  // 目录加载完成后刷新目录面板
  t.book.loaded.navigation.then(() => {
    if ($('#tocPanel').classList.contains('open') && activeTab() === t) buildToc(t);
  }).catch(() => {});
}
function addEpubAnno(t, a, save = true) {
  try {
    if (a.type === 'ul') t.rendition.annotations.add('underline', a.cfi, { note: a.note || '' }, null, null, { 'stroke': '#e05e5e', 'stroke-width': '2' });
    else t.rendition.annotations.add('highlight', a.cfi, { note: a.note || '' }, (e) => {
      if (annoMode === 'eraser') { t.rendition.annotations.remove(a.cfi, 'highlight'); removeEpubAnnoRecord(t, a.cfi); }
    }, null, { 'fill': a.color === 'yellow' ? '#ffd640' : a.color, 'fill-opacity': '0.45', 'mix-blend-mode': 'multiply' });
  } catch (e) {}
  if (save) {
    const list = store.get('mdr_epub_' + t.name + '_' + t.size, []);
    list.push(a); store.set('mdr_epub_' + t.name + '_' + t.size, list);
  }
}
function removeEpubAnnoRecord(t, cfi) {
  const k = 'mdr_epub_' + t.name + '_' + t.size;
  store.set(k, (store.get(k, []) || []).filter(x => x.cfi !== cfi));
}

/* ================= HTML 文档批注 ================= */
function wrapSelection(cls) {
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return false;
  const t = activeTab();
  if (!t || t.kind !== 'html') return false;
  const range = sel.getRangeAt(0);
  if (!t.page.contains(range.commonAncestorContainer)) return false;
  const walker = document.createTreeWalker(t.page, NodeFilter.SHOW_TEXT, {
    acceptNode(n) { return range.intersectsNode(n) && n.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT; }
  });
  const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(n => {
    if (n.parentElement && n.parentElement.closest('.' + cls.split(' ')[0])) return;
    const r = document.createRange();
    r.setStart(n, n === range.startContainer ? range.startOffset : 0);
    r.setEnd(n, n === range.endContainer ? range.endOffset : n.length);
    if (r.collapsed) return;
    const span = document.createElement('span');
    span.className = cls;
    try { r.surroundContents(span); } catch (e) {}
  });
  sel.removeAllRanges();
  persistHtmlDoc(t);
  return true;
}

function unwrapSpan(span) {
  const p = span.parentNode;
  while (span.firstChild) p.insertBefore(span.firstChild, span);
  p.removeChild(span);
  p.normalize();
}

function setupHtmlAnnoLayer(t) {
  // 编辑脏标记
  t.page.addEventListener('input', () => { if (editing) t.dirty = true; });
  // 涂画画布（覆盖整个文档页）
  const dc = document.createElement('canvas');
  dc.className = 'draw-canvas';
  dc.style.zIndex = 5;
  dc.style.pointerEvents = 'none'; // 确保非激活时不拦截点击
  t.page.appendChild(dc);
  t.drawCanvas = dc;
  requestAnimationFrame(() => sizeDrawCanvas(t));
  // 画布尺寸随内容变化
  if (window.ResizeObserver) {
    t._ro = new ResizeObserver(() => { if (!t._drawing) sizeDrawCanvas(t); });
    t._ro.observe(t.page);
  }
  // 点击：文字批注 / 删除
  t.page.addEventListener('click', (e) => {
    if (annoMode === 'eraser') {
      const m = e.target.closest('.anno-hl, .anno-ul, .anno-note-mark');
      if (m) { m.classList.contains('anno-note-mark') ? m.remove() : unwrapSpan(m); persistHtmlDoc(t); toast('已删除批注'); }
      else if (t.drawCanvas && t.drawCanvas.width) {
        // 清除涂画画布
        t.drawCanvas.getContext('2d').clearRect(0, 0, t.drawCanvas.width, t.drawCanvas.height);
        persistHtmlDoc(t);
        toast('已清除涂画');
      }
      return;
    }
    if (annoMode === 'note') {
      const range = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
      pendingNote = { kind: 'html', tab: t, range };
      $('#noteText').value = '';
      $('#noteMask').classList.add('open');
      return;
    }
    const mark = e.target.closest('.anno-note-mark');
    if (mark) showTransCard('💬 批注', mark.dataset.note || '', e.clientX, e.clientY);
  });
}
function sizeDrawCanvas(t) {
  const dc = t.drawCanvas; if (!dc) return;
  const w = t.page.scrollWidth, h = t.page.scrollHeight;
  if (dc.width !== w || dc.height !== h) {
    let img = null;
    if (dc.width && dc.height) { img = document.createElement('canvas'); img.width = dc.width; img.height = dc.height; img.getContext('2d').drawImage(dc, 0, 0); }
    dc.width = w; dc.height = h;
    if (img) dc.getContext('2d').drawImage(img, 0, 0);
  }
  dc.style.width = w + 'px'; dc.style.height = h + 'px';
}

/* 涂画逻辑（PDF 页画布 + HTML 文档画布通用） */
let drawing = null;
viewer.addEventListener('pointerdown', (e) => {
  if (annoMode !== 'draw') return;
  const cv = e.target.closest ? e.target.closest('canvas.draw-canvas') : null;
  if (!cv || !cv.classList.contains('active')) return;
  const t = activeTab(); if (t) t._drawing = true;
  const ctx = cv.getContext('2d');
  const r = cv.getBoundingClientRect();
  drawing = { cv, ctx, x: e.clientX - r.left, y: e.clientY - r.top };
  ctx.strokeStyle = '#e05555'; ctx.lineWidth = 3; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(drawing.x, drawing.y);
  e.preventDefault();
});
window.addEventListener('pointermove', (e) => {
  if (!drawing) return;
  const r = drawing.cv.getBoundingClientRect();
  drawing.ctx.lineTo(e.clientX - r.left, e.clientY - r.top);
  drawing.ctx.stroke();
});
window.addEventListener('pointerup', () => {
  if (!drawing) return;
  drawing = null;
  const t = activeTab();
  if (t) { t._drawing = false; if (t.kind === 'html') persistHtmlDoc(t); }
});

/* 文字批注确认 */
let pendingNote = null;
$('#noteOk').addEventListener('click', () => {
  const text = $('#noteText').value.trim();
  $('#noteMask').classList.remove('open');
  if (!text || !pendingNote) return;
  const t = activeTab();
  if (pendingNote.kind === 'html' && pendingNote.range) {
    const mark = document.createElement('span');
    mark.className = 'anno-note-mark'; mark.textContent = '💬'; mark.dataset.note = text;
    try { pendingNote.range.insertNode(mark); } catch (e) { t.page.appendChild(mark); }
    persistHtmlDoc(t);
  } else if (pendingNote.kind === 'pdf') {
    const d = document.createElement('div');
    d.className = 'pdf-anno-rect'; d.textContent = '💬';
    d.style.cssText = `left:${pendingNote.x}px;top:${pendingNote.y}px;font-size:16px;cursor:pointer;`;
    d.dataset.note = text;
    d.addEventListener('click', (ev) => {
      if (annoMode === 'eraser') { d.remove(); return; }
      showTransCard('💬 批注', text, ev.clientX, ev.clientY);
    });
    pendingNote.layer.appendChild(d);
  } else if (pendingNote.kind === 'epub') {
    addEpubAnno(t, { type: 'hl', cfi: pendingNote.cfi, note: text, color: '#e0a13e' });
  }
  pendingNote = null;
  toast('批注已添加');
});
$('#noteCancel').addEventListener('click', () => { $('#noteMask').classList.remove('open'); pendingNote = null; });

/* ================= 工具栏 ================= */
$$('#annoTools .tbtn').forEach(b => b.addEventListener('click', () => {
  const mode = b.dataset.anno;
  const t = activeTab();
  if (!t) { toast('请先打开一个文档'); return; }
  if (mode === 'hl' || mode === 'ul') {
    // 直接作用于当前选区
    let ok = false;
    if (t.kind === 'html') ok = wrapSelection(mode === 'hl' ? 'anno-hl' + (hlColor !== 'yellow' ? ' ' + hlColor : '') : 'anno-ul');
    else if (t.kind === 'pdf') ok = annotatePdfSelection(mode);
    else if (t.kind === 'epub') { toast('请在 EPUB 中选中文字后使用气泡菜单'); return; }
    if (!ok) { toast('请先选中要批注的文字'); annoMode = annoMode === mode ? null : mode; }
    else annoMode = null;
  } else if (mode === 'draw') {
    if (t.kind === 'epub') { toast('EPUB 暂不支持涂画'); return; }
    annoMode = annoMode === 'draw' ? null : 'draw';
  } else if (mode === 'note') {
    if (t.kind === 'epub') { toast('请在 EPUB 中选中文字后使用气泡菜单'); return; }
    annoMode = annoMode === 'note' ? null : 'note';
    if (annoMode) toast('点击文档任意位置插入文字批注');
  } else if (mode === 'eraser') {
    annoMode = annoMode === 'eraser' ? null : 'eraser';
    if (annoMode) toast('删除模式：点击批注或涂画区域可移除');
  }
  updateToolbar();
}));

function updateToolbar() {
  const t = activeTab();
  $$('#annoTools .tbtn').forEach(b => b.classList.toggle('on', b.dataset.anno === annoMode));
  // 涂画画布开关
  tabs.forEach(x => {
    const isDraw = x === t && annoMode === 'draw';
    if (x.kind === 'pdf') x.root.querySelectorAll('.draw-canvas').forEach(c => { c.classList.toggle('active', isDraw); c.style.pointerEvents = isDraw ? 'auto' : 'none'; });
    if (x.kind === 'html' && x.drawCanvas) { x.drawCanvas.classList.toggle('active', isDraw); x.drawCanvas.style.pointerEvents = isDraw ? 'auto' : 'none'; }
  });
  viewer.style.cursor = annoMode === 'draw' ? 'crosshair' : (annoMode === 'note' || annoMode === 'eraser') ? 'pointer' : '';
  const canEdit = t && (t.ext === 'md' || t.ext === 'docx');
  $('#editToggle').classList.toggle('on', editing);
  $('#editToggle').style.display = canEdit ? '' : 'none';
  $('#mdSourceBtn').classList.toggle('hidden', !(t && t.ext === 'md'));
  $$('.ed').forEach(el => el.classList.toggle('hidden', !(canEdit && editing)));
}

/* 捕获阶段：优先处理批注标记点击，确保弹窗可靠显示 */
viewer.addEventListener('click', (e) => {
  // 非擦除模式下，点击批注标记 → 显示批注内容
  if (annoMode !== 'eraser') {
    const mark = e.target.closest && e.target.closest('.anno-note-mark');
    if (mark) {
      e.stopPropagation();
      const note = mark.dataset.note || mark.getAttribute('data-note') || '(无批注内容)';
      showTransCard('💬 批注内容', note, e.clientX, e.clientY);
      return;
    }
    // PDF 批注矩形（非擦除模式下点击查看）
    const rect = e.target.closest && e.target.closest('.pdf-anno-rect');
    if (rect && rect.dataset && rect.dataset.note) {
      e.stopPropagation();
      showTransCard('💬 批注内容', rect.dataset.note, e.clientX, e.clientY);
      return;
    }
  }
}, true);

/* PDF 页面点击：文字批注 + 通用批注查看 */
viewer.addEventListener('click', (e) => {
  const t = activeTab();
  if (!t) return;
  if (annoMode === 'eraser') {
    const m = e.target.closest('.pdf-anno-rect');
    if (m) { m.remove(); toast('已删除批注'); }
    else {
      // 检查并清除当前页涂画
      const wrap = e.target.closest('.pdf-page');
      const dc = wrap && wrap.querySelector('canvas.draw-canvas');
      if (dc && dc.width) {
        dc.getContext('2d').clearRect(0, 0, dc.width, dc.height);
        toast('已清除涂画');
      }
    }
    return;
  }
  if (annoMode === 'note') {
    const wrap = e.target.closest('.pdf-page');
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    pendingNote = { kind: 'pdf', x: e.clientX - r.left, y: e.clientY - r.top, layer: wrap.querySelector('.pdf-anno-layer') };
    $('#noteText').value = '';
    $('#noteMask').classList.add('open');
  }
});

/* ================= 编辑模式 (MD / DOCX) ================= */
$('#editToggle').addEventListener('click', () => {
  const t = activeTab();
  if (!t || !(t.ext === 'md' || t.ext === 'docx')) { toast('仅 Word / Markdown 文档支持编辑'); return; }
  editing ? exitEditMode() : enterEditMode();
});
function enterEditMode() {
  const t = activeTab(); if (!t || !t.page) return;
  editing = true;
  t.page.contentEditable = 'true';
  t.page.focus();
  toast('编辑模式已开启');
  updateToolbar();
}
function exitEditMode() {
  const t = activeTab();
  if (t && t.page) t.page.contentEditable = 'false';
  if (editing && t) persistHtmlDoc(t);
  editing = false;
  updateToolbar();
}
$('#edBold').addEventListener('click', () => { document.execCommand('bold'); });
$('#edFontSize').addEventListener('change', (e) => {
  const size = e.target.value; if (!size) return;
  applySpanStyle({ fontSize: size });
  e.target.value = '';
});
function applySpanStyle(styleObj) {
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) { toast('请先选中文字'); return; }
  const t = activeTab(); if (!t || !t.page) return;
  const range = sel.getRangeAt(0);
  const walker = document.createTreeWalker(t.page, NodeFilter.SHOW_TEXT, {
    acceptNode(n) { return range.intersectsNode(n) && n.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT; }
  });
  const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(n => {
    const r = document.createRange();
    r.setStart(n, n === range.startContainer ? range.startOffset : 0);
    r.setEnd(n, n === range.endContainer ? range.endOffset : n.length);
    if (r.collapsed) return;
    const span = document.createElement('span');
    Object.assign(span.style, styleObj);
    try { r.surroundContents(span); } catch (e) {}
  });
  sel.removeAllRanges();
}
$('#edSave').addEventListener('click', () => {
  const t = activeTab(); if (!t) return;
  persistHtmlDoc(t);
  if (!t.dirty) { toast('已保存到应用内'); return; }
  promptSave(t, () => {});
});

/* Markdown 源码编辑 */
let mdSourceMode = false;
$('#mdSourceBtn').addEventListener('click', () => {
  const t = activeTab();
  if (!t || t.ext !== 'md') return;
  if (!mdSourceMode) {
    exitEditMode();
    const ta = document.createElement('textarea');
    ta.className = 'doc-page'; ta.id = 'mdSourceArea';
    ta.style.cssText += ';width:100%;min-height:80vh;border:none;background:var(--bg);color:var(--ink);resize:vertical;outline:none;font-family:Consolas,monospace;font-size:14px;line-height:1.7;';
    ta.value = t.mdSource;
    ta.addEventListener('input', () => { t.dirty = true; });
    t.page.style.display = 'none';
    t.root.appendChild(ta);
    mdSourceMode = true;
    $('#mdSourceBtn').classList.add('on');
  } else {
    const ta = $('#mdSourceArea');
    t.mdSource = ta.value;
    ta.remove();
    t.page.innerHTML = marked.parse(t.mdSource);
    t.page.style.display = '';
    t.page.appendChild(t.drawCanvas);
    requestAnimationFrame(() => sizeDrawCanvas(t));
    mdSourceMode = false;
    $('#mdSourceBtn').classList.remove('on');
    persistHtmlDoc(t);
  }
});

/* ================= 划词气泡 ================= */
const bubble = $('#selBubble');
let bubbleCtx = null;
function showSelBubble(x, y, text, ctx = {}) {
  bubbleCtx = Object.assign({ text }, ctx);
  bubble.style.display = 'flex';
  const bw = 280;
  bubble.style.left = Math.max(8, Math.min(window.innerWidth - bw - 8, x - bw / 2)) + 'px';
  bubble.style.top = Math.max(50, y - 46) + 'px';
}
function hideSelBubble() { bubble.style.display = 'none'; }

viewer.addEventListener('mouseup', (e) => {
  setTimeout(() => {
    const t = activeTab();
    if (!t || t.kind === 'epub') return;
    if (annoMode === 'draw' || annoMode === 'note') return;
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return;
    const text = sel.toString().trim();
    if (!text) return;
    const range = sel.getRangeAt(0);
    const container = t.kind === 'pdf' ? t.root : t.page;
    if (!container || !container.contains(range.commonAncestorContainer)) return;
    const r = range.getBoundingClientRect();
    // 高亮/划线持续模式：选中即应用
    if (annoMode === 'hl' || annoMode === 'ul') {
      bubbleCtx = { text };
      applyAnnoToSelection(annoMode);
      bubbleCtx = null;
      return;
    }
    showSelBubble(r.left + r.width / 2, r.top, text);
  }, 10);
});
document.addEventListener('mousedown', (e) => {
  if (!bubble.contains(e.target)) hideSelBubble();
  if (!$('#transCard').contains(e.target) && !e.target.closest('.anno-note-mark') && !e.target.closest('.pdf-anno-rect')) $('#transCard').style.display = 'none';
});

function applyAnnoToSelection(act) {
  const t = activeTab();
  if (!t || !bubbleCtx) return false;
  if (bubbleCtx.epub) {
    addEpubAnno(bubbleCtx.epub, { type: act, cfi: bubbleCtx.cfiRange, color: '#ffd640' });
    clearEpubSelection(bubbleCtx.epub);
    return true;
  }
  if (t.kind === 'pdf') return annotatePdfSelection(act);
  return wrapSelection(act === 'hl' ? 'anno-hl' + (hlColor !== 'yellow' ? ' ' + hlColor : '') : 'anno-ul');
}

bubble.addEventListener('click', (e) => {
  const btn = e.target.closest('button'); if (!btn || !bubbleCtx) return;
  const act = btn.dataset.act;
  const t = activeTab();
  const text = bubbleCtx.text;
  hideSelBubble();
  if (act === 'copy') { navigator.clipboard.writeText(text).then(() => toast('已复制')); return; }
  if (act === 'hl' || act === 'ul') {
    applyAnnoToSelection(act);
    return;
  }
  if (act === 'translate') { translateText(text); return; }
  if (act === 'ask') {
    if (bubbleCtx.epub) clearEpubSelection(bubbleCtx.epub);
    openAiPanel();
    askAI(`请解释以下内容：`, text);
  }
});
function clearEpubSelection(t) {
  try { t.rendition.getContents().forEach(c => c.window.getSelection().removeAllRanges()); } catch (e) {}
}

/* ================= 翻译卡片 ================= */
function showTransCard(title, content, x, y) {
  $('#tcSrc').textContent = title;
  $('#tcResult').textContent = content;
  const card = $('#transCard');
  card.style.display = 'block';
  card.style.left = Math.max(8, Math.min(window.innerWidth - 440, x - 160)) + 'px';
  card.style.top = Math.min(window.innerHeight - 200, y + 12) + 'px';
}
$('#tcClose').addEventListener('click', () => { $('#transCard').style.display = 'none'; });

/* ================= AI 功能 ================= */
function openAiPanel() { $('#aiPanel').classList.add('open'); $('#aiResizer').classList.add('open'); $('#aiPanelBtn').classList.add('on'); }
$('#aiPanelBtn').addEventListener('click', () => {
  $('#aiPanel').classList.toggle('open');
  const open = $('#aiPanel').classList.contains('open');
  $('#aiPanelBtn').classList.toggle('on', open);
  $('#aiResizer').classList.toggle('open', open);
});

/* AI 面板宽度拖拽 */
(function () {
  const rz = $('#aiResizer'), panel = $('#aiPanel');
  rz.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    rz.classList.add('drag');
    const move = (ev) => {
      const w = Math.max(240, Math.min(680, window.innerWidth - ev.clientX));
      panel.style.width = w + 'px';
    };
    const up = () => {
      rz.classList.remove('drag');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
})();

async function callAI(messages) {
  if (!aiCfg.base || !aiCfg.key || !aiCfg.model) {
    toast('请先在「AI 设置」中配置接口'); $('#aiCfgMask').classList.add('open');
    throw new Error('AI 未配置');
  }
  // 优先使用代理地址（网页版绕过 CORS），否则直接用 base
  const host = (aiCfg.proxy && aiCfg.proxy.trim()) ? aiCfg.proxy.trim() : aiCfg.base;
  const endpoint = host.replace(/\/+$/, '') + '/chat/completions';
  // 失败自动重试一次（网络抖动/限流保护）
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 600));
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + aiCfg.key },
        body: JSON.stringify({ model: aiCfg.model, messages, temperature: 0.3 })
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        // 429 限流 / 5xx 服务端错误时重试；4xx 业务错误不重试
        if ((res.status === 429 || res.status >= 500) && attempt === 0) { lastErr = new Error('接口错误 ' + res.status + '：' + txt.slice(0, 150)); continue; }
        throw new Error('接口错误 ' + res.status + '：' + txt.slice(0, 200));
      }
      let data;
      try { data = await res.json(); }
      catch (e) { throw new Error('返回内容解析失败（可能被代理/WAF 拦截）：' + e.message); }
      return data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '(无返回内容)';
    } catch (e) {
      lastErr = e;
      // 网络错误/CORS（TypeError: Failed to fetch）→ 重试一次
      if (e instanceof TypeError && attempt === 0) continue;
      if (/Failed to fetch/i.test(e.message || '') && attempt === 0) continue;
      break;
    }
  }
  throw lastErr instanceof TypeError
    ? new Error('网络/跨域错误（Failed to fetch）。网页版请到「AI 设置」填写 CORS 代理地址，或使用本地 EXE 版')
    : (lastErr || new Error('AI 请求失败'));
}

async function translateText(text) {
  const card = $('#transCard');
  showTransCard('原文：' + (text.length > 80 ? text.slice(0, 80) + '…' : text), '翻译中…', window.innerWidth / 2, window.innerHeight / 3);
  try {
    const out = await callAI([
      { role: 'system', content: `你是专业翻译。请将用户给出的内容翻译为${aiCfg.lang}，只输出译文，保持原意与格式。` },
      { role: 'user', content: text }
    ]);
    $('#tcResult').textContent = out;
  } catch (e) { $('#tcResult').textContent = '翻译失败：' + e.message; }
}

/* 翻译整页：获取当前可视页内容，分段翻译 → AI 面板 */
function getCurrentPageText(t) {
  if (t.kind === 'html' && t.page) {
    const vr = viewer.getBoundingClientRect();
    let blocks = Array.from(t.page.querySelectorAll('h1,h2,h3,h4,h5,p,li,pre,blockquote,td,th,caption'))
      .filter(el => {
        const r = el.getBoundingClientRect();
        return r.height > 0 && r.bottom > vr.top && r.top < vr.bottom;
      });
    // 去掉被其他块包含的嵌套块，避免文本重复
    blocks = blocks.filter(el => !blocks.some(o => o !== el && o.contains(el)));
    let txt = blocks.map(el => (el.innerText || el.textContent || '').trim()).filter(Boolean).join('\n');
    if (!txt.trim()) txt = t.page.innerText || t.page.textContent || ''; // 回退：整篇
    return txt;
  }
  if (t.kind === 'pdf') {
    const vr = viewer.getBoundingClientRect();
    const mid = vr.top + vr.height / 2;
    let best = null;
    t.root.querySelectorAll('.pdf-page').forEach(p => {
      const r = p.getBoundingClientRect();
      if (r.top <= mid && r.bottom >= mid) best = p;
    });
    if (!best) best = t.root.querySelector('.pdf-page');
    const tl = best && best.querySelector('.textLayer');
    return tl ? (tl.innerText || tl.textContent || '') : '';
  }
  if (t.kind === 'epub') {
    try {
      const c = t.rendition.getContents()[0];
      const body = c && c.document && c.document.body;
      return body ? (body.innerText || body.textContent || '') : '';
    } catch (e) { return ''; }
  }
  return '';
}

function splitSegments(text, maxLen = 1200) {
  const paras = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const segs = []; let cur = '';
  paras.forEach(p => {
    if (cur && (cur + '\n' + p).length > maxLen) { segs.push(cur); cur = p; }
    else cur = cur ? cur + '\n' + p : p;
  });
  if (cur) segs.push(cur);
  // 拆分超长单段
  const out = [];
  segs.forEach(s => {
    if (s.length <= maxLen) { out.push(s); return; }
    for (let i = 0; i < s.length; i += maxLen) out.push(s.slice(i, i + maxLen));
  });
  return out;
}

$('#transDocBtn').addEventListener('click', () => translateCurrentPage('panel'));

async function translateCurrentPage(mode) {
  const t = activeTab();
  if (!t) { toast('请先打开文档'); return; }
  if (mode === 'restore') { restoreOriginalText(t); return; }
  if (mode !== 'panel') {
    if (t.kind === 'pdf') toast('PDF 为画布渲染，暂不支持原位翻译，已改为输出到 AI 面板');
    else { translateBlocksInPlace(t, mode); return; }
  }
  const text = getCurrentPageText(t).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) { toast('未获取到当前页文本内容'); return; }
  const segs = splitSegments(text);
  openAiPanel();
  addMsg('user', `🌐 翻译当前页（共 ${segs.length} 段）`, text.length > 300 ? text.slice(0, 300) + '…' : text);
  const body = addMsg('ai', segs.length > 1 ? `正在翻译第 1/${segs.length} 段…` : '翻译中…');
  let done = '';
  for (let i = 0; i < segs.length; i++) {
    try {
      const out = await callAI([
        { role: 'system', content: `你是专业翻译。请将用户给出的内容翻译为${aiCfg.lang}，只输出译文，保持原意与段落格式。` },
        { role: 'user', content: segs[i] }
      ]);
      done += (i ? '\n\n' : '') + out;
      body.textContent = done;
    } catch (e) {
      body.textContent = done + (done ? '\n\n' : '') + `【第 ${i + 1} 段翻译失败：${e.message}】`;
      break;
    }
    if (segs.length > 1 && i < segs.length - 1) body.textContent = done + `\n\n（正在翻译第 ${i + 2}/${segs.length} 段…）`;
    $('#aiMsgs').scrollTop = $('#aiMsgs').scrollHeight;
  }
}

/* AI 聊天 */
const chatHistory = [];
function addMsg(role, content, quote) {
  const d = document.createElement('div');
  d.className = 'aimsg ' + (role === 'user' ? 'user' : 'ai');
  if (quote) { const q = document.createElement('span'); q.className = 'quote'; q.textContent = quote.length > 120 ? quote.slice(0, 120) + '…' : quote; d.appendChild(q); }
  const body = document.createElement('span'); body.textContent = content; d.appendChild(body);
  $('#aiMsgs').appendChild(d);
  $('#aiMsgs').scrollTop = $('#aiMsgs').scrollHeight;
  return body;
}
async function askAI(prefix, quoteText) {
  const userContent = quoteText ? prefix + '\n' + quoteText : prefix;
  addMsg('user', prefix, quoteText);
  chatHistory.push({ role: 'user', content: userContent });
  const loading = addMsg('ai', '思考中'); loading.parentElement.classList.add('loading');
  try {
    const sys = { role: 'system', content: '你是阅读助手「墨读 AI」，帮助用户理解与分析文档内容。回答简洁准确，使用中文。' };
    const ctx = chatHistory.slice(-10);
    const out = await callAI([sys, ...ctx]);
    loading.parentElement.classList.remove('loading');
    loading.textContent = out;
    chatHistory.push({ role: 'assistant', content: out });
  } catch (e) {
    loading.parentElement.classList.remove('loading');
    loading.textContent = '请求失败：' + e.message;
  }
  $('#aiMsgs').scrollTop = $('#aiMsgs').scrollHeight;
}
$('#aiSend').addEventListener('click', sendChat);
$('#aiInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });
function sendChat() {
  const v = $('#aiInput').value.trim();
  if (!v) return;
  $('#aiInput').value = '';
  askAI(v, null);
}
$('#aiClear').addEventListener('click', () => { chatHistory.length = 0; $('#aiMsgs').innerHTML = ''; });

/* ================= AI 设置弹窗 ================= */
$('#aiCfgBtn').addEventListener('click', () => {
  $('#cfgBase').value = aiCfg.base; $('#cfgKey').value = aiCfg.key;
  $('#cfgModel').value = aiCfg.model; $('#cfgLang').value = aiCfg.lang;
  if ($('#cfgProxy')) $('#cfgProxy').value = aiCfg.proxy || '';
  $('#aiCfgMask').classList.add('open');
});
$('#cfgCancel').addEventListener('click', () => $('#aiCfgMask').classList.remove('open'));
$('#cfgSave').addEventListener('click', () => {
  aiCfg.base = $('#cfgBase').value.trim(); aiCfg.key = $('#cfgKey').value.trim();
  aiCfg.model = $('#cfgModel').value.trim(); aiCfg.lang = $('#cfgLang').value;
  aiCfg.proxy = $('#cfgProxy') ? $('#cfgProxy').value.trim() : '';
  store.set('mdr_ai', aiCfg);
  $('#aiCfgMask').classList.remove('open');
  toast('AI 设置已保存');
});
$('#cfgTest').addEventListener('click', async () => {
  aiCfg.base = $('#cfgBase').value.trim(); aiCfg.key = $('#cfgKey').value.trim(); aiCfg.model = $('#cfgModel').value.trim();
  try {
    const out = await callAI([{ role: 'user', content: '回复「连接成功」四个字即可' }]);
    toast('测试通过：' + out.slice(0, 30));
  } catch (e) { toast('测试失败：' + e.message, 4000); }
});

/* ================= 阅读设置 ================= */
$('#readSetBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#readSettings').classList.toggle('open'); });
document.addEventListener('click', (e) => {
  if (!$('#readSettings').contains(e.target) && e.target.id !== 'readSetBtn' && !e.target.closest('#readSetBtn')) $('#readSettings').classList.remove('open');
});
$$('#rsFonts .rs-opt').forEach(b => b.addEventListener('click', () => { settings.ff = b.dataset.ff; applySettings(); }));
$$('#rsThemes .rs-theme').forEach(b => b.addEventListener('click', () => { settings.theme = b.dataset.th; applySettings(); }));
if ($('#glassToggle')) $('#glassToggle').addEventListener('change', (e) => {
  settings.glass = e.target.checked;
  // 液态玻璃仅支持黑/白主题
  if (settings.glass && settings.theme !== 'white' && settings.theme !== 'dark') {
    settings.theme = 'white';
    toast('液态玻璃效果已切换到白色主题');
  }
  applySettings();
});
$('#rsFs').addEventListener('input', (e) => { settings.fs = +e.target.value; applySettings(); });
$('#rsLh').addEventListener('input', (e) => { settings.lh = +e.target.value; applySettings(); });
$('#rsFw').addEventListener('input', (e) => { settings.fw = +e.target.value; applySettings(); });

/* ================= 快捷键 ================= */
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === 'o') { e.preventDefault(); $('#fileInput').click(); }
  if (e.ctrlKey && e.key.toLowerCase() === 'f') { e.preventDefault(); toggleSearch(); }
  if (e.key === 'Escape') { annoMode = null; updateToolbar(); $('#readSettings').classList.remove('open'); hideSelBubble(); if ($('#searchBar') && $('#searchBar').classList.contains('open')) closeSearch(); }
});

/* ================= exe 桥接（pywebview） ================= */
let bridge = null;
let bridgeReady = false;
window.addEventListener('pywebviewready', () => {
  if (bridgeReady) return;
  bridgeReady = true;
  bridge = window.pywebview.api;
  onBridgeReady();
});
function b64ToBuf(b64) {
  const STEP = 8 * 1024 * 1024; // 可被 4 整除，保证 base64 分组完整
  const chunks = []; let len = 0;
  for (let i = 0; i < b64.length; i += STEP) {
    const part = atob(b64.slice(i, i + STEP));
    const u8 = new Uint8Array(part.length);
    for (let j = 0; j < part.length; j++) u8[j] = part.charCodeAt(j);
    chunks.push(u8); len += u8.length;
  }
  const out = new Uint8Array(len); let off = 0;
  chunks.forEach(c => { out.set(c, off); off += c.length; });
  return out.buffer;
}
function bufToB64(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function openFromBridge(rec, toShelf) {
  const ext = rec.ext === 'markdown' ? 'md' : rec.ext;
  if (!['pdf', 'md', 'epub', 'docx', 'txt', 'html', 'htm'].includes(ext)) { toast('不支持的格式：' + rec.name); return; }
  const buf = b64ToBuf(rec.data);
  const data = (ext === 'md' || ext === 'txt' || ext === 'html' || ext === 'htm') ? new TextDecoder('utf-8').decode(buf) : buf;
  createTab(rec.name, ext, data, rec.size, rec.path, toShelf);
}
function onBridgeReady() {
  // 初始化持久化存储（从 Python 加载已保存的设置）
  initPersist();
  // 双击关联文件启动
  bridge.get_startup_file().then(r => { if (r && r.ok) openFromBridge(r, false); }).catch(() => {});
}
let _popupsChecked = false;
function checkPopups() {
  if (_popupsChecked) return; // 防止重复调用（超时保护 + initPersist 可能同时触发）
  _popupsChecked = true;
  // 先弹 UP主介绍（只弹一次），关闭后再弹默认应用
  if (!store.get('mdr_about_shown', false)) {
    store.set('mdr_about_shown', true);
    $('#aboutMask').classList.add('open');
  } else {
    // 已看过 about，直接检查默认应用
    checkAssocPopup();
  }
}
function checkAssocPopup() {
  // 仅 exe 环境显示默认应用横幅（浏览器无此概念）
  // 横幅常驻主页，每次启动都显示
  if (!window.pywebview) return;
  if ($('#assocBanner')) $('#assocBanner').style.display = 'flex';
}
if ($('#assocCloseBtn')) {
  $('#assocCloseBtn').addEventListener('click', () => {
    // 仅当前会话隐藏，下次启动仍显示
    if ($('#assocBanner')) $('#assocBanner').style.display = 'none';
  });
}
if ($('#assocSetBtn')) {
  $('#assocSetBtn').addEventListener('click', () => {
    if (!bridge) { toast('应用尚未就绪，请稍后重试', 3000); return; }
    bridge.register_associations(['.pdf', '.epub', '.md', '.docx', '.txt', '.html', '.htm']).then(r => {
      toast(r.ok ? '已设为默认打开方式，双击文档即可用墨读打开' : '设置失败：' + (r.error || ''), 4000);
    });
  });
}

/* ================= 主页 / 历史 / 收藏 ================= */
const ICONS = { pdf: '📕', epub: '📚', md: '📝', docx: '📄', txt: '📃', html: '🌐' };
let homeVisible = true;
let histList = store.get('mdr_history', []);

function addHistory(e) {
  const key = e.path || (e.name + '_' + e.size);
  const ex = histList.find(h => (h.path || (h.name + '_' + h.size)) === key);
  if (ex) { ex.time = e.time; ex.fav = ex.fav || !!e.fav; if (e.path) ex.path = e.path; }
  else histList.unshift(e);
  histList = histList.slice(0, 60);
  store.set('mdr_history', histList);
}
function fmtTime(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function renderHome() {
  // 书架
  const shelf = histList.filter(h => h.fav);
  const sg = $('#shelfGrid'); sg.innerHTML = '';
  if (!shelf.length) sg.innerHTML = '<div class="home-empty">书架空空如也，点击「添加书籍到书架」或历史记录的 ☆ 收藏文档</div>';
  shelf.forEach(h => {
    const d = document.createElement('div');
    d.className = 'shelf-item';
    d.innerHTML = `<span class="sdel" title="移出书架">✕</span><div class="sic">${ICONS[h.ext] || '📄'}</div><div class="sname">${esc(h.name)}</div>`;
    d.title = h.name;
    d.addEventListener('click', (e) => { if (!e.target.classList.contains('sdel')) openHistoryItem(h); });
    d.querySelector('.sdel').addEventListener('click', () => { h.fav = false; store.set('mdr_history', histList); renderHome(); });
    sg.appendChild(d);
  });
  // 历史
  const hl = $('#historyList'); hl.innerHTML = '';
  if (!histList.length) hl.innerHTML = '<div class="home-empty">暂无历史记录</div>';
  histList.slice(0, 20).forEach(h => {
    const d = document.createElement('div');
    d.className = 'hist-item';
    d.title = h.path ? ('本地路径：' + h.path) : '无本地路径（需重新选择文件）';
    d.innerHTML = `<span class="hicon">${ICONS[h.ext] || '📄'}</span><span class="hname">${esc(h.name)}</span>${h.path ? '<span class="hlink" title="' + esc(h.path) + '">🔗</span>' : ''}<span class="htime">${fmtTime(h.time)}</span><button class="hfav${h.fav ? ' on' : ''}" title="收藏到书架">${h.fav ? '★' : '☆'}</button><button class="hdel" title="删除此记录">🗑</button>`;
    d.addEventListener('click', (e) => { if (!e.target.classList.contains('hfav') && !e.target.classList.contains('hdel')) openHistoryItem(h); });
    d.querySelector('.hfav').addEventListener('click', () => { h.fav = !h.fav; store.set('mdr_history', histList); renderHome(); });
    d.querySelector('.hdel').addEventListener('click', (e) => {
      e.stopPropagation();
      var key = h.path || (h.name + '_' + h.size);
      histList = histList.filter(x => (x.path || (x.name + '_' + x.size)) !== key);
      store.set('mdr_history', histList);
      renderHome();
      toast('已删除该记录');
    });
    hl.appendChild(d);
  });
}
/* 清空历史记录 */
if ($('#clearHistBtn')) $('#clearHistBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!histList.length) { toast('历史记录已为空'); return; }
  if (!confirm(`确定清空全部 ${histList.length} 条历史记录吗？（收藏的书架项目也会被移除）`)) return;
  histList = [];
  store.set('mdr_history', histList);
  renderHome();
  toast('历史记录已清空');
});
function openHistoryItem(h) {
  if (bridge && h.path) {
    toast('正在打开：' + h.name, 2000);
    bridge.read_file(h.path).then(r => {
      if (r && r.ok) openFromBridge(r, false);
      else { toast((r && r.error) || '文件不存在或已被移动', 3000); }
    });
  } else if (!bridge && h.path) {
    // 浏览器环境无法按路径读取本地文件
    toast('浏览器环境无法直接打开本地文件，请重新选择', 3000);
    pendingShelf = false;
    $('#fileInput').click();
  } else {
    toast('请重新选择该文件');
    pendingShelf = false;
    $('#fileInput').click();
  }
}
$('#homeBtn').addEventListener('click', () => {
  const t = activeTab();
  if (homeVisible && tabs.length) {
    homeVisible = false;
    if (t) { t.root.style.display = ''; viewer.scrollTop = t.scroll || 0; }
  } else {
    if (t) { exitEditMode(); t.scroll = viewer.scrollTop; saveProgress(t); t.root.style.display = 'none'; }
    closeSearch();
    homeVisible = true;
  }
  renderTabs();
});

/* ================= 目录 ================= */
$('#tocBtn').addEventListener('click', () => {
  const p = $('#tocPanel');
  p.classList.toggle('open');
  $('#tocBtn').classList.toggle('on', p.classList.contains('open'));
  if (p.classList.contains('open')) buildToc(activeTab());
});
function buildToc(t) {
  const box = $('#tocList');
  box.innerHTML = '';
  const empty = (msg) => { box.innerHTML = `<div class="toc-empty">${msg}</div>`; };
  if (!t) { empty('暂无文档'); return; }
  const addItem = (label, lv, onclick) => {
    const b = document.createElement('button');
    b.className = 'toc-item lv' + Math.min(lv, 4);
    b.textContent = label;
    b.title = label;
    b.addEventListener('click', onclick);
    box.appendChild(b);
  };
  if (t.kind === 'html') {
    if (!t.page) { empty('文档加载中…'); return; }
    const hs = t.page.querySelectorAll('h1,h2,h3,h4');
    if (!hs.length) { empty('本文档没有标题结构'); return; }
    hs.forEach(h => addItem(h.textContent.trim() || '(空标题)', +h.tagName[1], () => h.scrollIntoView({ behavior: 'smooth', block: 'start' })));
  } else if (t.kind === 'pdf') {
    if (!t.pdf) { empty('文档加载中…'); return; }
    empty('正在读取大纲…');
    t.pdf.getOutline().then(async (outline) => {
      if (activeTab() !== t || !$('#tocPanel').classList.contains('open')) return;
      box.innerHTML = '';
      if (!outline || !outline.length) { empty('此 PDF 没有书签大纲'); return; }
      const walk = async (items, lv) => {
        for (const it of items) {
          let page = null;
          if (it.dest) {
            try {
              const dest = typeof it.dest === 'string' ? await t.pdf.getDestination(it.dest) : it.dest;
              if (dest && dest[0]) page = (await t.pdf.getPageIndex(dest[0])) + 1;
            } catch (e) {}
          }
          addItem(it.title || '(未命名)', lv, () => {
            if (!page) return;
            const pg = t.root.querySelector('.pdf-page[data-page="' + page + '"]');
            if (pg) pg.scrollIntoView({ behavior: 'smooth', block: 'start' });
          });
          if (it.items && it.items.length) await walk(it.items, lv + 1);
        }
      };
      await walk(outline, 1);
    }).catch(() => empty('大纲读取失败'));
  } else if (t.kind === 'epub') {
    if (!t.book) { empty('文档加载中…'); return; }
    t.book.loaded.navigation.then(nav => {
      if (activeTab() !== t || !$('#tocPanel').classList.contains('open')) return;
      box.innerHTML = '';
      if (!nav.toc || !nav.toc.length) { empty('此 EPUB 没有目录'); return; }
      const walk = (items, lv) => items.forEach(it => {
        addItem((it.label || '').trim() || '(未命名)', lv, () => { try { t.rendition.display(it.href); } catch (e) {} });
        if (it.subitems && it.subitems.length) walk(it.subitems, lv + 1);
      });
      walk(nav.toc, 1);
    }).catch(() => empty('目录读取失败'));
  }
}

/* ================= 翻译模式（替换 / 双语对照） ================= */
if ($('#transModeBtn')) $('#transModeBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const m = $('#transMenu');
  const r = e.currentTarget.getBoundingClientRect();
  m.style.left = Math.min(r.left, window.innerWidth - 250) + 'px';
  m.style.top = (r.bottom + 6) + 'px';
  m.classList.toggle('open');
});
document.addEventListener('click', (e) => { const tm = $('#transMenu'); if (tm && !tm.contains(e.target)) tm.classList.remove('open'); });
$$('#transMenu button').forEach(b => b.addEventListener('click', () => {
  $('#transMenu').classList.remove('open');
  translateCurrentPage(b.dataset.mode);
}));

function getVisibleBlockEls(t) {
  let doc, rootEl;
  if (t.kind === 'html') { doc = document; rootEl = t.page; }
  else if (t.kind === 'epub') {
    try { const c = t.rendition.getContents()[0]; doc = c.document; rootEl = doc.body; } catch (e) { return []; }
  } else return [];
  // 扩大选择器范围，覆盖更多块级元素
  let blocks = Array.from(rootEl.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,div,td,th,dt,dd,figcaption'))
    .filter(el => {
      const txt = (el.innerText || el.textContent || '').trim();
      if (txt.length < 2) return false;
      // 排除画布等非文本元素
      if (el.classList && el.classList.contains('draw-canvas')) return false;
      return true;
    });
  // 去掉被其他块包含的嵌套块，避免文本重复
  blocks = blocks.filter(el => !blocks.some(o => o !== el && o.contains(el)));
  if (t.kind === 'html') {
    const vr = viewer.getBoundingClientRect();
    const vis = blocks.filter(el => { const r = el.getBoundingClientRect(); return r.height > 0 && r.bottom > vr.top && r.top < vr.bottom; });
    return vis.length ? vis : blocks.slice(0, 40);
  }
  return blocks;
}

async function translateBlocksInPlace(t, mode) {
  const blocks = getVisibleBlockEls(t);
  if (!blocks.length) {
    // 回退：尝试获取当前页文本，切换到 AI 面板模式
    const text = getCurrentPageText(t).trim();
    if (text) {
      toast('未找到可原位翻译的段落，已切换到 AI 面板输出');
      translateCurrentPage('panel');
    } else {
      toast('当前页没有可翻译的文本段落');
    }
    return;
  }
  toast(`开始翻译 ${blocks.length} 个段落，请稍候…`);
  let done = 0;
  for (let bi = 0; bi < blocks.length; bi++) {
    const el = blocks[bi];
    // 跳过已有的双语译文块
    if (el.classList && el.classList.contains('bilingual-tr')) continue;

    // 获取原文：优先用保存的原文，否则用当前文本
    let src;
    if (el.dataset.origText) {
      src = el.dataset.origText;
    } else {
      src = (el.innerText || el.textContent || '').trim();
    }
    if (src.length < 2) continue;
    // 过长段落截断，防止超过模型上下文限制
    if (src.length > 4000) src = src.slice(0, 4000);

    try {
      const out = await callAI([
        { role: 'system', content: `你是专业翻译。请将用户给出的内容翻译为${aiCfg.lang}，只输出译文，不要解释。` },
        { role: 'user', content: src }
      ]);
      const translated = out.trim();

      if (mode === 'replace') {
        // 替换模式：保存原文（仅第一次），替换为译文
        if (!el.dataset.origText) el.dataset.origText = src;
        el.textContent = translated;
        // 移除可能存在的双语译文块
        const next = el.nextElementSibling;
        if (next && next.classList && next.classList.contains('bilingual-tr')) next.remove();
      } else {
        // 双语对照模式
        // 关键：先保存原文（仅第一次），确保后续切换模式时能恢复
        if (!el.dataset.origText) el.dataset.origText = src;
        // 恢复原文到当前元素（无论之前是替换还是双语模式）
        el.textContent = el.dataset.origText;
        // 移除已有的双语译文块，避免重复
        const next = el.nextElementSibling;
        if (next && next.classList && next.classList.contains('bilingual-tr')) next.remove();
        // 创建译文块
        const doc = el.ownerDocument;
        const tr = doc.createElement('p');
        tr.textContent = translated;
        // 统一添加 bilingual-tr 类名（HTML 和 EPUB 都加），确保重复翻译时能正确跳过
        tr.className = 'bilingual-tr';
        if (doc !== document) {
          tr.setAttribute('style', 'opacity:.75;font-size:0.92em;border-left:3px solid #4f7cff;padding-left:10px;margin:2px 0 10px;');
        }
        el.parentNode.insertBefore(tr, el.nextSibling);
      }
      done++;
      // 段落间加小间隔，降低限流风险
      if (bi < blocks.length - 1) await new Promise(r => setTimeout(r, 120));
    } catch (e) {
      toast(`翻译中断（已完成 ${done}/${blocks.length} 段）：${e.message}`, 4500);
      break;
    }
  }
  if (t.kind === 'html') {
    if (mode === 'replace') t.dirty = true;
    persistHtmlDoc(t);
    requestAnimationFrame(() => sizeDrawCanvas(t));
  }
  if (done) toast(`已翻译 ${done} 个段落`);
}

/* 恢复原文：撤销所有翻译 */
function restoreOriginalText(t) {
  let doc, rootEl;
  if (t.kind === 'html') { doc = document; rootEl = t.page; }
  else if (t.kind === 'epub') {
    try { const c = t.rendition.getContents()[0]; doc = c.document; rootEl = doc.body; } catch (e) { toast('无法恢复原文'); return; }
  } else { toast('当前文档类型不支持恢复原文'); return; }

  let count = 0;
  // 1. 移除所有双语译文块
  rootEl.querySelectorAll('.bilingual-tr').forEach(el => { el.remove(); count++; });
  // 2. 恢复有 origText 的元素
  rootEl.querySelectorAll('[data-orig-text]').forEach(el => {
    const orig = el.dataset.origText;
    if (orig) { el.textContent = orig; delete el.dataset.origText; count++; }
  });
  if (t.kind === 'html') {
    t.dirty = false;
    persistHtmlDoc(t);
    requestAnimationFrame(() => sizeDrawCanvas(t));
  }
  toast(count ? `已恢复原文（撤销 ${count} 处翻译）` : '没有需要恢复的翻译');
}

/* ================= 全文翻译导出 ================= */
let expUpload = null;
$('#exportBtn').addEventListener('click', () => {
  $('#expProgress').textContent = '尚未开始';
  $('#expBar').style.width = '0';
  $('#exportMask').classList.add('open');
});
$('#expClose').addEventListener('click', () => $('#exportMask').classList.remove('open'));
$('#expSource').addEventListener('change', (e) => {
  if (e.target.value !== 'upload') { expUpload = null; return; }
  pickExportUpload();
});
function pickExportUpload() {
  if (bridge) {
    bridge.pick_files().then(list => {
      const r = (list || [])[0];
      if (r && r.ok) { expUpload = { name: r.name, ext: r.ext === 'markdown' ? 'md' : r.ext, data: b64ToBuf(r.data) }; toast('已选择：' + r.name); }
      else { $('#expSource').value = 'current'; }
    });
  } else {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.pdf,.md,.markdown,.epub,.docx,.txt,.html,.htm';
    inp.onchange = () => {
      const f = inp.files[0]; if (!f) { $('#expSource').value = 'current'; return; }
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      const rd = new FileReader();
      rd.onload = () => { expUpload = { name: f.name, ext: ext === 'markdown' ? 'md' : ext, data: rd.result }; toast('已选择：' + f.name); };
      if (ext === 'md' || ext === 'markdown' || ext === 'txt' || ext === 'html' || ext === 'htm') rd.readAsText(f, 'utf-8'); else rd.readAsArrayBuffer(f);
    };
    inp.click();
  }
}
function setExpProgress(pct, msg) {
  $('#expBar').style.width = Math.round(pct) + '%';
  $('#expProgress').textContent = msg;
}
async function extractEpubText(book) {
  let s = '';
  const items = (book.spine && book.spine.spineItems) || [];
  for (const item of items) {
    try {
      const doc = await item.load(book.request.bind(book));
      const body = doc && (doc.body || doc.querySelector('body'));
      if (body) s += (body.textContent || '').replace(/\n{3,}/g, '\n\n') + '\n\n';
      if (item.unload) item.unload();
    } catch (e) {}
  }
  return s;
}
async function extractPdfText(pdf) {
  let s = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const p = await pdf.getPage(i);
    const tc = await p.getTextContent();
    s += tc.items.map(it => it.str).join('') + '\n\n';
  }
  return s;
}
async function extractFullText(t) {
  if (t.kind === 'html') return (t.page.innerText || '').replace(/\n{3,}/g, '\n\n');
  if (t.kind === 'pdf' && t.pdf) return extractPdfText(t.pdf);
  if (t.kind === 'epub' && t.book) return extractEpubText(t.book);
  return '';
}
async function extractTextFromData(name, ext, data) {
  if (ext === 'md' || ext === 'txt') return typeof data === 'string' ? data : new TextDecoder('utf-8').decode(data);
  if (ext === 'docx') { const r = await mammoth.extractRawText({ arrayBuffer: data }); return r.value; }
  if (ext === 'pdf') { const pdf = await pdfjsLib.getDocument({ data }).promise; return extractPdfText(pdf); }
  if (ext === 'epub') { const book = ePub(data); await book.ready; const s = await extractEpubText(book); try { book.destroy(); } catch (e) {} return s; }
  return '';
}
async function makeDocxB64(text) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = docx;
  const levels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4];
  const children = text.split(/\n+/).map(line => {
    const l = line.trim();
    if (!l) return new Paragraph({});
    const m = l.match(/^(#{1,4})\s+(.*)/);
    if (m) return new Paragraph({ heading: levels[m[1].length - 1], children: [new TextRun(m[2])] });
    return new Paragraph({ children: [new TextRun(l)] });
  });
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBase64String(doc);
}
async function saveBytes(filename, b64) {
  if (bridge) {
    const r = await bridge.save_file_as(filename, b64);
    if (r.ok) { toast('已保存：' + r.path, 4000); return true; }
    if (!r.cancel) toast('保存失败：' + (r.error || ''));
    return false;
  }
  downloadBlob(b64ToBuf(b64), filename);
  return true;
}
function downloadBlob(buf, filename) {
  const blob = new Blob([buf]);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
$('#expStart').addEventListener('click', async () => {
  const src = $('#expSource').value, fmt = $('#expFormat').value;
  let name = '文档', text = '';
  setExpProgress(2, '正在提取文本…');
  try {
    if (src === 'current') {
      const t = activeTab();
      if (!t) { setExpProgress(0, '请先打开一个文档'); return; }
      name = t.name;
      text = await extractFullText(t);
    } else {
      if (!expUpload) { setExpProgress(0, '请先选择要上传的文档'); pickExportUpload(); return; }
      name = expUpload.name;
      text = await extractTextFromData(expUpload.name, expUpload.ext, expUpload.data);
    }
  } catch (e) { setExpProgress(0, '文本提取失败：' + e.message); return; }
  text = (text || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
  if (!text) { setExpProgress(0, '未获取到文本内容'); return; }
  const segs = splitSegments(text, 2500);
  let out = '';
  for (let i = 0; i < segs.length; i++) {
    setExpProgress(5 + i / segs.length * 85, `正在翻译第 ${i + 1}/${segs.length} 段（共 ${text.length} 字）…`);
    try {
      out += (i ? '\n\n' : '') + await callAI([
        { role: 'system', content: `你是专业翻译。请将用户给出的内容翻译为${aiCfg.lang}，只输出译文，保持原有段落结构。` },
        { role: 'user', content: segs[i] }
      ]);
    } catch (e) { setExpProgress(0, `第 ${i + 1} 段翻译失败：${e.message}`); return; }
  }
  setExpProgress(93, '正在生成导出文件…');
  try {
    const base = name.replace(/\.[^.]+$/, '') + '_译文.' + fmt;
    const b64 = fmt === 'md'
      ? bufToB64(new TextEncoder().encode(`# ${name}（译文）\n\n${out}\n`))
      : await makeDocxB64(out);
    const ok = await saveBytes(base, b64);
    setExpProgress(100, ok ? '导出完成 ✅' : '已取消保存');
  } catch (e) { setExpProgress(0, '导出失败：' + e.message); }
});

/* ================= 编辑保存提示 ================= */
let saveCtx = null;
function promptSave(t, onDone) {
  saveCtx = { t, onDone };
  $('#saveDocName').textContent = t.name;
  const canDirect = !!(bridge && t.path && (t.ext === 'md' || t.ext === 'docx'));
  $('#saveDirectBtn').style.display = canDirect ? '' : 'none';
  $('#saveHint').textContent = canDirect
    ? '「直接保存」将覆盖原文件：' + t.path
    : '未获取原文件路径（浏览器打开或拖入的文件），可另存为导出；不保存则仅保留在应用内。';
  $('#saveMask').classList.add('open');
}
function closeSavePrompt() { $('#saveMask').classList.remove('open'); saveCtx = null; }
$('#saveCancel').addEventListener('click', closeSavePrompt);
$('#saveSkip').addEventListener('click', () => {
  const c = saveCtx; if (!c) return;
  c.t.dirty = false;
  persistHtmlDoc(c.t);
  closeSavePrompt();
  c.onDone();
});
$('#saveDirectBtn').addEventListener('click', async () => {
  const c = saveCtx; if (!c) return;
  try {
    const out = await exportTabBytes(c.t);
    const r = await bridge.write_file(c.t.path, out.b64);
    if (r.ok) { c.t.dirty = false; toast('已保存到原文件'); closeSavePrompt(); c.onDone(); }
    else toast('保存失败：' + (r.error || ''));
  } catch (e) { toast('保存失败：' + e.message); }
});
$('#saveAsBtn').addEventListener('click', async () => {
  const c = saveCtx; if (!c) return;
  try {
    const out = await exportTabBytes(c.t);
    const ok = await saveBytes(out.name, out.b64);
    if (ok) { c.t.dirty = false; closeSavePrompt(); c.onDone(); }
  } catch (e) { toast('导出失败：' + e.message); }
});
function htmlToMarkdown(page) {
  const clone = page.cloneNode(true);
  const cvs = clone.querySelector('canvas.draw-canvas'); if (cvs) cvs.remove();
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  return td.turndown(clone.innerHTML);
}
async function htmlToDocxB64(page) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = docx;
  const levels = { H1: HeadingLevel.HEADING_1, H2: HeadingLevel.HEADING_2, H3: HeadingLevel.HEADING_3, H4: HeadingLevel.HEADING_4 };
  const children = [];
  page.querySelectorAll('h1,h2,h3,h4,p,li').forEach(el => {
    const runs = [];
    el.childNodes.forEach(n => {
      if (n.nodeType === 3) { if (n.textContent.trim()) runs.push(new TextRun(n.textContent)); }
      else if (n.nodeType === 1 && n.tagName !== 'CANVAS') {
        const st = n.style || {};
        runs.push(new TextRun({
          text: n.textContent,
          bold: !!(n.closest('b,strong') || (st.fontWeight && parseInt(st.fontWeight) >= 600)),
          size: st.fontSize ? Math.round(parseInt(st.fontSize) * 2) : undefined
        }));
      }
    });
    if (!runs.length) return;
    children.push(new Paragraph({
      children: runs,
      heading: levels[el.tagName] || undefined,
      bullet: el.tagName === 'LI' ? { level: 0 } : undefined
    }));
  });
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBase64String(doc);
}
async function exportTabBytes(t) {
  if (t.ext === 'md') {
    const ta = t.root.querySelector('#mdSourceArea');
    const md = ta ? ta.value : htmlToMarkdown(t.page);
    return { name: t.name.replace(/\.[^.]+$/, '') + '.md', b64: bufToB64(new TextEncoder().encode(md)) };
  }
  const b64 = await htmlToDocxB64(t.page);
  return { name: t.name.replace(/\.[^.]+$/, '') + '.docx', b64 };
}

/* ================= 关于弹窗 ================= */
const AUTHOR_URL = 'https://space.bilibili.com/2122976393';
function closeAbout() {
  $('#aboutMask').classList.remove('open');
  // about 关闭后，检查是否需要弹默认应用弹窗（仅 exe 环境）
  checkAssocPopup();
}
$('#aboutClose').addEventListener('click', closeAbout);
$('#aboutGo').addEventListener('click', () => {
  if (bridge) bridge.open_url(AUTHOR_URL);
  else window.open(AUTHOR_URL, '_blank');
  closeAbout();
});
// 点击遮罩关闭 UP主介绍弹窗
$('#aboutMask').addEventListener('click', (e) => { if (e.target === $('#aboutMask')) closeAbout(); });
// 主页 UP 主横幅按钮
$('#homeAuthorBtn').addEventListener('click', () => {
  if (bridge) bridge.open_url(AUTHOR_URL);
  else window.open(AUTHOR_URL, '_blank');
});

/* ================= 文档内搜索 ================= */
var searchState = { marks: [], current: -1, term: '' };

function getSearchRoots(t) {
  if (!t) return [];
  if (t.kind === 'html' && t.page) return [t.page];
  if (t.kind === 'pdf') return Array.from(t.root.querySelectorAll('.textLayer'));
  if (t.kind === 'epub') {
    var ifr = t.root.querySelector('iframe');
    if (ifr && ifr.contentDocument && ifr.contentDocument.body) return [ifr.contentDocument.body];
    return [];
  }
  return [];
}

function clearSearchMarks() {
  // 主文档
  document.querySelectorAll('mark.search-mark').forEach(function(m) {
    var parent = m.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(m.textContent), m);
    parent.normalize();
  });
  // EPUB iframe 内的标记
  tabs.forEach(function(t) {
    if (t.kind === 'epub') {
      var ifr = t.root.querySelector('iframe');
      if (ifr && ifr.contentDocument) {
        ifr.contentDocument.querySelectorAll('mark.search-mark').forEach(function(m) {
          var parent = m.parentNode;
          if (!parent) return;
          parent.replaceChild(ifr.contentDocument.createTextNode(m.textContent), m);
          parent.normalize();
        });
      }
    }
  });
  searchState.marks = [];
  searchState.current = -1;
}

function doSearch(term) {
  clearSearchMarks();
  var q = (term || '').trim();
  if (!q) { if ($('#searchCount')) $('#searchCount').textContent = '0/0'; return; }
  searchState.term = q;
  var t = activeTab();
  if (!t) { if ($('#searchCount')) $('#searchCount').textContent = '0/0'; return; }
  var roots = getSearchRoots(t);
  var lowerQ = q.toLowerCase();

  roots.forEach(function(root) {
    var doc = root.ownerDocument || document;
    var walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function(n) {
        if (!n.textContent || !n.textContent.trim()) return NodeFilter.FILTER_REJECT;
        var p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        var tag = p.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
        if (p.classList && p.classList.contains('search-mark')) return NodeFilter.FILTER_REJECT;
        return n.textContent.toLowerCase().indexOf(lowerQ) >= 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(function(n) {
      var text = n.textContent;
      var lower = text.toLowerCase();
      var frag = doc.createDocumentFragment();
      var last = 0;
      var pos = lower.indexOf(lowerQ, last);
      while (pos >= 0) {
        if (pos > last) frag.appendChild(doc.createTextNode(text.slice(last, pos)));
        var mark = doc.createElement('mark');
        mark.className = 'search-mark';
        mark.textContent = text.slice(pos, pos + q.length);
        frag.appendChild(mark);
        searchState.marks.push(mark);
        last = pos + q.length;
        pos = lower.indexOf(lowerQ, last);
      }
      if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
      n.parentNode.replaceChild(frag, n);
    });
  });

  if (searchState.marks.length > 0) {
    searchState.current = 0;
    highlightCurrentMark();
  }
  if ($('#searchCount')) {
    $('#searchCount').textContent = searchState.marks.length > 0
      ? (1 + '/' + searchState.marks.length) : '0/0';
  }
}

function highlightCurrentMark() {
  // EPUB 翻页后旧标记脱离 DOM，自动重新搜索当前章节
  if (searchState.marks.length > 0 && !document.contains(searchState.marks[0]) && !searchState.marks[0].isConnected) {
    doSearch(searchState.term);
    return;
  }
  searchState.marks.forEach(function(m, i) { m.classList.toggle('current', i === searchState.current); });
  if (searchState.current >= 0 && searchState.current < searchState.marks.length) {
    var mark = searchState.marks[searchState.current];
    try { mark.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
  }
}

function searchNext() {
  if (!searchState.term) return;
  if (searchState.marks.length === 0 || !searchState.marks[0].isConnected) { doSearch(searchState.term); return; }
  searchState.current = (searchState.current + 1) % searchState.marks.length;
  highlightCurrentMark();
  if ($('#searchCount')) $('#searchCount').textContent = (searchState.current + 1) + '/' + searchState.marks.length;
}

function searchPrev() {
  if (!searchState.term) return;
  if (searchState.marks.length === 0 || !searchState.marks[0].isConnected) { doSearch(searchState.term); return; }
  searchState.current = (searchState.current - 1 + searchState.marks.length) % searchState.marks.length;
  highlightCurrentMark();
  if ($('#searchCount')) $('#searchCount').textContent = (searchState.current + 1) + '/' + searchState.marks.length;
}

function toggleSearch() {
  var bar = $('#searchBar');
  if (!bar) return;
  if (bar.classList.contains('open')) { closeSearch(); return; }
  bar.classList.add('open');
  var input = $('#searchInput');
  if (input) { input.focus(); input.select(); }
  if ($('#searchCount')) $('#searchCount').textContent = '0/0';
}

function closeSearch() {
  clearSearchMarks();
  var bar = $('#searchBar');
  if (bar) bar.classList.remove('open');
  searchState.term = '';
}

/* 搜索事件绑定 */
if ($('#searchBtn')) $('#searchBtn').addEventListener('click', toggleSearch);
if ($('#searchClose')) $('#searchClose').addEventListener('click', closeSearch);
if ($('#searchNext')) $('#searchNext').addEventListener('click', searchNext);
if ($('#searchPrev')) $('#searchPrev').addEventListener('click', searchPrev);
if ($('#searchInput')) {
  $('#searchInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? searchPrev() : searchNext(); }
    if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
  });
  var _searchTimer = null;
  $('#searchInput').addEventListener('input', function(e) {
    if (_searchTimer) clearTimeout(_searchTimer);
    _searchTimer = setTimeout(function() { doSearch(e.target.value); }, 350);
  });
}

/* ================= 阅读进度自动保存 ================= */
viewer.addEventListener('scroll', saveCurrentProgress, { passive: true });
document.addEventListener('visibilitychange', () => { if (document.hidden) saveProgress(activeTab()); });
window.addEventListener('beforeunload', () => { saveProgress(activeTab()); });
// 窗口缩放时重新调整 EPUB 渲染尺寸
let _epubResizeTimer = null;
window.addEventListener('resize', () => {
  if (_epubResizeTimer) clearTimeout(_epubResizeTimer);
  _epubResizeTimer = setTimeout(() => {
    tabs.forEach(t => { if (t.kind === 'epub' && t.rendition) { try { t.rendition.resize(); } catch (e) {} } });
  }, 200);
});

/* 初始化 */
try { applySettings(); } catch (e) { console.error('applySettings error:', e); }
try { renderTabs(); } catch (e) { console.error('renderTabs error:', e); }
// 检查弹窗（浏览器环境立即检查，exe 环境由 initPersist 完成后检查）
try {
  if (window.pywebview && window.pywebview.api && !bridgeReady) {
    // pywebview API 已就绪（少见情况）：直接初始化
    bridgeReady = true;
    bridge = window.pywebview.api;
    onBridgeReady();
  } else if (!window.pywebview) {
    // 浏览器环境：立即检查弹窗（使用 localStorage）
    checkPopups();
  } else {
    // exe 环境但 pywebview.api 尚未就绪：等待 pywebviewready 事件
    // 超时保护：3秒后若 bridge 仍未就绪则直接检查，避免弹窗永不显示
    setTimeout(() => { if (!bridgeReady) checkPopups(); }, 3000);
  }
} catch (e) { console.error('init error:', e); }
})();
