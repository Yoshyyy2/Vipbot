const TelegramBot = require('node-telegram-bot-api');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const config = require('./config.json');
const bot = new TelegramBot(config.BOT_TOKEN, { polling: true });

const DB_FILE = path.join(__dirname, 'accounts.json');
const EXPIRY_DAYS = 5;

function loadDB() {
  if (!fs.existsSync(DB_FILE)) return { accounts: [], pendingAccess: [], approvedUsers: [] };
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if (!db.approvedUsers) db.approvedUsers = [];
  if (!db.pendingAccess) db.pendingAccess = [];
  if (!db.accounts) db.accounts = [];
  return db;
}
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
function isApproved(userId) {
  const db = loadDB();
  return db.approvedUsers.includes(userId) || userId.toString() === config.ADMIN_ID.toString();
}
function formatDate(iso) { return new Date(iso).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }); }
function expiryISO() { const d = new Date(); d.setDate(d.getDate() + EXPIRY_DAYS); return d.toISOString(); }

function createSSHAccount(username, password) {
  return new Promise((resolve, reject) => {
    const script = `set timeout 60\nspawn menu\nexpect "Option:"\nsend "1\\r"\nexpect "Option:"\nsend "1\\r"\nexpect "Enter username:"\nsend "${username}\\r"\nexpect "Enter password:"\nsend "${password}\\r"\nexpect "Expiration (days):"\nsend "${EXPIRY_DAYS}\\r"\nexpect "Press Enter"\nsend "\\r"\nexpect "Option:"\nsend "0\\r"\nexpect "Option:"\nsend "0\\r"\nexpect eof`;
    const tmp = `/tmp/ssh_${Date.now()}.exp`;
    fs.writeFileSync(tmp, script);
    const proc = spawn('expect', [tmp]);
    let out = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => out += d.toString());
    proc.on('close', () => { fs.unlinkSync(tmp); out.toLowerCase().includes('created') ? resolve(out) : reject(out); });
  });
}

function deleteSSHAccount(username) {
  return new Promise((resolve) => {
    const script = `set timeout 60\nspawn menu\nexpect "Option:"\nsend "1\\r"\nexpect "Option:"\nsend "2\\r"\nexpect "username:"\nsend "${username}\\r"\nexpect "Press Enter"\nsend "\\r"\nexpect "Option:"\nsend "0\\r"\nexpect "Option:"\nsend "0\\r"\nexpect eof`;
    const tmp = `/tmp/delssh_${Date.now()}.exp`;
    fs.writeFileSync(tmp, script);
    const proc = spawn('expect', [tmp]);
    proc.on('close', () => { fs.unlinkSync(tmp); resolve(); });
  });
}

function createVLESSAccount(username, sni) {
  return new Promise((resolve, reject) => {
    const script = `set timeout 60\nspawn menu\nexpect "Option:"\nsend "2\\r"\nexpect "Option:"\nsend "1\\r"\nexpect "Enter username:"\nsend "${username}\\r"\nexpect "Expiration (days):"\nsend "${EXPIRY_DAYS}\\r"\nexpect "Enter SNI"\nsend "${sni}\\r"\nexpect "Press Enter"\nsend "\\r"\nexpect "Option:"\nsend "0\\r"\nexpect "Option:"\nsend "0\\r"\nexpect eof`;
    const tmp = `/tmp/vless_${Date.now()}.exp`;
    fs.writeFileSync(tmp, script);
    const proc = spawn('expect', [tmp]);
    let out = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => out += d.toString());
    proc.on('close', () => {
      fs.unlinkSync(tmp);
      const tls = out.match(/vless:\/\/[^\s]+443[^\s]+/);
      const nonTls = out.match(/vless:\/\/[^\s]+:80[^\s]+/);
      if (tls || nonTls) resolve({ tls: tls ? tls[0].trim() : null, nonTls: nonTls ? nonTls[0].trim() : null });
      else reject(out);
    });
  });
}

function deleteVLESSAccount(username) {
  return new Promise((resolve) => {
    const script = `set timeout 60\nspawn menu\nexpect "Option:"\nsend "2\\r"\nexpect "Option:"\nsend "2\\r"\nexpect "username:"\nsend "${username}\\r"\nexpect "Press Enter"\nsend "\\r"\nexpect "Option:"\nsend "0\\r"\nexpect "Option:"\nsend "0\\r"\nexpect eof`;
    const tmp = `/tmp/delvless_${Date.now()}.exp`;
    fs.writeFileSync(tmp, script);
    const proc = spawn('expect', [tmp]);
    proc.on('close', () => { fs.unlinkSync(tmp); resolve(); });
  });
}

