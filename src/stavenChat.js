"use strict";

/**
 * ══════════════════════════════════════════════════════════
 * STAVEN PRIVATE CHAT MANAGER V1
 * Developer: Magnus
 * Bot: Staven Blue V1
 * ══════════════════════════════════════════════════════════
 *
 * Independent interactive chat management system.
 * - Group list & management
 * - Message requests
 * - OTHER / Spam
 * - Statistics
 * - DM Lock
 * - Reply-based menu navigation
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/* ══════════════════════════════════════════════════════════
   CONFIGURATION
   ══════════════════════════════════════════════════════════ */

const STATE_FILE = path.resolve('data/stavenChatState.json');
const PAGE_SIZE = 30;

/* ══════════════════════════════════════════════════════════
   STATE MANAGEMENT
   ══════════════════════════════════════════════════════════ */

// Per-user state: key = `${senderID}_${threadID}`
// Value: { stage, data, page, etc.}
const sessions = {};

function sessionKey(senderID, threadID) {
  return `${senderID}_${threadID}`;
}

function setSession(key, data) {
  sessions[key] = data;
}

function getSession(key) {
  return sessions[key] || null;
}

function clearSession(key) {
  delete sessions[key];
}

/* ══════════════════════════════════════════════════════════
   PERSISTENCE — DM Lock
   ══════════════════════════════════════════════════════════ */

let dmLockEnabled = false;

async function saveState() {
  try {
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify({ dmLock: dmLockEnabled }, null, 2));
  } catch (err) {
    console.error('[STAVEN-CHAT] Save failed:', err?.message);
  }
}

export async function loadChatState() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const saved = JSON.parse(raw);
    if (typeof saved.dmLock === 'boolean') dmLockEnabled = saved.dmLock;
  } catch {
    // No file yet — that's fine
  }
}

export function isDmLockEnabled() {
  return dmLockEnabled;
}

/* ══════════════════════════════════════════════════════════
   FCA API WRAPPERS
   ══════════════════════════════════════════════════════════ */

// Promise wrappers that also support callback-style FCA APIs
function getThreadList(api, limit, tags) {
  return new Promise((resolve, reject) => {
    try {
      api.getThreadList(limit, null, tags, (err, list) => {
        if (err) return reject(err);
        resolve(list || []);
      });
    } catch (e) {
      reject(e);
    }
  });
}

function handleMessageRequest(api, threadID, accept) {
  return new Promise((resolve, reject) => {
    try {
      api.handleMessageRequest(threadID, accept, (err) => {
        if (err) return reject(err);
        resolve(true);
      });
    } catch (e) {
      reject(e);
    }
  });
}

/* ══════════════════════════════════════════════════════════
   FORMATTING
   ══════════════════════════════════════════════════════════ */

function box(title, lines) {
  const bar = '─'.repeat(36);
  return [`╭${bar}╮`, `│ ${title}`, '│', ...lines, `╰${bar}╯`].join('\n');
}

function mainMenu() {
  return box('🛠️ STAVEN — إدارة المحادثات', [
    '━━━━━━━━━━━━━━━━━━━━',
    '1️⃣ 👥 الغروبات',
    '2️⃣ 📩 طلبات المراسلة',
    '3️⃣ 🚨 غير مهم / Spam',
    '4️⃣ 📊 إحصائيات المحادثات',
    '5️⃣ 🔒 حالة DM Lock',
    '━━━━━━━━━━━━━━━━',
    '↩️ رد برقم الخيار',
  ]);
}

/* ══════════════════════════════════════════════════════════
   MENU HANDLERS
   ══════════════════════════════════════════════════════════ */

async function showMainMenu(sendFn, threadID, key) {
  setSession(key, { stage: 'MAIN_MENU' });
  await sendFn(mainMenu(), threadID);
}

async function handleMainMenu(body, sendFn, threadID, key, api, senderID) {
  const choice = body.trim();

  if (choice === '1' || choice === '1️⃣') {
    return await showGroupList(sendFn, threadID, key, api, 0);
  }
  if (choice === '2' || choice === '2️⃣') {
    return await showRequests(sendFn, threadID, key, api, 0);
  }
  if (choice === '3' || choice === '3️⃣') {
    return await showOtherSpam(sendFn, threadID, key, api, 0);
  }
  if (choice === '4' || choice === '4️⃣') {
    return await showStats(sendFn, threadID, key, api);
  }
  if (choice === '5' || choice === '5️⃣') {
    return await showDmLock(sendFn, threadID, key);
  }

  return false;
}

