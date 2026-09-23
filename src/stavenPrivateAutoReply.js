"use strict";

/**
 * ══════════════════════════════════════════════════════════
 * STAVEN AUTO REPLY V2
 * Developer: Magnus
 * Bot: Staven Blue V1
 * ══════════════════════════════════════════════════════════
 *
 * Auto-reply system with custom messages and intervals.
 * Works in DMs and groups.
 * Commands: !ستافين / !ستافين تشغيل / !ستافين ايقاف / !ستافين حالة
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/* ══════════════════════════════════════════════════════════
   DATA FILE
   ══════════════════════════════════════════════════════════ */

const DATA_FILE = path.resolve('data/stavenPrivateAutoReply.json');

/* ══════════════════════════════════════════════════════════
   STATE — one per thread
   ══════════════════════════════════════════════════════════ */

const state = {};
const timers = {};
let _sendFn = null;

/* ══════════════════════════════════════════════════════════
   MESSAGE DEDUPLICATION
   ══════════════════════════════════════════════════════════ */

const processedMsgIds = new Set();
const DEDUP_TTL = 5 * 60 * 1000;

export function isMessageProcessed(messageID) {
  if (!messageID) return false;
  return processedMsgIds.has(messageID);
}

export function markMessageProcessed(messageID) {
  if (!messageID) return;
  processedMsgIds.add(messageID);
  setTimeout(() => { processedMsgIds.delete(messageID); }, DEDUP_TTL);
}

/* ══════════════════════════════════════════════════════════
   PERMISSION CHECK (optional — for future use)
   ══════════════════════════════════════════════════════════ */

let _checkPerm = null;

export function setPermissionChecker(fn) {
  _checkPerm = fn;
}

/* ══════════════════════════════════════════════════════════
   TIME UNIT PARSING
   ══════════════════════════════════════════════════════════ */

function parseDuration(str) {
  if (!str) return null;
  str = str.trim();
  const match = str.match(/^([\d.]+)\s*(ث|د|س)$/);
  if (!match) return null;
  const num = parseFloat(match[1]);
  if (isNaN(num) || num <= 0) return null;
  const unit = match[2];
  if (unit === 'ث') return num * 1000;
  if (unit === 'د') return num * 60 * 1000;
  if (unit === 'س') return num * 3600 * 1000;
  return null;
}

function formatInterval(ms) {
  if (ms >= 3600000) {
    const h = ms / 3600000;
    return `${h} ${h === 1 ? 'ساعة' : 'ساعات'}`;
  }
  if (ms >= 60000) {
    const m = ms / 60000;
    return `${m} ${m === 1 ? 'دقيقة' : 'دقائق'}`;
  }
  const s = ms / 1000;
  return `${s} ${s === 1 ? 'ثانية' : 'ثواني'}`;
}

/* ══════════════════════════════════════════════════════════
   PERSISTENCE
   ══════════════════════════════════════════════════════════ */

let _pendingSave = Promise.resolve();

async function _doSave() {
  try {
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
    const out = {};
    for (const [tid, s] of Object.entries(state)) {
      if (s.active) {
        out[tid] = { active: true, message: s.message, intervalMs: s.intervalMs };
      }
    }
    await fs.writeFile(DATA_FILE, JSON.stringify(out, null, 2));
  } catch (err) {
    console.error('[STAVEN-PRIVATE] Save failed:', err?.message);
  }
}

function scheduleSave() {
  _pendingSave = _doSave();
}

/** Wait for the latest save to complete (useful in tests). */
export async function waitForSave() {
  await _pendingSave;
}

async function loadData() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const saved = JSON.parse(raw);
    for (const [tid, data] of Object.entries(saved)) {
      if (data.active && data.message && data.intervalMs) {
        state[tid] = { active: true, message: data.message, intervalMs: data.intervalMs };
      }
    }
  } catch {
    // No data file yet
  }
}

/* ══════════════════════════════════════════════════════════
   TIMER / SCHEDULER
   ══════════════════════════════════════════════════════════ */

function startScheduler(threadID) {
  if (timers[threadID]) return;
  const s = state[threadID];
  if (!s?.active) return;

  const loop = async () => {
    if (!state[threadID]?.active) {
      delete timers[threadID];
      return;
    }
    try {
      await _sendFn(state[threadID].message, threadID);
    } catch (err) {
      console.error(`[STAVEN-PRIVATE] Send failed in ${threadID}:`, err?.message);
    }
    if (state[threadID]?.active) {
      timers[threadID] = setTimeout(loop, state[threadID].intervalMs);
      if (timers[threadID]?.unref) timers[threadID].unref();
    } else {
      delete timers[threadID];
    }
  };

  timers[threadID] = setTimeout(loop, s.intervalMs);
  if (timers[threadID]?.unref) timers[threadID].unref();
}