async function checkExpiredAccounts() {
  const db = loadDB();
  const now = new Date();
  const expired = db.accounts.filter(a => new Date(a.expiry) <= now);
  for (const acc of expired) {
    try {
      if (acc.type === 'ssh') await deleteSSHAccount(acc.username);
      if (acc.type === 'vless') await deleteVLESSAccount(acc.username);
      await bot.sendMessage(acc.userId, `⚠️ Your *${acc.type.toUpperCase()}* account \`${acc.username}\` has expired and been deleted.\n\nCreate a new one with /createssh or /createvless!`, { parse_mode: 'Markdown' }).catch(() => {});
    } catch (e) { console.error(e); }
  }
  db.accounts = db.accounts.filter(a => new Date(a.expiry) > now);
  saveDB(db);
}
setInterval(checkExpiredAccounts, 60 * 60 * 1000);
checkExpiredAccounts();

// /start
bot.onText(/\/start/, (msg) => {
  const approved = isApproved(msg.from.id);
  bot.sendMessage(msg.chat.id,
    `👋 Hello *${msg.from.first_name}*! Welcome to *${config.SERVER_HOST}* VPN Bot!\n\n━━━━━━━━━━━━━━━━━━━━\n` +
    (approved
      ? `🔑 /createssh — Create SSH account\n🌐 /createvless — Create VLESS account\n📋 /myaccounts — View your accounts\n`
      : `🔐 /request — Request access to this bot\n`) +
    `━━━━━━━━━━━━━━━━━━━━\n⏳ All accounts expire in *${EXPIRY_DAYS} days*`,
    { parse_mode: 'Markdown' }
  );
});

// /request
bot.onText(/\/request/, (msg) => {
  const userId = msg.from.id;
  const db = loadDB();
  if (isApproved(userId)) return bot.sendMessage(msg.chat.id, `✅ You already have access!\n\n🔑 /createssh\n🌐 /createvless`);
  if (db.pendingAccess.find(r => r.userId === userId)) return bot.sendMessage(msg.chat.id, '⏳ Your request is already pending. Please wait for admin approval.');

  const requestId = uuidv4().slice(0, 8);
  db.pendingAccess.push({ requestId, userId, name: msg.from.first_name, username: msg.from.username || 'N/A', requestedAt: new Date().toISOString() });
  saveDB(db);

  bot.sendMessage(msg.chat.id, `✅ *Access Request Submitted!*\n\n⏳ Please wait for admin approval.\nOnce approved, you can create unlimited accounts!`, { parse_mode: 'Markdown' });
  bot.sendMessage(config.ADMIN_ID,
    `🔔 New Access Request\n━━━━━━━━━━━━━━━━━━━━\n👤 Name: ${msg.from.first_name}\n🆔 User ID: ${userId}\n📛 Username: @${msg.from.username || 'N/A'}\n━━━━━━━━━━━━━━━━━━━━\n✅ Approve: /grantaccess_${requestId}\n❌ Reject: /denyaccess_${requestId}`
  );
});

// /createssh
bot.onText(/\/createssh/, (msg) => {
  if (!isApproved(msg.from.id)) return bot.sendMessage(msg.chat.id, `🚫 *You don't have access to this bot!*\n\nSend /request to ask for access.`, { parse_mode: 'Markdown' });

  bot.sendMessage(msg.chat.id, `🔑 *Create SSH Account*\n\nReply with your username and password:\n\n\`username password\`\n\n_Example: \`john mypass123\`_`, { parse_mode: 'Markdown' });

  bot.once('message', async (reply) => {
    if (reply.chat.id !== msg.chat.id || !reply.text) return;
    const parts = reply.text.trim().split(/\s+/);
    if (parts.length < 2) return bot.sendMessage(msg.chat.id, '❌ Invalid format. Try /createssh again.');
    const [username, password] = parts;
    if (!/^[a-zA-Z0-9_]{3,16}$/.test(username)) return bot.sendMessage(msg.chat.id, '❌ Username must be 3-16 characters (letters, numbers, underscore). Try /createssh again.');

    bot.sendMessage(msg.chat.id, `⏳ Creating SSH account for *${username}*...`, { parse_mode: 'Markdown' });
    try {
      await createSSHAccount(username, password);
      const expiry = expiryISO();
      const db = loadDB();
      db.accounts.push({ userId: msg.from.id, username, password, type: 'ssh', expiry, createdAt: new Date().toISOString() });
      saveDB(db);

      bot.sendMessage(msg.chat.id,
        `✅ *SSH ACCOUNT CREATED*\n━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 Username   : \`${username}\`\n🔐 Password   : \`${password}\`\n⏳ Duration   : ${EXPIRY_DAYS} Day/s\n` +
        `📅 Expires    : ${formatDate(expiry)}\n🕐 Timezone   : Asia/Manila\n🌐 Host       : \`${config.SERVER_HOST}\`\n` +
        `🔑 Nameserver : \`${config.SERVER_NS}\`\n🔐 Public Key : \`${config.SERVER_PUBKEY}\`\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👑 *Server by: Yosh*`,
        { parse_mode: 'Markdown' }
      );
      bot.sendMessage(config.ADMIN_ID, `📌 SSH Created\n👤 ${msg.from.first_name} (${msg.from.id})\n🔑 ${username}\n📅 ${formatDate(expiry)}`).catch(()=>{});
    } catch (e) {
      console.error(e);
      bot.sendMessage(msg.chat.id, `❌ Failed to create SSH account. Try again with /createssh`);
    }
  });
});

