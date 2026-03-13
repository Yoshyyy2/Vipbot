'use strict';

const TelegramBot        = require('node-telegram-bot-api');
const { exec }           = require('child_process');
const fs                 = require('fs');
const path               = require('path');
const { v4: uuidv4 }     = require('uuid');

const config = require('./config.json');
const bot    = new TelegramBot(config.BOT_TOKEN, { polling: true });

// ══════════════════════════════════════════════════════════════
//  CONSTANTS
// ══════════════════════════════════════════════════════════════
const DB_FILE     = path.join(__dirname, 'accounts.json');
const EXPIRY_DAYS = config.EXPIRY_DAYS  || 3;
const DAILY_LIMIT = config.DAILY_LIMIT  || 3;

const PROTO_ICON = { ssh: '🖥️', vless: '📡', vmess: '📡', trojan: '🛡️' };
const LINE       = '━━━━━━━━━━━━━━━━━━━━━━';

// ══════════════════════════════════════════════════════════════
//  DATABASE
// ══════════════════════════════════════════════════════════════
function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      const blank = { accounts: [], pendingAccess: [], approvedUsers: [], bannedUsers: [] };
      fs.writeFileSync(DB_FILE, JSON.stringify(blank, null, 2));
      return blank;
    }
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db.accounts      = db.accounts      || [];
    db.pendingAccess = db.pendingAccess || [];
    db.approvedUsers = db.approvedUsers || [];
    db.bannedUsers   = db.bannedUsers   || [];
    return db;
  } catch { return { accounts: [], pendingAccess: [], approvedUsers: [], bannedUsers: [] }; }
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ══════════════════════════════════════════════════════════════
//  AUTH HELPERS
// ══════════════════════════════════════════════════════════════
const toId       = id => parseInt(id);
const isAdmin    = id => toId(id) === toId(config.ADMIN_ID);
const isApproved = id => isAdmin(id) || loadDB().approvedUsers.map(toId).includes(toId(id));
const isBanned   = id => loadDB().bannedUsers.map(toId).includes(toId(id));