/* ── GROUPS ─────────────────────────────────────────── */

async function showGroupList(sendFn, threadID, key, api, page) {
  try {
    const list = await getThreadList(api, 100, ['inbox']);
    const groups = list.filter(t => t.isGroup);

    if (groups.length === 0) {
      setSession(key, { stage: 'MAIN_MENU' });
      await sendFn('👥 لا توجد غروبات.', threadID);
      await sendFn(mainMenu(), threadID);
      return true;
    }

    const start = page * PAGE_SIZE;
    const slice = groups.slice(start, start + PAGE_SIZE);
    const totalPages = Math.ceil(groups.length / PAGE_SIZE);

    let text = `👥 الغروبات (${groups.length})\n━━━━━━━━━━━━━━━━━━━━\n`;
    slice.forEach((g, i) => {
      const idx = start + i + 1;
      text += `${idx}. ${g.name || 'بدون اسم'}\n   🆔 ${g.threadID}\n`;
    });
    text += '━━━━━━━━━━━━━━━━━━━━\n';
    text += `📄 الصفحة ${page + 1}/${totalPages}\n`;
    text += '↩️ رد برقم الغروب لإدارته\n';
    if (page > 0) text += '⬅️ رد بـ back للصفحة السابقة\n';
    if (start + PAGE_SIZE < groups.length) text += '➡️ رد بـ next للصفحة التالية\n';
    text += '0️⃣ العودة';

    setSession(key, {
      stage: 'GROUP_LIST',
      groups: groups.map(g => ({ threadID: g.threadID, name: g.name || 'بدون اسم' })),
      page,
    });

    await sendFn(text, threadID);
    return true;
  } catch (err) {
    await sendFn(`❌ خطأ في جلب الغروبات: ${err?.message || err}`, threadID);
    setSession(key, { stage: 'MAIN_MENU' });
    return true;
  }
}

async function showGroupDetail(sendFn, threadID, key, api, groupIdx) {
  const sess = getSession(key);
  if (!sess?.groups?.[groupIdx]) {
    await sendFn('❌ غروب غير صالح.', threadID);
    return true;
  }

  const group = sess.groups[groupIdx];
  let text = `👥 ${group.name}\n🆔 ${group.threadID}\n━━━━━━━━━━━━━━━━━━━━\n`;
  text += '1. ⚡ auto-reply —HEARTBEAT\n';
  text += '━━━━━━━━━━━━━━━━━━━━\n';
  text += '↩️ رد برقم الأمر لتنفیذه\n';
  text += '0️⃣ العودة';

  setSession(key, {
    stage: 'GROUP_DETAIL',
    groups: sess.groups,
    selectedGroup: group,
    page: sess.page,
  });

  await sendFn(text, threadID);
  return true;
}

/* ── REQUESTS ──────────────────────────────────────── */

async function showRequests(sendFn, threadID, key, api, page) {
  try {
    const list = await getThreadList(api, 100, ['pending']);

    if (list.length === 0) {
      setSession(key, { stage: 'MAIN_MENU' });
      await sendFn('📩 لا توجد طلبات مراسلة.', threadID);
      await sendFn(mainMenu(), threadID);
      return true;
    }

    const start = page * PAGE_SIZE;
    const slice = list.slice(start, start + PAGE_SIZE);
    const totalPages = Math.ceil(list.length / PAGE_SIZE);

    let text = `📩 طلبات المراسلة (${list.length})\n━━━━━━━━━━━━━━━━━━━━\n`;
    slice.forEach((t, i) => {
      const idx = start + i + 1;
      text += `${idx}. ${t.name || 'بدون اسم'}\n   🆔 ${t.threadID}\n   💬 ${t.snippet || 'بدون رسالة'}\n`;
    });
    text += '━━━━━━━━━━━━━━━━━━━━\n';
    text += `📄 الصفحة ${page + 1}/${totalPages}\n`;
    text += '📌 اختر رقم لإدارته\n';
    if (page > 0) text += '⬅️ رد بـ back\n';
    if (start + PAGE_SIZE < list.length) text += '➡️ رد بـ next\n';
    text += '0️⃣ العودة';

    setSession(key, {
      stage: 'REQUESTS_LIST',
      requests: list.map(t => ({ threadID: t.threadID, name: t.name || 'بدون اسم', snippet: t.snippet || '' })),
      page,
    });

    await sendFn(text, threadID);
    return true;
  } catch (err) {
    await sendFn(`❌ خطأ في جلب الطلبات: ${err?.message || err}`, threadID);
    setSession(key, { stage: 'MAIN_MENU' });
    return true;
  }
}

