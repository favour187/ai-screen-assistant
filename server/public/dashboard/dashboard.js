// Dashboard — account-free, localStorage only, token-driven, responsive
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const backendInput = $('#backendInput');
const connStatus = $('#connStatus');
const connUrl = $('#connUrl');
const pulse = $('#pulse');
const healthDot = $('#healthDot');
const statBackend = $('#statBackend');
const statUptime = $('#statUptime');
const statModel = $('#statModel');
const statModelsCount = $('#statModelsCount');
const statDevices = $('#statDevices');
const healthPre = $('#healthPre');
const clientLogs = $('#clientLogs');
const footerBackend = $('#footerBackend');
const toasts = $('#toasts');
let logs = [];

function toast(msg, type='info') {
  const el = document.createElement('div');
  el.className = `toast`;
  el.textContent = msg;
  el.style.borderColor = type==='error' ? 'rgba(239,68,68,.3)' : type==='success' ? 'rgba(34,197,94,.3)' : 'var(--border)';
  toasts.appendChild(el);
  setTimeout(()=> { el.style.opacity='0'; setTimeout(()=> el.remove(), 200); }, 3000);
}
function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logs.unshift(line);
  logs = logs.slice(0,120);
  if (clientLogs) clientLogs.textContent = logs.join('\n');
  console.log('[dashboard]', msg);
}
function getBackend() {
  // env-driven: dashboard same origin as backend — no URL input
  return location.origin.replace(/\/+$/,'');
}
function setBackend(url) {
  // kept for compat — no-op, env-driven
  if (backendInput) backendInput.value = url;
  if (connUrl) connUrl.textContent = url;
  if (footerBackend) footerBackend.textContent = url;
}
function getDevices() {
  try { return JSON.parse(localStorage.getItem('devices')||'[]'); } catch { return []; }
}
function saveDevices(list) { localStorage.setItem('devices', JSON.stringify(list.slice(0,20))); }
function registerThisDevice() {
  const list = getDevices();
  const url = getBackend();
  const entry = { id: 'browser-'+Math.random().toString(36).slice(2,7), name: navigator.userAgent.includes('Mobile') ? 'This phone' : 'This browser', backend: url, at: new Date().toISOString(), ua: navigator.userAgent.slice(0,80) };
  // dedupe by backend
  const filtered = list.filter(d=> d.backend!==url);
  filtered.unshift(entry);
  saveDevices(filtered);
  renderDevices();
  log(`Registered device for ${url}`);
  toast('Device registered locally','success');
}
function renderDevices() {
  const list = getDevices();
  const containers = [$('#devicesList'), $('#devicesFull')];
  for (const c of containers) {
    if (!c) continue;
    c.innerHTML = '';
    if (!list.length) {
      c.innerHTML = '<div class="xs muted" style="padding:12px; border:1px dashed var(--border); border-radius:12px; text-align:center">No devices yet — click “Register this browser” or run desktop/Android against this backend.</div>';
      continue;
    }
    for (const d of list) {
      const el = document.createElement('div');
      el.className = 'card';
      el.style.padding='12px';
      el.style.background='var(--bg-subtle)';
      el.innerHTML = `<div style="display:flex; justify-content:space-between; gap:8px; align-items:center"><strong style="font-size:13px">${d.name}</strong><span class="badge muted" style="font-size:10px">${new Date(d.at).toLocaleString()}</span></div><div class="xs muted" style="word-break:break-all">${d.backend}</div><div class="xs subtle">${d.ua}</div>`;
      c.appendChild(el);
    }
  }
  statDevices.textContent = `${list.length || 1} • Local`;
  if ($('#statDevices')) $('#statDevices').textContent = `${list.length} • This browser`;
}

async function refreshHealth() {
  const backend = getBackend();
  const t0 = performance.now();
  try {
    const res = await fetch(new URL('/health', backend).toString());
    const json = await res.json();
    const ms = Math.round(performance.now()-t0);
    healthPre.textContent = JSON.stringify(json, null, 2);
    connStatus.textContent = `Backend: ${json.status} • OpenRouter: ${json.checks.openrouter} • ${ms}ms`;
    connStatus.className = json.status==='ok' ? 'badge ok' : 'badge err';
    pulse.className = json.status==='ok' ? 'pulse ok' : 'pulse err';
    if (healthDot) healthDot.className = json.status==='ok' ? 'pulse ok' : 'pulse err';
    statBackend.textContent = json.status + ' • ' + json.checks.openrouter;
    statUptime.textContent = `uptime ${Math.floor(json.uptime/60)}m • v${json.version}`;
    statModel.textContent = json.models?.default || '—';
    if (statModelsCount) statModelsCount.textContent = json.models?.allowed==='any' ? 'any model' : String(json.models?.allowed).slice(0,60);
    footerBackend.textContent = backend;
    log(`Health ok ${json.status} ${ms}ms`);
    // also update version badge if exists
    const vb = document.getElementById('versionBadge');
    if (vb) vb.textContent = 'v'+json.version;
    // bump usage counters locally for health check
    incUsage('health');
  } catch (e) {
    healthPre.textContent = 'Fetch failed: '+ e.message + '\nBackend: '+backend;
    connStatus.textContent = 'Backend: unreachable';
    connStatus.className = 'badge err';
    pulse.className = 'pulse err';
    if (healthDot) healthDot.className = 'pulse err';
    statBackend.textContent = 'unreachable';
    log('Health failed: '+e.message);
  }
}

