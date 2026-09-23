import 'dotenv/config';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import crypto from 'node:crypto';
import { config } from './config.js';

if (config.railwayOnly && !(process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID || process.env.RAILWAY_ENVIRONMENT_ID)) {
  console.error('[STAVEN] This build is restricted to Railway.');
  process.exit(1);
}
import {
  loadSessionState,
  getSessionState,
  getRefreshStats,
  registerSession,
  replaceSession,
  removeSession,
  checkSession,
  manualRefresh,
  cleanupRefresh,
} from './session.js';
import { protections, redact } from './security.js';import { loadRoles,
  getRoles,
  getStagedRoles,
  getUserRole,
  addUserToStage,
  removeUserFromStage,
  stageRoles,
  saveRolesFromData,
  commitPendingRoles,
  discardPendingRoles,
} from './roles.js';

process.on('uncaughtException', e => console.error('[STAVEN BLUE V1]', redact(e?.message || e)));
process.on('unhandledRejection', e => console.error('[STAVEN BLUE V1]', redact(e?.message || e)));

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(rateLimit({ windowMs: 60_000, limit: 120 }));

/* ── Token-based session auth ────────────────────────────── */
const TOKEN_TTL = 7 * 24 * 60 * 60 * 1000;
const activeTokens = new Map();

function generateToken() {
  const token = crypto.randomUUID();
  activeTokens.set(token, Date.now() + TOKEN_TTL);
  return token;
}

function isValidToken(token) {
  if (!token) return false;
  const expiresAt = activeTokens.get(token);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) { activeTokens.delete(token); return false; }
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of activeTokens) { if (now > exp) activeTokens.delete(t); }
}, 60 * 60 * 1000);

function parseCookies(req) {
  const c = {};
  for (const pair of (req.headers.cookie || '').split(';')) {
    const [k, ...r] = pair.trim().split('=');
    if (k) c[k.trim()] = r.join('=').trim();
  }
  return c;
}

function requireAuth(req, res, next) {
  if (isValidToken(parseCookies(req)['staven_token'])) return next();
  return res.redirect('/login');
}

/* ── Public routes ───────────────────────────────────────── */

app.get('/health', (_req, res) => res.json({
  ok: true, name: 'STAVEN BLUE V1', uptime: process.uptime()
}));

