import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_FILE = path.resolve('data/group-protections.json');

const protections = new Map(); // threadID -> config
const timers = new Map();      // threadID -> { titleTimer, nickTimer }
const pending = new Map();     // threadID -> timeout for event-triggered enforcement
const locks = new Map();       // threadID -> Promise

async function load() {
  try {
    const raw = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return;
    for (const [threadID, cfg] of Object.entries(raw)) {
      if (!cfg || typeof cfg !== 'object') continue;
      protections.set(String(threadID), {
        title: typeof cfg.title === 'string' ? cfg.title : null,
        titleIntervalMs: validInterval(cfg.titleIntervalMs),
        nickname: typeof cfg.nickname === 'string' ? cfg.nickname : null,
        nicknameIntervalMs: validInterval(cfg.nicknameIntervalMs),
        enabled: cfg.enabled !== false,
      });
    }
  } catch {}
}

function validInterval(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1000 && n <= 24 * 60 * 60 * 1000 ? n : null;
}

async function save() {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  const obj = Object.fromEntries(protections.entries());
  const tmp = `${DATA_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  await fs.rename(tmp, DATA_FILE);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function serial(threadID, fn) {
  const previous = locks.get(threadID) || Promise.resolve();
  const current = previous.catch(() => {}).then(fn);
  locks.set(threadID, current);
  try {
    return await current;
  } finally {
    if (locks.get(threadID) === current) locks.delete(threadID);
  }
}

function stopTimers(threadID, type = 'all') {
  const t = timers.get(threadID);
  if (t) {
    if ((type === 'all' || type === 'title') && t.titleTimer) {
      clearTimeout(t.titleTimer);
      t.titleTimer = null;
    }
    if ((type === 'all' || type === 'nickname') && t.nickTimer) {
      clearTimeout(t.nickTimer);
      t.nickTimer = null;
    }
    if (!t.titleTimer && !t.nickTimer) timers.delete(threadID);
  }

  if (type === 'all') {
    const p = pending.get(threadID);
    if (p) clearTimeout(p);
    pending.delete(threadID);
  }
}

function scheduleTimers(api, threadID) {
  stopTimers(threadID);
  const cfg = protections.get(threadID);
  if (!cfg?.enabled) return;

  const t = {};

  if (cfg.title && cfg.titleIntervalMs) {
    const titleLoop = async () => {
      if (!protections.get(threadID)?.enabled) return;
      await enforceTitle(api, threadID);
      const current = protections.get(threadID);
      if (!current?.enabled || !current.titleIntervalMs) return;
      t.titleTimer = setTimeout(titleLoop, current.titleIntervalMs);
      if (t.titleTimer.unref) t.titleTimer.unref();
    };
    t.titleTimer = setTimeout(titleLoop, cfg.titleIntervalMs);
    if (t.titleTimer.unref) t.titleTimer.unref();
  }

  if (cfg.nickname && cfg.nicknameIntervalMs) {
    const nickLoop = async () => {
      if (!protections.get(threadID)?.enabled) return;
      await enforceNicknames(api, threadID);
      const current = protections.get(threadID);
      if (!current?.enabled || !current.nicknameIntervalMs) return;
      t.nickTimer = setTimeout(nickLoop, current.nicknameIntervalMs);
      if (t.nickTimer.unref) t.nickTimer.unref();
    };
    t.nickTimer = setTimeout(nickLoop, cfg.nicknameIntervalMs);
    if (t.nickTimer.unref) t.nickTimer.unref();
  }

  timers.set(threadID, t);
}
async function getThreadInfo(api, threadID) {
  if (typeof api.getThreadInfo !== 'function') return null;
  return new Promise((resolve, reject) => {
    api.getThreadInfo(String(threadID), (err, info) => {
      if (err) reject(err);
      else resolve(info || null);
    });
  });
}

async function setTitle(api, threadID, title) {
  if (typeof api.setTitle !== 'function') throw new Error('setTitle is not supported by this FCA client');
  return new Promise((resolve, reject) => {
    api.setTitle(String(title), String(threadID), err => err ? reject(err) : resolve());
  });
}

async function changeNickname(api, nickname, threadID, userID) {
  if (typeof api.changeNickname !== 'function') throw new Error('changeNickname is not supported by this FCA client');
  return new Promise((resolve, reject) => {
    api.changeNickname(String(nickname), String(threadID), String(userID), err => err ? reject(err) : resolve());
  });
}

async function enforceTitle(api, threadID) {
  const cfg = protections.get(String(threadID));
  if (!cfg?.enabled || !cfg.title) return false;

  return serial(String(threadID), async () => {
    try {
      await setTitle(api, threadID, cfg.title);
      return true;
    } catch (e) {
      console.error(`[STAVEN] title protection failed for ${threadID}:`, e?.message || e);
      return false;
    }
  });
}

async function enforceNicknames(api, threadID) {
  const cfg = protections.get(String(threadID));
  if (!cfg?.enabled || !cfg.nickname) return false;

  return serial(String(threadID), async () => {
    try {
      const info = await getThreadInfo(api, threadID);
      const ids = Array.isArray(info?.participantIDs)
        ? info.participantIDs.map(String)
        : [];

      if (!ids.length) return false;

      for (const uid of ids) {
        const current = info?.nicknames && typeof info.nicknames === 'object'
          ? info.nicknames[uid]
          : undefined;

        if (current === cfg.nickname) continue;

        try {
          await changeNickname(api, cfg.nickname, threadID, uid);
        } catch (e) {
          console.error(`[STAVEN] nickname protection failed for ${threadID}/${uid}:`, e?.message || e);
        }

        // User-requested pacing: each nickname operation gets the configured delay.
        await delay(cfg.nicknameIntervalMs);
      }
      return true;
    } catch (e) {
      console.error(`[STAVEN] nickname sweep failed for ${threadID}:`, e?.message || e);
      return false;
    }
  });
}

function triggerEnforcement(api, threadID) {
  threadID = String(threadID);
  const cfg = protections.get(threadID);
  if (!cfg?.enabled) return;

  const old = pending.get(threadID);
  if (old) clearTimeout(old);

  // Wait for the configured protection interval after a detected change.
  const ms = Math.min(
    cfg.titleIntervalMs || cfg.nicknameIntervalMs || 10000,
    24 * 60 * 60 * 1000
  );

  const timer = setTimeout(async () => {
    pending.delete(threadID);
    if (cfg.title) await enforceTitle(api, threadID);
    if (cfg.nickname) await enforceNicknames(api, threadID);
  }, ms);

  if (timer.unref) timer.unref();
  pending.set(threadID, timer);
}

export async function initGroupProtections() {
  await load();
}

export function getGroupProtection(threadID) {
  const cfg = protections.get(String(threadID));
  return cfg ? { ...cfg } : null;
}

export async function setTitleProtection(api, threadID, title, intervalMs) {
  threadID = String(threadID);
  const cfg = protections.get(threadID) || {
    title: null, titleIntervalMs: null,
    nickname: null, nicknameIntervalMs: null,
    enabled: true,
  };

  cfg.title = String(title).trim();
  cfg.titleIntervalMs = validInterval(intervalMs);
  cfg.enabled = true;
  protections.set(threadID, cfg);
  await save();
  scheduleTimers(api, threadID);

  // Apply immediately, then the periodic protection continues.
  await enforceTitle(api, threadID);
  return { ...cfg };
}

export async function setNicknameProtection(api, threadID, nickname, intervalMs) {
  threadID = String(threadID);
  const cfg = protections.get(threadID) || {
    title: null, titleIntervalMs: null,
    nickname: null, nicknameIntervalMs: null,
    enabled: true,
  };

  cfg.nickname = String(nickname).trim();
  cfg.nicknameIntervalMs = validInterval(intervalMs);
  cfg.enabled = true;
  protections.set(threadID, cfg);
  await save();
  scheduleTimers(api, threadID);

  // Start the first sweep in the background so the command itself does not block
  // while every member is processed sequentially.
  enforceNicknames(api, threadID).catch(() => {});
  return { ...cfg };
}

export async function stopTitleProtection(threadID) {
  threadID = String(threadID);
  const cfg = protections.get(threadID);
  if (!cfg) return null;
  cfg.title = null;
  cfg.titleIntervalMs = null;
  stopTimers(threadID, 'title');
  if (!cfg.nickname) cfg.enabled = false;
  protections.set(threadID, cfg);
  await save();
  return { ...cfg };
}

export async function stopNicknameProtection(threadID) {
  threadID = String(threadID);
  const cfg = protections.get(threadID);
  if (!cfg) return null;
  cfg.nickname = null;
  cfg.nicknameIntervalMs = null;
  stopTimers(threadID, 'nickname');
  if (!cfg.title) cfg.enabled = false;
  protections.set(threadID, cfg);
  await save();
  return { ...cfg };
}

export async function stopGroupProtection(threadID) {
  threadID = String(threadID);
  stopTimers(threadID, 'all');
  const cfg = protections.get(threadID);
  if (cfg) {
    cfg.enabled = false;
    protections.set(threadID, cfg);
    await save();
  }
  return cfg ? { ...cfg } : null;
}

export function handleGroupChangeEvent(api, event) {
  const threadID = String(event?.threadID || '');
  if (!threadID) return;

  const cfg = protections.get(threadID);
  if (!cfg?.enabled) return;

  const type = String(event?.logMessageType || event?.type || '').toLowerCase();
  const data = event?.logMessageData || {};

  const titleChanged =
    type.includes('thread-name') ||
    type.includes('thread_name') ||
    type.includes('threadname') ||
    type.includes('name-change') ||
    type.includes('thread-name-change');

  const nicknameChanged =
    type.includes('thread-nickname') ||
    type.includes('nickname') ||
    type.includes('nick-name');

  if (titleChanged || nicknameChanged || data?.name || data?.nickname) {
    triggerEnforcement(api, threadID);
  }
}

export async function restoreAllGroupProtections(api) {
  for (const [threadID, cfg] of protections.entries()) {
    if (!cfg.enabled) continue;
    scheduleTimers(api, threadID);
  }
}

export async function cleanupGroupProtectionTimers() {
  for (const threadID of [...timers.keys()]) stopTimers(threadID);
  locks.clear();
  pending.clear();
}
