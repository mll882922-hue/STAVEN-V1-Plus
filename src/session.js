import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { startBot, stopBot, getBotState } from './bot.js';
import { config } from './config.js';

const STATE_FILE = path.resolve('data/session-state.json');
const APPSTATE_FILE = path.resolve('data/appstate.json');
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';

function encryptionKey() {
  return crypto.createHash('sha256').update(String(config.sessionEncryptionKey)).digest();
}

function encryptAtRest(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    alg: ENCRYPTION_ALGORITHM,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: ciphertext.toString('base64'),
  };
}

function decryptAtRest(envelope) {
  if (!envelope || envelope.version !== 1 || envelope.alg !== ENCRYPTION_ALGORITHM) return null;
  const decipher = crypto.createDecipheriv(
    ENCRYPTION_ALGORITHM,
    encryptionKey(),
    Buffer.from(envelope.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.data, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

const state = {
  configured: false,
  status: 'not_configured',
  updatedAt: null,
  lastCheck: null,
  lastFailedCheck: null,
  createdAt: null,
  sessionRef: null,
};

/* ── Refresh stats (persisted) ────────────────────────── */
const refreshStats = {
  successfulRefreshes: 0,
  failedRefreshes: 0,
  totalAttempts: 0,
  lastSuccessfulRefresh: null,
  lastFailedRefresh: null,
  nextAutomaticRefresh: null,
};

/* ── Auto-refresh timer ───────────────────────────────── */
let refreshTimer = null;
let refreshLock = false; // prevent concurrent refreshes

const DEFAULT_REFRESH_INTERVAL = 90 * 60 * 1000; // 90 minutes
function getRefreshInterval() {
  const env = process.env.SESSION_REFRESH_INTERVAL_MS;
  if (env) {
    const ms = Number(env);
    if (ms >= 60_000 && ms <= 7_200_000) return ms; // 1min to 2hr
  }
  return DEFAULT_REFRESH_INTERVAL;
}

function scheduleNextRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  const interval = getRefreshInterval();
  refreshStats.nextAutomaticRefresh = new Date(Date.now() + interval).toISOString();
  refreshTimer = setTimeout(async () => {
    await performRefresh('automatic');
    scheduleNextRefresh();
  }, interval);
  // Prevent timer from keeping the process alive
  if (refreshTimer.unref) refreshTimer.unref();
}

function stopRefreshTimer() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  refreshStats.nextAutomaticRefresh = null;
}

/* ── Persistence ────────────────────────────────────────── */

export async function loadSessionState() {
  try {
    const saved = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
    // Restore refresh stats if present
    if (saved.refreshStats) {
      Object.assign(refreshStats, saved.refreshStats);
    }
    // Restore core state (without refreshStats key)
    const { refreshStats: _, ...coreState } = saved;
    Object.assign(state, coreState);
  } catch { /* no saved state yet */ }

  // Try to auto-start bot if appstate exists on disk
  if (state.configured) {
    try {
      const appState = await loadAppstateFromDisk();
      if (appState && appState.length > 0) {
        await startBot(appState);
        scheduleNextRefresh();
      }
    } catch (e) {
      console.error('[SESSION] Auto-start bot failed:', e?.message);
      state.status = 'error';
    }
  }

  return { ...state };
}

async function saveState() {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify({
    ...state,
    refreshStats,
  }, null, 2));
  return { ...state };
}

export function getSessionState() {
  const bot = getBotState();
  return {
    ...state,
    botStatus: bot.status,
    lastConnected: bot.lastConnected,
    lastDisconnected: bot.lastDisconnected,
    lastBotError: bot.lastError,
  };
}

export function getRefreshStats() {
  const bot = getBotState();
  let sessionStatus = 'Disconnected';
  if (bot.status === 'connected') sessionStatus = 'Connected';
  else if (bot.status === 'connecting') sessionStatus = 'Connecting';
  else if (bot.status === 'error') sessionStatus = 'Re-authentication Required';

  // Check if session is stale (no successful refresh in a while)
  if (state.status === 'error') sessionStatus = 'Re-authentication Required';

  return {
    ...refreshStats,
    currentSessionStatus: sessionStatus,
    refreshInterval: getRefreshInterval(),
    nextAutomaticRefresh: refreshStats.nextAutomaticRefresh,
  };
}