app.get('/login', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>STAVEN BLUE V1 — Login</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#090b10;color:#eef1f6;font-family:Inter,system-ui,-apple-system,sans-serif}
.login-box{background:#131720;border:1px solid #252b38;border-radius:18px;padding:40px;width:100%;max-width:380px;box-shadow:0 10px 35px #0003}
h1{font-size:22px;margin-bottom:4px}
.subtitle{color:#929caf;margin-bottom:28px;font-size:14px}
.field{margin-bottom:16px}
.field label{display:block;font-size:13px;color:#929caf;margin-bottom:6px}
.field input{width:100%;padding:11px 14px;border:1px solid #252b38;border-radius:11px;background:#0e1017;color:#eef1f6;font-size:15px;outline:none;transition:border-color .2s}
.field input:focus{border-color:#4f7cff}
button{width:100%;padding:12px;border:0;border-radius:11px;background:#4f7cff;color:#fff;font-weight:700;font-size:15px;cursor:pointer;transition:background .2s}
button:hover{background:#3d6ae0}
.error{color:#ff6b6b;font-size:13px;margin-bottom:14px;display:none}
</style>
</head>
<body>
<div class="login-box">
  <h1>STAVEN BLUE V1</h1>
  <div class="subtitle">Control Center Login</div>
  <div class="error" id="err">Invalid username or password</div>
  <form method="POST" action="/login">
    <div class="field">
      <label for="u">Username</label>
      <input type="text" id="u" name="username" autocomplete="username" required autofocus>
    </div>
    <div class="field">
      <label for="p">Password</label>
      <input type="password" id="p" name="password" autocomplete="current-password" required>
    </div>
    <button type="submit">Sign In</button>
  </form>
</div>
<script>
if(new URLSearchParams(location.search).get('error')==='1')document.getElementById('err').style.display='block';
</script>
</body>
</html>`);
});

app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === config.dashboardUser && password === config.dashboardPassword) {
    const token = generateToken();
    res.setHeader('Set-Cookie', `staven_token=${token}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${TOKEN_TTL / 1000}`);
    return res.redirect('/');
  }
  return res.redirect('/login?error=1');
});

app.get('/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'staven_token=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0');
  return res.redirect('/login');
});

/* ── Protected API routes ────────────────────────────────── */
function apiAuth(req, res, next) {
  if (isValidToken(parseCookies(req)['staven_token'])) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

app.get('/api/health', apiAuth, (_req, res) => res.json({
  ok: true, name: 'STAVEN BLUE V1', uptime: process.uptime()
}));

app.get('/api/session', apiAuth, (_req, res) => {
  res.json(getSessionState());
});

app.post('/api/session/register', apiAuth, async (req, res) => {
  try {
    const appState = req.body?.appState;
    if (!appState) return res.status(400).json({ ok: false, error: 'appState is required in request body' });
    const result = await registerSession(appState);
    if (result.error) return res.status(400).json({ ok: false, error: result.error });
    res.json({ ok: true, state: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed to register session' });
  }
});

app.post('/api/session/replace', apiAuth, async (req, res) => {
  try {
    const appState = req.body?.appState;
    if (!appState) return res.status(400).json({ ok: false, error: 'appState is required in request body' });
    const result = await replaceSession(appState);
    if (result.error) return res.status(400).json({ ok: false, error: result.error });
    res.json({ ok: true, state: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed to replace session' });
  }
});

app.post('/api/session/remove', apiAuth, async (_req, res) => {
  try {
    const result = await removeSession();
    res.json({ ok: true, state: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed to remove session' });
  }
});

app.post('/api/session/check', apiAuth, async (_req, res) => {
  try {
    const result = await checkSession();
    res.json({ ok: true, state: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed to check session' });
  }
});

app.get('/api/session/refresh-stats', apiAuth, (_req, res) => {
  res.json(getRefreshStats());
});

app.post('/api/session/refresh', apiAuth, async (_req, res) => {
  try {
    const result = await manualRefresh();
    if (!result) return res.json({ ok: false, error: 'Refresh already in progress or no session configured' });
    if (result.error) return res.json({ ok: false, error: result.error });
    res.json({ ok: true, state: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Refresh failed' });
  }
});

/* ── Roles / Admin Management API ────────────────────── */

app.get('/api/roles', apiAuth, (_req, res) => {
  res.json(getRoles());
});

app.get('/api/roles/staged', apiAuth, (_req, res) => {
  const staged = getStagedRoles();
  res.json({ staged: staged || getRoles() });
});

app.get('/api/roles/limits', apiAuth, (_req, res) => {
  res.json({ owner: 1, superAdmin: 15, admin: 20 });
});

app.post('/api/roles/add', apiAuth, (req, res) => {
  const { userId, role } = req.body || {};
  if (!userId || !role) return res.status(400).json({ ok: false, error: 'userId and role are required' });
  const result = addUserToStage(userId, role);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/roles/remove', apiAuth, (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ ok: false, error: 'userId is required' });
  const result = removeUserFromStage(userId);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

app.post('/api/roles/save', apiAuth, async (req, res) => {
  try {
    // Accept staged data from request body (frontend sends full state)
    const bodyData = req.body;
    if (bodyData && bodyData.owner) {
      const result = await saveRolesFromData(bodyData);
      if (!result.ok) return res.status(400).json(result);
      return res.json(result);
    }
    // Fallback: commit existing server-side pending state
    const result = await commitPendingRoles();
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed to save roles' });
  }
});

app.post('/api/roles/discard', apiAuth, (_req, res) => {
  discardPendingRoles();
  res.json({ ok: true });
});

/* ── Dashboard (protected by cookie) ────────────────────── */
app.get('/', requireAuth, (_req, res) => {
  const protectionText = JSON.stringify(protections.map(x => '\u2713 ' + x).join('\n'));
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>STAVEN BLUE V1 Control Center</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#090b10;color:#eef1f6;font-family:Inter,system-ui,-apple-system,sans-serif}
main{max-width:1100px;margin:auto;padding:28px}
.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;flex-wrap:wrap;gap:12px}
h1{margin:0;font-size:34px}
h2{margin:0 0 16px;font-size:20px;color:#eef1f6}
.muted{color:#929caf}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:16px}
.card{background:#131720;border:1px solid #252b38;border-radius:18px;padding:20px;box-shadow:0 10px 35px #0003}
.v{font-size:27px;font-weight:750;margin-top:8px}
button{padding:11px 15px;border:0;border-radius:11px;font-weight:700;cursor:pointer;transition:opacity .2s}
button:disabled{opacity:.5;cursor:not-allowed}
pre{white-space:pre-wrap;line-height:1.65}
.status{margin-top:12px}
.btn-secondary{background:#252b38;color:#eef1f6}.btn-secondary:hover{background:#353d4e}
.top-right{display:flex;gap:10px;align-items:center}
.btn-sm{padding:7px 14px;font-size:13px}
.btn-green{background:#16a34a;color:#fff}.btn-green:hover{background:#15803d}
.btn-blue{background:#2563eb;color:#fff}.btn-blue:hover{background:#1d4ed8}
.btn-orange{background:#d97706;color:#fff}.btn-orange:hover{background:#b45309}
.btn-red{background:#dc2626;color:#fff}.btn-red:hover{background:#b91c1c}
.session-info{display:grid;grid-template-columns:1fr 1fr;gap:8px 24px;font-size:14px}
.session-info .lbl{color:#929caf}
.session-info .val{color:#eef1f6;font-weight:600}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;padding-top:16px;border-top:1px solid #252b38}
.appstate-area{margin-top:16px}
.appstate-area label{display:block;font-size:13px;color:#929caf;margin-bottom:6px}
.appstate-area textarea{width:100%;min-height:80px;padding:10px 12px;border:1px solid #252b38;border-radius:11px;background:#0e1017;color:#eef1f6;font-size:13px;font-family:monospace;resize:vertical;outline:none;transition:border-color .2s}
.appstate-area textarea:focus{border-color:#4f7cff}
.toast{position:fixed;top:20px;right:20px;padding:12px 20px;border-radius:11px;font-weight:600;font-size:14px;z-index:9999;display:none;box-shadow:0 4px 15px #0005;max-width:90vw}
.toast-ok{background:#16a34a;color:#fff}
.toast-err{background:#dc2626;color:#fff}
.status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
.dot-green{background:#22c55e}.dot-yellow{background:#eab308}.dot-red{background:#ef4444}.dot-gray{background:#6b7280}
</style>
</head>
<body><main>
<div class="top"><div><h1>STAVEN BLUE V1</h1><div class="muted">Control Center</div></div>
<div class="top-right"><button class="btn-secondary" onclick="location.href='/logout'">Logout</button><button onclick="refresh()">Refresh</button></div>
</div>

<nav style="display:flex;gap:0;margin-bottom:24px;background:#131720;border-radius:14px;border:1px solid #252b38;overflow:hidden;width:fit-content">
<a href="/" style="padding:10px 24px;text-decoration:none;color:#eef1f6;font-weight:700;font-size:14px;background:#4f7cff">Main</a>
<a href="/settings" style="padding:10px 24px;text-decoration:none;color:#929caf;font-weight:600;font-size:14px;transition:background .2s" onmouseover="this.style.background='#1a1f2e'" onmouseout="this.style.background='transparent'">Settings</a>
</nav>

<div class="grid" id="cards">
<div class="card"><div class="muted">Bot</div><div class="v" id="bot-status">\u2014</div></div>
<div class="card"><div class="muted">Uptime</div><div class="v" id="uptime">\u2014</div></div>
<div class="card"><div class="muted">Session</div><div class="v" id="session">\u2014</div></div>
</div>

<div class="card" style="margin-top:16px">
<h2>Session / Authentication</h2>
<div id="conn-banner" style="display:flex;align-items:center;gap:8px;padding:12px 16px;border-radius:11px;margin-bottom:16px;font-weight:600;font-size:14px;background:#1a1f2e;border:1px solid #252b38">
<span class="status-dot dot-gray" id="conn-dot"></span>
<span id="conn-label">Disconnected</span>
</div>
<div class="session-info">
<div><span class="lbl">Status: </span><span class="val" id="sm-status">\u2014</span></div>
<div><span class="lbl">State: </span><span class="val" id="sm-state">\u2014</span></div>
<div><span class="lbl">Last Check: </span><span class="val" id="sm-last-check">\u2014</span></div>
<div><span class="lbl">Last Failed: </span><span class="val" id="sm-last-fail">\u2014</span></div>
<div><span class="lbl">Created: </span><span class="val" id="sm-created">\u2014</span></div>
<div><span class="lbl">Reference: </span><span class="val" id="sm-ref">\u2014</span></div>
<div><span class="lbl">Last Error: </span><span class="val" id="sm-error" style="color:#ef4444">\u2014</span></div>
</div>

<div class="appstate-area">
<label for="appstate-input">Facebook Session Data</label>
<div style="font-size:12px;color:#6b7280;margin-bottom:8px">Paste your appstate as a <b>JSON array</b> or <b>cookie string</b> (e.g. c_user=...; xs=...)</div>
<textarea id="appstate-input" placeholder='[{"key":"c_user","value":"123456","domain":".facebook.com"},\n {"key":"xs","value":"abc123...","domain":".facebook.com"}]\n\nOr cookie string: c_user=123456; xs=abc123...'></textarea>
</div>

<div class="actions">
<button class="btn-sm btn-green" id="btn-register" onclick="smAction('register')">Connect</button>
<button class="btn-sm btn-blue" id="btn-replace" onclick="smAction('replace')">Replace Session</button>
<button class="btn-sm btn-red" id="btn-remove" onclick="smAction('remove')">Remove Session</button>
<button class="btn-sm btn-orange" id="btn-check" onclick="smAction('check')">Check Status</button>
</div>
<div class="muted status" id="sm-msg"></div>
</div>

<div class="card" style="margin-top:16px">
<h2>Cookie / Session Refresh</h2>
<div class="session-info" style="margin-bottom:16px">
<div><span class="lbl">Successful Refreshes: </span><span class="val" id="rf-success">0</span></div>
<div><span class="lbl">Failed Refreshes: </span><span class="val" id="rf-failed" style="color:#ef4444">0</span></div>
<div><span class="lbl">Total Attempts: </span><span class="val" id="rf-total">0</span></div>
<div><span class="lbl">Last Successful: </span><span class="val" id="rf-last-ok">\u2014</span></div>
<div><span class="lbl">Last Failed: </span><span class="val" id="rf-last-fail">\u2014</span></div>
<div><span class="lbl">Next Auto Refresh: </span><span class="val" id="rf-next">\u2014</span></div>
<div><span class="lbl">Current Session: </span><span class="val" id="rf-status">\u2014</span></div>
<div><span class="lbl">Refresh Interval: </span><span class="val" id="rf-interval">\u2014</span></div>
</div>
<div class="actions">
<button class="btn-sm btn-green" id="btn-refresh" onclick="refreshSession()">Refresh Now</button>
<button class="btn-sm btn-orange" id="btn-rf-check" onclick="smAction('check')">Check Session</button>
</div>
<div class="muted status" id="rf-msg"></div>
</div>

<div class="card" style="margin-top:16px"><h2>Security</h2><pre id="security"></pre></div>
</main>

<div class="toast" id="toast"></div>

<script>
var H={'Content-Type':'application/json'};
var BOT_DOT={connecting:'dot-yellow',connected:'dot-green',disconnected:'dot-gray',error:'dot-red'};
var BOT_LABEL={connecting:'Connecting',connected:'Connected',disconnected:'Offline',error:'Error'};

function showToast(msg,ok){
  var t=document.getElementById('toast');
  t.textContent=msg;
  t.className='toast '+(ok?'toast-ok':'toast-err');
  t.style.display='block';
  setTimeout(function(){t.style.display='none'},4000);
}

function fmt(iso){
  if(!iso)return'\u2014';
  try{return new Date(iso).toLocaleString()}catch{return iso}
}

function updateUI(s){
  var bs=s.botStatus||s.status||'disconnected';
  document.getElementById('bot-status').innerHTML='<span class="status-dot '+(BOT_DOT[bs]||'dot-gray')+'"></span>'+(BOT_LABEL[bs]||bs);
  document.getElementById('uptime').textContent=Math.floor((s.uptime||0))+'s';
  document.getElementById('session').textContent=BOT_LABEL[bs]||s.status||'\u2014';
  var cd=document.getElementById('conn-dot');var cl=document.getElementById('conn-label');
  if(cd){cd.className='status-dot '+(BOT_DOT[bs]||'dot-gray');}if(cl){cl.textContent=BOT_LABEL[bs]||bs||'Disconnected';}
  document.getElementById('sm-status').textContent=BOT_LABEL[bs]||s.status||'\u2014';
  document.getElementById('sm-state').textContent=s.configured?'Configured':'Not Configured';
  document.getElementById('sm-last-check').textContent=fmt(s.lastCheck);
  document.getElementById('sm-last-fail').textContent=fmt(s.lastFailedCheck);
  document.getElementById('sm-created').textContent=fmt(s.createdAt);
  document.getElementById('sm-ref').textContent=s.sessionRef||'\u2014';
  document.getElementById('sm-error').textContent=s.error||s.lastBotError||'\u2014';
}

async function refresh(){
  try{
    var a=await fetch('/api/health',{headers:H});
    var s=await fetch('/api/session',{headers:H});
    if(!a.ok||!s.ok){location.reload();return}
    var aj=await a.json(),sj=await s.json();
    sj.uptime=aj.uptime;
    updateUI(sj);
  }catch(e){
    document.getElementById('sm-msg').textContent='Refresh failed';
  }
}

function setLoading(loading){
  var btns=['btn-register','btn-replace','btn-remove','btn-check'];
  btns.forEach(function(id){document.getElementById(id).disabled=loading});
}

async function smAction(action){
  var el=document.getElementById('sm-msg');
  var input=document.getElementById('appstate-input');
  el.textContent='Processing...';
  setLoading(true);

  try{
    var body={};
    if(action==='register'||action==='replace'){
      var val=input.value.trim();
      if(!val){showToast('Paste appstate data first',false);el.textContent='';setLoading(false);return}
      try{body.appState=JSON.parse(val)}catch(e){body.appState=val}
    }

    var r=await fetch('/api/session/'+action,{method:'POST',headers:H,body:JSON.stringify(body)});
    var j=await r.json();

    if(j.ok){
      showToast(action.charAt(0).toUpperCase()+action.slice(1)+' successful',true);
      if(action==='remove')input.value='';
      updateUI(j.state);
      el.textContent='';
    }else{
      showToast(j.error||'Operation failed',false);
      el.textContent=j.error||'Failed';
    }
  }catch(e){
    showToast('Network error',false);
    el.textContent='Network error';
  }finally{
    setLoading(false);
  }
}

document.getElementById('security').textContent=${protectionText};
function fmtMs(ms){
  if(!ms)return'\u2014';
  var m=Math.floor(ms/60000),s=Math.floor((ms%60000)/1000);
  if(m>0)return m+' min '+s+' sec';
  return s+' sec';
}

async function loadRefreshStats(){
  try{
    var r=await fetch('/api/session/refresh-stats',{headers:H});
    if(!r.ok)return;
    var j=await r.json();
    document.getElementById('rf-success').textContent=j.successfulRefreshes||0;
    document.getElementById('rf-failed').textContent=j.failedRefreshes||0;
    document.getElementById('rf-total').textContent=j.totalAttempts||0;
    document.getElementById('rf-last-ok').textContent=fmt(j.lastSuccessfulRefresh);
    document.getElementById('rf-last-fail').textContent=fmt(j.lastFailedRefresh);
    document.getElementById('rf-next').textContent=fmt(j.nextAutomaticRefresh);
    document.getElementById('rf-interval').textContent=fmtMs(j.refreshInterval);
    var ss=j.currentSessionStatus||'\u2014';
    var sEl=document.getElementById('rf-status');
    sEl.textContent=ss;
    if(ss==='Connected')sEl.style.color='#22c55e';
    else if(ss==='Re-authentication Required')sEl.style.color='#ef4444';
    else if(ss==='Connecting')sEl.style.color='#eab308';
    else sEl.style.color='#eef1f6';
  }catch(e){}
}

async function refreshSession(){
  var el=document.getElementById('rf-msg');
  var btn=document.getElementById('btn-refresh');
  btn.disabled=true;
  btn.textContent='Refreshing...';
  el.textContent='Performing refresh...';
  try{
    var r=await fetch('/api/session/refresh',{method:'POST',headers:H});
    var j=await r.json();
    if(j.ok){
      showToast('Refresh successful',true);
      el.textContent='';
      updateUI(j.state);
    }else{
      showToast(j.error||'Refresh failed',false);
      el.textContent=j.error||'Refresh failed';
    }
  }catch(e){
    showToast('Network error',false);
    el.textContent='Network error';
  }finally{
    btn.disabled=false;
    btn.textContent='Refresh Now';
    loadRefreshStats();
  }
}

refresh();
loadRefreshStats();
setInterval(refresh,15000);
setInterval(loadRefreshStats,15000);
</script>
</body></html>`);
});

/* ── Settings page (protected by cookie) ──────────────── */
app.get('/settings', requireAuth, (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>STAVEN BLUE V1 — Settings</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#090b10;color:#eef1f6;font-family:Inter,system-ui,-apple-system,sans-serif}
main{max-width:1100px;margin:auto;padding:28px}
.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;flex-wrap:wrap;gap:12px}
h1{margin:0;font-size:34px}
h2{margin:0 0 16px;font-size:20px;color:#eef1f6}
.muted{color:#929caf}
.card{background:#131720;border:1px solid #252b38;border-radius:18px;padding:20px;box-shadow:0 10px 35px #0003}
button{padding:11px 15px;border:0;border-radius:11px;font-weight:700;cursor:pointer;transition:opacity .2s}
button:disabled{opacity:.5;cursor:not-allowed}
.btn-secondary{background:#252b38;color:#eef1f6}.btn-secondary:hover{background:#353d4e}
.btn-sm{padding:7px 14px;font-size:13px}
.btn-green{background:#16a34a;color:#fff}.btn-green:hover{background:#15803d}
.btn-blue{background:#2563eb;color:#fff}.btn-blue:hover{background:#1d4ed8}
.btn-orange{background:#d97706;color:#fff}.btn-orange:hover{background:#b45309}
.btn-red{background:#dc2626;color:#fff}.btn-red:hover{background:#b91c1c}
.toast{position:fixed;top:20px;right:20px;padding:12px 20px;border-radius:11px;font-weight:600;font-size:14px;z-index:9999;display:none;box-shadow:0 4px 15px #0005;max-width:90vw}
.toast-ok{background:#16a34a;color:#fff}
.toast-err{background:#dc2626;color:#fff}
.role-section{margin-bottom:24px}
.role-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.role-badge{display:inline-block;padding:3px 10px;border-radius:8px;font-size:12px;font-weight:700;margin-right:8px}
.role-owner{background:#854d0e;color:#fbbf24}
.role-super{background:#1e3a5f;color:#60a5fa}
.role-admin{background:#1a3a2a;color:#4ade80}
.user-row{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#0e1017;border:1px solid #252b38;border-radius:11px;margin-bottom:8px;font-size:14px}
.user-row .uid{font-family:monospace;color:#eef1f6}
.user-row .remove-btn{background:#dc2626;color:#fff;border:0;padding:5px 12px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer}
.user-row .remove-btn:hover{background:#b91c1c}
.add-form{display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin-top:12px}
.add-form .field{flex:1;min-width:120px}
.add-form label{display:block;font-size:12px;color:#929caf;margin-bottom:4px}
.add-form input,.add-form select{width:100%;padding:9px 12px;border:1px solid #252b38;border-radius:9px;background:#0e1017;color:#eef1f6;font-size:13px;outline:none}
.add-form input:focus,.add-form select:focus{border-color:#4f7cff}
.count{font-size:13px;color:#929caf;margin-bottom:8px}
.pending-bar{display:flex;align-items:center;gap:10px;padding:10px 14px;background:#78350f;border:1px solid #92400e;border-radius:11px;margin-top:16px;color:#fbbf24;font-size:13px;font-weight:600}
.empty{padding:16px;color:#6b7280;font-size:13px;font-style:italic}
</style>
</head>
<body><main>
<div class="top"><div><h1>STAVEN BLUE V1</h1><div class="muted">Settings</div></div>
<div class="top-right" style="display:flex;gap:10px;align-items:center"><a href="/" style="text-decoration:none;padding:11px 15px;border-radius:11px;font-weight:700;background:#252b38;color:#eef1f6;display:inline-block">← Main</a><button class="btn-secondary" onclick="location.href='/logout'">Logout</button></div>
</div>

<nav style="display:flex;gap:0;margin-bottom:24px;background:#131720;border-radius:14px;border:1px solid #252b38;overflow:hidden;width:fit-content">
<a href="/" style="padding:10px 24px;text-decoration:none;color:#929caf;font-weight:600;font-size:14px;transition:background .2s" onmouseover="this.style.background='#1a1f2e'" onmouseout="this.style.background='transparent'">Main</a>
<a href="/settings" style="padding:10px 24px;text-decoration:none;color:#eef1f6;font-weight:700;font-size:14px;background:#4f7cff">Settings</a>
</nav>

<div class="card">
<h2>Admin Management</h2>
<div class="muted" style="margin-bottom:16px;font-size:13px">Manage bot command permissions. Changes are staged until you click <b>Save Changes</b>.</div>

<div class="pending-bar" id="pending-bar" style="display:none">
⚠ <span id="pending-count">0</span> uncommitted change(s) — click Save Changes to apply.
<button class="btn-sm btn-orange" onclick="discardChanges()" style="margin-left:auto">Discard</button>
</div>

<!-- OWNER -->
<div class="role-section">
<div class="role-header">
<div><span class="role-badge role-owner">OWNER</span><b>Owner</b></div>
<div class="count"><span id="owner-count">0</span> / 1</div>
</div>
<div id="owner-list"></div>
<div class="add-form">
<div class="field"><label>User ID</label><input id="owner-uid" placeholder="e.g. 1000123456789"></div>
<button class="btn-sm btn-green" onclick="addUser('owner')">Add Owner</button>
</div>
</div>

<!-- SUPER ADMINS -->
<div class="role-section">
<div class="role-header">
<div><span class="role-badge role-super">SUPER ADMIN</span><b>Super Admins</b></div>
<div class="count"><span id="super-count">0</span> / 15</div>
</div>
<div id="super-list"></div>
<div class="add-form">
<div class="field"><label>User ID</label><input id="super-uid" placeholder="e.g. 1000123456789"></div>
<button class="btn-sm btn-blue" onclick="addUser('superAdmin')">Add Super Admin</button>
</div>
</div>

<!-- ADMINS -->
<div class="role-section">
<div class="role-header">
<div><span class="role-badge role-admin">ADMIN</span><b>Admins</b></div>
<div class="count"><span id="admin-count">0</span> / 20</div>
</div>
<div id="admin-list"></div>
<div class="add-form">
<div class="field"><label>User ID</label><input id="admin-uid" placeholder="e.g. 1000123456789"></div>
<button class="btn-sm btn-orange" onclick="addUser('admin')">Add Admin</button>
</div>
</div>

<div style="margin-top:20px;display:flex;gap:10px;flex-wrap:wrap">
<button id="btn-save" class="btn-green" onclick="saveChanges()">Save Changes</button>
<button id="btn-discard" class="btn-secondary" onclick="discardChanges()">Discard</button>
</div>
<div id="settings-msg" class="muted" style="margin-top:10px"></div>
</div>
</main>

<div class="toast" id="toast"></div>

<script>
var H={'Content-Type':'application/json'};
var staged={owner:[],superAdmins:[],admins:[]};
var committed={owner:[],superAdmins:[],admins:[]};
var saving=false;

function showToast(m,ok){
  var t=document.getElementById('toast');
  t.textContent=m;t.className='toast '+(ok?'toast-ok':'toast-err');t.style.display='block';
  setTimeout(function(){t.style.display='none'},4000);
}

function renderUsers(listId,users){
  var el=document.getElementById(listId);
  if(!users||users.length===0){el.innerHTML='<div class="empty">No users</div>';return}
  el.innerHTML=users.map(function(uid){
    return '<div class="user-row"><span class="uid">User ID: '+uid+'</span><button class="remove-btn" onclick="removeUser(&quot;'+uid+'&quot;)">Remove</button></div>';
  }).join('');
}

function renderAll(){
  renderUsers('owner-list',staged.owner);
  renderUsers('super-list',staged.superAdmins);
  renderUsers('admin-list',staged.admins);
  document.getElementById('owner-count').textContent=staged.owner.length;
  document.getElementById('super-count').textContent=staged.superAdmins.length;
  document.getElementById('admin-count').textContent=staged.admins.length;
  var changed=JSON.stringify(staged)!==JSON.stringify(committed);
  document.getElementById('pending-bar').style.display=changed?'flex':'none';
  if(changed){
    var n=0;
    var allS=[].concat(staged.owner,staged.superAdmins,staged.admins);
    var allC=[].concat(committed.owner,committed.superAdmins,committed.admins);
    allS.forEach(function(id){if(allC.indexOf(id)===-1)n++});
    allC.forEach(function(id){if(allS.indexOf(id)===-1)n++});
    document.getElementById('pending-count').textContent=Math.max(n,1);
  }
}

async function loadRoles(){
  try{
    var r1=await fetch('/api/roles',{headers:H});
    if(!r1.ok){showToast('Failed to load roles',false);return}
    committed=await r1.json();
    try{
      var r2=await fetch('/api/roles/staged',{headers:H});
      if(r2.ok){var d=await r2.json();if(d.staged)committed=d.staged;}
    }catch(e){}
    staged={owner:committed.owner?committed.owner.slice():[],superAdmins:committed.superAdmins?committed.superAdmins.slice():[],admins:committed.admins?committed.admins.slice():[]};
    renderAll();
  }catch(e){showToast('Failed to load roles: '+e.message,false)}
}

async function addUser(role){
  var inputMap={owner:'owner-uid',superAdmin:'super-uid',admin:'admin-uid'};
  var input=document.getElementById(inputMap[role]);
  var uid=input.value.trim();
  if(!uid){showToast('Enter a User ID',false);return}
  var r=await fetch('/api/roles/add',{method:'POST',headers:H,body:JSON.stringify({userId:uid,role:role})});
  var j=await r.json();
  if(j.ok&&j.staged){
    staged=j.staged;
    input.value='';
    renderAll();
    showToast('Added to pending changes',true);
  }else{
    showToast(j.error||'Failed to add',false);
  }
}

async function removeUser(uid){
  var r=await fetch('/api/roles/remove',{method:'POST',headers:H,body:JSON.stringify({userId:String(uid)})});
  var j=await r.json();
  if(j.ok&&j.staged){
    staged=j.staged;
    renderAll();
    showToast('Removed from pending changes',true);
  }else{
    showToast(j.error||'Failed to remove',false);
  }
}

async function saveChanges(){
  if(saving)return;
  saving=true;
  var btn=document.getElementById('btn-save');
  btn.disabled=true;btn.textContent='Saving...';
  var msg=document.getElementById('settings-msg');
  msg.textContent='';
  try{
    var body={owner:staged.owner.slice(),superAdmins:staged.superAdmins.slice(),admins:staged.admins.slice()};
    var r=await fetch('/api/roles/save',{method:'POST',headers:H,body:JSON.stringify(body)});
    var j=await r.json();
    if(r.ok&&j.ok){
      committed=j.roles;
      staged={owner:committed.owner?committed.owner.slice():[],superAdmins:committed.superAdmins?committed.superAdmins.slice():[],admins:committed.admins?committed.admins.slice():[]};
      renderAll();
      showToast('Changes saved successfully',true);
      msg.textContent='Saved.';msg.style.color='#22c55e';
    }else{
      var errMsg=j.error||'Failed to save';
      showToast(errMsg,false);
      msg.textContent=errMsg;msg.style.color='#ef4444';
    }
  }catch(e){showToast('Network error: '+e.message,false);msg.textContent='Network error';msg.style.color='#ef4444'}
  finally{saving=false;btn.disabled=false;btn.textContent='Save Changes'}
}

async function discardChanges(){
  await fetch('/api/roles/discard',{method:'POST',headers:H});
  staged={owner:committed.owner?committed.owner.slice():[],superAdmins:committed.superAdmins?committed.superAdmins.slice():[],admins:committed.admins?committed.admins.slice():[]};
  renderAll();
  showToast('Changes discarded',true);
}

loadRoles();
</script>
</body></html>`);
});

/* ── Start ───────────────────────────────────────────────── */

await loadRoles();
await loadSessionState();

const port = Number(process.env.PORT || config.port || 3000);
const host = '0.0.0.0';

app.listen(port, host, () => {
  console.log(`[STAVEN BLUE V1] listening on ${host}:${port}`);
});

function shutdown(signal) {
  console.log(`[STAVEN BLUE V1] ${signal} received, shutting down`);
  cleanupRefresh();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
