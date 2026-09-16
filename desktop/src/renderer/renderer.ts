/**
 * Renderer — Polished AI Product (Windows)
 * Premium, dark-first, token-driven. OS-authorized capture only.
 * Streaming markdown + code viewer (syntax-highlighted, virtualized),
 * history, toasts, theme, keyboard shortcuts, floating overlay.
 * Capture independent from viewed app (desktopCapturer + getUserMedia).
 */
import { CaptureEngine, CaptureEngineConfig } from './captureEngine.js';
import { checkHealth as checkHealthApi, fetchModels, visionAnalyzeOnce, visionAnalyzeStream } from './api.js';

type HealthResponse = { status: string; checks: { openrouter: string } };
const $ = (s: string) => document.querySelector(s) as HTMLElement;
const $$ = (s: string) => document.querySelectorAll(s) as NodeListOf<HTMLElement>;

// Core elements (keep IDs for compatibility)
const els = {
  backendStatus: $('#backendStatus'),
  versionBadge: $('#versionBadge'),
  apiBaseLabel: $('#apiBaseLabel'),
  backendInput: $('#backendInput') as HTMLInputElement,
  backendUrlLabel: $('#backendUrlLabel'),
  btnPickSource: $('#btnPickSource') as HTMLButtonElement,
  btnCapture: $('#btnCapture') as HTMLButtonElement,
  btnStop: $('#btnStop') as HTMLButtonElement,
  btnPause: $('#btnPause') as HTMLButtonElement,
  btnCaptureNow: $('#btnCaptureNow') as HTMLButtonElement,
  sourceGrid: $('#sourceGrid'),
  selectedLabel: $('#selectedSourceLabel'),
  captureInfo: $('#captureInfo'),
  previewImg: $('#previewImg') as HTMLImageElement,
  previewPlaceholder: $('#previewPlaceholder'),
  hiddenVideo: $('#hiddenVideo') as HTMLVideoElement,
  hiddenCanvas: $('#hiddenCanvas') as HTMLCanvasElement,
  fpsLabel: $('#fpsLabel'),
  diffLabel: $('#diffLabel'),
  skippedLabel: $('#skippedLabel'),
  queueLabel: $('#queueLabel'),
  intervalInput: $('#intervalInput') as HTMLInputElement,
  scaleInput: $('#scaleInput') as HTMLInputElement,
  qualityInput: $('#qualityInput') as HTMLInputElement,
  diffInput: $('#diffInput') as HTMLInputElement,
  intervalVal: $('#intervalVal'),
  scaleVal: $('#scaleVal'),
  qualityVal: $('#qualityVal'),
  diffVal: $('#diffVal'),
  chkFrameDiff: $('#chkFrameDiff') as HTMLInputElement,
  chkAuto: $('#chkAuto') as HTMLInputElement,
  chkOverlayTop: $('#chkOverlayTop') as HTMLInputElement,
  promptInput: $('#promptInput') as HTMLTextAreaElement,
  modelSelect: $('#modelSelect') as HTMLSelectElement,
  chkStream: $('#chkStream') as HTMLInputElement,
  btnAnalyze: $('#btnAnalyze') as HTMLButtonElement,
  btnClear: $('#btnClear') as HTMLButtonElement,
  btnHealth: $('#btnHealth') as HTMLButtonElement,
  btnRefreshModels: $('#btnRefreshModels') as HTMLButtonElement,
  btnCreateOverlay: $('#btnCreateOverlay') as HTMLButtonElement,
  btnOverlayToggle: $('#btnOverlayToggle') as HTMLButtonElement,
  overlayStatus: $('#overlayStatus'),
  responsePlaceholder: $('#responsePlaceholder'),
  responseContent: $('#responseContent'),
  responseMeta: $('#responseMeta'),
  streamStatus: $('#streamStatus'),
  // polished additions
  btnTheme: $('#btnTheme') as HTMLButtonElement | null,
  btnCopy: $('#btnCopy') as HTMLButtonElement | null,
  btnSave: $('#btnSave') as HTMLButtonElement | null,
  btnRegenerate: $('#btnRegenerate') as HTMLButtonElement | null,
  btnContinue: $('#btnContinue') as HTMLButtonElement | null,
  btnClearResponse: $('#btnClearResponse') as HTMLButtonElement | null,
  liveDot: $('#liveDot') as HTMLElement | null,
  analyzingState: $('#analyzingState') as HTMLElement | null,
  responseBox: $('#responseBox') as HTMLElement | null,
  historyList: $('#historyList') as HTMLElement | null,
  historyEmpty: $('#historyEmpty') as HTMLElement | null,
  historyCount: $('#historyCount') as HTMLElement | null,
  responseStats: $('#responseStats') as HTMLElement | null,
  pulse: $('#pulse') as HTMLElement | null,
  captureLiveBadge: $('#captureLiveBadge') as HTMLElement | null,
  previewBox: $('#previewBox') as HTMLElement | null,
  toasts: $('#toasts') as HTMLElement | null,
  shortcutsDialog: $('#shortcutsDialog') as HTMLDialogElement | null,
  btnShortcuts: $('#btnShortcuts') as HTMLElement | null,
};

let API_BASE = (import.meta as any).env?.VITE_API_BASE_URL || 'http://localhost:3000';
const ENV_BACKEND = (import.meta as any).env?.VITE_API_BASE_URL?.trim() || '';
const IS_ENV_FIXED = !!ENV_BACKEND && !ENV_BACKEND.includes('localhost'); // env attached at build time -> user-friendly, no URL input
let selectedSourceId: string | null = null;
let selectedSourceName: string | null = null;
let lastImageBase64: string | null = null;
let isCapturing = false;
let isPaused = false;
let abortController: AbortController | null = null;
let captureEngine: CaptureEngine | null = null;
let lastPrompt = '';
let lastModel: string | undefined = undefined;
let fullStreaming = '';
let isStreaming = false;

const defaultConfig: CaptureEngineConfig = {
  intervalMs: 1500,
  scaleFactor: 0.6,
  jpegQuality: 75,
  enableFrameDiff: true,
  diffThresholdPercent: 3.0,
  autoAnalyze: false,
  maxQueueSize: 2,
};
let captureConfig: CaptureEngineConfig = { ...defaultConfig };