// ══════════════════════════════════════════════════════════════
//  UTILITY
// ══════════════════════════════════════════════════════════════
function formatDate(iso) {
  return new Date(iso).toLocaleString('en-PH', {
    timeZone: 'Asia/Manila', month: 'short', day: '2-digit',
    year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

function expiryISO() {
  const d = new Date();
  d.setDate(d.getDate() + EXPIRY_DAYS);
  return d.toISOString();
}

function timeUntilReset() {
  const now      = new Date();
  const tomorrow = new Date(now);
  tomorrow.setHours(24, 0, 0, 0);
  const ms = tomorrow - now;
  const h  = Math.floor(ms / 3600000);
  const m  = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}m`;
}

function getDailyCount(userId, types) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return loadDB().accounts.filter(a =>
    a.userId === userId &&
    types.includes(a.type) &&
    new Date(a.createdAt) >= today
  ).length;
}

function getActiveAccounts(userId) {
  const now = new Date();
  return loadDB().accounts.filter(a =>
    a.userId === userId && new Date(a.expiry) > now
  );
}

// ══════════════════════════════════════════════════════════════
//  EXPECT RUNNER
// ══════════════════════════════════════════════════════════════
function runExpect(script) {
  return new Promise((resolve, reject) => {
    const tmp = `/tmp/yoshbot_${Date.now()}_${uuidv4().slice(0,6)}.exp`;
    fs.writeFileSync(tmp, script);
    exec(`expect "${tmp}"`, { timeout: 90000 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmp); } catch (_) {}
      const out = stdout + stderr;
      if (err && !out) return reject(new Error(err.message));
      resolve(out);
    });
  });
}

// ══════════════════════════════════════════════════════════════
//  VPS ACTIONS
// ══════════════════════════════════════════════════════════════
async function createSSH(username, password) {
  const script =
`set timeout 60
spawn menu
expect "Option:"
send "1\\r"
expect "Option:"
send "1\\r"
expect "Enter username:"
send "${username}\\r"
expect "Enter password:"
send "${password}\\r"
expect "Expiration"
send "${EXPIRY_DAYS}\\r"
expect "Press Enter"
send "\\r"
expect "Option:"
send "0\\r"
expect "Option:"
send "0\\r"
expect eof`;
  const out = await runExpect(script);
  if (!out.toLowerCase().includes('created')) throw new Error('SSH creation failed');
}

async function deleteSSH(username) {
  const script =
`set timeout 60
spawn menu
expect "Option:"
send "1\\r"
expect "Option:"
send "2\\r"
expect "username:"
send "${username}\\r"
expect "Press Enter"
send "\\r"
expect "Option:"
send "0\\r"
expect "Option:"
send "0\\r"
expect eof`;
  await runExpect(script).catch(() => {});
}

async function createVLESS(username) {
  const script =
`set timeout 90
spawn menu
expect "Option:"
send "2\\r"
expect "Option:"
send "1\\r"
expect "Option:"
send "1\\r"
expect "Enter username:"
send "${username}\\r"
expect "Expiration"
send "${EXPIRY_DAYS}\\r"
expect "SNI"
send "${config.SERVER_HOST}\\r"
expect "Press Enter"
send "\\r"
expect "Option:"
send "0\\r"
expect "Option:"
send "0\\r"
expect "Option:"
send "0\\r"
expect eof`;
  const out  = await runExpect(script);
  const all  = out.match(/vless:\/\/\S+/g) || [];
  if (!all.length) throw new Error('VLESS creation failed');
  return {
    tls:    all.find(l => l.includes('443'))?.trim() || null,
    nonTls: all.find(l => l.includes(':80'))?.trim()  || null
  };
}

async function createVMess(username) {
  const script =
`set timeout 90
spawn menu
expect "Option:"
send "2\\r"
expect "Option:"
send "1\\r"
expect "Option:"
send "2\\r"
expect "Enter username:"
send "${username}\\r"
expect "Expiration"
send "${EXPIRY_DAYS}\\r"
expect "SNI"
send "${config.SERVER_HOST}\\r"
expect "Press Enter"
send "\\r"
expect "Option:"
send "0\\r"
expect "Option:"
send "0\\r"
expect "Option:"
send "0\\r"
expect eof`;
  const out = await runExpect(script);
  const all = out.match(/vmess:\/\/\S+/g) || [];
  if (!all.length) throw new Error('VMess creation failed');
  return {
    tls:    all.find(l => l.includes('443'))?.trim() || null,
    nonTls: all.find(l => l.includes(':80'))?.trim()  || null
  };
}

async function createTrojan(password) {
  const script =
`set timeout 90
spawn menu
expect "Option:"
send "2\\r"
expect "Option:"
send "1\\r"
expect "Option:"
send "3\\r"
expect "Enter password:"
send "${password}\\r"
expect "Expiration"
send "${EXPIRY_DAYS}\\r"
expect "SNI"
send "${config.SERVER_HOST}\\r"
expect "Press Enter"
send "\\r"
expect "Option:"
send "0\\r"
expect "Option:"
send "0\\r"
expect "Option:"
send "0\\r"
expect eof`;
  const out = await runExpect(script);
  const all = out.match(/trojan:\/\/\S+/g) || [];
  if (!all.length) throw new Error('Trojan creation failed');
  return {
    tls:    all.find(l => l.includes('443'))?.trim() || null,
    nonTls: all.find(l => l.includes(':80'))?.trim()  || null
  };
}

async function deleteV2Ray(username) {
  const script =
`set timeout 60
spawn menu
expect "Option:"
send "2\\r"
expect "Option:"
send "2\\r"
expect "username:"
send "${username}\\r"
expect "Press Enter"
send "\\r"
expect "Option:"
send "0\\r"
expect "Option:"
send "0\\r"
expect eof`;
  await runExpect(script).catch(() => {});
}

// ══════════════════════════════════════════════════════════════
//  AUTO EXPIRY CLEANER  (runs every hour)
// ══════════════════════════════════════════════════════════════
async function checkExpired() {
  const db      = loadDB();
  const now     = new Date();
  const expired = db.accounts.filter(a => new Date(a.expiry) <= now);

  for (const acc of expired) {
    try {
      if (acc.type === 'ssh')                            await deleteSSH(acc.username);
      if (['vless','vmess','trojan'].includes(acc.type)) await deleteV2Ray(acc.username || acc.password);
      bot.sendMessage(acc.userId,
        `⚠️ *Account Expired & Removed*\n${LINE}\n\n` +
        `${PROTO_ICON[acc.type] || '📋'} *${acc.type.toUpperCase()}*\n` +
        `👤 \`${acc.username || acc.password}\`\n` +
        `📅 Expired: ${formatDate(acc.expiry)}\n\n` +
        `Create a new one with /menu 🚀`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    } catch (e) { console.error('[EXPIRY]', e.message); }
  }

  if (expired.length) {
    db.accounts = db.accounts.filter(a => new Date(a.expiry) > now);
    saveDB(db);
    console.log(`[EXPIRY] Removed ${expired.length} expired account(s)`);
  }
}
setInterval(checkExpired, 60 * 60 * 1000);
checkExpired();

// ══════════════════════════════════════════════════════════════
//  SESSION STATE  (multi-step input)
// ══════════════════════════════════════════════════════════════
const sessions = new Map();
const set$     = (id, s) => sessions.set(id, s);
const get$     = id => sessions.get(id) || null;
const clear$   = id => sessions.delete(id);

// ══════════════════════════════════════════════════════════════
//  KEYBOARDS
// ══════════════════════════════════════════════════════════════
const KB_MAIN = { inline_keyboard: [
  [{ text: '🖥️  SSH Account',     callback_data: 'menu_ssh'    },
   { text: '📡  V2Ray Account',   callback_data: 'menu_v2ray'  }],
  [{ text: '📋  My Accounts',     callback_data: 'my_accounts' },
   { text: '🌐  Server Info',     callback_data: 'server_info' }],
  [{ text: '📖  Help',            callback_data: 'help'        }]
]};

