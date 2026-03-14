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
const EXPIRY_DAYS = config.EXPIRY_DAYS || 3;

const COST       = { ssh: 3, vless: 2, vmess: 2, trojan: 2 };
const PROTO_ICON = { ssh: '🖥️', vless: '📡', vmess: '📡', trojan: '🛡️' };
const LINE       = '━━━━━━━━━━━━━━━━━━━━━━';

// ══════════════════════════════════════════════════════════════
//  DATABASE
// ══════════════════════════════════════════════════════════════
function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      const blank = { accounts: [], users: {}, codes: [], bannedUsers: [] };
      fs.writeFileSync(DB_FILE, JSON.stringify(blank, null, 2));
      return blank;
    }
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db.accounts    = db.accounts    || [];
    db.users       = db.users       || {};
    db.codes       = db.codes       || [];
    db.bannedUsers = db.bannedUsers || [];
    return db;
  } catch { return { accounts: [], users: {}, codes: [], bannedUsers: [] }; }
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ══════════════════════════════════════════════════════════════
//  AUTH & CREDITS
// ══════════════════════════════════════════════════════════════
const toId     = id => parseInt(id);
const isAdmin  = id => toId(id) === toId(config.ADMIN_ID);
const isBanned = id => loadDB().bannedUsers.map(toId).includes(toId(id));

function getUser(userId) {
  return loadDB().users[toId(userId)] || null;
}

function getCredits(userId) {
  if (isAdmin(userId)) return Infinity;
  const u = getUser(userId);
  return u ? u.credits : 0;
}

function deductCredits(userId, amount) {
  const db = loadDB();
  const id = toId(userId);
  if (!db.users[id] || db.users[id].credits < amount) return false;
  db.users[id].credits -= amount;
  saveDB(db);
  return true;
}

function registerUser(userId, name) {
  const db = loadDB();
  const id = toId(userId);
  if (!db.users[id]) {
    db.users[id] = { name: name || 'User', credits: 0, registeredAt: new Date().toISOString() };
    saveDB(db);
  }
  return db.users[id];
}

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

function getActiveAccounts(userId) {
  const now = new Date();
  return loadDB().accounts.filter(a =>
    a.userId === toId(userId) && new Date(a.expiry) > now
  );
}

function creditsDisplay(userId) {
  return isAdmin(userId) ? '∞' : String(getCredits(userId));
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
  const out = await runExpect(script);
  const all = out.match(/vless:\/\/\S+/g) || [];
  if (!all.length) throw new Error('VLESS creation failed');
  return { tls: all.find(l => l.includes('443'))?.trim() || null, nonTls: all.find(l => l.includes(':80'))?.trim() || null };
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
  return { tls: all.find(l => l.includes('443'))?.trim() || null, nonTls: all.find(l => l.includes(':80'))?.trim() || null };
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
  return { tls: all.find(l => l.includes('443'))?.trim() || null, nonTls: all.find(l => l.includes(':80'))?.trim() || null };
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
//  AUTO EXPIRY CLEANER
// ══════════════════════════════════════════════════════════════
async function checkExpired() {
  const db  = loadDB();
  const now = new Date();
  const expired = db.accounts.filter(a => new Date(a.expiry) <= now);
  for (const acc of expired) {
    try {
      if (acc.type === 'ssh')                            await deleteSSH(acc.username);
      if (['vless','vmess','trojan'].includes(acc.type)) await deleteV2Ray(acc.username || acc.password);
      bot.sendMessage(acc.userId,
        `⚠️ *Account Expired*\n${LINE}\n` +
        `${PROTO_ICON[acc.type]} *${acc.type.toUpperCase()}* · \`${acc.username || acc.password}\`\n` +
        `📅 Expired: ${formatDate(acc.expiry)}\n\n` +
        `Use /redeem to get more credits! 🎟️`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    } catch (e) { console.error('[EXPIRY]', e.message); }
  }
  if (expired.length) {
    db.accounts = db.accounts.filter(a => new Date(a.expiry) > now);
    saveDB(db);
  }
}
setInterval(checkExpired, 60 * 60 * 1000);
checkExpired();

// ══════════════════════════════════════════════════════════════
//  SESSION STATE
// ══════════════════════════════════════════════════════════════
const sessions = new Map();
const set$   = (id, s) => sessions.set(id, s);
const get$   = id => sessions.get(id) || null;
const clear$ = id => sessions.delete(id);

// ══════════════════════════════════════════════════════════════
//  KEYBOARDS
// ══════════════════════════════════════════════════════════════
const KB_MAIN = { inline_keyboard: [
  [{ text: '🖥️  SSH Account',   callback_data: 'menu_ssh'    },
   { text: '📡  V2Ray Account', callback_data: 'menu_v2ray'  }],
  [{ text: '📋  My Accounts',   callback_data: 'my_accounts' },
   { text: '💰  My Credits',    callback_data: 'my_credits'  }],
  [{ text: '🌐  Server Info',   callback_data: 'server_info' },
   { text: '📖  Help',          callback_data: 'help'        }]
]};

const KB_V2RAY = { inline_keyboard: [
  [{ text: '📡 VLESS',  callback_data: 'proto_vless'  },
   { text: '📡 VMess',  callback_data: 'proto_vmess'  },
   { text: '🛡️ Trojan', callback_data: 'proto_trojan' }],
  [{ text: '‹ Back',    callback_data: 'back_main'    }]
]};

const KB_CANCEL = { inline_keyboard: [[{ text: '✕  Cancel', callback_data: 'cancel' }]] };
const KB_BACK   = { inline_keyboard: [[{ text: '‹ Back to Menu', callback_data: 'back_main' }]] };

// ══════════════════════════════════════════════════════════════
//  MESSAGE BUILDERS
// ══════════════════════════════════════════════════════════════
function msgSSHResult(u, p, expiry, remaining) {
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
    `💰  *Credits Used* : 3  |  *Remaining* : ${remaining}\n` +
    `${LINE}\n` +
    `👑 *Server by Yosh — 🇸🇬 Singapore*`
  );
}

function msgV2RayResult(proto, data, remaining) {
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
    `💰  *Credits Used* : 2  |  *Remaining* : ${remaining}\n` +
    `${LINE}\n` +
    `👑 *Server by Yosh — 🇸🇬 Singapore*`
  );
}