/* ── File helpers ───────────────────────────────────────── */

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function loadAppstateFromDisk() {
  try {
    const raw = await fs.readFile(APPSTATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);

    // New encrypted format.
    if (parsed && parsed.version === 1 && parsed.alg === ENCRYPTION_ALGORITHM) {
      const plain = decryptAtRest(parsed);
      if (!plain) return null;
      try { return JSON.parse(plain); } catch { return plain; }
    }

    // Backward-compatible migration for an older plaintext file.
    if (Array.isArray(parsed) || typeof parsed === 'string') {
      try { await writeAppstate(parsed); } catch {}
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function maskRef(data) {
  try {
    const str = typeof data === 'string' ? data : JSON.stringify(data);
    const hash = crypto.createHash('sha256').update(str).digest('hex');
    return '\u2022\u2022\u2022\u2022\u2022\u2022' + hash.slice(-6);
  } catch {
    return null;
  }
}

function parseAppStateInput(input) {
  if (!input) return null;

  // Already parsed (array or object from JSON body)
  if (Array.isArray(input)) return input.length > 0 ? input : null;
  if (input && typeof input === 'object' && Array.isArray(input.appState)) {
    return input.appState.length > 0 ? input.appState : null;
  }

  // String input
  const trimmed = String(input).trim();
  if (!trimmed) return null;

  // Try JSON parse
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.length > 0 ? parsed : null;
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.appState)) {
      return parsed.appState.length > 0 ? parsed.appState : null;
    }
    return null;
  } catch {}

  // Raw cookie string: "c_user=...; xs=..."
  if (trimmed.includes('=') && trimmed.includes(';')) {
    return trimmed;
  }

  return null;
}

async function writeAppstate(data) {
  await fs.mkdir(path.dirname(APPSTATE_FILE), { recursive: true });
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  const envelope = encryptAtRest(str);
  await fs.writeFile(APPSTATE_FILE, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 });
  try { await fs.chmod(APPSTATE_FILE, 0o600); } catch {}
}

async function deleteAppstate() {
  try { await fs.unlink(APPSTATE_FILE); } catch {}
}

/* ── Session management operations ──────────────────────── */

export async function registerSession(appStateInput) {
  const parsed = parseAppStateInput(appStateInput);
  if (!parsed) {
    return { ...state, error: 'Invalid appstate data. Provide a JSON array of cookies or a raw cookie string.' };
  }

  const now = new Date().toISOString();
  await writeAppstate(parsed);

  state.configured = true;
  state.status = 'connecting';
  state.updatedAt = now;
  state.lastCheck = now;
  state.createdAt = state.createdAt || now;
  state.lastFailedCheck = null;
  state.sessionRef = maskRef(parsed);
  await saveState();

  // Start bot
  try {
    await startBot(parsed);
    state.status = 'connected';
    // Start auto-refresh after successful connection
    scheduleNextRefresh();
  } catch (e) {
    state.status = 'error';
    state.lastFailedCheck = new Date().toISOString();
    state.error = e?.message || 'Failed to connect';
  }
  state.updatedAt = new Date().toISOString();
  await saveState();
  return { ...state };
}

export async function replaceSession(appStateInput) {
  const parsed = parseAppStateInput(appStateInput);
  if (!parsed) {
    return { ...state, error: 'Invalid appstate data. Provide a JSON array of cookies or a raw cookie string.' };
  }

  const now = new Date().toISOString();
  await writeAppstate(parsed);

  state.configured = true;
  state.status = 'connecting';
  state.updatedAt = now;
  state.lastCheck = now;
  state.lastFailedCheck = null;
  state.error = null;
  state.createdAt = state.createdAt || now;
  state.sessionRef = maskRef(parsed);
  await saveState();

  // Restart bot with new appstate
  try {
    await startBot(parsed);
    state.status = 'connected';
    scheduleNextRefresh();
  } catch (e) {
    state.status = 'error';
    state.lastFailedCheck = new Date().toISOString();
    state.error = e?.message || 'Failed to connect';
  }
  state.updatedAt = new Date().toISOString();
  await saveState();
  return { ...state };
}

