const TelegramBot = require('node-telegram-bot-api');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const config = require('./config.json');
const bot = new TelegramBot(config.BOT_TOKEN, { polling: true });

const DB_FILE = path.join(__dirname, 'accounts.json');
const EXPIRY_DAYS = 5;

// ─── DATABASE ──────────────────────────────────────────────────────────────
function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      const empty = { accounts: [], pendingAccess: [], approvedUsers: [] };
      fs.writeFileSync(DB_FILE, JSON.stringify(empty, null, 2));
      return empty;
    }
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!db.accounts) db.accounts = [];
    if (!db.pendingAccess) db.pendingAccess = [];
    if (!db.approvedUsers) db.approvedUsers = [];
    return db;
  } catch (e) {
    console.error('[DB ERROR] loadDB:', e.message);
    return { accounts: [], pendingAccess: [], approvedUsers: [] };
  }
}

function saveDB(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('[DB ERROR] saveDB:', e.message);
  }
}

function isApproved(userId) {
  if (userId.toString() === config.ADMIN_ID.toString()) return true;
  const db = loadDB();
  return db.approvedUsers.includes(userId);
}

function formatDate(iso) {
  return new Date(iso).toLocaleString('en-PH', { timeZone: 'Asia/Manila' });
}

function expiryISO() {
  const d = new Date();
  d.setDate(d.getDate() + EXPIRY_DAYS);
  return d.toISOString();
}

// ─── RUN COMMAND ──────────────────────────────────────────────────────────
function runExpect(script) {
  return new Promise((resolve, reject) => {
    const tmp = `/tmp/vipbot_${Date.now()}_${Math.random().toString(36).slice(2)}.exp`;
    fs.writeFileSync(tmp, script);
    exec(`expect "${tmp}"`, { timeout: 60000 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmp); } catch (_) {}
      const output = stdout + stderr;
      if (err && !output) return reject('Timeout or error: ' + (err.message || ''));
      resolve(output);
    });
  });
}

// ─── SSH ──────────────────────────────────────────────────────────────────
async function createSSH(username, password) {
  const script = `
set timeout 60
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
expect eof
`;
  const out = await runExpect(script);
  if (!out.toLowerCase().includes('created')) throw new Error('SSH creation failed');
  return out;
}

async function deleteSSH(username) {
  const script = `
set timeout 60
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
expect eof
`;
  await runExpect(script).catch(() => {});
}

// ─── VLESS ────────────────────────────────────────────────────────────────
async function createVLESS(username) {
  const sni = config.SERVER_HOST;
  const script = `
set timeout 60
spawn menu
expect "Option:"
send "2\\r"
expect "Option:"
send "1\\r"
expect "Enter username:"
send "${username}\\r"
expect "Expiration"
send "${EXPIRY_DAYS}\\r"
expect "SNI"
send "${sni}\\r"
expect "Press Enter"
send "\\r"
expect "Option:"
send "0\\r"
expect "Option:"
send "0\\r"
expect eof
`;
  const out = await runExpect(script);
  const tls = (out.match(/vless:\/\/\S+443\S+/) || [])[0] || null;
  const nonTls = (out.match(/vless:\/\/\S+:80\S+/) || [])[0] || null;
  if (!tls && !nonTls) throw new Error('VLESS creation failed');
  return { tls: tls ? tls.trim() : null, nonTls: nonTls ? nonTls.trim() : null };
}

async function deleteVLESS(username) {
  const script = `
set timeout 60
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
expect eof
`;
  await runExpect(script).catch(() => {});
}