async function loadModels() {
  const backend = getBackend();
  try {
    const res = await fetch(new URL('/api/models', backend).toString());
    const json = await res.json();
    const models = json.models || json.data || [];
    statModelsCount.textContent = `${models.length} models`;
    const sel = document.getElementById('modelSelect');
    const list = document.getElementById('modelList');
    if (sel) {
      const cur = localStorage.getItem('preferredModel')||'';
      sel.innerHTML = '<option value="">Default (server)</option>';
      for (const m of models.slice(0,80)) {
        const o=document.createElement('option'); o.value=m.id; o.textContent = m.name ? `${m.name} — ${m.id}` : m.id;
        if (m.id===cur) o.selected=true;
        sel.appendChild(o);
      }
    }
    if (list) {
      list.innerHTML = '';
      for (const m of models.slice(0,40)) {
        const row=document.createElement('div');
        row.style.cssText='display:flex; justify-content:space-between; align-items:center; padding:8px 10px; border:1px solid var(--border); border-radius:10px; background:var(--surface); font-size:12px';
        row.innerHTML=`<span style="font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:70%">${m.id}</span><span class="xs muted">${m.name? m.name.slice(0,40):''}</span>`;
        row.style.cursor='pointer';
        row.onclick=()=> { localStorage.setItem('preferredModel', m.id); if(sel) sel.value=m.id; toast('Preferred model: '+m.id,'success'); };
        list.appendChild(row);
      }
    }
    log(`Models ${models.length}`);
  } catch (e) { log('Models failed: '+e.message); }
}