// ══════════════════════════════════════════════════════════════
//  CREATION FLOW
// ══════════════════════════════════════════════════════════════
function startCreate(chatId, userId, proto) {
  if (isBanned(userId)) return;
  registerUser(userId, 'User');

  const credits = getCredits(userId);
  const cost    = COST[proto];
  const icon    = PROTO_ICON[proto];

  if (!isAdmin(userId) && credits < cost) {
    return bot.sendMessage(chatId,
      `❌ *Not Enough Credits!*\n\n` +
      `💰 Your credits : *${credits}*\n` +
      `💸 Cost         : *${cost}*\n\n` +
      `Ask admin for a redeem code!\nUse: \`/redeem <code>\``,
      { parse_mode: 'Markdown', reply_markup: KB_BACK }
    );
  }

  if (proto === 'ssh') {
    set$(userId, { step: 'ssh_user', proto });
    bot.sendMessage(chatId,
      `${icon} *Create SSH Account*\n${LINE}\n\n` +
      `💰 Your credits: *${creditsDisplay(userId)}* _(costs 3)_\n\n` +
      `Enter your desired *username*:\n_3–16 chars · letters / numbers / _`,
      { parse_mode: 'Markdown', reply_markup: KB_CANCEL }
    );
  } else if (proto === 'trojan') {
    set$(userId, { step: 'trojan_pass', proto });
    bot.sendMessage(chatId,
      `${icon} *Create Trojan Account*\n${LINE}\n\n` +
      `💰 Your credits: *${creditsDisplay(userId)}* _(costs 2)_\n\n` +
      `Enter your *password*:\n_Min. 4 characters_`,
      { parse_mode: 'Markdown', reply_markup: KB_CANCEL }
    );
  } else {
    set$(userId, { step: 'v2ray_user', proto });
    bot.sendMessage(chatId,
      `${icon} *Create ${proto.toUpperCase()} Account*\n${LINE}\n\n` +
      `💰 Your credits: *${creditsDisplay(userId)}* _(costs 2)_\n\n` +
      `Enter your desired *username*:\n_3–16 chars · letters / numbers / _`,
      { parse_mode: 'Markdown', reply_markup: KB_CANCEL }
    );
  }
}