const KB_V2RAY = { inline_keyboard: [
  [{ text: '📡 VLESS',   callback_data: 'proto_vless'  },
   { text: '📡 VMess',   callback_data: 'proto_vmess'  },
   { text: '🛡️ Trojan',  callback_data: 'proto_trojan' }],
  [{ text: '‹ Back',     callback_data: 'back_main'    }]
]};

const KB_CANCEL = { inline_keyboard: [[{ text: '✕  Cancel', callback_data: 'cancel' }]] };
const KB_BACK   = { inline_keyboard: [[{ text: '‹ Back to Menu', callback_data: 'back_main' }]] };

// ══════════════════════════════════════════════════════════════
//  MESSAGE BUILDERS
// ══════════════════════════════════════════════════════════════
function msgSSHResult(u, p, expiry) {
  return (
    `✅ *SSH ACCOUNT CREATED*\n${LINE}\n` +
    `🖥️  *Host*       : \`${config.SERVER_HOST}\`\n` +
    `📡  *Nameserver* : \`${config.SERVER_NS}\`\n` +
    `🔑  *Public Key* : \`${config.SERVER_PUBKEY}\`\n` +
    `${LINE}\n` +
    `👤  *Username*   : \`${u}\`\n` +
    `🔐  *Password*   : \`${p}\`\n` +
    `⏳  *Duration*   : ${EXPIRY_DAYS} day(s)\n` +
    `📅  *Expires*    : ${formatDate(expiry)}\n` +
    `${LINE}\n` +
    `👑 *Server by Yosh — 🇸🇬 Singapore*`
  );
}

function msgV2RayResult(proto, data) {
  const name  = proto === 'trojan' ? data.password : data.username;
  const label = proto === 'trojan' ? 'Password' : 'Username';
  return (
    `✅ *${proto.toUpperCase()} ACCOUNT CREATED*\n${LINE}\n` +
    `🌐  *Host*     : \`${config.SERVER_HOST}\`\n` +
    `🔗  *SNI*      : \`${config.SERVER_HOST}\`\n` +
    `${LINE}\n` +
    `👤  *${label}* : \`${name}\`\n` +
    (proto !== 'trojan' ? `🔐  *Password* : \`${data.password}\`\n` : '') +
    `⏳  *Duration* : ${EXPIRY_DAYS} day(s)\n` +
    `📅  *Expires*  : ${formatDate(data.expiry)}\n` +
    `${LINE}\n` +
    `🔒 *TLS · Port 443*\n\`${data.tls || 'N/A'}\`\n\n` +
    `🔓 *Non-TLS · Port 80*\n\`${data.nonTls || 'N/A'}\`\n` +
    `${LINE}\n` +
    `👑 *Server by Yosh — 🇸🇬 Singapore*`
  );
}

// ══════════════════════════════════════════════════════════════
//  CREATION FLOW  (shared)
// ══════════════════════════════════════════════════════════════
function startCreate(chatId, userId, proto) {
  const types   = proto === 'ssh' ? ['ssh'] : ['vless','vmess','trojan'];
  const used    = getDailyCount(userId, types);
  const left    = DAILY_LIMIT - used;

  if (left <= 0) {
    return bot.sendMessage(chatId,
      `❌ *Daily Limit Reached*\n\n` +
      `You've used all *${DAILY_LIMIT}* free accounts today.\n` +
      `⏰ Resets in: *${timeUntilReset()}*`,
      { parse_mode: 'Markdown', reply_markup: KB_BACK }
    );
  }

  const icon = PROTO_ICON[proto] || '📋';

  if (proto === 'ssh') {
    set$(userId, { step: 'ssh_user', proto });
    bot.sendMessage(chatId,
      `${icon} *Create SSH Account*\n${LINE}\n\n` +
      `📊 Remaining today: *${left}/${DAILY_LIMIT}*\n\n` +
      `Enter your desired *username*:\n_3–16 chars · letters / numbers / _`,
      { parse_mode: 'Markdown', reply_markup: KB_CANCEL }
    );
  } else if (proto === 'trojan') {
    set$(userId, { step: 'trojan_pass', proto });
    bot.sendMessage(chatId,
      `${icon} *Create Trojan Account*\n${LINE}\n\n` +
      `📊 Remaining today: *${left}/${DAILY_LIMIT}*\n\n` +
      `Enter your *password*:\n_Min. 4 characters_`,
      { parse_mode: 'Markdown', reply_markup: KB_CANCEL }
    );
  } else {
    set$(userId, { step: 'v2ray_user', proto });
    bot.sendMessage(chatId,
      `${icon} *Create ${proto.toUpperCase()} Account*\n${LINE}\n\n` +
      `📊 Remaining today: *${left}/${DAILY_LIMIT}*\n\n` +
      `Enter your desired *username*:\n_3–16 chars · letters / numbers / _`,
      { parse_mode: 'Markdown', reply_markup: KB_CANCEL }
    );
  }
}