async function showRequestDetail(sendFn, threadID, key, reqIdx) {
  const sess = getSession(key);
  if (!sess?.requests?.[reqIdx]) {
    await sendFn('❌ طلب غير صالح.', threadID);
    return true;
  }

  const req = sess.requests[reqIdx];
  let text = `📩 طلب المراسلة\n━━━━━━━━━━━━━━━━━━━━\n`;
  text += `👤 ${req.name}\n`;
  text += `🆔 ${req.threadID}\n`;
  text += `💬 ${req.snippet || 'بدون رسالة'}\n`;
  text += '━━━━━━━━━━━━━━━━━━━━\n';
  text += '1️⃣ ✅ قبول وإرسال اهلاً\n';
  text += '0️⃣ ↩️ العودة';

  setSession(key, {
    stage: 'REQUEST_DETAIL',
    requests: sess.requests,
    selectedRequest: req,
    page: sess.page,
  });

  await sendFn(text, threadID);
  return true;
}

async function acceptRequest(sendFn, threadID, key, api) {
  const sess = getSession(key);
  const req = sess?.selectedRequest;
  if (!req) {
    await sendFn('❌ لا يوجد طلب محدد.', threadID);
    return true;
  }

  try {
    await handleMessageRequest(api, req.threadID, true);
    // Send welcome message
    try { await api.sendMessage('اهلاً', req.threadID); } catch {}
    await sendFn(`✅ تم قبول المحادثة.\n👋 تم إرسال: اهلاً`, threadID);
  } catch (err) {
    await sendFn(`❌ فشل القبول: ${err?.message || err}`, threadID);
  }

  // Go back to requests list
  setSession(key, { stage: 'MAIN_MENU' });
  return true;
}

/* ── OTHER / SPAM ──────────────────────────────────── */

async function showOtherSpam(sendFn, threadID, key, api, page) {
  try {
    const list = await getThreadList(api, 100, ['filtered']);

    if (list.length === 0) {
      setSession(key, { stage: 'MAIN_MENU' });
      await sendFn('🚨 لا توجد محادثات مصنفة كـ OTHER / Spam.', threadID);
      await sendFn(mainMenu(), threadID);
      return true;
    }

    const start = page * PAGE_SIZE;
    const slice = list.slice(start, start + PAGE_SIZE);
    const totalPages = Math.ceil(list.length / PAGE_SIZE);

    let text = `🚨 غير مهم / Spam (${list.length})\n━━━━━━━━━━━━━━━━━━━━\n`;
    slice.forEach((t, i) => {
      const idx = start + i + 1;
      text += `${idx}. ${t.name || 'بدون اسم'}\n   🆔 ${t.threadID}\n   💬 ${t.snippet || ''}\n`;
    });
    text += '━━━━━━━━━━━━━━━━━━━━\n';
    text += `📄 الصفحة ${page + 1}/${totalPages}\n`;
    if (page > 0) text += '⬅️ رد بـ back\n';
    if (start + PAGE_SIZE < list.length) text += '➡️ رد بـ next\n';
    text += '0️⃣ العودة';

    setSession(key, {
      stage: 'OTHER_LIST',
      others: list.map(t => ({ threadID: t.threadID, name: t.name || 'بدون اسم', snippet: t.snippet || '' })),
      page,
    });

    await sendFn(text, threadID);
    return true;
  } catch (err) {
    await sendFn(`❌ خطأ في جلب المحادثات: ${err?.message || err}`, threadID);
    setSession(key, { stage: 'MAIN_MENU' });
    return true;
  }
}

/* ── STATS ─────────────────────────────────────────── */