// ══════════════════════════════════════════════════════════════
//  TEXT MESSAGE HANDLER
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
      return bot.sendMessage(msg.chat.id, `❌ *Invalid username!*\n_3–16 chars · letters/numbers/_ only_\n\nTry again:`, { parse_mode: 'Markdown', reply_markup: KB_CANCEL });
    }
    set$(userId, { step: 'ssh_pass', proto, username: text });
    return bot.sendMessage(msg.chat.id, `👤 Username: \`${text}\`\n\nNow enter your *password*:\n_Min. 4 characters_`, { parse_mode: 'Markdown', reply_markup: KB_CANCEL });
  }

  // ─── SSH step 2: password ──────────────────────────────
  if (step === 'ssh_pass') {
    if (text.length < 4) return bot.sendMessage(msg.chat.id, `❌ Password too short! Min. 4 characters.\n\nTry again:`, { parse_mode: 'Markdown', reply_markup: KB_CANCEL });
    const { username } = sess;
    clear$(userId);
    if (!isAdmin(userId) && getCredits(userId) < 3) {
      return bot.sendMessage(msg.chat.id, `❌ Not enough credits! Need *3*, you have *${getCredits(userId)}*.`, { parse_mode: 'Markdown', reply_markup: KB_BACK });
    }
    const wait = await bot.sendMessage(msg.chat.id, `⏳ Creating SSH account, please wait...`);
    try {
      await createSSH(username, text);
      if (!isAdmin(userId)) deductCredits(userId, 3);
      const expiry = expiryISO();
      const db = loadDB(); db.accounts.push({ userId: toId(userId), username, password: text, type: 'ssh', expiry, createdAt: new Date().toISOString() }); saveDB(db);
      bot.editMessageText(msgSSHResult(username, text, expiry, creditsDisplay(userId)), { chat_id: msg.chat.id, message_id: wait.message_id, parse_mode: 'Markdown', reply_markup: KB_BACK });
      bot.sendMessage(config.ADMIN_ID, `📌 *SSH Created*\n👤 ${msg.from.first_name} (\`${userId}\`)\n🔑 \`${username}\`\n📅 ${formatDate(expiry)}`, { parse_mode: 'Markdown' }).catch(() => {});
    } catch (e) {
      console.error('[SSH]', e.message);
      bot.editMessageText(`❌ Failed to create SSH account. Please try again.`, { chat_id: msg.chat.id, message_id: wait.message_id, reply_markup: KB_BACK });
    }
    return;
  }

  // ─── V2Ray step 1: username ────────────────────────────
  if (step === 'v2ray_user') {
    if (!/^[a-zA-Z0-9_]{3,16}$/.test(text)) {
      return bot.sendMessage(msg.chat.id, `❌ *Invalid username!*\n_3–16 chars · letters/numbers/_ only_\n\nTry again:`, { parse_mode: 'Markdown', reply_markup: KB_CANCEL });
    }
    set$(userId, { step: 'v2ray_pass', proto, username: text });
    return bot.sendMessage(msg.chat.id, `👤 Username: \`${text}\`\n\nNow enter your *password*:\n_Min. 4 characters_`, { parse_mode: 'Markdown', reply_markup: KB_CANCEL });
  }

  // ─── V2Ray step 2: password ────────────────────────────
  if (step === 'v2ray_pass') {
    if (text.length < 4) return bot.sendMessage(msg.chat.id, `❌ Password too short! Min. 4 characters.\n\nTry again:`, { parse_mode: 'Markdown', reply_markup: KB_CANCEL });
    const { username } = sess;
    clear$(userId);
    if (!isAdmin(userId) && getCredits(userId) < 2) {
      return bot.sendMessage(msg.chat.id, `❌ Not enough credits! Need *2*, you have *${getCredits(userId)}*.`, { parse_mode: 'Markdown', reply_markup: KB_BACK });
    }
    const wait = await bot.sendMessage(msg.chat.id, `⏳ Creating ${proto.toUpperCase()} account, please wait...`);
    try {
      const result = proto === 'vless' ? await createVLESS(username) : await createVMess(username);
      if (!isAdmin(userId)) deductCredits(userId, 2);
      const expiry = expiryISO();
      const db = loadDB(); db.accounts.push({ userId: toId(userId), username, password: text, type: proto, expiry, createdAt: new Date().toISOString(), ...result }); saveDB(db);
      bot.editMessageText(msgV2RayResult(proto, { username, password: text, expiry, ...result }, creditsDisplay(userId)), { chat_id: msg.chat.id, message_id: wait.message_id, parse_mode: 'Markdown', reply_markup: KB_BACK });
      bot.sendMessage(config.ADMIN_ID, `📌 *${proto.toUpperCase()} Created*\n👤 ${msg.from.first_name} (\`${userId}\`)\n🌐 \`${username}\`\n📅 ${formatDate(expiry)}`, { parse_mode: 'Markdown' }).catch(() => {});
    } catch (e) {
      console.error(`[${proto.toUpperCase()}]`, e.message);
      bot.editMessageText(`❌ Failed to create ${proto.toUpperCase()} account. Please try again.`, { chat_id: msg.chat.id, message_id: wait.message_id, reply_markup: KB_BACK });
    }
    return;
  }

  // ─── Trojan: password ──────────────────────────────────
  if (step === 'trojan_pass') {
    if (text.length < 4) return bot.sendMessage(msg.chat.id, `❌ Password too short! Min. 4 characters.\n\nTry again:`, { parse_mode: 'Markdown', reply_markup: KB_CANCEL });
    clear$(userId);
    if (!isAdmin(userId) && getCredits(userId) < 2) {
      return bot.sendMessage(msg.chat.id, `❌ Not enough credits! Need *2*, you have *${getCredits(userId)}*.`, { parse_mode: 'Markdown', reply_markup: KB_BACK });
    }
    const wait = await bot.sendMessage(msg.chat.id, `⏳ Creating Trojan account, please wait...`);
    try {
      const result = await createTrojan(text);
      if (!isAdmin(userId)) deductCredits(userId, 2);
      const expiry = expiryISO();
      const db = loadDB(); db.accounts.push({ userId: toId(userId), username: text, password: text, type: 'trojan', expiry, createdAt: new Date().toISOString(), ...result }); saveDB(db);
      bot.editMessageText(msgV2RayResult('trojan', { password: text, expiry, ...result }, creditsDisplay(userId)), { chat_id: msg.chat.id, message_id: wait.message_id, parse_mode: 'Markdown', reply_markup: KB_BACK });
      bot.sendMessage(config.ADMIN_ID, `📌 *Trojan Created*\n👤 ${msg.from.first_name} (\`${userId}\`)\n🔐 \`${text}\`\n📅 ${formatDate(expiry)}`, { parse_mode: 'Markdown' }).catch(() => {});
    } catch (e) {
      console.error('[TROJAN]', e.message);
      bot.editMessageText(`❌ Failed to create Trojan account. Please try again.`, { chat_id: msg.chat.id, message_id: wait.message_id, reply_markup: KB_BACK });
    }
    return;
  }
});