// ══════════════════════════════════════════════════════════════
//  TEXT MESSAGE HANDLER  (state machine)
// ══════════════════════════════════════════════════════════════
bot.on('message', async (msg) => {
  const userId = msg.from.id;
  const text   = (msg.text || '').trim();

  if (isBanned(userId) || text.startsWith('/')) return;

  const sess = get$(userId);
  if (!sess) return;

  const { step, proto } = sess;

  // ─── SSH step 1: username ──────────────────────────────
  if (step === 'ssh_user') {
    if (!/^[a-zA-Z0-9_]{3,16}$/.test(text)) {
      return bot.sendMessage(msg.chat.id,
        `❌ *Invalid username!*\n_3–16 chars · letters/numbers/_ only_\n\nTry again:`,
        { parse_mode: 'Markdown', reply_markup: KB_CANCEL }
      );
    }
    set$(userId, { step: 'ssh_pass', proto, username: text });
    return bot.sendMessage(msg.chat.id,
      `👤 Username: \`${text}\`\n\nNow enter your *password*:\n_Min. 4 characters_`,
      { parse_mode: 'Markdown', reply_markup: KB_CANCEL }
    );
  }

  // ─── SSH step 2: password ──────────────────────────────
  if (step === 'ssh_pass') {
    if (text.length < 4) {
      return bot.sendMessage(msg.chat.id,
        `❌ Password too short! Min. 4 characters.\n\nTry again:`,
        { parse_mode: 'Markdown', reply_markup: KB_CANCEL }
      );
    }
    const { username } = sess;
    clear$(userId);
    const wait = await bot.sendMessage(msg.chat.id, `⏳ Creating SSH account, please wait...`);
    try {
      await createSSH(username, text);
      const expiry = expiryISO();
      const db = loadDB();
      db.accounts.push({ userId, username, password: text, type: 'ssh', expiry, createdAt: new Date().toISOString() });
      saveDB(db);
      bot.editMessageText(msgSSHResult(username, text, expiry), {
        chat_id: msg.chat.id, message_id: wait.message_id,
        parse_mode: 'Markdown', reply_markup: KB_BACK
      });
      bot.sendMessage(config.ADMIN_ID,
        `📌 *SSH Created*\n👤 ${msg.from.first_name} (\`${userId}\`)\n🔑 \`${username}\`\n📅 ${formatDate(expiry)}`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    } catch (e) {
      console.error('[SSH]', e.message);
      bot.editMessageText(`❌ Failed to create SSH account.\nPlease try again.`, {
        chat_id: msg.chat.id, message_id: wait.message_id, reply_markup: KB_BACK
      });
    }
    return;
  }

  // ─── V2Ray step 1: username ────────────────────────────
  if (step === 'v2ray_user') {
    if (!/^[a-zA-Z0-9_]{3,16}$/.test(text)) {
      return bot.sendMessage(msg.chat.id,
        `❌ *Invalid username!*\n_3–16 chars · letters/numbers/_ only_\n\nTry again:`,
        { parse_mode: 'Markdown', reply_markup: KB_CANCEL }
      );
    }
    set$(userId, { step: 'v2ray_pass', proto, username: text });
    return bot.sendMessage(msg.chat.id,
      `👤 Username: \`${text}\`\n\nNow enter your *password*:\n_Min. 4 characters_`,
      { parse_mode: 'Markdown', reply_markup: KB_CANCEL }
    );
  }

  // ─── V2Ray step 2: password ────────────────────────────
  if (step === 'v2ray_pass') {
    if (text.length < 4) {
      return bot.sendMessage(msg.chat.id,
        `❌ Password too short! Min. 4 characters.\n\nTry again:`,
        { parse_mode: 'Markdown', reply_markup: KB_CANCEL }
      );
    }
    const { username } = sess;
    clear$(userId);
    const wait = await bot.sendMessage(msg.chat.id,
      `⏳ Creating ${proto.toUpperCase()} account, please wait...`
    );
    try {
      const result = proto === 'vless' ? await createVLESS(username) : await createVMess(username);
      const expiry = expiryISO();
      const db = loadDB();
      db.accounts.push({ userId, username, password: text, type: proto, expiry, createdAt: new Date().toISOString(), ...result });
      saveDB(db);
      bot.editMessageText(msgV2RayResult(proto, { username, password: text, expiry, ...result }), {
        chat_id: msg.chat.id, message_id: wait.message_id,
        parse_mode: 'Markdown', reply_markup: KB_BACK
      });
      bot.sendMessage(config.ADMIN_ID,
        `📌 *${proto.toUpperCase()} Created*\n👤 ${msg.from.first_name} (\`${userId}\`)\n🌐 \`${username}\`\n📅 ${formatDate(expiry)}`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    } catch (e) {
      console.error(`[${proto.toUpperCase()}]`, e.message);
      bot.editMessageText(`❌ Failed to create ${proto.toUpperCase()} account.\nPlease try again.`, {
        chat_id: msg.chat.id, message_id: wait.message_id, reply_markup: KB_BACK
      });
    }
    return;
  }

  // ─── Trojan: password ──────────────────────────────────
  if (step === 'trojan_pass') {
    if (text.length < 4) {
      return bot.sendMessage(msg.chat.id,
        `❌ Password too short! Min. 4 characters.\n\nTry again:`,
        { parse_mode: 'Markdown', reply_markup: KB_CANCEL }
      );
    }
    clear$(userId);
    const wait = await bot.sendMessage(msg.chat.id, `⏳ Creating Trojan account, please wait...`);
    try {
      const result = await createTrojan(text);
      const expiry = expiryISO();
      const db = loadDB();
      db.accounts.push({ userId, username: text, password: text, type: 'trojan', expiry, createdAt: new Date().toISOString(), ...result });
      saveDB(db);
      bot.editMessageText(msgV2RayResult('trojan', { password: text, expiry, ...result }), {
        chat_id: msg.chat.id, message_id: wait.message_id,
        parse_mode: 'Markdown', reply_markup: KB_BACK
      });
      bot.sendMessage(config.ADMIN_ID,
        `📌 *Trojan Created*\n👤 ${msg.from.first_name} (\`${userId}\`)\n🔐 \`${text}\`\n📅 ${formatDate(expiry)}`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    } catch (e) {
      console.error('[TROJAN]', e.message);
      bot.editMessageText(`❌ Failed to create Trojan account.\nPlease try again.`, {
        chat_id: msg.chat.id, message_id: wait.message_id, reply_markup: KB_BACK
      });
    }
    return;
  }
});

// ══════════════════════════════════════════════════════════════
//  CALLBACK QUERY  (inline button taps)
// ══════════════════════════════════════════════════════════════
bot.on('callback_query', async (q) => {
  const userId = q.from.id;
  const data   = q.data;
  const chatId = q.message.chat.id;
  const msgId  = q.message.message_id;

  bot.answerCallbackQuery(q.id).catch(() => {});
  if (isBanned(userId)) return;

  // ─── Navigation ────────────────────────────────────────
  if (data === 'back_main') {
    clear$(userId);
    return bot.editMessageText(
      `🇸🇬 *Yosh VIP Panel*\n\nWhat would you like to do?`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: KB_MAIN }
    );
  }

  if (data === 'cancel') {
    clear$(userId);
    return bot.editMessageText(
      `❌ *Cancelled*\n\nReturning to menu...`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: KB_MAIN }
    );
  }

  // ─── Unapproved: request access button ─────────────────
  if (data === 'request_access') {
    if (isApproved(userId)) return;
    const db = loadDB();
    if (db.pendingAccess.find(r => toId(r.userId) === toId(userId))) {
      return bot.editMessageText(`⏳ Already pending! Please wait for admin approval.`,
        { chat_id: chatId, message_id: msgId });
    }
    const requestId = uuidv4().slice(0, 8);
    db.pendingAccess.push({ requestId, userId, name: q.from.first_name, username: q.from.username || 'N/A', requestedAt: new Date().toISOString() });
    saveDB(db);
    bot.editMessageText(`✅ *Request Submitted!*\n\n⏳ Waiting for admin approval...`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
    bot.sendMessage(config.ADMIN_ID,
      `🔔 *New Access Request*\n${LINE}\n` +
      `👤 *Name*     : ${q.from.first_name}\n` +
      `🆔 *User ID*  : \`${userId}\`\n` +
      `📛 *Username* : @${q.from.username || 'N/A'}\n${LINE}`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
        { text: '✅ Approve', callback_data: `grant_${requestId}` },
        { text: '❌ Deny',    callback_data: `deny_${requestId}`  }
      ]] }}
    ).catch(() => {});
    return;
  }

  if (!isApproved(userId)) return;

  // ─── Main menu ──────────────────────────────────────────
  if (data === 'menu_ssh') {
    bot.deleteMessage(chatId, msgId).catch(() => {});
    return startCreate(chatId, userId, 'ssh');
  }

  if (data === 'menu_v2ray') {
    return bot.editMessageText(
      `📡 *Create V2Ray Account*\n\nChoose a protocol:`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: KB_V2RAY }
    );
  }

  if (data === 'proto_vless')  { bot.deleteMessage(chatId, msgId).catch(() => {}); return startCreate(chatId, userId, 'vless'); }
  if (data === 'proto_vmess')  { bot.deleteMessage(chatId, msgId).catch(() => {}); return startCreate(chatId, userId, 'vmess'); }
  if (data === 'proto_trojan') { bot.deleteMessage(chatId, msgId).catch(() => {}); return startCreate(chatId, userId, 'trojan'); }

  if (data === 'my_accounts') {
    const accs = getActiveAccounts(userId);
    if (!accs.length) {
      return bot.editMessageText(
        `📭 *No Active Accounts*\n\nYou have no active accounts.\nCreate one from the menu!`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: KB_MAIN }
      );
    }
    let text = `📋 *Your Active Accounts*\n${LINE}\n\n`;
    accs.forEach((a, i) => {
      const name = a.username || a.password || '?';
      text += `${i+1}. ${PROTO_ICON[a.type] || '📋'} *${a.type.toUpperCase()}*\n`;
      text += `   👤 \`${name}\`\n`;
      text += `   📅 ${formatDate(a.expiry)}\n\n`;
    });
    text += `${LINE}\nTotal: *${accs.length}* active account(s)`;
    return bot.editMessageText(text, {
      chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: KB_BACK
    });
  }

  if (data === 'server_info') {
    const total = loadDB().accounts.filter(a => new Date(a.expiry) > new Date()).length;
    return bot.editMessageText(
      `🌐 *Server Info*\n${LINE}\n` +
      `🏠 *Host*    : \`${config.SERVER_HOST}\`\n` +
      `📡 *NS*      : \`${config.SERVER_NS}\`\n` +
      `📊 *Active*  : *${total}* account(s)\n` +
      `⏳ *Expiry*  : *${EXPIRY_DAYS}* day(s)\n` +
      `📅 *Limit*   : *${DAILY_LIMIT}* account(s)/day\n` +
      `${LINE}\n👑 *Server by Yosh*`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: KB_BACK }
    );
  }

  if (data === 'help') {
    return bot.editMessageText(
      `📖 *Commands*\n${LINE}\n` +
      `🏠 /menu — Open main menu\n` +
      `🖥️ /createssh — Create SSH\n` +
      `📡 /createvless — Create VLESS\n` +
      `📡 /createvmess — Create VMess\n` +
      `🛡️ /createtrojan — Create Trojan\n` +
      `📋 /myaccounts — My active accounts\n` +
      `${LINE}\n👑 *Server by Yosh*`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: KB_BACK }
    );
  }

  // ─── Admin: grant / deny via button ────────────────────
  if (data.startsWith('grant_') && isAdmin(userId)) {
    const rid = data.replace('grant_', '');
    const db  = loadDB();
    const req = db.pendingAccess.find(r => r.requestId === rid);
    if (!req) return bot.editMessageText(`❌ Request not found or already handled.`, { chat_id: chatId, message_id: msgId });
    if (!db.approvedUsers.map(toId).includes(toId(req.userId))) db.approvedUsers.push(toId(req.userId));
    db.pendingAccess = db.pendingAccess.filter(r => r.requestId !== rid);
    saveDB(db);
    bot.editMessageText(`✅ *Approved* — ${req.name} (\`${req.userId}\`)`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
    bot.sendMessage(req.userId,
      `🎉 *Access Granted!*\n\nWelcome to *🇸🇬 Yosh VIP Bot!*\nYou can now create accounts.\n\nSend /menu to get started!`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  }

  if (data.startsWith('deny_') && isAdmin(userId)) {
    const rid = data.replace('deny_', '');
    const db  = loadDB();
    const req = db.pendingAccess.find(r => r.requestId === rid);
    if (!req) return bot.editMessageText(`❌ Request not found.`, { chat_id: chatId, message_id: msgId });
    db.pendingAccess = db.pendingAccess.filter(r => r.requestId !== rid);
    saveDB(db);
    bot.editMessageText(`❌ *Denied* — ${req.name}`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' });
    bot.sendMessage(req.userId, `❌ Your access request was denied.`).catch(() => {});
  }
});

// ══════════════════════════════════════════════════════════════
//  SLASH COMMANDS
// ══════════════════════════════════════════════════════════════
function guard(msg, cb) {
  if (isBanned(msg.from.id)) return;
  if (!isApproved(msg.from.id)) {
    return bot.sendMessage(msg.chat.id,
      `🚫 *No Access*\n\nSend /request to ask for access.`,
      { parse_mode: 'Markdown' }
    );
  }
  cb();
}

bot.onText(/\/start/, (msg) => {
  if (isBanned(msg.from.id)) return;
  clear$(msg.from.id);
  if (!isApproved(msg.from.id)) {
    return bot.sendMessage(msg.chat.id,
      `👋 Hello, *${msg.from.first_name}*!\n\n` +
      `Welcome to *🇸🇬 Yosh VIP Bot*\n` +
      `Singapore Server · SSH & V2Ray\n\n` +
      `You don't have access yet.\nTap below to request:`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
        { text: '🔐 Request Access', callback_data: 'request_access' }
      ]] }}
    );
  }
  bot.sendMessage(msg.chat.id,
    `👋 Welcome back, *${msg.from.first_name}*!\n\n` +
    `🇸🇬 *Yosh VIP Panel*\n` +
    `Singapore Server · SSH & V2Ray\n\n` +
    `What would you like to do?`,
    { parse_mode: 'Markdown', reply_markup: KB_MAIN }
  );
});