function stopScheduler(threadID) {
  if (timers[threadID]) {
    clearTimeout(timers[threadID]);
    delete timers[threadID];
  }
}

function cleanupAll() {
  for (const tid of Object.keys(timers)) {
    clearTimeout(timers[tid]);
    delete timers[tid];
  }
}

/* ══════════════════════════════════════════════════════════
   COMMAND HANDLER
   ══════════════════════════════════════════════════════════ */

function box(title, lines) {
  const bar = '─'.repeat(36);
  return [`╭${bar}╮`, `│ ${title}`, '│', ...lines, `╰${bar}╯`].join('\n');
}

/**
 * Handle a STAVEN command.
 * @param {object} event - FCA messageCreate event
 * @param {Function} sendFn - async (msg, threadID) => void
 * @param {object} opts - { isBotMsg: boolean, botID: string }
 * @returns {boolean} true if handled
 */
export async function handleStavenCommand(event, sendFn, opts = {}) {
  const body = String(event?.body || '').trim();
  const threadID = String(event?.threadID || '');
  const senderID = String(event?.senderID || '');

  if (!body.startsWith('!ستافين')) return false;

  const sub = body.slice('!ستافين'.length).trim();

  console.log(`[STAVEN-CMD] body="${body}" sub="${sub}" thread=${threadID} sender=${senderID} isBot=${opts.isBotMsg}`);

  // ── !ستافين (bare — show help) ─────────────────────
  if (sub === '') {
    const msg = box('⚡ STAVEN AUTO REPLY V2', [
      '⚙️ نظام الرسائل المتكررة',
      '',
      '🔧 طريقة الاستخدام:',
      '!ستافين تشغيل <النص> <المدة>',
      '!ستافين ايقاف',
      '!ستافين حالة',
      '',
      '📌 أمثلة:',
      '!ستافين تشغيل كك 15ث',
      '!ستافين تشغيل صباح الخير 1د',
      '!ستافين تشغيل hello 2س',
      '',
      '⏱️ الوحدات المدعومة:',
      'ث = ثواني | د = دقائق | س = ساعات',
      '',
      '👑 المطور: Magnus',
    ]);
    sendFn(msg, threadID).catch(() => {});
    return true;
  }

  // ── !ستافين تشغيل <message> <interval> ─────────────
  if (sub.startsWith('تشغيل')) {
    const args = sub.slice('تشغيل'.length).trim();

    // Permission check (bot owner always passes, configured users pass)
    // opts.allowAll = true skips permission check entirely
    if (!opts.isBotMsg && !opts.allowAll && _checkPerm) {
      const allowed = await _checkPerm(senderID, 'admin');
      if (!allowed) {
        sendFn('❌ هذا الأمر متاح فقط لـ Owner / Admin.', threadID).catch(() => {});
        return true;
      }
    }

    if (!args) {
      const msg = box('⚡ STAVEN AUTO REPLY V2', [
        '❌ يرجى إدخال النص والمدة.',
        '',
        '📌 الاستخدام:',
        '!ستافين تشغيل <النص> <المدة>',
        '',
        '📌 أمثلة:',
        '!ستافين تشغيل كك 15ث',
        '!ستافين تشغيل صباح الخير 1د',
        '!ستافين تشغيل hello 2س',
        '',
        '⏱️ الوحدات: ث = ثواني | د = دقائق | س = ساعات',
      ]);
      sendFn(msg, threadID).catch(() => {});
      return true;
    }

    const parts = args.split(/\s+/);
    let durationStr = '';
    let messageText = '';

    const lastPart = parts[parts.length - 1];
    const lastMatch = lastPart.match(/^([\d.]+)(ث|د|س)$/);
    if (lastMatch) {
      durationStr = lastPart;
      messageText = parts.slice(0, -1).join(' ').trim();
    } else {
      const msg = box('⚡ STAVEN AUTO REPLY V2', [
        '❌ المدة غير صحيحة.',
        '',
        '⏱️ الوحدات المدعومة:',
        'ث = ثواني (مثل: 15ث)',
        'د = دقائق (مثل: 1د, 0.5د)',
        'س = ساعات (مثل: 2س)',
        '',
        '📌 مثال:',
        '!ستافين تشغيل كك 15ث',
      ]);
      sendFn(msg, threadID).catch(() => {});
      return true;
    }

    const intervalMs = parseDuration(durationStr);
    if (!intervalMs) {
      const msg = box('⚡ STAVEN AUTO REPLY V2', [
        '❌ المدة غير صحيحة.',
        '',
        '⏱️ الوحدات المدعومة:',
        'ث = ثواني (مثل: 15ث)',
        'د = دقائق (مثل: 1د, 0.5د)',
        'س = ساعات (مثل: 2س)',
      ]);
      sendFn(msg, threadID).catch(() => {});
      return true;
    }

    if (!messageText) {
      const msg = box('⚡ STAVEN AUTO REPLY V2', [
        '❌ يرجى إدخال النص المراد إرساله.',
        '',
        '📌 مثال:',
        '!ستافين تشغيل كك 15ث',
      ]);
      sendFn(msg, threadID).catch(() => {});
      return true;
    }

    // Stop any existing timer (replace old task)
    if (timers[threadID]) {
      console.log(`[STAVEN-PRIVATE] Stopping existing timer for ${threadID}`);
      stopScheduler(threadID);
    }

    state[threadID] = { active: true, message: messageText, intervalMs };

    // Send first message immediately
    console.log(`[STAVEN-PRIVATE] Sending first message: "${messageText}" to ${threadID}`);
    try {
      await sendFn(messageText, threadID);
      console.log(`[STAVEN-PRIVATE] First message sent successfully`);
    } catch (err) {
      console.error(`[STAVEN-PRIVATE] First send failed:`, err?.message);
    }

    startScheduler(threadID);
    scheduleSave();

    console.log(`[STAVEN-PRIVATE] Scheduler started: interval=${intervalMs}ms`);

    const msg = box('⚡ STAVEN AUTO REPLY V2', [
      '✅ تم تشغيل النظام بنجاح',
      '',
      `📝 النص: ${messageText}`,
      `⏱️ الفاصل: كل ${formatInterval(intervalMs)}`,
      '⚙️ طبيعة الأمر: إرسال تلقائي متكرر',
      '',
      '🤖 البوت: Staven Blue V1',
      '👑 المطور: Magnus',
    ]);
    sendFn(msg, threadID).catch(() => {});
    return true;
  }

  // ── !ستافين ايقاف ──────────────────────────────────
  if (sub === 'ايقاف') {
    if (!opts.isBotMsg && !opts.allowAll && _checkPerm) {
      const allowed = await _checkPerm(senderID, 'admin');
      if (!allowed) {
        sendFn('❌ هذا الأمر متاح فقط لـ Owner / Admin.', threadID).catch(() => {});
        return true;
      }
    }

    const wasActive = state[threadID]?.active;
    stopScheduler(threadID);
    delete state[threadID];
    scheduleSave();

    console.log(`[STAVEN-PRIVATE] Stopped for ${threadID} (was active: ${wasActive})`);

    const msg = box('⚡ STAVEN AUTO REPLY V2', [
      wasActive ? '🛑 تم إيقاف النظام' : '⚠️ النظام غير نشط حالياً',
      '',
      '🤖 البوت: Staven Blue V1',
      '👑 المطور: Magnus',
      '🔴 الحالة: متوقف',
    ]);
    sendFn(msg, threadID).catch(() => {});
    return true;
  }

  // ── !ستافين حالة ────────────────────────────────────
  if (sub === 'حالة') {
    const s = state[threadID];
    const isActive = !!s?.active;
    const msg = box('⚡ STAVEN AUTO REPLY V2', [
      isActive
        ? `🟢 الحالة: يعمل\n📝 النص: ${s.message}\n⏱️ الفاصل: كل ${formatInterval(s.intervalMs)}`
        : '🔴 الحالة: متوقف',
      '',
      '🤖 البوت: Staven Blue V1',
      '👑 المطور: Magnus',
    ]);
    sendFn(msg, threadID).catch(() => {});
    return true;
  }

  return false;
}

/* ══════════════════════════════════════════════════════════
   INITIALIZATION
   ══════════════════════════════════════════════════════════ */

export async function initStavenPrivate(sendFn, getUserRoleFn) {
  _sendFn = sendFn;

  if (getUserRoleFn) {
    const ROLE_LEVEL = { admin: 1, superAdmin: 2, owner: 3 };
    _checkPerm = async (userId, minLevel) => {
      const role = getUserRoleFn(userId);
      if (!role) return false;
      return (ROLE_LEVEL[role] || 0) >= (ROLE_LEVEL[minLevel] || 0);
    };
  }

  await loadData();

  let restored = 0;
  for (const [tid, s] of Object.entries(state)) {
    if (s.active && !timers[tid] && _sendFn) {
      startScheduler(tid);
      restored++;
    }
  }

  if (restored > 0) {
    console.log(`[STAVEN-PRIVATE] Restored ${restored} active scheduler(s)`);
  }
}

export function cleanupStavenPrivate() {
  cleanupAll();
  for (const tid of Object.keys(state)) {
    delete state[tid];
  }
}