async function showStats(sendFn, threadID, key, api) {
  try {
    const [inbox, pending, filtered] = await Promise.all([
      getThreadList(api, 1, ['inbox']).then(r => r.length).catch(() => '?'),
      getThreadList(api, 1, ['pending']).then(r => r.length).catch(() => '?'),
      getThreadList(api, 1, ['filtered']).then(r => r.length).catch(() => '?'),
    ]);

    let text = `📊 إحصائيات المحادثات\n━━━━━━━━━━━━━━━━━━━━\n`;
    text += `👥 غروبات: ${inbox}\n`;
    text += `📩 طلبات مراسلة: ${pending}\n`;
    text += `🚨 غير مهم / Other: ${filtered}\n`;
    text += `🔒 DM Lock: ${dmLockEnabled ? '🟢 مفعل' : '⚫ معطل'}\n`;
    text += '━━━━━━━━━━━━━━━━━━━━\n';
    text += '0️⃣ العودة';

    setSession(key, { stage: 'MAIN_MENU' });
    await sendFn(text, threadID);
    return true;
  } catch (err) {
    await sendFn(`❌ خطأ في جلب الإحصائيات: ${err?.message || err}`, threadID);
    setSession(key, { stage: 'MAIN_MENU' });
    return true;
  }
}

/* ── DM LOCK ───────────────────────────────────────── */

async function showDmLock(sendFn, threadID, key) {
  let text = `🔒 DM Lock: ${dmLockEnabled ? '🟢 مفعل' : '⚫ معطل'}\n`;
  text += '━━━━━━━━━━━━━━━━━━━━\n';
  text += '1. 🟢 تفعيل DM Lock\n';
  text += '2. ⚫ إلغاء DM Lock\n';
  text += '━━━━━━━━━━━━━━━━━━━━\n';
  text += '↩️ رد برقم الخيار\n';
  text += '0️⃣ العودة';

  setSession(key, { stage: 'DM_LOCK' });
  await sendFn(text, threadID);
  return true;
}

/* ══════════════════════════════════════════════════════════
   MAIN COMMAND HANDLER
   ══════════════════════════════════════════════════════════ */

/**
 * Handle STAVEN CHAT commands.
 * @param {object} event - FCA messageCreate event
 * @param {Function} sendFn - async (msg, threadID) => void
 * @param {object} api - FCA bot API
 * @param {Function} checkPermission - async (userId, level) => boolean
 * @returns {boolean} true if handled
 */
export async function handleStavenChat(event, sendFn, api, checkPermission) {
  const body = String(event?.body || '').trim();
  const threadID = String(event?.threadID || '');
  const senderID = String(event?.senderID || '');

  if (!body.startsWith('!ستافين')) return false;

  const sub = body.slice('!ستافين'.length).trim();

  // ── !ستافين شات — open main menu ──
  if (sub === 'شات' || sub === 'chat') {
    const allowed = await checkPermission(senderID, 'superAdmin');
    if (!allowed) {
      await sendFn('⛔ للأدمن فقط.', threadID);
      return true;
    }
    const key = sessionKey(senderID, threadID);
    await showMainMenu(sendFn, threadID, key);
    return true;
  }

  // ── !ستافين شات dm on/off — shortcut ──
  if (sub === 'شات dm on' || sub === 'chat dm on') {
    const allowed = await checkPermission(senderID, 'superAdmin');
    if (!allowed) {
      await sendFn('⛔ للأدمن فقط.', threadID);
      return true;
    }
    dmLockEnabled = true;
    await saveState();
    await sendFn('✅ تم تفعيل DM Lock — البوت لن يرد على الرسائل الخاصة.', threadID);
    return true;
  }

  if (sub === 'شات dm off' || sub === 'chat dm off') {
    const allowed = await checkPermission(senderID, 'superAdmin');
    if (!allowed) {
      await sendFn('⛔ للأدمن فقط.', threadID);
      return true;
    }
    dmLockEnabled = false;
    await saveState();
    await sendFn('✅ تم إلغاء DM Lock.', threadID);
    return true;
  }

  return false;
}

/**
 * Handle reply-based menu navigation.
 * Call this for every non-command message to check if it's a menu reply.
 * @returns {boolean} true if handled
 */
