/**
 * Overlay — Polished floating result (always-on-top, resizable, independent)
 * Mirrors polished markdown + code blocks, supports large responses, theme synced.
 */

const els = {
  status: document.getElementById('overlayStatus') as HTMLElement,
  placeholder: document.getElementById('overlayPlaceholder') as HTMLElement,
  text: document.getElementById('overlayText') as HTMLElement,
  meta: document.getElementById('overlayMeta') as HTMLElement,
  backend: document.getElementById('overlayBackend') as HTMLElement,
  btnClose: document.getElementById('btnClose') as HTMLButtonElement,
  btnMinimize: document.getElementById('btnMinimize') as HTMLButtonElement,
  btnPin: document.getElementById('btnPin') as HTMLButtonElement,
  btnCopy: document.getElementById('btnCopyOverlay') as HTMLButtonElement,
  btnExpand: document.getElementById('btnExpand') as HTMLButtonElement,
  dragHandle: document.getElementById('dragHandle') as HTMLElement,
};

let isStreaming = false;
let lastFull = '';

function escapeHtml(s: string){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function highlightCode(code: string){
  const esc=escapeHtml(code);
  if(code.split('\n').length>600) return esc;
  return esc.replace(/(\/\/.*?$|\/\*[\s\S]*?\*\/|#.*?$)/gm,'<span style="color:#6b7892">$1</span>')
            .replace(/(&quot;.*?&quot;|&#39;.*?&#39;|`.*?`)/g,'<span style="color:#8ec49b">$1</span>')
            .replace(/\b(import|export|from|const|let|var|function|class|return|if|else|for|while|async|await|try|catch|new)\b/g,'<span style="color:#82aaff; font-weight:600">$1</span>');
}
function renderMarkdownLite(md: string): string {
  // lightweight for overlay — reuse same token colors
  const parts = md.split(/(```[\s\S]*?```)/g);
  let html='';
  for(const part of parts){
    if(part.startsWith('```')){
      const m=part.match(/```(\w+)?\n?([\s\S]*?)```/);
      const lang=(m?.[1]||'text').toLowerCase();
      const code=m?.[2]?? part.slice(3,-3);
      html+=`<div style="margin:12px 0; border:1px solid #1e2636; border-radius:12px; overflow:hidden; background:#0b0e14"><div style="display:flex; justify-content:space-between; padding:6px 10px; background:#0f131c; border-bottom:1px solid #1e2636; font-size:10px; color:#6b7892; letter-spacing:.06em; text-transform:uppercase">${escapeHtml(lang)}<span style="font-size:11px; text-transform:none; letter-spacing:0">${code.split('\n').length} lines</span></div><pre style="margin:0; padding:12px; overflow:auto; max-height:50vh; font-family:'JetBrains Mono', monospace; font-size:12px; line-height:1.6; color:#d6deeb; white-space:pre"><code>${highlightCode(code.trimEnd())}</code></pre></div>`;
    } else {
      // simple inline: keep line breaks, escape, but allow bold/code
      let s=escapeHtml(part);
      s=s.replace(/`([^`]+)`/g,'<code style="background:#0f131c; border:1px solid #1e2636; padding:1px 5px; border-radius:6px; font-family:JetBrains Mono, monospace; font-size:11px">$1</code>');
      s=s.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
      // paragraphs
      const lines=s.split('\n').filter(l=> l.trim()).map(l=> `<p style="margin:0 0 8px">${l}</p>`).join('');
      html+=lines;
    }
  }
  return html || `<p>${escapeHtml(md)}</p>`;
}

function setStatus(s: string, streaming: boolean, isError=false) {
  els.status.textContent = s;
  els.status.className = 'status' + (streaming ? ' streaming' : '') + (isError ? ' error' : '');
  const dot = document.querySelector('.dot') as HTMLElement;
  if (dot) dot.className = 'dot' + (streaming ? ' streaming' : '');
}

els.btnClose.addEventListener('click', () => window.assistantAPI.window.closeOverlay());
els.btnMinimize.addEventListener('click', () => window.assistantAPI.window.minimize('overlay'));
els.btnPin.addEventListener('click', async () => {
  const { alwaysOnTop } = await window.assistantAPI.overlay.toggleAlwaysOnTop();
  els.btnPin.textContent = alwaysOnTop ? '📌' : '📍';
  els.btnPin.title = alwaysOnTop ? 'Always on top: ON' : 'Always on top: OFF';
});
if (els.btnCopy) els.btnCopy.addEventListener('click', ()=> {
  if (!lastFull) return;
  navigator.clipboard.writeText(lastFull).then(()=> {
    const prev = els.btnCopy.textContent; els.btnCopy.textContent='✓';
    setTimeout(()=> els.btnCopy.textContent=prev, 1200);
  });
});
if (els.btnExpand) els.btnExpand.addEventListener('click', ()=> {
  const win = window as any;
  // Toggle expand via IPC — request larger bounds
  win.assistantAPI?.overlay?.setBounds?.({ x: 80, y: 80, width: 720, height: 640 });
});

window.assistantAPI.overlay.onUpdate((payload) => {
  const { text, isStreaming: streaming, backendStatus } = payload;
  lastFull = text || lastFull;
  isStreaming = streaming;
  if (streaming) {
    setStatus('streaming…', true);
    els.placeholder.style.display = 'none';
    els.text.style.display = 'block';
    // During stream, plain text for performance
    els.text.textContent = text || '…';
    els.meta.textContent = 'Streaming • ' + (backendStatus || '');
  } else if (text) {
    setStatus(text.startsWith('[Error')|| text.startsWith('[Network') ? 'error' : 'done', false, text.startsWith('[Error'));
    els.placeholder.style.display = 'none';
    els.text.style.display = 'block';
    // Polished render on done: markdown + code
    if (text.length > 600 || text.includes('```')) {
      els.text.innerHTML = renderMarkdownLite(text);
    } else {
      els.text.textContent = text;
    }
    els.meta.textContent = backendStatus || '';
  } else {
    setStatus('idle', false);
    els.placeholder.style.display = 'block';
    els.text.style.display = 'none';
  }
  if (payload.backendStatus) els.backend.textContent = `backend: ${payload.backendStatus}`;
  els.text.scrollTop = els.text.scrollHeight;
});

// Theme sync from main (store)
try {
  const saved = localStorage.getItem('theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  // Listen for theme changes from main
  window.addEventListener('storage', (e)=> {
    if (e.key==='theme' && e.newValue) document.documentElement.setAttribute('data-theme', e.newValue);
  });
} catch {}

setStatus('idle', false);