function incUsage(kind='request') {
  const key='usage_'+kind;
  const n = parseInt(localStorage.getItem(key)||'0',10)+1;
  localStorage.setItem(key, String(n));
  updateUsageUI();
}
function updateUsageUI() {
  const req = parseInt(localStorage.getItem('usage_request')||'0',10) + parseInt(localStorage.getItem('usage_health')||'0',10);
  const tok = parseInt(localStorage.getItem('usage_tokens')||'0',10);
  const err = parseInt(localStorage.getItem('usage_error')||'0',10);
  for (const id of ['usageRequests','uReq']) { const el=document.getElementById(id); if(el) el.textContent=String(req); }
  for (const id of ['usageTokens','uTok']) { const el=document.getElementById(id); if(el) el.textContent=String(tok); }
  for (const id of ['uErr']) { const el=document.getElementById(id); if(el) el.textContent=String(err); }
}
function resetUsage() { for(const k of ['usage_request','usage_tokens','usage_error','usage_health']) localStorage.removeItem(k); updateUsageUI(); toast('Counters reset','info'); log('Usage reset'); }
function clearLocal() { if(confirm('Clear all local dashboard data (backend URL, devices, usage, capture config, model)?')) { localStorage.clear(); location.reload(); } }
function copyHealth() { navigator.clipboard.writeText(healthPre.textContent||'').then(()=> toast('Copied','success')); }
function clearLogs() { logs=[]; if(clientLogs) clientLogs.textContent='—'; toast('Logs cleared','info'); }
async function testStream() {
  const backend=getBackend();
  log('Test stream POST /api/vision/analyze?stream=true');
  try {
    const res = await fetch(new URL('/api/vision/analyze?stream=true', backend).toString(), { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ prompt:'Say hello in a code block', imageBase64:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', stream:true }) });
    if (!res.ok || !res.body) throw new Error('HTTP '+res.status);
    const reader=res.body.getReader(); const dec=new TextDecoder(); let buf=''; let got=false;
    while(true){ const{done,value}=await reader.read(); if(done) break; buf+=dec.decode(value,{stream:true}); const parts=buf.split('\n\n'); buf=parts.pop()||''; for(const p of parts){ if(p.includes('event: delta')) got=true; log(p.slice(0,120)); } }
    toast(got? 'Stream OK — saw delta':'Stream finished','success'); incUsage('request');
  } catch(e){ log('Stream failed: '+e.message); toast('Stream failed: '+e.message,'error'); incUsage('error'); }
}

// Capture config local
function loadCapture() {
  let cfg; try{ cfg=JSON.parse(localStorage.getItem('captureConfig')||'null'); }catch{}
  cfg = cfg || { intervalMs:1500, scaleFactor:0.6, jpegQuality:75, diffThresholdPercent:3, enableFrameDiff:true, autoAnalyze:false, stream:true };
  const set = (id,val)=> { const el=document.getElementById(id); if(el) el.value=val; };
  const setTxt=(id,val)=> { const el=document.getElementById(id); if(el) el.textContent=val; };
  if(document.getElementById('cInterval')) { set('cInterval', cfg.intervalMs); setTxt('cIntervalVal', cfg.intervalMs+'ms'); set('cScale', Math.round(cfg.scaleFactor*100)); setTxt('cScaleVal', Math.round(cfg.scaleFactor*100)+'%'); set('cQuality', cfg.jpegQuality); setTxt('cQualityVal', cfg.jpegQuality); set('cDiff', cfg.diffThresholdPercent); setTxt('cDiffVal', cfg.diffThresholdPercent+'%'); const a=document.getElementById('cDiffChk'); if(a) a.checked=!!cfg.enableFrameDiff; const b=document.getElementById('cAuto'); if(b) b.checked=!!cfg.autoAnalyze; const c=document.getElementById('cStream'); if(c) c.checked=cfg.stream!==false; }
}
function saveCapture() {
  const cfg = {
    intervalMs: parseInt(document.getElementById('cInterval').value,10),
    scaleFactor: parseInt(document.getElementById('cScale').value,10)/100,
    jpegQuality: parseInt(document.getElementById('cQuality').value,10),
    diffThresholdPercent: parseFloat(document.getElementById('cDiff').value),
    enableFrameDiff: document.getElementById('cDiffChk').checked,
    autoAnalyze: document.getElementById('cAuto').checked,
    stream: document.getElementById('cStream').checked,
  };
  localStorage.setItem('captureConfig', JSON.stringify(cfg));
  log('Capture config saved locally');
  toast('Capture settings saved','success');
}
function resetCapture() { localStorage.removeItem('captureConfig'); loadCapture(); toast('Capture reset','info'); }

// Nav
$$('.nav-item[data-view]').forEach(el=>{
  el.addEventListener('click', ()=>{
    const view=el.getAttribute('data-view');
    $$('.nav-item').forEach(n=> n.classList.remove('active'));
    el.classList.add('active');
    $$('.view').forEach(v=> v.classList.toggle('hidden', v.getAttribute('data-view')!==view));
    const titles={overview:['Overview','Live backend • secure'], devices:['Devices','Local only'], models:['Models','Server default (env)'], capture:['Capture','Defaults work'], usage:['Usage','Local estimate'], logs:['Diagnostics','Health & logs'], api:['API Reference','Shared protocol 1.0.0'] };
    const t=titles[view]||[view, ''];
    $('#viewTitle').textContent=t[0]; $('#viewSubtitle').textContent=t[1];
  });
});

$('#btnMenu')?.addEventListener('click', ()=>{
  const s=document.querySelector('.sidebar'); const o=document.getElementById('sidebarOverlay');
  s?.classList.toggle('open'); o?.classList.toggle('open');
});
$$('.nav-item[data-view]').forEach(el=> el.addEventListener('click', ()=> { document.querySelector('.sidebar')?.classList.remove('open'); document.getElementById('sidebarOverlay')?.classList.remove('open'); }));
// Theme
$('#btnTheme')?.addEventListener('click', ()=>{
  const curr=document.documentElement.getAttribute('data-theme')||'dark';
  const next=curr==='dark'?'light':'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  toast('Theme: '+next,'info');
});
const savedTheme = localStorage.getItem('theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
document.documentElement.setAttribute('data-theme', savedTheme);

// Backend is env-driven (same origin) — hidden input kept for compat
if (backendInput) backendInput.value = location.origin;
if (connUrl) connUrl.textContent = location.origin;
if (footerBackend) footerBackend.textContent = location.origin;
$('#btnSaveBackend')?.addEventListener('click', ()=> { toast('Backend is env-driven — attached at deploy','info'); });
if (connUrl) connUrl.textContent = getBackend();
$('#btnHealth')?.addEventListener('click', refreshHealth);
$('#modelSelect')?.addEventListener('change', (e)=> { localStorage.setItem('preferredModel', e.target.value); toast('Model preference saved','success'); log('Preferred model '+ (e.target.value||'default')); });

// Capture sliders live labels
['cInterval','cScale','cQuality','cDiff'].forEach(id=>{
  const el=document.getElementById(id);
  if(!el) return;
  el.addEventListener('input', ()=>{
    const vals={ cInterval: el.value+'ms', cScale: el.value+'%', cQuality: el.value, cDiff: el.value+'%' };
    const tid = id+'Val'; const lab=document.getElementById(tid); if(lab) lab.textContent=vals[id];
  });
});

// Init — env-driven, no editable backend
renderDevices();
loadCapture();
updateUsageUI();
refreshHealth();
loadModels();
logs.push('Dashboard loaded — '+new Date().toLocaleString());
if (clientLogs) clientLogs.textContent = logs.join('\n');

// expose for HTML inline
window.testStream=testStream; window.clearLocal=clearLocal; window.registerThisDevice=registerThisDevice; window.refreshHealth=refreshHealth; window.copyHealth=copyHealth; window.clearLogs=clearLogs; window.saveCapture=saveCapture; window.resetCapture=resetCapture; window.resetUsage=resetUsage;