export async function removeSession() {
  await stopBot();
  await deleteAppstate();
  stopRefreshTimer();

  state.configured = false;
  state.status = 'not_configured';
  state.updatedAt = new Date().toISOString();
  state.lastCheck = null;
  state.lastFailedCheck = null;
  state.createdAt = null;
  state.sessionRef = null;
  state.error = null;

  // Reset refresh stats
  refreshStats.successfulRefreshes = 0;
  refreshStats.failedRefreshes = 0;
  refreshStats.totalAttempts = 0;
  refreshStats.lastSuccessfulRefresh = null;
  refreshStats.lastFailedRefresh = null;
  refreshStats.nextAutomaticRefresh = null;

  await saveState();
  return { ...state };
}

export async function checkSession() {
  const now = new Date().toISOString();
  const exists = await fileExists(APPSTATE_FILE);

  if (!exists) {
    state.configured = false;
    state.status = 'not_configured';
    state.lastFailedCheck = now;
    state.lastCheck = now;
    state.updatedAt = now;
    await saveState();
    return { ...state };
  }

  const appState = await loadAppstateFromDisk();
  state.sessionRef = appState ? maskRef(appState) : null;
  state.lastCheck = now;
  state.updatedAt = now;

  if (!appState || (Array.isArray(appState) && appState.length === 0)) {
    state.status = 'error';
    state.lastFailedCheck = now;
    state.configured = false;
    state.error = 'Appstate file is empty or invalid';
  } else {
    // Try to (re)start the bot
    state.configured = true;
    state.status = 'connecting';
    await saveState();
    try {
      await startBot(appState);
      state.status = 'connected';
      state.error = null;
    } catch (e) {
      state.status = 'error';
      state.lastFailedCheck = now;
      state.error = e?.message || 'Connection failed';
    }
  }

  await saveState();
  return { ...state };
}

/* ── Session Refresh ────────────────────────────────────── */

async function performRefresh(trigger) {
  // Prevent concurrent refreshes
  if (refreshLock) {
    console.log(`[SESSION] Refresh skipped — another ${trigger} refresh is already running`);
    return null;
  }

  // Only refresh if session is configured
  if (!state.configured) {
    console.log('[SESSION] Refresh skipped — no session configured');
    return null;
  }

  const appState = await loadAppstateFromDisk();
  if (!appState || (Array.isArray(appState) && appState.length === 0)) {
    refreshStats.totalAttempts++;
    refreshStats.failedRefreshes++;
    refreshStats.lastFailedRefresh = new Date().toISOString();
    state.status = 'error';
    state.lastFailedCheck = new Date().toISOString();
    state.error = 'No appstate data found on disk';
    await saveState();
    return { ...state };
  }

  refreshLock = true;
  refreshStats.totalAttempts++;

  try {
    // Restart bot with existing appstate (the FCA library reconnects)
    await startBot(appState);

    // Refresh successful
    refreshStats.successfulRefreshes++;
    refreshStats.lastSuccessfulRefresh = new Date().toISOString();
    state.status = 'connected';
    state.lastCheck = new Date().toISOString();
    state.lastFailedCheck = null;
    state.error = null;
    await saveState();
    console.log(`[SESSION] ${trigger} refresh successful (#${refreshStats.successfulRefreshes})`);
  } catch (e) {
    refreshStats.failedRefreshes++;
    refreshStats.lastFailedRefresh = new Date().toISOString();
    state.status = 'error';
    state.lastFailedCheck = new Date().toISOString();
    state.error = e?.message || 'Refresh failed';
    await saveState();
    console.error(`[SESSION] ${trigger} refresh failed:`, e?.message || e);
  } finally {
    refreshLock = false;
    state.updatedAt = new Date().toISOString();
    await saveState();
  }

  return { ...state };
}

/**
 * Manual refresh triggered by the user via "Refresh Now" button.
 * Returns the result and prevents concurrent refreshes.
 */
export async function manualRefresh() {
  return performRefresh('manual');
}

/**
 * Check if a refresh is currently in progress.
 */
export function isRefreshInProgress() {
  return refreshLock;
}

/**
 * Clean up timers on shutdown.
 */
export function cleanupRefresh() {
  stopRefreshTimer();
}
