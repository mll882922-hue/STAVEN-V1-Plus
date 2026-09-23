import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
const fca = require('@dongdev/fca-unofficial');
const { createMessengerBot } = fca;
import { hasPermission, getUserRole } from './roles.js';
import {
  handleStavenCommand,
  initStavenPrivate,
  cleanupStavenPrivate,
  isMessageProcessed,
  markMessageProcessed,
} from './stavenPrivateAutoReply.js';
import { handleSuperAdminCommand, loadSuperAdmins } from './stavenSuperAdminManager.js';
import { handleStavenChat, handleChatReply, loadChatState } from './stavenChat.js';
import {
  initGroupProtections,
  restoreAllGroupProtections,
  cleanupGroupProtectionTimers,
  setTitleProtection,
  setNicknameProtection,
  stopTitleProtection,
  stopNicknameProtection,
  stopGroupProtection,
  getGroupProtection,
  handleGroupChangeEvent,
} from './groupProtection.js';

/* ── Bot Core ─────────────────────────────────────────── */

let bot = null;
let botApi = null;

let botState = {
  status: 'disconnected',
  lastConnected: null,
  lastDisconnected: null,
  lastError: null,
};

export function getBotState() { return { ...botState }; }
export function getBotApi() { return botApi; }

/* ── Helpers ──────────────────────────────────────────── */

function box(title, lines) {
  const bar = '─'.repeat(32);
  return [`╭${bar}╮`, `│ ${title}`, '│', ...lines, `╰${bar}╯`].join('\n');
}

async function tryUnsend(messageID) {
  if (!messageID || !botApi) return;
  try {
    if (typeof botApi.unsendMessage === 'function') await botApi.unsendMessage(messageID);
    else if (typeof botApi.unsend === 'function') await botApi.unsend(messageID);
  } catch {}
}

function log(msg) { console.log(`[STAVEN] ${msg}`); }

const COMMAND_RESPONSE_DELAY_MS = 3000;