// ─── EXPIRY CHECKER ───────────────────────────────────────────────────────
async function checkExpired() {
  const db = loadDB();
  const now = new Date();
  const expired = db.accounts.filter(a => new Date(a.expiry) <= now);
  for (const acc of expired) {
    try {
      if (acc.type === 'ssh') await deleteSSH(acc.username);
      if (acc.type === 'vless') await deleteVLESS(acc.username);
      bot.sendMessage(acc.userId,
        `⚠️ Your *${acc.type.toUpperCase()}* account \`${acc.username}\` has expired and been deleted.\n\nCreate a new one anytime!`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
      console.log(`[EXPIRED] ${acc.type} - ${acc.username}`);
    } catch (e) {
      console.error(`[EXPIRY ERROR] ${acc.username}:`, e.message);
    }
  }
  if (expired.length > 0) {
    db.accounts = db.accounts.filter(a => new Date(a.expiry) > now);
    saveDB(db);
  }
}
setInterval(checkExpired, 60 * 60 * 1000);
checkExpired();

// ─── WAITING USERS (track who is waiting for input) ───────────────────────
const waitingFor = new Map(); // userId -> 'ssh' | 'vless'

bot.on('message', async (msg) => {
  const userId = msg.from.id;
  const text = msg.text || '';

  // Skip commands
  if (text.startsWith('/')) return;

  // Check if user is waiting to provide info
  if (!waitingFor.has(userId)) return;

  const mode = waitingFor.get(userId);
  waitingFor.delete(userId);

  if (mode === 'ssh') {
    const parts = text.trim().split(/\s+/);
    if (parts.length < 2) {
      return bot.sendMessage(msg.chat.id, '❌ Invalid format!\n\nUse: `username password`\nExample: `john mypass123`\n\nTry /createssh again.', { parse_mode: 'Markdown' });
    }
    const [username, password] = parts;
    if (!/^[a-zA-Z0-9_]{3,16}$/.test(username)) {
      return bot.sendMessage(msg.chat.id, '❌ Username must be 3-16 characters (letters, numbers, underscore only).\n\nTry /createssh again.');
    }

    try {
      await createSSH(username, password);
      const expiry = expiryISO();
      const db = loadDB();
      db.accounts.push({ userId, username, password, type: 'ssh', expiry, createdAt: new Date().toISOString() });
      saveDB(db);

      bot.sendMessage(msg.chat.id,
        `✅ *SSH ACCOUNT CREATED*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 Username   : \`${username}\`\n` +
        `🔐 Password   : \`${password}\`\n` +
        `⏳ Duration   : ${EXPIRY_DAYS} Day/s\n` +
        `📅 Expires    : ${formatDate(expiry)}\n` +
        `🕐 Timezone   : Asia/Manila\n` +
        `🌐 Host       : \`${config.SERVER_HOST}\`\n` +
        `🔑 Nameserver : \`${config.SERVER_NS}\`\n` +
        `🔐 Public Key : \`${config.SERVER_PUBKEY}\`\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👑 *Server by: Yosh*`,
        { parse_mode: 'Markdown' }
      );
      bot.sendMessage(config.ADMIN_ID,
        `📌 SSH Created\n👤 ${msg.from.first_name} (${userId})\n🔑 ${username}\n📅 ${formatDate(expiry)}`
      ).catch(() => {});
    } catch (e) {
      console.error('[SSH ERROR]', e.message);
      bot.sendMessage(msg.chat.id, `❌ Failed to create SSH account.\n\nPlease try again with /createssh`);
    }

  } else if (mode === 'vless') {
    const username = text.trim().split(/\s+/)[0];
    if (!username || !/^[a-zA-Z0-9_]{3,16}$/.test(username)) {
      return bot.sendMessage(msg.chat.id, '❌ Invalid username. Must be 3-16 characters (letters, numbers, underscore).\n\nTry /createvless again.');
    }

    try {
      const result = await createVLESS(username);
      const expiry = expiryISO();
      const db = loadDB();
      db.accounts.push({ userId, username, type: 'vless', expiry, createdAt: new Date().toISOString() });
      saveDB(db);

      bot.sendMessage(msg.chat.id,
        `✅ *VLESS ACCOUNT CREATED*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📧 Email      : \`${username}\`\n` +
        `⏳ Expiration : ${EXPIRY_DAYS} days\n` +
        `📅 Expire Date: ${formatDate(expiry)}\n` +
        `🌐 Domain     : \`${config.SERVER_HOST}\`\n` +
        `🔗 SNI        : \`${config.SERVER_HOST}\`\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🔒 *TLS (443):*\n\`${result.tls || 'N/A'}\`\n\n` +
        `🔓 *Non-TLS (80):*\n\`${result.nonTls || 'N/A'}\`\n\n` +
        `👑 *Server by: Yosh*`,
        { parse_mode: 'Markdown' }
      );
      bot.sendMessage(config.ADMIN_ID,
        `📌 VLESS Created\n👤 ${msg.from.first_name} (${userId})\n🌐 ${username}\n📅 ${formatDate(expiry)}`
      ).catch(() => {});
    } catch (e) {
      console.error('[VLESS ERROR]', e.message);
      bot.sendMessage(msg.chat.id, `❌ Failed to create VLESS account.\n\nPlease try again with /createvless`);
    }
  }
});

// ─── /start ───────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const approved = isApproved(msg.from.id);
  bot.sendMessage(msg.chat.id,
    `👋 Hello, *${msg.from.first_name}*! Welcome to *Yosh VIP Bot*! 🎉\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🤖 *About this Bot*\n` +
    `This bot allows you to create your own\n` +
    `🔑 SSH and 🌐 VLESS accounts instantly\n` +
    `on our high-speed VPN server!\n\n` +
    `📌 *Features:*\n` +
    `• Fast account creation\n` +
    `• Accounts valid for *${EXPIRY_DAYS} days*\n` +
    `• Unlimited account creation\n` +
    `• SSH & VLESS supported\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    (approved
      ? `✅ *You have access! Use:*\n🔑 /createssh — Create SSH account\n🌐 /createvless — Create VLESS account\n`
      : `🔐 /request — Request access to this bot\n`
    ) +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👑 *Server by: Yosh*`,
    { parse_mode: 'Markdown' }
  );
});