// /createvless
bot.onText(/\/createvless/, (msg) => {
  if (!isApproved(msg.from.id)) return bot.sendMessage(msg.chat.id, `🚫 *You don't have access to this bot!*\n\nSend /request to ask for access.`, { parse_mode: 'Markdown' });

  bot.sendMessage(msg.chat.id, `🌐 *Create VLESS Account*\n\nReply with your desired username:\n\n_Example: \`john\`_`, { parse_mode: 'Markdown' });

  bot.once('message', async (reply) => {
    if (reply.chat.id !== msg.chat.id || !reply.text) return;
    const username = reply.text.trim().split(/\s+/)[0];
    if (!username || !/^[a-zA-Z0-9_]{3,16}$/.test(username)) return bot.sendMessage(msg.chat.id, '❌ Invalid username. Try /createvless again.');

    const sni = config.SERVER_HOST;
    bot.sendMessage(msg.chat.id, `⏳ Creating VLESS account for *${username}*...`, { parse_mode: 'Markdown' });
    try {
      const result = await createVLESSAccount(username, sni);
      const expiry = expiryISO();
      const db = loadDB();
      db.accounts.push({ userId: msg.from.id, username, type: 'vless', expiry, createdAt: new Date().toISOString() });
      saveDB(db);

      bot.sendMessage(msg.chat.id,
        `✅ *VLESS ACCOUNT CREATED*\n━━━━━━━━━━━━━━━━━━━━\n` +
        `📧 Email      : \`${username}\`\n⏳ Expiration : ${EXPIRY_DAYS} days\n📅 Expire Date: ${formatDate(expiry)}\n` +
        `🌐 Domain     : \`${config.SERVER_HOST}\`\n🔗 SNI        : \`${sni}\`\n━━━━━━━━━━━━━━━━━━━━\n` +
        `🔒 *TLS (443):*\n\`${result.tls || 'N/A'}\`\n\n🔓 *Non-TLS (80):*\n\`${result.nonTls || 'N/A'}\``,
        { parse_mode: 'Markdown' }
      );
      bot.sendMessage(config.ADMIN_ID, `📌 VLESS Created\n👤 ${msg.from.first_name} (${msg.from.id})\n🌐 ${username}\n📅 ${formatDate(expiry)}`);
    } catch (e) {
      console.error(e);
      bot.sendMessage(msg.chat.id, `❌ Failed to create VLESS account. Try again with /createvless`);
    }
  });
});