// ══════════════════════════════════════════════════════════════
//  CALLBACK QUERY
// ══════════════════════════════════════════════════════════════
bot.on('callback_query', async (q) => {
  const userId = q.from.id;
  const data   = q.data;
  const chatId = q.message.chat.id;
  const msgId  = q.message.message_id;
  bot.answerCallbackQuery(q.id).catch(() => {});
  if (isBanned(userId)) return;

  if (data === 'back_main') {
    clear$(userId);
    return bot.editMessageText(`🇸🇬 *Yosh VIP Panel*\n💰 Credits: *${creditsDisplay(userId)}*\n\nWhat would you like to do?`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: KB_MAIN });
  }
  if (data === 'cancel') {
    clear$(userId);
    return bot.editMessageText(`❌ *Cancelled*\n\nReturning to menu...`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: KB_MAIN });
  }
  if (data === 'menu_ssh')    { bot.deleteMessage(chatId, msgId).catch(() => {}); return startCreate(chatId, userId, 'ssh'); }
  if (data === 'menu_v2ray')  { return bot.editMessageText(`📡 *Create V2Ray Account*\n\nChoose a protocol:`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: KB_V2RAY }); }
  if (data === 'proto_vless') { bot.deleteMessage(chatId, msgId).catch(() => {}); return startCreate(chatId, userId, 'vless'); }
  if (data === 'proto_vmess') { bot.deleteMessage(chatId, msgId).catch(() => {}); return startCreate(chatId, userId, 'vmess'); }
  if (data === 'proto_trojan'){ bot.deleteMessage(chatId, msgId).catch(() => {}); return startCreate(chatId, userId, 'trojan'); }

  if (data === 'my_accounts') {
    const accs = getActiveAccounts(userId);
    if (!accs.length) return bot.editMessageText(`📭 *No Active Accounts*\n\nCreate one from the menu!`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: KB_MAIN });
    let text = `📋 *Your Active Accounts*\n${LINE}\n\n`;
    accs.forEach((a, i) => { text += `${i+1}. ${PROTO_ICON[a.type]} *${a.type.toUpperCase()}*\n   👤 \`${a.username||a.password}\`\n   📅 ${formatDate(a.expiry)}\n\n`; });
    text += `${LINE}\nTotal: *${accs.length}* account(s)`;
    return bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: KB_BACK });
  }

  if (data === 'my_credits') {
    return bot.editMessageText(
      `💰 *Your Credits*\n${LINE}\n\n` +
      `👤 *Name*    : ${q.from.first_name}\n` +
      `💳 *Credits* : *${creditsDisplay(userId)}*\n\n` +
      `🖥️ SSH costs *3 credits*\n` +
      `📡 V2Ray costs *2 credits*\n\n` +
      `_Use /redeem <code> to top up!_`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: KB_BACK }
    );
  }

  if (data === 'server_info') {
    const total = loadDB().accounts.filter(a => new Date(a.expiry) > new Date()).length;
    return bot.editMessageText(
      `🌐 *Server Info*\n${LINE}\n` +
      `🏠 *Host*   : \`${config.SERVER_HOST}\`\n` +
      `📡 *NS*     : \`${config.SERVER_NS}\`\n` +
      `📊 *Active* : *${total}* account(s)\n` +
      `⏳ *Expiry* : *${EXPIRY_DAYS}* day(s)\n` +
      `${LINE}\n👑 *Server by Yosh*`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: KB_BACK }
    );
  }

  if (data === 'help') {
    return bot.editMessageText(
      `📖 *Commands*\n${LINE}\n` +
      `🏠 /menu — Open main menu\n` +
      `🎟️ /redeem <code> — Redeem a code\n` +
      `💰 /credits — Check your credits\n` +
      `🖥️ /createssh — Create SSH _(3 credits)_\n` +
      `📡 /createvless — Create VLESS _(2 credits)_\n` +
      `📡 /createvmess — Create VMess _(2 credits)_\n` +
      `🛡️ /createtrojan — Create Trojan _(2 credits)_\n` +
      `📋 /myaccounts — My active accounts\n` +
      `${LINE}\n👑 *Server by Yosh*`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: KB_BACK }
    );
  }
});