bot.onText(/\/menu/, (msg) => {
  guard(msg, () => {
    clear$(msg.from.id);
    bot.sendMessage(msg.chat.id,
      `🇸🇬 *Yosh VIP Panel*\n\nWhat would you like to do?`,
      { parse_mode: 'Markdown', reply_markup: KB_MAIN }
    );
  });
});

bot.onText(/\/request/, (msg) => {
  const userId = msg.from.id;
  if (isBanned(userId)) return;
  if (isApproved(userId)) {
    return bot.sendMessage(msg.chat.id, `✅ You already have access!`, { reply_markup: KB_MAIN });
  }
  const db = loadDB();
  if (db.pendingAccess.find(r => toId(r.userId) === toId(userId))) {
    return bot.sendMessage(msg.chat.id, `⏳ Your request is already pending. Please wait!`);
  }
  const requestId = uuidv4().slice(0, 8);
  db.pendingAccess.push({ requestId, userId, name: msg.from.first_name, username: msg.from.username || 'N/A', requestedAt: new Date().toISOString() });
  saveDB(db);
  bot.sendMessage(msg.chat.id,
    `✅ *Request Submitted!*\n\n⏳ Please wait for admin approval.`,
    { parse_mode: 'Markdown' }
  );
  bot.sendMessage(config.ADMIN_ID,
    `🔔 *New Access Request*\n${LINE}\n` +
    `👤 *Name*     : ${msg.from.first_name}\n` +
    `🆔 *User ID*  : \`${userId}\`\n` +
    `📛 *Username* : @${msg.from.username || 'N/A'}\n${LINE}`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
      { text: '✅ Approve', callback_data: `grant_${requestId}` },
      { text: '❌ Deny',    callback_data: `deny_${requestId}`  }
    ]] }}
  ).catch(() => {});
});