export async function handleChatReply(event, sendFn, api, checkPermission) {
  const body = String(event?.body || '').trim();
  const threadID = String(event?.threadID || '');
  const senderID = String(event?.senderID || '');

  // Skip commands — those are handled by handleStavenChat
  if (body.startsWith('!')) return false;

  const key = sessionKey(senderID, threadID);
  const sess = getSession(key);
  if (!sess) return false;

  // ── Route by stage ──
  switch (sess.stage) {
    case 'MAIN_MENU':
      return await handleMainMenu(body, sendFn, threadID, key, api, senderID);

    case 'GROUP_LIST': {
      // Navigation
      if (body === '0' || body === '0️⃣') {
        clearSession(key);
        await showMainMenu(sendFn, threadID, key);
        return true;
      }
      if (body.toLowerCase() === 'back' && sess.page > 0) {
        return await showGroupList(sendFn, threadID, key, api, sess.page - 1);
      }
      if (body.toLowerCase() === 'next') {
        return await showGroupList(sendFn, threadID, key, api, sess.page + 1);
      }
      // Select group
      const gIdx = parseInt(body) - 1;
      if (!isNaN(gIdx) && gIdx >= 0 && gIdx < sess.groups.length) {
        return await showGroupDetail(sendFn, threadID, key, api, gIdx);
      }
      await sendFn('❌ اختر رقمًا صحيحًا.', threadID);
      return true;
    }

    case 'GROUP_DETAIL': {
      if (body === '0' || body === '0️⃣') {
        return await showGroupList(sendFn, threadID, key, api, sess.page || 0);
      }
      // For now, any other input goes back to main
      await sendFn('↩️ العودة للقائمة الرئيسية.', threadID);
      clearSession(key);
      await showMainMenu(sendFn, threadID, key);
      return true;
    }

    case 'REQUESTS_LIST': {
      if (body === '0' || body === '0️⃣') {
        clearSession(key);
        await showMainMenu(sendFn, threadID, key);
        return true;
      }
      if (body.toLowerCase() === 'back' && sess.page > 0) {
        return await showRequests(sendFn, threadID, key, api, sess.page - 1);
      }
      if (body.toLowerCase() === 'next') {
        return await showRequests(sendFn, threadID, key, api, sess.page + 1);
      }
      const rIdx = parseInt(body) - 1;
      if (!isNaN(rIdx) && rIdx >= 0 && rIdx < sess.requests.length) {
        return await showRequestDetail(sendFn, threadID, key, rIdx);
      }
      await sendFn('❌ اختر رقمًا صحيحًا.', threadID);
      return true;
    }

    case 'REQUEST_DETAIL': {
      if (body === '0' || body === '0️⃣') {
        return await showRequests(sendFn, threadID, key, api, sess.page || 0);
      }
      if (body === '1' || body === '1️⃣') {
        return await acceptRequest(sendFn, threadID, key, api);
      }
      await sendFn('❌ اختر 1 للقبول أو 0 للرجوع.', threadID);
      return true;
    }

    case 'OTHER_LIST': {
      if (body === '0' || body === '0️⃣') {
        clearSession(key);
        await showMainMenu(sendFn, threadID, key);
        return true;
      }
      if (body.toLowerCase() === 'back' && sess.page > 0) {
        return await showOtherSpam(sendFn, threadID, key, api, sess.page - 1);
      }
      if (body.toLowerCase() === 'next') {
        return await showOtherSpam(sendFn, threadID, key, api, sess.page + 1);
      }
      await sendFn('❌ اختر رقمًا صحيحًا أو 0 للرجوع.', threadID);
      return true;
    }

    case 'DM_LOCK': {
      if (body === '0' || body === '0️⃣') {
        clearSession(key);
        await showMainMenu(sendFn, threadID, key);
        return true;
      }
      if (body === '1' || body === '1️⃣') {
        dmLockEnabled = true;
        await saveState();
        await sendFn('✅ تم تفعيل DM Lock — البوت لن يرد على الرسائل الخاصة.', threadID);
        clearSession(key);
        await showMainMenu(sendFn, threadID, key);
        return true;
      }
      if (body === '2' || body === '2️⃣') {
        dmLockEnabled = false;
        await saveState();
        await sendFn('✅ تم إلغاء DM Lock.', threadID);
        clearSession(key);
        await showMainMenu(sendFn, threadID, key);
        return true;
      }
      await sendFn('❌ اختر 1 للتفعيل أو 2 للإلغاء أو 0 للرجوع.', threadID);
      return true;
    }

    default:
      // Unknown stage — clear and return
      clearSession(key);
      return false;
  }
}
