"use strict";

/**
 * ══════════════════════════════════════════════════════════
 * STAVEN SUPER ADMIN MANAGER V1
 * Developer: Magnus
 * Bot: Staven Blue V1
 * ══════════════════════════════════════════════════════════
 *
 * Independent Super Admin management system.
 * - Add Super Admin via Reply
 * - Remove Super Admin via Reply
 * - Persistent data in data/stavenSuperAdmins.json
 * - Only existing Super Admins can manage
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/* ══════════════════════════════════════════════════════════
   DATA FILE
   ══════════════════════════════════════════════════════════ */

const DATA_FILE = path.resolve('data/stavenSuperAdmins.json');

// In-memory list: array of user ID strings
let superAdmins = [];

/* ══════════════════════════════════════════════════════════
   PERSISTENCE
   ══════════════════════════════════════════════════════════ */

async function saveData() {
  try {
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
    await fs.writeFile(DATA_FILE, JSON.stringify({ superAdmins }, null, 2));
  } catch (err) {
    console.error('[STAVEN-SUPERADMIN] Save failed:', err?.message);
  }
}

export async function loadSuperAdmins() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const saved = JSON.parse(raw);
    if (Array.isArray(saved.superAdmins)) {
      superAdmins = saved.superAdmins.map(String).filter(Boolean);
    }
  } catch {
    // No data file yet — start empty
    superAdmins = [];
  }
  return [...superAdmins];
}

/* ══════════════════════════════════════════════════════════
   CHECK / ADD / REMOVE
   ══════════════════════════════════════════════════════════ */

/**
 * Check if a user ID is a Super Admin.
 */
export function isSuperAdmin(userId) {
  if (!userId) return false;
  return superAdmins.includes(String(userId).trim());
}

/**
 * Get all Super Admin IDs.
 */
export function getSuperAdmins() {
  return [...superAdmins];
}

/**
 * Add a user as Super Admin.
 * @returns {{ ok: boolean, error?: string }}
 */
export async function addSuperAdmin(userId) {
  const id = String(userId).trim();
  if (!id) return { ok: false, error: 'User ID is required' };

  if (superAdmins.includes(id)) {
    return { ok: false, error: '⚠️ هذا المستخدم Super Admin بالفعل.' };
  }

  superAdmins.push(id);
  await saveData();
  return { ok: true };
}

/**
 * Remove a user from Super Admin.
 * @returns {{ ok: boolean, error?: string }}
 */
export async function removeSuperAdmin(userId) {
  const id = String(userId).trim();
  if (!id) return { ok: false, error: 'User ID is required' };

  if (!superAdmins.includes(id)) {
    return { ok: false, error: '⚠️ هذا المستخدم ليس Super Admin.' };
  }

  superAdmins = superAdmins.filter(x => x !== id);
  await saveData();
  return { ok: true };
}

/* ══════════════════════════════════════════════════════════
   COMMAND HANDLER
   ══════════════════════════════════════════════════════════ */

function box(title, lines) {
  const bar = '─'.repeat(36);
  return [`╭${bar}╮`, `│ ${title}`, '│', ...lines, `╰${bar}╯`].join('\n');
}

/**
 * Handle STAVEN SUPER ADMIN commands.
 * @param {object} event - FCA messageCreate event
 * @param {Function} sendFn - async (msg, threadID) => void
 * @param {Function} checkPermission - async (userId, level) => boolean
 * @returns {boolean} true if this system handled the command
 */
export async function handleSuperAdminCommand(event, sendFn, checkPermission) {
  const body = String(event?.body || '').trim();
  const threadID = String(event?.threadID || '');
  const senderID = String(event?.senderID || '');

  if (!body.startsWith('!ستافين')) return false;

  const sub = body.slice('!ستافين'.length).trim();

  // ── !ستافين اضافة ادمن ─────────────────────────────
  if (sub === 'اضافة ادمن' || sub === 'اضافةادمن') {
    // Permission check — only existing Super Admin or Owner
    const allowed = await checkPermission(senderID, 'superAdmin');
    if (!allowed) {
      sendFn('❌ هذا الأمر متاح فقط لـ Owner / Super Admin.', threadID).catch(() => {});
      return true;
    }

    // Must be a reply
    const replySenderID = event?.messageReply?.senderID;
    if (!replySenderID) {
      sendFn('❌ يجب استخدام الأمر كرد على رسالة الشخص المراد إضافته.', threadID).catch(() => {});
      return true;
    }

    // Can't add yourself
    if (replySenderID === senderID) {
      sendFn('❌ لا يمكنك إضافة نفسك.', threadID).catch(() => {});
      return true;
    }

    const result = await addSuperAdmin(replySenderID);
    if (!result.ok) {
      sendFn(result.error, threadID).catch(() => {});
      return true;
    }

    const msg = box('⚡ STAVEN SUPER ADMIN V1', [
      '✅ تمت إضافة Super Admin بنجاح',
      `👤 المستخدم: ${replySenderID}`,
      `🆔 ID: ${replySenderID}`,
      '👑 الصلاحية: Super Admin',
      '🤖 البوت: Staven Blue V1',
      '👑 المطور: Magnus',
    ]);
    sendFn(msg, threadID).catch(() => {});
    return true;
  }

  // ── !ستافين ازالة من ادمن ──────────────────────────
  if (sub === 'ازالة من ادمن' || sub === 'ازالة') {
    // Permission check
    const allowed = await checkPermission(senderID, 'superAdmin');
    if (!allowed) {
      sendFn('❌ هذا الأمر متاح فقط لـ Owner / Super Admin.', threadID).catch(() => {});
      return true;
    }

    // Must be a reply
    const replySenderID = event?.messageReply?.senderID;
    if (!replySenderID) {
      sendFn('❌ يجب استخدام الأمر كرد على رسالة الشخص المراد إزالته.', threadID).catch(() => {});
      return true;
    }

    const result = await removeSuperAdmin(replySenderID);
    if (!result.ok) {
      sendFn(result.error, threadID).catch(() => {});
      return true;
    }

    const msg = box('⚡ STAVEN SUPER ADMIN V1', [
      '✅ تمت إزالة Super Admin',
      `👤 المستخدم: ${replySenderID}`,
      `🆔 ID: ${replySenderID}`,
      '🔴 الصلاحية: تمت الإزالة',
      '🤖 البوت: Staven Blue V1',
      '👑 المطور: Magnus',
    ]);
    sendFn(msg, threadID).catch(() => {});
    return true;
  }

  // Not a STAVEN SUPER ADMIN command
  return false;
}