// ══════════════════════════════════════════════════════════════
//  /start  /menu
// ══════════════════════════════════════════════════════════════
bot.onText(/\/start/, (msg) => {
  if (isBanned(msg.from.id)) return;
  clear$(msg.from.id);
  registerUser(msg.from.id, msg.from.first_name);
  bot.sendMessage(msg.chat.id,
    `👋 Welcome, *${msg.from.first_name}*!\n\n` +
    `🇸🇬 *Yosh VIP Panel*\n` +
    `Singapore Server · SSH & V2Ray\n\n` +
    `💰 Your credits: *${creditsDisplay(msg.from.id)}*\n\n` +
    `_No credits? Ask admin for a redeem code!_\n` +
    `_Use: /redeem <code>_`,
    { parse_mode: 'Markdown', reply_markup: KB_MAIN }
  );
});

bot.onText(/\/menu/, (msg) => {
  if (isBanned(msg.from.id)) return;
  clear$(msg.from.id);
  registerUser(msg.from.id, msg.from.first_name);
  bot.sendMessage(msg.chat.id,
    `🇸🇬 *Yosh VIP Panel*\n💰 Credits: *${creditsDisplay(msg.from.id)}*\n\nWhat would you like to do?`,
    { parse_mode: 'Markdown', reply_markup: KB_MAIN }
  );
});