bot.onText(/\/createssh/,    msg => guard(msg, () => startCreate(msg.chat.id, msg.from.id, 'ssh')));
bot.onText(/\/createvless/,  msg => guard(msg, () => startCreate(msg.chat.id, msg.from.id, 'vless')));
bot.onText(/\/createvmess/,  msg => guard(msg, () => startCreate(msg.chat.id, msg.from.id, 'vmess')));
bot.onText(/\/createtrojan/, msg => guard(msg, () => startCreate(msg.chat.id, msg.from.id, 'trojan')));

bot.onText(/\/myaccounts/, (msg) => {
  guard(msg, () => {
    const accs = getActiveAccounts(msg.from.id);
    if (!accs.length) {
      return bot.sendMessage(msg.chat.id,
        `📭 *No Active Accounts*\n\nCreate one with /menu!`,
        { parse_mode: 'Markdown' }
      );
    }
    let text = `📋 *Your Active Accounts*\n${LINE}\n\n`;
    accs.forEach((a, i) => {
      const name = a.username || a.password || '?';
      text += `${i+1}. ${PROTO_ICON[a.type] || '📋'} *${a.type.toUpperCase()}*\n`;
      text += `   👤 \`${name}\`\n`;
      text += `   📅 ${formatDate(a.expiry)}\n\n`;
    });
    text += `${LINE}\nTotal: *${accs.length}* account(s)`;
    bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown', reply_markup: KB_BACK });
  });
});