// ─── /request ─────────────────────────────────────────────────────────────
bot.onText(/\/request/, (msg) => {
  const userId = msg.from.id;
  if (isApproved(userId)) {
    return bot.sendMessage(msg.chat.id,
      `✅ You already have access!\n\n🔑 /createssh — Create SSH account\n🌐 /createvless — Create VLESS account`
    );
  }
  const db = loadDB();
  if (db.pendingAccess.find(r => r.userId === userId)) {
    return bot.sendMessage(msg.chat.id, '⏳ Your request is already pending. Please wait for admin approval.');
  }
  const requestId = uuidv4().slice(0, 8);
  db.pendingAccess.push({
    requestId, userId,
    name: msg.from.first_name,
    username: msg.from.username || 'N/A',
    requestedAt: new Date().toISOString()
  });
  saveDB(db);

  bot.sendMessage(msg.chat.id,
    `✅ *Access Request Submitted!*\n\n⏳ Please wait for admin approval.\nOnce approved, you can create unlimited accounts!`,
    { parse_mode: 'Markdown' }
  );
  bot.sendMessage(config.ADMIN_ID,
    `🔔 New Access Request\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👤 Name: ${msg.from.first_name}\n` +
    `🆔 User ID: ${userId}\n` +
    `📛 Username: @${msg.from.username || 'N/A'}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `✅ Approve: /grantaccess_${requestId}\n` +
    `❌ Reject: /denyaccess_${requestId}`
  ).catch(() => {});
});

// ─── /createssh ───────────────────────────────────────────────────────────
bot.onText(/\/createssh/, (msg) => {
  if (!isApproved(msg.from.id)) {
    return bot.sendMessage(msg.chat.id,
      `🚫 *You don't have access to this bot!*\n\nSend /request to ask for access.`,
      { parse_mode: 'Markdown' }
    );
  }
  waitingFor.set(msg.from.id, 'ssh');
  bot.sendMessage(msg.chat.id,
    `🔑 *Create SSH Account*\n\nReply with your username and password:\n\n\`username password\`\n\n_Example: \`john mypass123\`_`,
    { parse_mode: 'Markdown' }
  );
});