// ══════════════════════════════════════════════════════════════
//  /redeem
// ══════════════════════════════════════════════════════════════
bot.onText(/\/redeem(.*)/, (msg, match) => {
  if (isBanned(msg.from.id)) return;
  const userId = msg.from.id;
  const code   = (match[1] || '').trim().toUpperCase();
  registerUser(userId, msg.from.first_name);

  if (!code) {
    return bot.sendMessage(msg.chat.id,
      `🎟️ *Redeem a Code*\n\nUsage: \`/redeem <code>\`\nExample: \`/redeem YOSH-ABCD1234\`\n\n💰 Your credits: *${creditsDisplay(userId)}*`,
      { parse_mode: 'Markdown' }
    );
  }

  const db    = loadDB();
  const entry = db.codes.find(c => c.code === code);
  if (!entry)       return bot.sendMessage(msg.chat.id, `❌ *Invalid code!* Check the code and try again.`, { parse_mode: 'Markdown' });
  if (entry.usedBy) return bot.sendMessage(msg.chat.id, `❌ *Code already used!* This code has been redeemed already.`, { parse_mode: 'Markdown' });

  entry.usedBy   = toId(userId);
  entry.usedAt   = new Date().toISOString();
  entry.usedName = msg.from.first_name;
  db.users[toId(userId)].credits += entry.credits;
  saveDB(db);

  const newTotal = db.users[toId(userId)].credits;
  bot.sendMessage(msg.chat.id,
    `✅ *Code Redeemed!*\n${LINE}\n` +
    `🎟️ *Code*        : \`${code}\`\n` +
    `💰 *Credits Got* : *+${entry.credits}*\n` +
    `💳 *Total Now*   : *${newTotal}*\n` +
    `${LINE}\n` +
    `🖥️ SSH costs *3 credits*\n` +
    `📡 V2Ray costs *2 credits*\n\n` +
    `Use /menu to start! 🚀`,
    { parse_mode: 'Markdown' }
  );
  bot.sendMessage(config.ADMIN_ID,
    `🎟️ *Code Redeemed*\n👤 ${msg.from.first_name} (\`${userId}\`)\n💰 +${entry.credits} credits\n🔑 \`${code}\``,
    { parse_mode: 'Markdown' }
  ).catch(() => {});
});