function parseDurationToken(token) {
  const m = String(token || '').match(/^([\d.]+)(ث|د|س)$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (m[2] === 'ث') return n * 1000;
  if (m[2] === 'د') return n * 60 * 1000;
  return n * 60 * 60 * 1000;
}

async function handleGroupProtectionCommand(event, sendFn, checkPerm) {
  const body = String(event?.body || '').trim();
  const threadID = String(event?.threadID || '');
  const senderID = String(event?.senderID || '');
  if (!body.startsWith('!ستافين')) return false;

  const sub = body.slice('!ستافين'.length).trim();
  const isProtectionCommand = sub === 'ايقاف' || sub === 'اسم ايقاف' || sub === 'كنيات ايقاف' || sub.startsWith('اسم ') || sub.startsWith('كنيات ');
  if (!isProtectionCommand) return false;

  if (!event?.isGroup && !event?.threadID) return false;


  // The bot itself is allowed when selfListen causes its own command to be processed.
  const isBotCommand = event?.__stavenBotMessage === true;
  if (!isBotCommand) {
    const allowed = await checkPerm(senderID, 'admin');
    if (!allowed) {
      await sendFn('❌ هذا الأمر متاح فقط لـ Owner / Admin.', threadID);
      return true;
    }
  }

  if (sub === 'اسم ايقاف') {
    const existing = getGroupProtection(threadID);
    if (!existing?.title) {
      await sendFn('ℹ️ حماية اسم المجموعة غير مفعلة حاليًا.', threadID);
      return true;
    }
    await stopTitleProtection(threadID);
    await sendFn('🛑 تم إيقاف حماية اسم المجموعة فقط. حماية الكنيات بقيت كما هي.', threadID);
    return true;
  }

  if (sub === 'كنيات ايقاف') {
    const existing = getGroupProtection(threadID);
    if (!existing?.nickname) {
      await sendFn('ℹ️ حماية الكنيات غير مفعلة حاليًا.', threadID);
      return true;
    }
    await stopNicknameProtection(threadID);
    await sendFn('🛑 تم إيقاف حماية الكنيات فقط. حماية اسم المجموعة بقيت كما هي.', threadID);
    return true;
  }

  if (sub === 'ايقاف') {
    const existing = getGroupProtection(threadID);
    if (!existing?.enabled) return false;
    await stopGroupProtection(threadID);
    await sendFn('🛑 تم إيقاف حماية اسم المجموعة والكنيات في هذا القروب.', threadID);
    return true;
  }

  const match = sub.match(/^(اسم|كنيات)\s+(.+?)\s+([\d.]+(?:ث|د|س))$/);
  if (!match) {
    await sendFn(
      '❌ الصيغة غير صحيحة.\n\n' +
      'اسم المجموعة:\n!ستافين اسم ماغنوس اقوى 15ث\n\n' +
      'حماية الكنيات:\n!ستافين كنيات ماغنوس اقوى 10ث\n\nإيقاف الاسم فقط:\n!ستافين اسم ايقاف\n\nإيقاف الكنيات فقط:\n!ستافين كنيات ايقاف',
      threadID
    );
    return true;
  }

  const type = match[1];
  const value = match[2].trim();
  const intervalMs = parseDurationToken(match[3]);
  if (!value || !intervalMs || intervalMs < 1000) {
    await sendFn('❌ المدة يجب أن تكون مثل 10ث أو 1د أو 1س.', threadID);
    return true;
  }

  if (type === 'اسم') {
    const cfg = await setTitleProtection(botApi, threadID, value, intervalMs);
    await sendFn(
      `✅ تم تفعيل حماية اسم المجموعة.\n📝 الاسم: ${cfg.title}\n⏱️ الفاصل: ${match[3]}\n\nإذا تم تغييره، سيحاول STAVEN إرجاعه بعد المدة المحددة.`,
      threadID
    );
    return true;
  }

  const cfg = await setNicknameProtection(botApi, threadID, value, intervalMs);
  await sendFn(
    `✅ تم تفعيل حماية كنيات الأعضاء.\n📝 الكنية: ${cfg.nickname}\n⏱️ الفاصل بين عمليات تغيير الكنيات: ${match[3]}\n\nسيتم تطبيقها على أعضاء القروب بالتتابع وحمايتها بعد ذلك.`,
    threadID
  );
  return true;
}

function delayedCommandSender(api, threadID) {
  return async (msg, tid = threadID) => {
    await new Promise(resolve => setTimeout(resolve, COMMAND_RESPONSE_DELAY_MS));
    await api.sendMessage(msg, tid);
  };
}

/* ══════════════════════════════════════════════════════════
   BOT STARTUP
   ══════════════════════════════════════════════════════════ */

export async function startBot(appStateArray) {
  if (bot) { try { await stopBot(); } catch {} }

  botState.status = 'connecting';
  botState.lastError = null;

  try {
    bot = await createMessengerBot(
      { appState: appStateArray },
      { listenEvents: true, stopOnSignals: false, selfListen: true }
    );

    botApi = bot.api || bot;

    // Cache the bot's own ID for self-message detection
    let cachedBotID = '';
    try {
      if (typeof botApi.getCurrentUserID === 'function') {
        cachedBotID = String(await botApi.getCurrentUserID());
      }
    } catch {}
    const botID = cachedBotID;

    console.log(`[BOT] Bot ID: ${botID || '(unknown)'}`);

    // Initialize STAVEN PRIVATE AUTO REPLY
    const sendFn = async (msg, tid) => { await botApi.sendMessage(msg, tid); };
    await initStavenPrivate(sendFn, getUserRole);

    // Initialize STAVEN SUPER ADMIN MANAGER
    await loadSuperAdmins();

    // Initialize STAVEN CHAT MANAGER
    await loadChatState();
    await initGroupProtections();
    await restoreAllGroupProtections(botApi);

    bot.on('error', (err) => {
      console.error('[BOT] Error:', err?.message || err);
      botState.status = 'error';
      botState.lastError = new Date().toISOString();
      botState.lastDisconnected = new Date().toISOString();
    });

    bot.on('messageCreate', async (event) => {
      const body = String(event?.body || '').trim();
      const threadID = String(event?.threadID || '');
      const senderID = String(event?.senderID || '');
      const messageID = String(event?.messageID || '');
      if (!threadID) return;

      // ════════════════════════════════════════════════════════
      // DEDUPLICATION — prevent processing same message twice
      // ════════════════════════════════════════════════════════
      if (messageID && isMessageProcessed(messageID)) return;
      if (messageID) markMessageProcessed(messageID);

      // ════════════════════════════════════════════════════════
      // IDENTIFY MESSAGE SOURCE
      // ════════════════════════════════════════════════════════
      const isBotMsg = senderID === '0' || senderID === botID;

      // Group title/nickname change events can arrive as messageCreate/log events.
      handleGroupChangeEvent(botApi, event);

      const sendFn = async (msg, tid) => { await botApi.sendMessage(msg, tid); };
      // Commands wait 3 seconds before replying. This is a UX delay, not an attempt to evade platform detection.
      const commandSendFn = delayedCommandSender(botApi, threadID);
      const checkPerm = async (uid, level) => {
        if (botID && uid === botID) return true;
        return hasPermission(uid, level);
      };

      // ════════════════════════════════════════════════════════
      // BOT MESSAGE HANDLING (selfListen: true)
      // ════════════════════════════════════════════════════════
      if (isBotMsg) {
        // Bot's own messages: only handle STAVEN commands, ignore everything else
        // This prevents loops from auto-reply messages
        if (body.startsWith('!ستافين')) {
          const groupEvent = { ...event, __stavenBotMessage: true };
          if (await handleGroupProtectionCommand(groupEvent, commandSendFn, checkPerm)) return;
          if (await handleStavenCommand(event, commandSendFn, { isBotMsg: true, botID })) return;
          if (await handleStavenChat(event, commandSendFn, botApi, checkPerm)) return;
          if (await handleSuperAdminCommand(event, commandSendFn, checkPerm)) return;
        }
        // All other bot messages (including auto-reply output) → ignore
        return;
      }

      // ════════════════════════════════════════════════════════
      // HUMAN MESSAGE HANDLING
      // ════════════════════════════════════════════════════════

      // 1. Try STAVEN COMMANDS first (highest priority for !ستافين)
      if (body.startsWith('!ستافين')) {
        if (await handleGroupProtectionCommand(event, commandSendFn, checkPerm)) return;
        if (await handleStavenCommand(event, commandSendFn, { isBotMsg: false, botID })) return;
        if (await handleStavenChat(event, commandSendFn, botApi, checkPerm)) return;
        if (await handleSuperAdminCommand(event, commandSendFn, checkPerm)) return;
      }

      // 2. Try STAVEN CHAT reply-based menu navigation (no prefix required)
      if (await handleChatReply(event, sendFn, botApi, checkPerm)) return;

      // 3. Try other commands
      if (!body.startsWith('!')) return;

      // ── !uptime ──────────────────────────────────────
      const cmd = body.split(/\s+/)[0].toLowerCase();
      if (cmd === '!uptime') {
        if (!await checkPerm(senderID, 'admin')) return;

        const totalSec = Math.floor(process.uptime());
        const days = Math.floor(totalSec / 86400);
        const hours = Math.floor((totalSec % 86400) / 3600);
        const minutes = Math.floor((totalSec % 3600) / 60);
        const seconds = totalSec % 60;

        const bar = '─'.repeat(32);
        const msg = [
          `╭${bar}╮`,
          '│ ⚡ STAVEN BLUE V1',
          '│',
          '│ ⏱️ مدة التشغيل:',
          `│ 📅 الأيام: ${days}`,
          `│ 🕐 الساعات: ${hours}`,
          `│ ⏳ الدقائق: ${minutes}`,
          `│ ⚡ الثواني: ${seconds}`,
          '│',
          '│ 🤖 النظام: Staven Blue V1',
          '│ 👑 المطور: Magnus',
          '│',
          `╰${bar}╯`,
        ].join('\n');

        try { botApi.sendMessage(msg, threadID); } catch {}
      }
    });

    botState.status = 'connected';
    botState.lastConnected = new Date().toISOString();
    console.log('[BOT] Connected to Facebook Messenger');
  } catch (err) {
    bot = null;
    botApi = null;
    botState.status = 'error';
    botState.lastError = new Date().toISOString();
    console.error('[BOT] Failed to start:', err?.message || err);
    throw err;
  }
}

export async function stopBot() {
  cleanupStavenPrivate();
  await cleanupGroupProtectionTimers();
  if (bot) {
    try {
      if (typeof bot.stop === 'function') bot.stop();
      else if (typeof bot.stopListening === 'function') bot.stopListening();
      else if (typeof bot.disconnect === 'function') bot.disconnect();
      else if (bot.api && typeof bot.api.stopListening === 'function') bot.api.stopListening();
      else if (bot.api && typeof bot.api.logout === 'function') bot.api.logout();
    } catch {}
    bot = null;
    botApi = null;
  }
  botState.status = 'disconnected';
  botState.lastDisconnected = new Date().toISOString();
  console.log('[BOT] Stopped');
}