// ─── /createvless ─────────────────────────────────────────────────────────
bot.onText(/\/createvless/, (msg) => {
  if (!isApproved(msg.from.id)) {
    return bot.sendMessage(msg.chat.id,
      `🚫 *You don't have access to this bot!*\n\nSend /request to ask for access.`,
      { parse_mode: 'Markdown' }
    );
  }
  waitingFor.set(msg.from.id, 'vless');
  bot.sendMessage(msg.chat.id,
    `🌐 *Create VLESS Account*\n\nReply with your desired username:\n\n_Example: \`john\`_`,
    { parse_mode: 'Markdown' }
  );
});

});

// ─── /help ────────────────────────────────────────────────────────────────
bot.onText(/\/help/, (msg) => {
  const isAdmin = msg.from.id.toString() === config.ADMIN_ID.toString();
  if (isAdmin) {
    bot.sendMessage(msg.chat.id,
      `🛠️ *Admin Commands*\n━━━━━━━━━━━━━━━━━━━━\n` +
      `👥 /pending — Pending access requests\n` +
      `✅ /grantaccess_<id> — Approve user\n` +
      `❌ /denyaccess_<id> — Deny user\n` +
      `🚫 /revokeaccess <userId> — Remove access\n` +
      `👤 /approvedusers — List approved users\n` +
      `🗑️ /deleteaccount <username> — Remove account from DB\n` +
      `🧹 /clearaccounts — Clear all account records\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👑 *Server by: Yosh*`,
      { parse_mode: 'Markdown' }
    );
  } else if (isApproved(msg.from.id)) {
    bot.sendMessage(msg.chat.id,
      `📖 *Commands*\n━━━━━━━━━━━━━━━━━━━━\n` +
      `🔑 /createssh — Create SSH account\n` +
      `🌐 /createvless — Create VLESS account\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👑 *Server by: Yosh*`,
      { parse_mode: 'Markdown' }
    );
  } else {
    bot.sendMessage(msg.chat.id,
      `🚫 *You don't have access yet!*\n\nSend /request to ask for access.`,
      { parse_mode: 'Markdown' }
    );
  }
});

// ─── ADMIN: /grantaccess_<id> ─────────────────────────────────────────────
bot.onText(/\/grantaccess_(.+)/, (msg, match) => {
  if (msg.from.id.toString() !== config.ADMIN_ID.toString()) return;
  const db = loadDB();
  const req = db.pendingAccess.find(r => r.requestId === match[1]);
  if (!req) return bot.sendMessage(msg.chat.id, `❌ Request not found.`);
  if (!db.approvedUsers.includes(req.userId)) db.approvedUsers.push(req.userId);
  db.pendingAccess = db.pendingAccess.filter(r => r.requestId !== match[1]);
  saveDB(db);
  bot.sendMessage(req.userId,
    `✅ *Access Granted!*\n\nWelcome to *Yosh VIP Bot*! 🎉\nYou can now create unlimited accounts!\n\n🔑 /createssh — Create SSH account\n🌐 /createvless — Create VLESS account`,
    { parse_mode: 'Markdown' }
  ).catch(() => {});
  bot.sendMessage(msg.chat.id, `✅ Access granted to ${req.name} (${req.userId})!`);
});