// ══════════════════════════════════════════════════════════════
//  /credits  /myaccounts  /help  + shortcuts
// ══════════════════════════════════════════════════════════════
bot.onText(/\/credits/, (msg) => {
  if (isBanned(msg.from.id)) return;
  registerUser(msg.from.id, msg.from.first_name);
  bot.sendMessage(msg.chat.id,
    `💰 *Your Credits*\n${LINE}\n\n` +
    `👤 *Name*    : ${msg.from.first_name}\n` +
    `💳 *Credits* : *${creditsDisplay(msg.from.id)}*\n\n` +
    `🖥️ SSH costs *3 credits*\n` +
    `📡 V2Ray costs *2 credits*\n\n` +
    `_Use /redeem <code> to top up!_`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/createssh/,    msg => { if (!isBanned(msg.from.id)) { registerUser(msg.from.id, msg.from.first_name); startCreate(msg.chat.id, msg.from.id, 'ssh'); }});
bot.onText(/\/createvless/,  msg => { if (!isBanned(msg.from.id)) { registerUser(msg.from.id, msg.from.first_name); startCreate(msg.chat.id, msg.from.id, 'vless'); }});
bot.onText(/\/createvmess/,  msg => { if (!isBanned(msg.from.id)) { registerUser(msg.from.id, msg.from.first_name); startCreate(msg.chat.id, msg.from.id, 'vmess'); }});
bot.onText(/\/createtrojan/, msg => { if (!isBanned(msg.from.id)) { registerUser(msg.from.id, msg.from.first_name); startCreate(msg.chat.id, msg.from.id, 'trojan'); }});

bot.onText(/\/myaccounts/, (msg) => {
  if (isBanned(msg.from.id)) return;
  const accs = getActiveAccounts(msg.from.id);
  if (!accs.length) return bot.sendMessage(msg.chat.id, `📭 *No Active Accounts*\n\nCreate one with /menu!`, { parse_mode: 'Markdown' });
  let text = `📋 *Your Active Accounts*\n${LINE}\n\n`;
  accs.forEach((a, i) => { text += `${i+1}. ${PROTO_ICON[a.type]} *${a.type.toUpperCase()}*\n   👤 \`${a.username||a.password}\`\n   📅 ${formatDate(a.expiry)}\n\n`; });
  text += `${LINE}\nTotal: *${accs.length}* account(s)`;
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown', reply_markup: KB_BACK });
});

bot.onText(/\/help/, (msg) => {
  if (isBanned(msg.from.id)) return;
  if (isAdmin(msg.from.id)) {
    return bot.sendMessage(msg.chat.id,
      `🛠️ *Admin Commands*\n${LINE}\n` +
      `📊 /stats — Bot statistics\n` +
      `🎟️ /gencode <credits> — Generate redeem code\n` +
      `📋 /codes — List all codes\n` +
      `💰 /addcredits <id> <amount> — Add credits\n` +
      `👥 /users — List all users\n` +
      `🚫 /ban <id> — Ban a user\n` +
      `✅ /unban <id> — Unban a user\n` +
      `🗑️ /deleteaccount <username>\n` +
      `🧹 /clearaccounts — Clear all records\n` +
      `${LINE}\n👑 *Server by Yosh*`,
      { parse_mode: 'Markdown' }
    );
  }
  bot.sendMessage(msg.chat.id,
    `📖 *Commands*\n${LINE}\n` +
    `🏠 /menu — Open main menu\n` +
    `🎟️ /redeem <code> — Redeem a code\n` +
    `💰 /credits — Check your credits\n` +
    `🖥️ /createssh — Create SSH _(3 credits)_\n` +
    `📡 /createvless — Create VLESS _(2 credits)_\n` +
    `📡 /createvmess — Create VMess _(2 credits)_\n` +
    `🛡️ /createtrojan — Create Trojan _(2 credits)_\n` +
    `📋 /myaccounts — My active accounts\n` +
    `${LINE}\n👑 *Server by Yosh*`,
    { parse_mode: 'Markdown' }
  );
});

// ══════════════════════════════════════════════════════════════
//  ADMIN COMMANDS
// ══════════════════════════════════════════════════════════════
bot.onText(/\/gencode (.+)/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const amount = parseInt(match[1]);
  if (isNaN(amount) || amount <= 0) return bot.sendMessage(msg.chat.id, `❌ Usage: /gencode <credits>\nExample: /gencode 10`);
  const code = 'YOSH-' + uuidv4().slice(0, 8).toUpperCase();
  const db   = loadDB();
  db.codes.push({ code, credits: amount, usedBy: null, createdAt: new Date().toISOString() });
  saveDB(db);
  bot.sendMessage(msg.chat.id,
    `✅ *Redeem Code Generated!*\n${LINE}\n` +
    `🎟️ *Code*    : \`${code}\`\n` +
    `💰 *Credits* : *${amount}*\n` +
    `${LINE}\n` +
    `Share to user → \`/redeem ${code}\``,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/codes/, (msg) => {
  if (!isAdmin(msg.from.id)) return;
  const db = loadDB();
  if (!db.codes.length) return bot.sendMessage(msg.chat.id, `📭 No codes generated yet.`);
  let text = `🎟️ *All Codes*\n${LINE}\n\n`;
  db.codes.slice(-20).forEach((c, i) => {
    const status = c.usedBy ? `✅ Used by \`${c.usedBy}\`` : `🟢 Available`;
    text += `${i+1}. \`${c.code}\` — *${c.credits}* credits\n   ${status}\n\n`;
  });
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/addcredits (\d+) (\d+)/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const targetId = toId(match[1]);
  const amount   = parseInt(match[2]);
  const db = loadDB();
  if (!db.users[targetId]) db.users[targetId] = { name: 'User', credits: 0, registeredAt: new Date().toISOString() };
  db.users[targetId].credits += amount;
  saveDB(db);
  bot.sendMessage(msg.chat.id, `✅ Added *${amount}* credits to \`${targetId}\`\nNew total: *${db.users[targetId].credits}*`, { parse_mode: 'Markdown' });
  bot.sendMessage(targetId, `💰 *Credits Added!*\n\nAdmin added *+${amount}* credits!\nYour total: *${db.users[targetId].credits}*`, { parse_mode: 'Markdown' }).catch(() => {});
});

bot.onText(/\/users/, (msg) => {
  if (!isAdmin(msg.from.id)) return;
  const db = loadDB();
  const users = Object.entries(db.users);
  if (!users.length) return bot.sendMessage(msg.chat.id, `📭 No users yet.`);
  let text = `👥 *All Users* (${users.length})\n${LINE}\n\n`;
  users.forEach(([id, u]) => { text += `👤 \`${id}\` — *${u.name}* — 💰 *${u.credits}* credits\n`; });
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/stats/, (msg) => {
  if (!isAdmin(msg.from.id)) return;
  const db = loadDB();
  const now = new Date();
  const active = db.accounts.filter(a => new Date(a.expiry) > now);
  const today = new Date(); today.setHours(0,0,0,0);
  const newToday  = db.accounts.filter(a => new Date(a.createdAt) >= today).length;
  const usedCodes = db.codes.filter(c => c.usedBy).length;
  bot.sendMessage(msg.chat.id,
    `📊 *Bot Statistics*\n${LINE}\n` +
    `👥 Total users     : *${Object.keys(db.users).length}*\n` +
    `🚫 Banned          : *${db.bannedUsers.length}*\n` +
    `🎟️ Codes           : *${db.codes.length}* (${usedCodes} used)\n` +
    `${LINE}\n` +
    `📋 Active accounts : *${active.length}*\n` +
    `   🖥️  SSH    : *${active.filter(a=>a.type==='ssh').length}*\n` +
    `   📡 VLESS  : *${active.filter(a=>a.type==='vless').length}*\n` +
    `   📡 VMess  : *${active.filter(a=>a.type==='vmess').length}*\n` +
    `   🛡️  Trojan : *${active.filter(a=>a.type==='trojan').length}*\n` +
    `${LINE}\n` +
    `📅 Created today   : *${newToday}*\n` +
    `${LINE}\n👑 *Server by Yosh*`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/ban (.+)/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const targetId = toId(match[1]);
  const db = loadDB();
  if (!db.bannedUsers.includes(targetId)) db.bannedUsers.push(targetId);
  saveDB(db);
  bot.sendMessage(msg.chat.id, `🚫 User \`${targetId}\` banned.`, { parse_mode: 'Markdown' });
  bot.sendMessage(targetId, `🚫 You have been banned from this bot.`).catch(() => {});
});

bot.onText(/\/unban (.+)/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const targetId = toId(match[1]);
  const db = loadDB();
  db.bannedUsers = db.bannedUsers.filter(id => id !== targetId);
  saveDB(db);
  bot.sendMessage(msg.chat.id, `✅ User \`${targetId}\` unbanned.`, { parse_mode: 'Markdown' });
});

bot.onText(/\/deleteaccount (.+)/, (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const username = match[1].trim();
  const db = loadDB();
  const before = db.accounts.length;
  db.accounts = db.accounts.filter(a => (a.username||'').toLowerCase() !== username.toLowerCase());
  saveDB(db);
  const removed = before - db.accounts.length;
  bot.sendMessage(msg.chat.id, removed ? `✅ Removed *${removed}* record(s) for \`${username}\`` : `❌ No account found: \`${username}\``, { parse_mode: 'Markdown' });
});

bot.onText(/\/clearaccounts/, (msg) => {
  if (!isAdmin(msg.from.id)) return;
  const db = loadDB(); db.accounts = []; saveDB(db);
  bot.sendMessage(msg.chat.id, `✅ All account records cleared!`);
});

// ══════════════════════════════════════════════════════════════
//  REGISTER SLASH COMMANDS
// ══════════════════════════════════════════════════════════════
bot.setMyCommands([
  { command: 'start',        description: '👋 Start / Welcome' },
  { command: 'menu',         description: '🏠 Open main menu' },
  { command: 'redeem',       description: '🎟️ Redeem a code for credits' },
  { command: 'credits',      description: '💰 Check your credits' },
  { command: 'createssh',    description: '🖥️ Create SSH (3 credits)' },
  { command: 'createvless',  description: '📡 Create VLESS (2 credits)' },
  { command: 'createvmess',  description: '📡 Create VMess (2 credits)' },
  { command: 'createtrojan', description: '🛡️ Create Trojan (2 credits)' },
  { command: 'myaccounts',   description: '📋 View my active accounts' },
  { command: 'help',         description: '📖 Show all commands' },
]).catch(() => {});

bot.on('polling_error', err => console.error('[POLLING]', err.message));
bot.on('error',         err => console.error('[BOT]',     err.message));

console.log('🤖 Yosh VIP Bot v4.0 — Credits System — Running...');