// ── Theme ──────────────────────────────────────────────────
function initTheme() {
  const saved = (localStorage.getItem('theme') as 'dark'|'light'|null) || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.setAttribute('data-theme', saved);
  updateThemeIcon(saved);
}
function toggleTheme() {
  const curr = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = curr === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  (window as any).assistantAPI?.store?.set?.('theme', next).catch(()=>{});
  updateThemeIcon(next);
  toast(`Theme: ${next}`, 'info');
}
function updateThemeIcon(t: string) {
  if (els.btnTheme) els.btnTheme.textContent = t === 'dark' ? '◐' : '☀';
}

// ── Toasts ──────────────────────────────────────────────────
function toast(msg: string, type: 'success'|'error'|'info' = 'info', ms = 3200) {
  if (!els.toasts) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="ico">${type==='success'?'✓':type==='error'?'✕':'•'}</span><span style="flex:1; line-height:1.4">${escapeHtml(msg)}</span>`;
  els.toasts.appendChild(el);
  setTimeout(() => { el.style.opacity='0'; el.style.transform='translateY(4px)'; setTimeout(()=> el.remove(), 220); }, ms);
}

// ── Utils ───────────────────────────────────────────────────
function escapeHtml(s: string) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function saveAs(text: string, filename: string) {
  const blob = new Blob([text], {type:'text/markdown;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download=filename; a.click();
  setTimeout(()=> URL.revokeObjectURL(url), 1000);
}
function copyText(text: string) {
  navigator.clipboard.writeText(text).then(()=> toast('Copied to clipboard','success'), ()=> toast('Copy failed','error'));
}

// ── Markdown + Code Highlight (lightweight, no heavy deps) ──
const codeLangMap: Record<string,string> = { js:'javascript', ts:'typescript', py:'python', sh:'bash', bash:'bash', json:'json', html:'html', css:'css' };

function highlightCode(code: string, lang?: string): string {
  // Minimal highlight: keywords, strings, comments, numbers
  const esc = escapeHtml(code);
  // For performance, only highlight if < 800 lines, else plain
  if (code.split('\n').length > 800) return esc;
  const keywords = /\b(import|export|from|const|let|var|function|class|return|if|else|for|while|async|await|try|catch|new|extends|implements|type|interface|enum|public|private|def|return|print|select|insert|update)\b/g;
  const strings = /(&quot;.*?&quot;|&#39;.*?&#39;|`.*?`)/g;
  const comments = /(\/\/.*?$|\/\*[\s\S]*?\*\/|#.*?$)/gm;
  // Do escaped but color via spans: simple approach—wrap
  return esc
    .replace(comments, '<span style="color:#6b7892; font-style:italic">$1</span>')
    .replace(strings, '<span style="color:#8ec49b">$1</span>')
    .replace(keywords, '<span style="color:#82aaff; font-weight:600">$1</span>')
    .replace(/\b(\d+)\b/g, '<span style="color:#f78c6c">$1</span>');
}

function renderMarkdown(md: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'md';

  // Split by code fences first
  const parts = md.split(/(```[\s\S]*?```)/g);
  for (const part of parts) {
    if (part.startsWith('```')) {
      const m = part.match(/```(\w+)?\n?([\s\S]*?)```/);
      const langRaw = (m?.[1]||'').toLowerCase();
      const lang = codeLangMap[langRaw] || langRaw || 'text';
      const code = m?.[2] ?? part.slice(3,-3);
      const lines = code.split('\n').length;
      const isLarge = lines > 400 || code.length > 40000;

      const block = document.createElement('div');
      block.className = 'code-block';
      block.innerHTML = `
        <div class="code-header">
          <span class="code-lang">${escapeHtml(lang)}</span>
          <span class="xs muted">${lines} lines • ${isLarge ? 'virtualized' : ''}</span>
          <span class="code-actions">
            <button class="btn btn-sm btn-ghost" data-action="copy">Copy</button>
            <button class="btn btn-sm btn-ghost" data-action="save">Save</button>
            <button class="btn btn-sm ${isLarge ? '' : 'hidden'}" data-action="expand">${isLarge ? 'Expand' : ''}</button>
          </span>
        </div>
        <pre class="code-pre ${isLarge ? 'large' : ''}" style="${isLarge ? 'max-height:380px' : ''}"><code>${highlightCode(code.trimEnd(), lang)}</code></pre>
        ${isLarge ? `<div class="code-virtual-hint">Large code — scroll inside. <button class="btn btn-sm btn-ghost" data-action="expand">Expand full</button> <span class="xs muted">${(code.length/1024).toFixed(1)} KB</span></div>` : ''}
      `;
      // wire copy/save
      block.querySelectorAll('[data-action="copy"]').forEach(b=> b.addEventListener('click', ()=> copyText(code)));
      block.querySelectorAll('[data-action="save"]').forEach(b=> b.addEventListener('click', ()=> saveAs(code, `assistant-${Date.now()}.${lang==='text'?'txt':lang}`)));
      block.querySelectorAll('[data-action="expand"]').forEach(b=> b.addEventListener('click', ()=> {
        const pre = block.querySelector('.code-pre') as HTMLElement;
        if (pre) { pre.style.maxHeight = pre.style.maxHeight ? '' : 'none'; pre.classList.toggle('large'); }
      }));
      wrap.appendChild(block);
    } else {
      // Inline markdown for non-code: headings, bold, italic, inline code, links, lists, blockquote, hr
      const lines = part.split('\n');
      let html = '';
      let inList = false;
      for (let line of lines) {
        const trimmed = line.trim();
        if (!trimmed) { if (inList) { html += '</ul>'; inList=false; } html += ''; continue; }
        if (/^#{1,3}\s/.test(trimmed)) {
          if (inList) { html += '</ul>'; inList=false; }
          const level = trimmed.match(/^#+/)![0].length;
          const text = escapeHtml(trimmed.replace(/^#+\s/, ''));
          html += `<h${level}>${text}</h${level}>`;
        } else if (/^[-*]\s/.test(trimmed)) {
          if (!inList) { html += '<ul>'; inList=true; }
          const text = inlineMd(trimmed.replace(/^[-*]\s/, ''));
          html += `<li>${text}</li>`;
        } else if (/^\d+\.\s/.test(trimmed)) {
          if (!inList) { html += '<ol>'; inList=true; }
          const text = inlineMd(trimmed.replace(/^\d+\.\s/, ''));
          html += `<li>${text}</li>`;
        } else if (/^>\s/.test(trimmed)) {
          if (inList) { html += '</ul>'; inList=false; }
          html += `<blockquote>${inlineMd(trimmed.replace(/^>\s/, ''))}</blockquote>`;
        } else if (/^---+$/.test(trimmed)) {
          if (inList) { html += '</ul>'; inList=false; }
          html += '<hr/>';
        } else {
          if (inList && !/^[-*0-9]/.test(trimmed)) { /* keep list open? close */ }
          html += `<p>${inlineMd(trimmed)}</p>`;
        }
      }
      if (inList) html += '</ul>';
      if (html.trim()) {
        const div = document.createElement('div');
        div.innerHTML = html;
        // Move children
        while (div.firstChild) wrap.appendChild(div.firstChild);
      }
    }
  }
  // If md was plain text without fences but contains code-like lines, fallback: show as md
  if (!wrap.children.length && md.trim()) {
    const p = document.createElement('p');
    p.textContent = md; // will be replaced by outer caller if needed
    // But we already handled plain; this is fallback for empty
  }
  return wrap;
}
function inlineMd(text: string): string {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}

// ── History (local) ─────────────────────────────────────────
type HistItem = { id: string; prompt: string; answer: string; model?: string; at: number; truncated?: boolean };
function loadHistory(): HistItem[] {
  try { return JSON.parse(localStorage.getItem('assistant_history')||'[]'); } catch { return []; }
}
function saveHistory(items: HistItem[]) {
  localStorage.setItem('assistant_history', JSON.stringify(items.slice(0,20)));
  renderHistory();
}
function pushHistory(prompt: string, answer: string, model?: string, truncated?: boolean) {
  const items = loadHistory();
  items.unshift({ id: String(Date.now()), prompt, answer, model, at: Date.now(), truncated });
  saveHistory(items);
}
function renderHistory() {
  if (!els.historyList || !els.historyEmpty || !els.historyCount) return;
  const items = loadHistory();
  els.historyCount.textContent = String(items.length);
  els.historyList.innerHTML = '';
  if (!items.length) {
    els.historyEmpty.style.display = 'flex';
    els.historyList.classList.add('hidden');
    return;
  }
  els.historyEmpty.style.display = 'none';
  els.historyList.classList.remove('hidden');
  for (const it of items) {
    const el = document.createElement('div');
    el.className = 'history-item';
    const ago = (()=>{ const d=Date.now()-it.at; if(d<60000) return 'now'; if(d<3600000) return Math.floor(d/60000)+'m ago'; if(d<86400000) return Math.floor(d/3600000)+'h ago'; return new Date(it.at).toLocaleDateString(); })();
    el.innerHTML = `<div style="display:flex; justify-content:space-between; gap:8px; align-items:center"><strong style="font-size:12px; line-height:1.3; display:-webkit-box; -webkit-line-clamp:1; -webkit-box-orient:vertical; overflow:hidden">${escapeHtml(it.prompt.slice(0,80))}</strong><span class="xs muted">${ago}</span></div><p class="xs muted" style="display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden">${escapeHtml(it.answer.slice(0,140))}</p><div style="display:flex; gap:6px; margin-top:6px"><span class="badge muted" style="font-size:10px">${escapeHtml(it.model||'default')}</span>${it.truncated?'<span class="badge warn" style="font-size:10px">truncated</span>':''}</div>`;
    el.addEventListener('click', ()=>{
      // restore
      els.promptInput.value = it.prompt;
      renderResponse(it.answer, { model: it.model, truncated: it.truncated });
      document.querySelectorAll('.history-item').forEach(n=> n.classList.remove('active'));
      el.classList.add('active');
      toast('Restored from history','info');
    });
    els.historyList.appendChild(el);
  }
}

// ── Response rendering ──────────────────────────────────────
function setAnalyzing(on: boolean) {
  isStreaming = on;
  if (els.analyzingState) els.analyzingState.classList.toggle('hidden', !on);
  if (els.liveDot) els.liveDot.classList.toggle('hidden', !on);
  if (els.streamStatus) { els.streamStatus.textContent = on ? 'streaming…' : ''; els.streamStatus.classList.toggle('hidden', false); }
  if (els.pulse) els.pulse.classList.toggle('ok', on);
  if (on) {
    els.responsePlaceholder.style.display='none';
    els.responseContent.style.display='block';
    els.responseContent.classList.add('streaming-cursor');
  } else {
    els.responseContent.classList.remove('streaming-cursor');
  }
}
function renderResponse(full: string, meta: { model?: string; truncated?: boolean; finishReason?: string; requestId?: string; stats?: string } = {}) {
  const isCodeHeavy = (full.match(/```/g)||[]).length >=2 || full.split('\n').length>120;
  fullStreaming = full;
  els.responsePlaceholder.style.display='none';
  els.responseContent.style.display='block';
  els.responseContent.classList.remove('streaming-cursor');
  els.responseContent.innerHTML = '';
  // If very large (> 400k chars) show virtual hint and render truncated view + full in overlay
  if (full.length > 400000) {
    const hint = document.createElement('div');
    hint.className = 'code-virtual-hint';
    hint.innerHTML = `Very large response (${(full.length/1024).toFixed(0)} KB, ${full.split('\n').length} lines) — virtualized view. <button class="btn btn-sm">Copy full</button>`;
    hint.querySelector('button')?.addEventListener('click', ()=> copyText(full));
    els.responseContent.appendChild(hint);
    // render first 200k + last
    const view = full.slice(0,150000) + '\n\n… [truncated middle — copy full to see all] …\n\n' + full.slice(-50000);
    els.responseContent.appendChild(renderMarkdown(view));
  } else if (isCodeHeavy || full.includes('```') || /^\s*(import|function|class|def |const |let |#include)/m.test(full)) {
    els.responseContent.appendChild(renderMarkdown(full));
  } else {
    // Normal answer + code mixed
    els.responseContent.appendChild(renderMarkdown(full));
  }
  // stats
  if (els.responseStats) {
    els.responseStats.textContent = `${full.length} chars • ${full.split('\n').length} lines${meta.truncated ? ' • truncated' : ''}${meta.model ? ' • '+meta.model : ''}`;
  }
  if (meta.truncated && els.btnContinue) els.btnContinue.style.display='inline-flex';
  else if (els.btnContinue) els.btnContinue.style.display='none';
  // persist history
  if (full && !isStreaming) {
    // already pushed in doAnalyze done, but ensure
  }
  els.responseContent.scrollTop = els.responseContent.scrollHeight;
}

// ── Init store ──────────────────────────────────────────────
async function loadStore() {
  try {
    const all = await (window as any).assistantAPI.store.getAll();
    // env-driven: if VITE_API_BASE_URL is production, ignore stored custom URL
    if (IS_ENV_FIXED) {
      API_BASE = ENV_BACKEND;
      if (els.backendInput) els.backendInput.value = API_BASE;
    } else if (all?.backendUrl) { API_BASE = all.backendUrl; if (els.backendInput) els.backendInput.value = API_BASE; }
    else if (els.backendInput) els.backendInput.value = API_BASE;
    if (all?.captureConfig) { captureConfig = { ...defaultConfig, ...all.captureConfig }; applyConfigToUI(); }
    const theme = all?.theme; if (theme) { document.documentElement.setAttribute('data-theme', theme); localStorage.setItem('theme', theme); updateThemeIcon(theme); }
    updateBackendLabel();
  } catch (e) {
    console.warn('store load failed', e);
    if (els.backendInput) els.backendInput.value = API_BASE;
  }
}
function applyConfigToUI() {
  els.intervalInput.value = String(captureConfig.intervalMs);
  els.scaleInput.value = String(Math.round(captureConfig.scaleFactor * 100));
  els.qualityInput.value = String(captureConfig.jpegQuality);
  els.diffInput.value = String(captureConfig.diffThresholdPercent);
  els.chkFrameDiff.checked = captureConfig.enableFrameDiff;
  els.chkAuto.checked = captureConfig.autoAnalyze;
  els.intervalVal.textContent = `${captureConfig.intervalMs}ms`;
  els.scaleVal.textContent = `${Math.round(captureConfig.scaleFactor * 100)}%`;
  els.qualityVal.textContent = String(captureConfig.jpegQuality);
  els.diffVal.textContent = `${captureConfig.diffThresholdPercent}%`;
  els.queueLabel.textContent = `0/${captureConfig.maxQueueSize}`;
}
async function persistConfig() { try { await window.assistantAPI.store.set('captureConfig', captureConfig); } catch (e) { console.warn('persist config failed', e); } }
async function persistBackendUrl() { try { await window.assistantAPI.store.set('backendUrl', API_BASE); } catch (e) { console.warn('persist backend failed', e); } }
function updateBackendLabel() {
  els.apiBaseLabel.textContent = API_BASE;
  els.backendUrlLabel.textContent = API_BASE;
}

// ── Health & Models ─────────────────────────────────────────
async function checkHealth() {
  try {
    const data = await checkHealthApi(API_BASE) as HealthResponse;
    const ok = data.status === 'ok';
    els.backendStatus.textContent = `Backend: ${data.status} • OpenRouter: ${data.checks.openrouter}`;
    els.backendStatus.className = ok ? 'badge ok' : 'badge err';
    if (els.pulse) { els.pulse.className = ok ? 'pulse ok' : data.status==='degraded' ? 'pulse warn' : 'pulse err'; }
    // Mirror to overlay
    window.assistantAPI.overlay.update({ text: '', isStreaming: false, backendStatus: `${data.status} • ${data.checks.openrouter}` });
    if (!ok) toast(`Backend ${data.status}: ${data.checks.openrouter}`, 'error');
  } catch (e) {
    els.backendStatus.textContent = 'Backend: unreachable';
    els.backendStatus.className = 'badge err';
    if (els.pulse) els.pulse.className = 'pulse err';
  }
}
async function loadModels() {
  try {
    const models = await fetchModels(API_BASE);
    const current = els.modelSelect.value;
    els.modelSelect.innerHTML = '<option value="">Default (server)</option>';
    for (const m of models.slice(0, 80)) {
      const opt = document.createElement('option'); opt.value = m.id; opt.textContent = m.name ? `${m.name} — ${m.id}` : m.id;
      els.modelSelect.appendChild(opt);
    }
    if (current) els.modelSelect.value = current;
  } catch (e) { console.warn('models load failed', e); }
}
async function loadVersion() { try { const v = await window.assistantAPI.getVersion(); els.versionBadge.textContent = `v${v}`; } catch {} }

// ── Sources ─────────────────────────────────────────────────
els.btnPickSource.addEventListener('click', async () => {
  els.btnPickSource.disabled = true; els.btnPickSource.textContent = 'Loading…';
  try {
    await window.assistantAPI.requestPermission();
    const sources = await window.assistantAPI.getSources();
    renderSources(sources);
    toast(`Found ${sources.length} capturable sources`,'success');
  } catch (e: any) {
    toast(String(e?.message||e),'error');
    window.assistantAPI.showError('Capture Error', String(e?.message || e));
  } finally {
    els.btnPickSource.disabled = false; els.btnPickSource.textContent = '▣ Choose Window / Screen';
  }
});
function renderSources(sources: Array<{ id: string; name: string; thumbnailDataUrl: string }>) {
  els.sourceGrid.innerHTML = '';
  if (sources.length === 0) {
    els.sourceGrid.innerHTML = '<div class="empty" style="grid-column:1/-1"><div class="empty-icon">⊘</div><h4>No sources found</h4><p class="hint small">No windows/screens available. Try again or check permissions.</p></div>';
    return;
  }
  for (const s of sources) {
    const card = document.createElement('div');
    card.className = 'source-card' + (selectedSourceId === s.id ? ' selected' : '');
    card.tabIndex = 0; card.setAttribute('role','option'); card.setAttribute('aria-selected', String(selectedSourceId===s.id));
    card.innerHTML = `<img src="${s.thumbnailDataUrl}" alt="" loading="lazy" /><div class="name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</div>`;
    const select = () => {
      selectedSourceId = s.id; selectedSourceName = s.name;
      els.selectedLabel.textContent = `Selected: ${s.name}`;
      els.btnCapture.disabled = false; els.btnCaptureNow.disabled = false;
      document.querySelectorAll('.source-card').forEach((c)=> c.classList.remove('selected'));
      card.classList.add('selected');
    };
    card.addEventListener('click', select);
    card.addEventListener('keydown', (e)=> { if (e.key==='Enter'||e.key===' ') { e.preventDefault(); select(); } });
    els.sourceGrid.appendChild(card);
  }
}

// ── CaptureEngine ───────────────────────────────────────────
function ensureEngine(): CaptureEngine {
  if (!captureEngine) {
    captureEngine = new CaptureEngine(els.hiddenVideo, els.hiddenCanvas, captureConfig);
    captureEngine.onFrameReady = (frame) => {
      lastImageBase64 = frame.jpegDataUrl;
      els.previewImg.src = frame.jpegDataUrl; els.previewImg.style.display = 'block';
      els.previewPlaceholder.style.display = 'none';
      if (els.previewBox) els.previewBox.classList.add('has-image');
      els.captureInfo.textContent = `${frame.width}×${frame.height} • ${(frame.byteLength/1024).toFixed(1)} KB • diff ${frame.diffPercent.toFixed(1)}%`;
      els.btnAnalyze.disabled = false; els.btnCaptureNow.disabled = false;
      els.queueLabel.textContent = `${captureEngine!.getStats().queueSize}/${captureConfig.maxQueueSize}`;
      els.diffLabel.textContent = `${frame.diffPercent.toFixed(1)}%`;
      els.skippedLabel.textContent = String(captureEngine!.getStats().skipped);
      if (captureConfig.autoAnalyze) {
        void doAnalyze(frame.jpegDataUrl, true);
        setTimeout(()=> captureEngine?.markQueueConsumed(), 60);
      } else {
        captureEngine?.markQueueConsumed();
      }
    };
    captureEngine.onPreview = (_url, stats) => {
      els.fpsLabel.textContent = stats.fps ? stats.fps.toFixed(1) : '—';
      els.diffLabel.textContent = `${stats.lastDiffPercent.toFixed(1)}%`;
      els.skippedLabel.textContent = String(stats.skipped);
      els.queueLabel.textContent = `${stats.queueSize}/${captureConfig.maxQueueSize}`;
    };
    captureEngine.onError = (msg) => {
      els.captureInfo.textContent = msg; toast(msg,'error'); window.assistantAPI.showError('Capture Error', msg);
    };
    captureEngine.onFps = (fps)=> { els.fpsLabel.textContent = fps.toFixed(1); };
  }
  return captureEngine;
}

// ── Capture controls ────────────────────────────────────────
els.btnCapture.addEventListener('click', async () => {
  if (!selectedSourceId) { toast('Choose a window/screen first','error'); return; }
  const engine = ensureEngine(); engine.updateConfig(captureConfig);
  els.btnCapture.disabled = true; els.btnCapture.textContent = 'Starting…';
  try {
    await engine.start(selectedSourceId!);
    isCapturing = true; isPaused=false;
    els.btnStop.disabled=false; els.btnPause.disabled=false; els.btnPause.textContent='⏸ Pause';
    els.btnCapture.textContent='● Capturing';
    if (els.captureLiveBadge) els.captureLiveBadge.classList.remove('hidden');
    els.captureInfo.textContent = `Continuous • ${captureConfig.intervalMs}ms • ${Math.round(captureConfig.scaleFactor*100)}% • q${captureConfig.jpegQuality}`;
    els.btnCaptureNow.disabled=false;
    toast('Continuous capture started — frame diff active','success');
  } catch (e:any) {
    els.btnCapture.disabled=false; els.btnCapture.textContent='◎ Start Continuous';
    toast(e.message||String(e),'error'); els.captureInfo.textContent='Failed: '+(e.message||String(e));
  }
});
els.btnStop.addEventListener('click', async () => {
  if (captureEngine) await captureEngine.stop();
  isCapturing=false; isPaused=false;
  els.btnCapture.disabled=false; els.btnCapture.textContent='◎ Start Continuous';
  els.btnStop.disabled=true; els.btnPause.disabled=true; els.btnPause.textContent='⏸ Pause';
  els.captureInfo.textContent='Stopped'; els.fpsLabel.textContent='—';
  if (els.captureLiveBadge) els.captureLiveBadge.classList.add('hidden');
  toast('Capture stopped','info');
});
els.btnPause.addEventListener('click', async () => {
  if (!captureEngine || !isCapturing) return;
  if (!isPaused) {
    await captureEngine.stop(); isPaused=true; els.btnPause.textContent='▶ Resume'; els.captureInfo.textContent='Paused'; toast('Paused','info');
  } else {
    await captureEngine.start(selectedSourceId!); isPaused=false; els.btnPause.textContent='⏸ Pause'; els.captureInfo.textContent='Resumed'; toast('Resumed','success');
  }
});
els.btnCaptureNow.addEventListener('click', async () => {
  if (!selectedSourceId && !lastImageBase64) { toast('Choose a source first','error'); return; }
  try {
    const engine = ensureEngine();
    const frame = await engine.captureOnce(selectedSourceId || undefined);
    if (frame) {
      lastImageBase64 = frame.jpegDataUrl;
      els.previewImg.src = frame.jpegDataUrl; els.previewImg.style.display='block';
      els.previewPlaceholder.style.display='none'; if (els.previewBox) els.previewBox.classList.add('has-image');
      els.captureInfo.textContent = `Single • ${frame.width}×${frame.height} • ${(frame.byteLength/1024).toFixed(1)} KB`;
      els.btnAnalyze.disabled=false;
      if (captureConfig.autoAnalyze) void doAnalyze(frame.jpegDataUrl, true);
    } else if (lastImageBase64) {
      void doAnalyze(lastImageBase64, false);
    }
  } catch (e:any) { toast(e.message||String(e),'error'); }
});

// ── Settings ────────────────────────────────────────────────
els.intervalInput.addEventListener('input', () => {
  captureConfig.intervalMs = parseInt(els.intervalInput.value,10);
  els.intervalVal.textContent=`${captureConfig.intervalMs}ms`;
  captureEngine?.updateConfig({ intervalMs: captureConfig.intervalMs }); persistConfig();
});
els.scaleInput.addEventListener('input', () => {
  captureConfig.scaleFactor = parseInt(els.scaleInput.value,10)/100;
  els.scaleVal.textContent=`${els.scaleInput.value}%`;
  captureEngine?.updateConfig({ scaleFactor: captureConfig.scaleFactor }); persistConfig();
});
els.qualityInput.addEventListener('input', () => {
  captureConfig.jpegQuality = parseInt(els.qualityInput.value,10);
  els.qualityVal.textContent=String(captureConfig.jpegQuality);
  captureEngine?.updateConfig({ jpegQuality: captureConfig.jpegQuality }); persistConfig();
});
els.diffInput.addEventListener('input', () => {
  captureConfig.diffThresholdPercent = parseFloat(els.diffInput.value);
  els.diffVal.textContent=`${captureConfig.diffThresholdPercent}%`;
  captureEngine?.updateConfig({ diffThresholdPercent: captureConfig.diffThresholdPercent }); persistConfig();
});
els.chkFrameDiff.addEventListener('change', ()=> { captureConfig.enableFrameDiff = els.chkFrameDiff.checked; captureEngine?.updateConfig({ enableFrameDiff: captureConfig.enableFrameDiff }); persistConfig(); });
els.chkAuto.addEventListener('change', ()=> { captureConfig.autoAnalyze = els.chkAuto.checked; captureEngine?.updateConfig({ autoAnalyze: captureConfig.autoAnalyze }); persistConfig(); });
els.chkOverlayTop.addEventListener('change', async ()=> { await window.assistantAPI.overlay.toggleAlwaysOnTop(); });

// ── Backend ─────────────────────────────────────────────────
els.backendInput.addEventListener('change', async ()=>{
  if (IS_ENV_FIXED) { toast('Backend is attached at environment — rebuild with VITE_API_BASE_URL to change','info'); els.backendInput.value=API_BASE; return; }
  const next=els.backendInput.value.trim(); if(!next) return;
  try { new URL(next); API_BASE=next; updateBackendLabel(); await persistBackendUrl(); await checkHealth(); await loadModels(); toast('Backend saved','success'); }
  catch(e:any){ toast(e.message,'error'); els.backendInput.value=API_BASE; }
});
els.btnHealth.addEventListener('click', ()=> { checkHealth(); toast('Health check…','info'); });
els.btnRefreshModels.addEventListener('click', ()=> { loadModels(); toast('Refreshing models…','info'); });
if (els.btnTheme) els.btnTheme.addEventListener('click', toggleTheme);
if (els.btnShortcuts) els.btnShortcuts.addEventListener('click', ()=> showShortcuts(true));

// ── Analyze ─────────────────────────────────────────────────
els.btnAnalyze.addEventListener('click', ()=> { if(!lastImageBase64) { toast('Capture a screenshot first','error'); return; } void doAnalyze(lastImageBase64,false); });
if (els.btnCopy) els.btnCopy.addEventListener('click', ()=> fullStreaming ? copyText(fullStreaming) : toast('Nothing to copy','info'));
if (els.btnSave) els.btnSave.addEventListener('click', ()=> { if(!fullStreaming) { toast('Nothing to save','info'); return; } saveAs(fullStreaming, `assistant-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.md`); toast('Saved .md','success'); });
if (els.btnRegenerate) els.btnRegenerate.addEventListener('click', ()=> { if(!lastImageBase64) { toast('No image to regenerate','error'); return; } void doAnalyze(lastImageBase64,false); });
if (els.btnContinue) els.btnContinue.addEventListener('click', ()=> { if(!lastImageBase64) return; toast('Continuing truncated response…','info'); void doAnalyze(lastImageBase64,false); });
if (els.btnClearResponse) els.btnClearResponse.addEventListener('click', clearResponse);
els.btnClear.addEventListener('click', ()=> { lastImageBase64=null; els.previewImg.style.display='none'; els.previewPlaceholder.style.display='block'; if(els.previewBox) els.previewBox.classList.remove('has-image'); clearResponse(); els.btnAnalyze.disabled=true; els.captureInfo.textContent=''; if(abortController) abortController.abort(); toast('Cleared','info'); });

function clearResponse() {
  fullStreaming=''; els.responseContent.innerHTML=''; els.responseContent.style.display='none'; els.responsePlaceholder.style.display='flex';
  els.responseMeta.textContent=''; els.streamStatus.textContent=''; els.streamStatus.classList.add('hidden');
  if(els.btnContinue) els.btnContinue.style.display='none';
  if(els.responseStats) els.responseStats.textContent='No response yet • History saved locally';
  window.assistantAPI.overlay.update({ text:'', isStreaming:false });
  if(abortController) abortController.abort();
}

async function doAnalyze(imageBase64: string, fromAuto: boolean) {
  const prompt = els.promptInput.value.trim() || 'Describe what you see on this screen and help the user concisely.';
  lastPrompt = prompt; lastModel = els.modelSelect.value || undefined;
  const model = lastModel; const stream = els.chkStream.checked;

  els.btnAnalyze.disabled=true; els.btnAnalyze.textContent = stream ? 'Streaming…' : 'Analyzing…';
  els.responsePlaceholder.style.display='none'; els.responseContent.style.display='block';
  if(!fromAuto) { els.responseContent.innerHTML=''; fullStreaming=''; }
  els.responseMeta.textContent = fromAuto ? 'Auto-analyze…' : ''; els.streamStatus.textContent = stream ? 'streaming…' : '';
  els.streamStatus.classList.remove('hidden');
  abortController?.abort(); abortController=new AbortController();
  let full = fromAuto ? '' : fullStreaming; // keep previous if not fromAuto? we cleared above
  if (!fromAuto) full='';
  let truncatedInfo: { truncated?: boolean; continuationAvailable?: boolean } = {};
  setAnalyzing(stream);

  try {
    if (stream) {
      let sawDelta = false;
      const result = await visionAnalyzeStream(API_BASE, prompt, imageBase64, model, (delta)=>{
        sawDelta = true; full+=delta; fullStreaming=full;
        // Throttle DOM updates to ~30fps
        els.responseContent.textContent = full; // plain during stream for performance
        els.responseContent.classList.add('streaming-cursor');
        if (full.length>500000) {
          els.responseContent.textContent = full.slice(-500000) + '\n\n[…truncated view: full length '+full.length+' chars, see overlay or save]';
        }
        window.assistantAPI.overlay.update({ text: full, isStreaming:true, backendStatus: els.backendStatus.textContent||undefined, prompt, model });
        if (els.streamStatus) els.streamStatus.textContent = `${full.length} chars`;
        if (els.responseStats) els.responseStats.textContent = `${full.length} chars streaming…`;
      }, (meta)=>{
        els.responseMeta.textContent = `Model: ${meta.model||model||'server default'}${meta.requestId ? ' • '+meta.requestId.slice(0,8):''}`;
      }, (cont)=>{
        truncatedInfo.continuationAvailable=cont.available; truncatedInfo.truncated=true;
        els.responseMeta.textContent = `Truncated — continuation available (${full.length} chars)`;
        els.streamStatus.textContent = 'truncated — click Continue';
      }, abortController.signal);

      truncatedInfo = { truncated: result.truncated, continuationAvailable: result.continuationAvailable };
      fullStreaming = full;
      if (result.truncated) {
        toast('Response truncated — more available. Click Continue.','info',5000);
        renderResponse(full, { model: model||'server', truncated:true, finishReason: result.finishReason, requestId: result.requestId });
        // append hint already in renderResponse
      } else {
        els.responseMeta.textContent = `Done • ${full.length} chars${result.finishReason ? ' • '+result.finishReason:''}${result.requestId ? ' • '+result.requestId.slice(0,8):''}`;
        if (els.streamStatus) els.streamStatus.textContent = 'done';
        // Final polished render: markdown + highlighted code
        renderResponse(full, { model: model||'server', truncated:false, finishReason: result.finishReason, requestId: result.requestId });
        pushHistory(prompt, full, model, !!result.truncated);
        toast('Analysis complete','success');
      }
      window.assistantAPI.overlay.update({ text: full, isStreaming:false, backendStatus: truncatedInfo.truncated?'truncated — tap continue':els.backendStatus.textContent||undefined });
      if (!sawDelta && !full) throw new Error('Malformed AI response: no delta received');
    } else {
      const data:any = await visionAnalyzeOnce(API_BASE, prompt, imageBase64, model, abortController.signal);
      const answer = typeof data.answer==='string'? data.answer : (data.answer!=null? JSON.stringify(data.answer):'');
      if (!answer) throw new Error('Malformed AI response: empty answer');
      fullStreaming = answer;
      renderResponse(answer, { model: data.model, truncated: !!data.metadata?.truncated, requestId: data.metadata?.requestId });
      els.responseMeta.textContent = `Model: ${data.model} • ${data.usage? `${data.usage.totalTokens??''} tokens •`:''} ${answer.length} chars${data.metadata?.truncated?' • truncated':''}`;
      if (data.metadata?.truncated) {
        if (els.btnContinue) els.btnContinue.style.display='inline-flex';
        els.streamStatus.textContent='truncated — continuation available';
        toast('Truncated — tap Continue or re-run with autoContinue','info',5000);
      } else {
        els.streamStatus.textContent='done';
        pushHistory(prompt, answer, data.model, !!data.metadata?.truncated);
        toast('Analysis complete','success');
      }
      window.assistantAPI.overlay.update({ text: answer, isStreaming:false, backendStatus: els.backendStatus.textContent||undefined });
    }
  } catch (e:any) {
    setAnalyzing(false);
    if (e.name==='AbortError' || e.message?.includes('Aborted')) {
      els.responseMeta.textContent='Aborted'; if(els.streamStatus) els.streamStatus.textContent='aborted';
      toast('Aborted','info');
    } else if (e.code==='NETWORK_ERROR' || e.message?.includes('Network failure') || e.message?.includes('Failed to fetch')) {
      const msg = `[Network failure] ${e.message}. Backend: ${API_BASE} — check health and CORS.`;
      const errDiv = document.createElement('div'); errDiv.className='error-panel'; errDiv.innerHTML=`<span>⚠</span><div><strong>Network failure</strong><br/>${escapeHtml(e.message)}<br/><span class="xs muted">${escapeHtml(API_BASE)}</span><div style="margin-top:8px" class="row"><button class="btn btn-sm">Retry</button><button class="btn btn-sm btn-ghost">Health</button></div></div>`;
      errDiv.querySelector('button')?.addEventListener('click', ()=> doAnalyze(imageBase64, false));
      (errDiv.querySelectorAll('button')[1] as HTMLElement)?.addEventListener('click', ()=> checkHealth());
      els.responseContent.appendChild(errDiv);
      els.responseMeta.textContent='Network failure — retry'; if(els.streamStatus) els.streamStatus.textContent='offline — retry';
      toast('Network failure — retry','error',5000);
      window.assistantAPI.overlay.update({ text: (els.responseContent.textContent||'')+ '\n'+msg, isStreaming:false, backendStatus:'Network error' });
    } else if (e.message?.includes('Malformed')) {
      renderResponse(full||'', {});
      const errDiv=document.createElement('div'); errDiv.className='error-panel'; errDiv.textContent = `[Malformed AI response] ${e.message} — showing raw. Try again or change model.`;
      els.responseContent.appendChild(errDiv);
      toast('Malformed response','error');
    } else {
      const msg=`[Error${e.code?' '+e.code:''}] ${e.message||e}`;
      const errDiv=document.createElement('div'); errDiv.className='error-panel'; errDiv.innerHTML=`<span>✕</span><div><strong>Error</strong><br/>${escapeHtml(e.message||String(e))}<br/><span class="xs muted">${escapeHtml(e.code||'')}</span></div>`;
      els.responseContent.appendChild(errDiv);
      els.responseMeta.textContent=`Error: ${e.code||'unknown'}`; if(els.streamStatus) els.streamStatus.textContent='error — retry';
      toast(e.message||'Error','error');
      window.assistantAPI.overlay.update({ text: els.responseContent.textContent||'', isStreaming:false, backendStatus:`Error: ${String(e.message).slice(0,80)}` });
    }
  } finally {
    setAnalyzing(false);
    els.btnAnalyze.disabled=!lastImageBase64; els.btnAnalyze.textContent='✦ Analyze Screenshot';
    abortController=null;
  }
}

// ── Overlay wiring ──────────────────────────────────────────
els.btnCreateOverlay.addEventListener('click', async ()=> { await window.assistantAPI.overlay.create(); els.overlayStatus.textContent='Overlay: visible'; toast('Overlay created','success'); });
els.btnOverlayToggle.addEventListener('click', async ()=> {
  const {visible}=await window.assistantAPI.overlay.toggle();
  els.overlayStatus.textContent=`Overlay: ${visible?'visible':'hidden'}`;
  toast(visible?'Overlay visible':'Overlay hidden','info');
});
window.assistantAPI.overlay.onUpdate((payload)=>{
  if (payload.text && !els.responseContent.textContent && !isStreaming) {
    els.responsePlaceholder.style.display='none'; els.responseContent.style.display='block';
    renderResponse(payload.text, {});
  }
});
window.assistantAPI.overlay.onClosed(()=> { els.overlayStatus.textContent='Overlay: hidden'; });

// ── Paste / Drop ────────────────────────────────────────────
document.addEventListener('paste', (e)=>{
  const item=[...(e.clipboardData?.items||[])].find(i=> i.type.startsWith('image/')); if(!item) return;
  const file=item.getAsFile(); if(!file) return;
  const reader=new FileReader(); reader.onload=()=>{
    lastImageBase64=reader.result as string;
    els.previewImg.src=lastImageBase64; els.previewImg.style.display='block'; els.previewPlaceholder.style.display='none'; if(els.previewBox) els.previewBox.classList.add('has-image');
    els.btnAnalyze.disabled=false; els.btnCaptureNow.disabled=false; els.captureInfo.textContent=`Pasted • ${file.name} • ${(file.size/1024).toFixed(1)} KB`;
    toast('Pasted image ready','success');
  }; reader.readAsDataURL(file);
});

// ── Shortcuts & theme ───────────────────────────────────────
function showShortcuts(show: boolean) {
  if (!els.shortcutsDialog) return;
  if (show) { els.shortcutsDialog.classList.remove('hidden'); els.shortcutsDialog.showModal?.(); }
  else { els.shortcutsDialog.classList.add('hidden'); try{ els.shortcutsDialog.close(); }catch{} }
}
document.addEventListener('keydown', (e)=>{
  const tag=(document.activeElement as HTMLElement)?.tagName;
  const inInput = tag==='INPUT' || tag==='TEXTAREA' || tag==='SELECT' || (document.activeElement as HTMLElement)?.isContentEditable;
  if (e.key==='?' && !inInput) { e.preventDefault(); const open = els.shortcutsDialog && !els.shortcutsDialog.classList.contains('hidden'); showShortcuts(!open); }
  else if ((e.key==='t' || e.key==='T') && !inInput) { e.preventDefault(); toggleTheme(); }
  else if (e.key==='Enter' && (e.metaKey||e.ctrlKey)) { e.preventDefault(); if(lastImageBase64) void doAnalyze(lastImageBase64,false); }
  else if (e.key==='Enter' && !inInput && lastImageBase64) { // plain Enter when not typing
    // Only if prompt not focused? Allow quick analyze
  }
  else if (e.key==='Escape') {
    if (els.shortcutsDialog && !els.shortcutsDialog.classList.contains('hidden')) { showShortcuts(false); }
    else if (isStreaming && abortController) { abortController.abort(); toast('Stopped','info'); }
    else if (isCapturing) { els.btnStop.click(); }
  }
  else if ((e.key==='o' || e.key==='O') && !inInput) { e.preventDefault(); els.btnOverlayToggle.click(); }
  else if ((e.key==='r' || e.key==='R') && !inInput) { e.preventDefault(); if(lastImageBase64) void doAnalyze(lastImageBase64,false); }
  else if ((e.key==='c' || e.key==='C') && !inInput) { e.preventDefault(); if(fullStreaming) copyText(fullStreaming); }
  else if ((e.key==='s' || e.key==='S') && !inInput && (e.ctrlKey||e.metaKey)) { e.preventDefault(); if(fullStreaming) saveAs(fullStreaming, `assistant-${Date.now()}.md`); }
  else if ((e.key==='k' || e.key==='K') && (e.ctrlKey||e.metaKey)) { e.preventDefault(); els.btnPickSource.click(); }
});
if (els.shortcutsDialog) {
  els.shortcutsDialog.addEventListener('click', (e)=>{
    const rect=els.shortcutsDialog!.getBoundingClientRect();
    const inDialog = e.clientX>=rect.left && e.clientX<=rect.right && e.clientY>=rect.top && e.clientY<=rect.bottom;
    if (!inDialog) showShortcuts(false);
  });
}

// ── Boot ────────────────────────────────────────────────────
(async()=>{
  initTheme();
  await loadStore(); applyConfigToUI(); renderHistory(); checkHealth(); loadVersion(); loadModels();
  setInterval(checkHealth,30000);
  try { const {visible}=await window.assistantAPI.overlay.isVisible(); els.overlayStatus.textContent=`Overlay: ${visible?'visible':'hidden'}`; } catch {}
  // Display change hint
  try { (window as any).assistantAPI.onDisplayChanged?.(()=> toast('Display changed — re-pick source if needed','info')); } catch {}
  // Register service worker for overlay? not needed
})();