// /myaccounts
bot.onText(/\/myaccounts/, (msg) => {
  if (!isApproved(msg.from.id)) return bot.sendMessage(msg.chat.id, `🚫 You don't have access. Send /request first.`);
  const db = loadDB();
  const accs = db.accounts.filter(a => a.userId === msg.from.id);
  if (accs.length === 0) return bot.sendMessage(msg.chat.id, '📭 No active accounts.\n\nCreate one with /createssh or /createvless!');
  let text = `📋 *Your Active Accounts*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  for (const acc of accs) {
    text += `📡 *Type:* ${acc.type.toUpperCase()}\n👤 *Username:* \`${acc.username}\`\n📅 *Expires:* ${formatDate(acc.expiry)}\n\n`;
  }
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

// Admin: /grantaccess_<id>
bot.onText(/\/grantaccess_(.+)/, (msg, match) => {
  if (msg.from.id.toString() !== config.ADMIN_ID.toString()) return;
  const db = loadDB();
  const req = db.pendingAccess.find(r => r.requestId === match[1]);
  if (!req) return bot.sendMessage(msg.chat.id, `❌ Request not found.`);
  db.approvedUsers.push(req.userId);
  db.pendingAccess = db.pendingAccess.filter(r => r.requestId !== match[1]);
  saveDB(db);
  bot.sendMessage(req.userId, `✅ *Access Granted!*\n\nYou can now create unlimited accounts!\n\n🔑 /createssh\n🌐 /createvless\n📋 /myaccounts`, { parse_mode: 'Markdown' });
  bot.sendMessage(msg.chat.id, `✅ Access granted to ${req.name} (${req.userId})!`);
});

// Admin: /denyaccess_<id>
bot.onText(/\/denyaccess_(.+)/, (msg, match) => {
  if (msg.from.id.toString() !== config.ADMIN_ID.toString()) return;
  const db = loadDB();
  const req = db.pendingAccess.find(r => r.requestId === match[1]);
  if (!req) return bot.sendMessage(msg.chat.id, `❌ Request not found.`);
  db.pendingAccess = db.pendingAccess.filter(r => r.requestId !== match[1]);
  saveDB(db);
  bot.sendMessage(req.userId, `❌ Your access request has been denied.`);
  bot.sendMessage(msg.chat.id, `✅ Denied access for ${req.name}.`);
});

// Admin: /revokeaccess <userId>
bot.onText(/\/revokeaccess (.+)/, (msg, match) => {
  if (msg.from.id.toString() !== config.ADMIN_ID.toString()) return;
  const targetId = parseInt(match[1]);
  const db = loadDB();
  db.approvedUsers = db.approvedUsers.filter(id => id !== targetId);
  saveDB(db);
  bot.sendMessage(msg.chat.id, `✅ Access revoked for user ${targetId}.`);
  bot.sendMessage(targetId, `❌ Your access has been revoked by the admin.`).catch(() => {});
});

// Admin: /pending
bot.onText(/\/pending/, (msg) => {
  if (msg.from.id.toString() !== config.ADMIN_ID.toString()) return;
  const db = loadDB();
  if (db.pendingAccess.length === 0) return bot.sendMessage(msg.chat.id, '📭 No pending requests.');
  let text = `⏳ Pending Access Requests\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  for (const req of db.pendingAccess) {
    text += `👤 ${req.name} (@${req.username}) — ${req.userId}\n✅ /grantaccess_${req.requestId}  ❌ /denyaccess_${req.requestId}\n\n`;
  }
  bot.sendMessage(msg.chat.id, text);
});

// Admin: /approvedusers
bot.onText(/\/approvedusers/, (msg) => {
  if (msg.from.id.toString() !== config.ADMIN_ID.toString()) return;
  const db = loadDB();
  if (db.approvedUsers.length === 0) return bot.sendMessage(msg.chat.id, '📭 No approved users.');
  let text = `✅ Approved Users\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  for (const id of db.approvedUsers) text += `👤 ${id}\n/revokeaccess ${id}\n\n`;
  bot.sendMessage(msg.chat.id, text);
});

// Admin: /listaccounts
bot.onText(/\/listaccounts/, (msg) => {
  if (msg.from.id.toString() !== config.ADMIN_ID.toString()) return;
  const db = loadDB();
  if (db.accounts.length === 0) return bot.sendMessage(msg.chat.id, '📭 No active accounts.');
  let text = `📋 All Active Accounts\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  for (const acc of db.accounts) text += `👤 ${acc.username} — ${acc.type.toUpperCase()} — User ${acc.userId}\n📅 ${formatDate(acc.expiry)}\n\n`;
  bot.sendMessage(msg.chat.id, text);
});


// /help
bot.onText(/\/help/, (msg) => {
  const isAdmin = msg.from.id.toString() === config.ADMIN_ID.toString();
  if (isAdmin) {
    bot.sendMessage(msg.chat.id,
      `🛠️ *Admin Commands*\n━━━━━━━━━━━━━━━━━━━━\n` +
      `👥 /pending — View pending access requests\n` +
      `✅ /grantaccess_<id> — Approve user access\n` +
      `❌ /denyaccess_<id> — Deny user access\n` +
      `🚫 /revokeaccess <userId> — Revoke user access\n` +
      `👤 /approvedusers — List approved users\n` +
      `📋 /listaccounts — List all active accounts\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👑 *Server by: Yosh*`,
      { parse_mode: 'Markdown' }
    );
  } else if (isApproved(msg.from.id)) {
    bot.sendMessage(msg.chat.id,
      `📖 *Commands*\n━━━━━━━━━━━━━━━━━━━━\n` +
      `🔑 /createssh — Create SSH account\n` +
      `🌐 /createvless — Create VLESS account\n` +
      `📋 /myaccounts — View your active accounts\n` +
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

console.log('🤖 Bot is running on ' + (config.SERVER_HOST || 'VPS') + '...');