bot.onText(/\/help/, (msg) => {
  if (isBanned(msg.from.id)) return;
  if (isAdmin(msg.from.id)) {
    return bot.sendMessage(msg.chat.id,
      `🛠️ *Admin Commands*\n${LINE}\n` +
      `📊 /stats — Bot statistics\n` +
      `⏳ /pending — Pending requests\n` +
      `✅ /approvedusers — Approved users\n` +
      `🚫 /ban <id> — Ban a user\n` +
      `✅ /unban <id> — Unban a user\n` +
      `🗑️ /deleteaccount <username>\n` +
      `🧹 /clearaccounts — Clear all records\n` +
      `${LINE}\n👑 *Server by Yosh*`,
      { parse_mode: 'Markdown' }
    );
  }
  if (!isApproved(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, `🚫 Send /request to get access.`);
  }
  bot.sendMessage(msg.chat.id,
    `📖 *Commands*\n${LINE}\n` +
    `🏠 /menu — Open main menu\n` +
    `🖥️ /createssh — Create SSH\n` +
    `📡 /createvless — Create VLESS\n` +
    `📡 /createvmess — Create VMess\n` +
    `🛡️ /createtrojan — Create Trojan\n` +
    `📋 /myaccounts — My active accounts\n` +
    `${LINE}\n👑 *Server by Yosh*`,
    { parse_mode: 'Markdown', reply_markup: KB_BACK }
  );
});

// ══════════════════════════════════════════════════════════════
//  ADMIN COMMANDS
// ══════════════════════════════════════════════════════════════
bot.onText(/\/stats/, (msg) => {
  if (!isAdmin(msg.from.id)) return;
  const db     = loadDB();
  const now    = new Date();
  const active = db.accounts.filter(a => new Date(a.expiry) > now);
  const today  = new Date(); today.setHours(0,0,0,0);
  const newToday = db.accounts.filter(a => new Date(a.createdAt) >= today).length;
  bot.sendMessage(msg.chat.id,
    `📊 *Bot Statistics*\n${LINE}\n` +
    `👥 Approved users   : *${db.approvedUsers.length}*\n` +
    `⏳ Pending requests  : *${db.pendingAccess.length}*\n` +
    `🚫 Banned users     : *${db.bannedUsers.length}*\n` +
    `${LINE}\n` +
    `📋 Active accounts  : *${active.length}*\n` +
    `   🖥️  SSH    : *${active.filter(a=>a.type==='ssh').length}*\n` +
    `   📡 VLESS  : *${active.filter(a=>a.type==='vless').length}*\n` +
    `   📡 VMess  : *${active.filter(a=>a.type==='vmess').length}*\n` +
    `   🛡️  Trojan : *${active.filter(a=>a.type==='trojan').length}*\n` +
    `${LINE}\n` +
    `📅 Created today    : *${newToday}*\n` +
    `${LINE}\n👑 *Server by Yosh*`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/clearpending/, (msg) => {
  if (!isAdmin(msg.from.id)) return;
  const db = loadDB();
  db.pendingAccess = [];
  saveDB(db);
  bot.sendMessage(msg.chat.id, `✅ All pending requests cleared!`);
});

bot.onText(/\/pending/, (msg) => {
  if (!isAdmin(msg.from.id)) return;
  const db = loadDB();
  // Auto-repair: assign requestId to any entry missing one
  let repaired = false;
  db.pendingAccess.forEach(r => {
    if (!r.requestId) { r.requestId = uuidv4().slice(0, 8); repaired = true; }
    if (!r.name)      { r.name = 'Unknown'; }
    if (!r.username)  { r.username = 'N/A'; }
  });
  if (repaired) saveDB(db);
  if (!db.pendingAccess.length) return bot.sendMessage(msg.chat.id, `📭 No pending requests.`);
  let text = `⏳ *Pending Requests* (${db.pendingAccess.length})\n${LINE}\n\n`;
  db.pendingAccess.forEach(r => {
    text += `👤 *${r.name}* (@${r.username || 'N/A'})\n🆔 \`${r.userId}\`\n📅 ${r.requestedAt ? formatDate(r.requestedAt) : 'N/A'}\n\n`;
  });
  bot.sendMessage(msg.chat.id, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: db.pendingAccess.map(r => ([
      { text: `✅ ${r.name}`, callback_data: `grant_${r.requestId}` },
      { text: `❌ Deny`,      callback_data: `deny_${r.requestId}`  }
    ]))}
  });
});