// ─── ADMIN: /denyaccess_<id> ──────────────────────────────────────────────
bot.onText(/\/denyaccess_(.+)/, (msg, match) => {
  if (msg.from.id.toString() !== config.ADMIN_ID.toString()) return;
  const db = loadDB();
  const req = db.pendingAccess.find(r => r.requestId === match[1]);
  if (!req) return bot.sendMessage(msg.chat.id, `❌ Request not found.`);
  db.pendingAccess = db.pendingAccess.filter(r => r.requestId !== match[1]);
  saveDB(db);
  bot.sendMessage(req.userId, `❌ Your access request has been denied.`).catch(() => {});
  bot.sendMessage(msg.chat.id, `✅ Denied access for ${req.name}.`);
});

// ─── ADMIN: /revokeaccess <userId> ────────────────────────────────────────
bot.onText(/\/revokeaccess (.+)/, (msg, match) => {
  if (msg.from.id.toString() !== config.ADMIN_ID.toString()) return;
  const targetId = parseInt(match[1]);
  const db = loadDB();
  db.approvedUsers = db.approvedUsers.filter(id => id !== targetId);
  saveDB(db);
  bot.sendMessage(msg.chat.id, `✅ Access revoked for user ${targetId}.`);
  bot.sendMessage(targetId, `❌ Your access has been revoked by the admin.`).catch(() => {});
});

// ─── ADMIN: /pending ──────────────────────────────────────────────────────
bot.onText(/\/pending/, (msg) => {
  if (msg.from.id.toString() !== config.ADMIN_ID.toString()) return;
  const db = loadDB();
  if (db.pendingAccess.length === 0) return bot.sendMessage(msg.chat.id, '📭 No pending requests.');
  let text = `⏳ Pending Access Requests\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  for (const req of db.pendingAccess) {
    text += `👤 ${req.name} (@${req.username})\n🆔 ${req.userId}\n`;
    text += `/grantaccess_${req.requestId}\n/denyaccess_${req.requestId}\n\n`;
  }
  bot.sendMessage(msg.chat.id, text);
});

// ─── ADMIN: /approvedusers ────────────────────────────────────────────────
bot.onText(/\/approvedusers/, (msg) => {
  if (msg.from.id.toString() !== config.ADMIN_ID.toString()) return;
  const db = loadDB();
  if (db.approvedUsers.length === 0) return bot.sendMessage(msg.chat.id, '📭 No approved users.');
  let text = `✅ Approved Users\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  for (const id of db.approvedUsers) text += `👤 ${id}\n/revokeaccess ${id}\n\n`;
  bot.sendMessage(msg.chat.id, text);
});


// ─── ADMIN: /deleteaccount <username> ─────────────────────────────────────
bot.onText(/\/deleteaccount (.+)/, (msg, match) => {
  if (msg.from.id.toString() !== config.ADMIN_ID.toString()) return;
  const username = match[1].trim();
  const db = loadDB();
  const before = db.accounts.length;
  db.accounts = db.accounts.filter(a => a.username.toLowerCase() !== username.toLowerCase());
  saveDB(db);
  if (db.accounts.length < before) {
    bot.sendMessage(msg.chat.id, `✅ Account \`${username}\` removed from bot records.`, { parse_mode: 'Markdown' });
  } else {
    bot.sendMessage(msg.chat.id, `❌ No account found with username \`${username}\`.`, { parse_mode: 'Markdown' });
  }
});

// ─── ADMIN: /clearaccounts ────────────────────────────────────────────────
bot.onText(/\/clearaccounts/, (msg) => {
  if (msg.from.id.toString() !== config.ADMIN_ID.toString()) return;
  const db = loadDB();
  db.accounts = [];
  saveDB(db);
  bot.sendMessage(msg.chat.id, `✅ All account records cleared!`);
});

// ─── ERROR HANDLING ───────────────────────────────────────────────────────
bot.on('polling_error', (err) => console.error('[POLLING ERROR]', err.message));
bot.on('error', (err) => console.error('[BOT ERROR]', err.message));

console.log('🤖 Bot is running on ' + config.SERVER_HOST + '...');