bot.onText(/\/approvedusers/, (msg) => {
  if (!isAdmin(msg.from.id)) return;
  const db = loadDB();
  if (!db.approvedUsers.length) return bot.sendMessage(msg.chat.id, `📭 No approved users.`);
  let text = `✅ *Approved Users* (${db.approvedUsers.length})\n${LINE}\n\n`;
  db.approvedUsers.forEach(id => { text += `👤 \`${id}\`\n`; });
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/ban (.+)/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const targetId = parseInt(match[1]);
  const db = loadDB();
  if (!db.bannedUsers.includes(targetId)) db.bannedUsers.push(targetId);
  db.approvedUsers = db.approvedUsers.filter(id => id !== targetId);
  saveDB(db);
  bot.sendMessage(msg.chat.id, `🚫 User \`${targetId}\` has been banned.`, { parse_mode: 'Markdown' });
  bot.sendMessage(targetId, `🚫 You have been banned from this bot.`).catch(() => {});
});

bot.onText(/\/unban (.+)/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const targetId = parseInt(match[1]);
  const db = loadDB();
  db.bannedUsers = db.bannedUsers.filter(id => id !== targetId);
  saveDB(db);
  bot.sendMessage(msg.chat.id, `✅ User \`${targetId}\` has been unbanned.`, { parse_mode: 'Markdown' });
});

bot.onText(/\/revokeaccess (.+)/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const targetId = parseInt(match[1]);
  const db = loadDB();
  db.approvedUsers = db.approvedUsers.filter(id => id !== targetId);
  saveDB(db);
  bot.sendMessage(msg.chat.id, `✅ Access revoked for \`${targetId}\``, { parse_mode: 'Markdown' });
  bot.sendMessage(targetId, `❌ Your access has been revoked by the admin.`).catch(() => {});
});

bot.onText(/\/deleteaccount (.+)/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const username = match[1].trim();
  const db = loadDB();
  const before = db.accounts.length;
  db.accounts = db.accounts.filter(a => (a.username||'').toLowerCase() !== username.toLowerCase());
  saveDB(db);
  const removed = before - db.accounts.length;
  bot.sendMessage(msg.chat.id,
    removed
      ? `✅ Removed *${removed}* record(s) for \`${username}\``
      : `❌ No account found: \`${username}\``,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/clearaccounts/, (msg) => {
  if (!isAdmin(msg.from.id)) return;
  const db = loadDB();
  db.accounts = [];
  saveDB(db);
  bot.sendMessage(msg.chat.id, `✅ All account records cleared!`);
});

// ══════════════════════════════════════════════════════════════
//  REGISTER SLASH COMMANDS (shows in Telegram "/" menu)
// ══════════════════════════════════════════════════════════════
bot.setMyCommands([
  { command: 'start',         description: '👋 Start / Welcome' },
  { command: 'menu',          description: '🏠 Open main menu' },
  { command: 'createssh',     description: '🖥️ Create SSH account' },
  { command: 'createvless',   description: '📡 Create VLESS account' },
  { command: 'createvmess',   description: '📡 Create VMess account' },
  { command: 'createtrojan',  description: '🛡️ Create Trojan account' },
  { command: 'myaccounts',    description: '📋 View my active accounts' },
  { command: 'help',          description: '📖 Show all commands' },
  { command: 'request',       description: '🔐 Request access' },
]).catch(() => {});

// ══════════════════════════════════════════════════════════════
//  ERROR HANDLERS
// ══════════════════════════════════════════════════════════════
bot.on('polling_error', err => console.error('[POLLING]', err.message));
bot.on('error',         err => console.error('[BOT]',     err.message));

console.log('🤖 Yosh VIP Bot v3.0 is running...');
