const TelegramBot = require('node-telegram-bot-api');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// ─── CONFIG ────────────────────────────────────────────────────────────────
const config = require('./config.json');
const bot = new TelegramBot(config.BOT_TOKEN, { polling: true });

const DB_FILE = path.join(__dirname, 'accounts.json');
const EXPIRY_DAYS = 5;

// ─── DATABASE ──────────────────────────────────────────────────────────────
function loadDB() {
  if (!fs.existsSync(DB_FILE)) return { accounts: [], pendingAccess: [], approvedUsers: [] };
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if (!db.approvedUsers) db.approvedUsers = [];
  if (!db.pendingAccess) db.pendingAccess = [];
  if (!db.accounts) db.accounts = [];
  return db;
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
function isApproved(userId) {
  const db = loadDB();
  return db.approvedUsers.includes(userId) || userId.toString() === config.ADMIN_ID.toString();
}

// ─── UTILS ─────────────────────────────────────────────────────────────────
function formatDate(iso) {
  return new Date(iso).toLocaleString('en-PH', { timeZone: 'Asia/Manila' });
}
function expiryISO() {
  const d = new Date();
  d.setDate(d.getDate() + EXPIRY_DAYS);
  return d.toISOString();
}

// ─── CREATE SSH ACCOUNT ────────────────────────────────────────────────────
function createSSHAccount(username, password) {
  return new Promise((resolve, reject) => {
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
expect "Expiration (days):"
send "${EXPIRY_DAYS}\\r"
expect "Press Enter"
send "\\r"
expect "Option:"
send "0\\r"
expect "Option:"
send "0\\r"
expect eof
`;
    const tmpScript = `/tmp/ssh_${Date.now()}.exp`;
    fs.writeFileSync(tmpScript, script);
    const proc = spawn('expect', [tmpScript]);
    let output = '';
    proc.stdout.on('data', d => output += d.toString());
    proc.stderr.on('data', d => output += d.toString());
    proc.on('close', () => {
      fs.unlinkSync(tmpScript);
      if (output.toLowerCase().includes('created')) resolve(output);
      else reject('SSH creation failed:\n' + output);
    });
  });
}

// ─── DELETE SSH ACCOUNT ────────────────────────────────────────────────────
function deleteSSHAccount(username) {
  return new Promise((resolve) => {
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
    const tmpScript = `/tmp/delssh_${Date.now()}.exp`;
    fs.writeFileSync(tmpScript, script);
    const proc = spawn('expect', [tmpScript]);
    proc.on('close', () => { fs.unlinkSync(tmpScript); resolve(); });
  });
}

// ─── CREATE VLESS ACCOUNT ──────────────────────────────────────────────────
function createVLESSAccount(username, sni) {
  return new Promise((resolve, reject) => {
    const script = `
set timeout 60
spawn menu
expect "Option:"
send "2\\r"
expect "Option:"
send "1\\r"
expect "Enter username:"
send "${username}\\r"
expect "Expiration (days):"
send "${EXPIRY_DAYS}\\r"
expect "Enter SNI"
send "${sni}\\r"
expect "Press Enter"
send "\\r"
expect "Option:"
send "0\\r"
expect "Option:"
send "0\\r"
expect eof
`;
    const tmpScript = `/tmp/vless_${Date.now()}.exp`;
    fs.writeFileSync(tmpScript, script);
    const proc = spawn('expect', [tmpScript]);
    let output = '';
    proc.stdout.on('data', d => output += d.toString());
    proc.stderr.on('data', d => output += d.toString());
    proc.on('close', () => {
      fs.unlinkSync(tmpScript);
      const tlsMatch = output.match(/vless:\/\/[^\s]+443[^\s]+/);
      const nonTlsMatch = output.match(/vless:\/\/[^\s]+:80[^\s]+/);
      if (tlsMatch || nonTlsMatch) {
        resolve({
          tls: tlsMatch ? tlsMatch[0].trim() : null,
          nonTls: nonTlsMatch ? nonTlsMatch[0].trim() : null,
        });
      } else {
        reject('VLESS creation failed:\n' + output);
      }
    });
  });
}

// ─── DELETE VLESS ACCOUNT ─────────────────────────────────────────────────
function deleteVLESSAccount(username) {
  return new Promise((resolve) => {
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
    const tmpScript = `/tmp/delvless_${Date.now()}.exp`;
    fs.writeFileSync(tmpScript, script);
    const proc = spawn('expect', [tmpScript]);
    proc.on('close', () => { fs.unlinkSync(tmpScript); resolve(); });
  });
}

// ─── EXPIRY CHECKER ───────────────────────────────────────────────────────
async function checkExpiredAccounts() {
  const db = loadDB();
  const now = new Date();
  const expired = db.accounts.filter(a => new Date(a.expiry) <= now);
  for (const acc of expired) {
    try {
      if (acc.type === 'ssh') await deleteSSHAccount(acc.username);
      if (acc.type === 'vless') await deleteVLESSAccount(acc.username);
      await bot.sendMessage(acc.userId,
        `⚠️ Your *${acc.type.toUpperCase()}* account \`${acc.username}\` has *expired* and been deleted.\n\nCreate a new one anytime with /createssh or /createvless!`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
      console.log(`[EXPIRED] ${acc.type}: ${acc.username}`);
    } catch (e) {
      console.error(`[ERROR] ${acc.username}:`, e);
    }
  }
  db.accounts = db.accounts.filter(a => new Date(a.expiry) > now);
  saveDB(db);
}
setInterval(checkExpiredAccounts, 60 * 60 * 1000);
checkExpiredAccounts();

// ─── /start ───────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const name = msg.from.first_name || 'there';
  const approved = isApproved(msg.from.id);
  bot.sendMessage(msg.chat.id,
    `👋 Hello *${name}*! Welcome to *${config.SERVER_HOST}* VPN Bot!\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    (approved
      ? `🔑 /createssh — Create SSH account\n🌐 /createvless — Create VLESS account\n📋 /myaccounts — View your accounts\n`
      : `🔐 /request — Request access to this bot\n`
    ) +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⏳ All accounts expire in *${EXPIRY_DAYS} days*`,
    { parse_mode: 'Markdown' }
  );
});

// ─── /request — request access ────────────────────────────────────────────
bot.onText(/\/request/, (msg) => {
  const userId = msg.from.id;
  const db = loadDB();

  if (isApproved(userId)) {
    return bot.sendMessage(msg.chat.id,
      `✅ You already have access!\n\nUse:\n🔑 /createssh\n🌐 /createvless`
    );
  }
  if (db.pendingAccess.find(r => r.userId === userId)) {
    return bot.sendMessage(msg.chat.id, '⏳ Your access request is already pending. Please wait for admin approval.');
  }

  const requestId = uuidv4().slice(0, 8);
  db.pendingAccess.push({ requestId, userId, name: msg.from.first_name, username: msg.from.username || 'N/A', requestedAt: new Date().toISOString() });
  saveDB(db);

  bot.sendMessage(msg.chat.id,
    `✅ *Access Request Submitted!*\n\n⏳ Please wait for admin approval.\nOnce approved, you can create unlimited SSH and VLESS accounts!`,
    { parse_mode: 'Markdown' }
  );

  bot.sendMessage(config.ADMIN_ID,
    `🔔 New Access Request\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👤 Name: ${msg.from.first_name}\n` +
    `🆔 User ID: ${userId}\n` +
    `📛 Username: @${msg.from.username || 'N/A'}\n` +
    `🆔 Request ID: ${requestId}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `✅ Approve: /grantaccess_${requestId}\n` +
    `❌ Reject: /denyaccess_${requestId}`
  );
});

// ─── /createssh ───────────────────────────────────────────────────────────
bot.onText(/\/createssh/, (msg) => {
  const userId = msg.from.id;
  if (!isApproved(userId)) {
    return bot.sendMessage(msg.chat.id,
      `🚫 *You don't have access to this bot!*\n\nSend /request to ask for access.`,
      { parse_mode: 'Markdown' }
    );
  }

  bot.sendMessage(msg.chat.id,
    `🔑 *Create SSH Account*\n\nReply with your username and password:\n\n\`username password\`\n\n_Example: \`john mypass123\`_`,
    { parse_mode: 'Markdown' }
  );

  bot.once('message', async (reply) => {
    if (reply.chat.id !== msg.chat.id || !reply.text) return;
    const parts = reply.text.trim().split(/\s+/);
    if (parts.length < 2) {
      return bot.sendMessage(msg.chat.id, '❌ Invalid format. Example: `john mypass123`\n\nTry /createssh again.', { parse_mode: 'Markdown' });
    }

    const [username, password] = parts;
    if (!/^[a-zA-Z0-9_]{3,16}$/.test(username)) {
      return bot.sendMessage(msg.chat.id, '❌ Username must be 3-16 characters (letters, numbers, underscore only).\n\nTry /createssh again.');
    }

    bot.sendMessage(msg.chat.id, `⏳ Creating SSH account \`${username}\`...`, { parse_mode: 'Markdown' });

    try {
      await createSSHAccount(username, password);
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
        `🖥️ Connect: \`ssh ${username}@${config.SERVER_HOST}\``,
        { parse_mode: 'Markdown' }
      );

      // Notify admin
      bot.sendMessage(config.ADMIN_ID,
        `📌 SSH Account Created\n` +
        `👤 User: ${msg.from.first_name} (${userId})\n` +
        `🔑 Username: ${username}\n` +
        `📅 Expires: ${formatDate(expiry)}`
      );

    } catch (e) {
      console.error(e);
      bot.sendMessage(msg.chat.id, `❌ Failed to create SSH account. Please try again.\n\nError: \`${e}\``, { parse_mode: 'Markdown' });
    }
  });
});

// ─── /createvless ─────────────────────────────────────────────────────────
bot.onText(/\/createvless/, (msg) => {
  const userId = msg.from.id;
  if (!isApproved(userId)) {
    return bot.sendMessage(msg.chat.id,
      `🚫 *You don't have access to this bot!*\n\nSend /request to ask for access.`,
      { parse_mode: 'Markdown' }
    );
  }

  bot.sendMessage(msg.chat.id,
    `🌐 *Create VLESS Account*\n\nReply with your desired username:\n\n_Example: \`john\`_`,
    { parse_mode: 'Markdown' }
  );

  bot.once('message', async (reply) => {
    if (reply.chat.id !== msg.chat.id || !reply.text) return;
    const username = reply.text.trim().split(/\s+/)[0];
    if (!username || !/^[a-zA-Z0-9_]{3,16}$/.test(username)) {
      return bot.sendMessage(msg.chat.id, '❌ Invalid username. Must be 3-16 characters.\n\nTry /createvless again.');
    }

    const sni = config.SERVER_HOST;
    bot.sendMessage(msg.chat.id, `⏳ Creating VLESS account \`${username}\`...`, { parse_mode: 'Markdown' });

    try {
      const result = await createVLESSAccount(username, sni);
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
        `🔗 SNI        : \`${sni}\`\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🔒 *TLS (443):*\n\`${result.tls || 'N/A'}\`\n\n` +
        `🔓 *Non-TLS (80):*\n\`${result.nonTls || 'N/A'}\``,
        { parse_mode: 'Markdown' }
      );

      bot.sendMessage(config.ADMIN_ID,
        `📌 VLESS Account Created\n` +
        `👤 User: ${msg.from.first_name} (${userId})\n` +
        `🌐 Username: ${username}\n` +
        `📅 Expires: ${formatDate(expiry)}`
      );

    } catch (e) {
      console.error(e);
      bot.sendMessage(msg.chat.id, `❌ Failed to create VLESS account. Please try again.\n\nError: \`${e}\``, { parse_mode: 'Markdown' });
    }
  });
});

// ─── /myaccounts ──────────────────────────────────────────────────────────
bot.onText(/\/myaccounts/, (msg) => {
  if (!isApproved(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, `🚫 You don't have access. Send /request first.`);
  }
  const db = loadDB();
  const userAccounts = db.accounts.filter(a => a.userId === msg.from.id);
  if (userAccounts.length === 0) {
    return bot.sendMessage(msg.chat.id, '📭 You have no active accounts.\n\nCreate one with /createssh or /createvless!');
  }
  let text = `📋 *Your Active Accounts*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  for (const acc of userAccounts) {
    text += `📡 *Type:* ${acc.type.toUpperCase()}\n`;
    text += `👤 *Username:* \`${acc.username}\`\n`;
    text += `📅 *Expires:* ${formatDate(acc.expiry)}\n\n`;
  }
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

// ─── ADMIN: /grantaccess_<id> ─────────────────────────────────────────────
bot.onText(/\/grantaccess_(.+)/, (msg, match) => {
  if (msg.from.id.toString() !== config.ADMIN_ID.toString()) return;
  const requestId = match[1];
  const db = loadDB();
  const req = db.pendingAccess.find(r => r.requestId === requestId);
  if (!req) return bot.sendMessage(msg.chat.id, `❌ Request not found.`);

  db.approvedUsers.push(req.userId);
  db.pendingAccess = db.pendingAccess.filter(r => r.requestId !== requestId);
  saveDB(db);

  bot.sendMessage(req.userId,
    `✅ *Access Granted!*\n\n` +
    `You can now create unlimited accounts!\n\n` +
    `🔑 /createssh — Create SSH account\n` +
    `🌐 /createvless — Create VLESS account\n` +
    `📋 /myaccounts — View your accounts`,
    { parse_mode: 'Markdown' }
  );
  bot.sendMessage(msg.chat.id, `✅ Access granted to ${req.name} (${req.userId})!`);
});

// ─── ADMIN: /denyaccess_<id> ──────────────────────────────────────────────
bot.onText(/\/denyaccess_(.+)/, (msg, match) => {
  if (msg.from.id.toString() !== config.ADMIN_ID.toString()) return;
  const requestId = match[1];
  const db = loadDB();
  const req = db.pendingAccess.find(r => r.requestId === requestId);
  if (!req) return bot.sendMessage(msg.chat.id, `❌ Request not found.`);

  db.pendingAccess = db.pendingAccess.filter(r => r.requestId !== requestId);
  saveDB(db);

  bot.sendMessage(req.userId, `❌ Your access request has been denied by the admin.`);
  bot.sendMessage(msg.chat.id, `✅ Access denied for ${req.name} (${req.userId}).`);
});

// ─── ADMIN: /revokeaccess <userId> ────────────────────────────────────────
bot.onText(/\/revokeaccess (.+)/, (msg, match) => {
  if (msg.from.id.toString() !== config.ADMIN_ID.toString()) return;
  const targetId = parseInt(match[1]);
  const db = loadDB();
  db.approvedUsers = db.approvedUsers.filter(id => id !== targetId);
  saveDB(db);
  bot.sendMessage(msg.chat.id, `✅ Access revoked for user ${targetId}.`);
  bot.sendMessage(targetId, `❌ Your access to this bot has been revoked by the admin.`).catch(() => {});
});

// ─── ADMIN: /pending ──────────────────────────────────────────────────────
bot.onText(/\/pending/, (msg) => {
  if (msg.from.id.toString() !== config.ADMIN_ID.toString()) return;
  const db = loadDB();
  if (db.pendingAccess.length === 0) return bot.sendMessage(msg.chat.id, '📭 No pending access requests.');
  let text = `⏳ Pending Access Requests\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  for (const req of db.pendingAccess) {
    text += `👤 ${req.name} (@${req.username}) — ID: ${req.userId}\n`;
    text += `✅ /grantaccess_${req.requestId}  ❌ /denyaccess_${req.requestId}\n\n`;
  }
  bot.sendMessage(msg.chat.id, text);
});

// ─── ADMIN: /approvedusers ────────────────────────────────────────────────
bot.onText(/\/approvedusers/, (msg) => {
  if (msg.from.id.toString() !== config.ADMIN_ID.toString()) return;
  const db = loadDB();
  if (db.approvedUsers.length === 0) return bot.sendMessage(msg.chat.id, '📭 No approved users yet.');
  let text = `✅ Approved Users\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  for (const id of db.approvedUsers) {
    text += `👤 User ID: ${id}\n/revokeaccess ${id}\n\n`;
  }
  bot.sendMessage(msg.chat.id, text);
});

// ─── ADMIN: /listaccounts ─────────────────────────────────────────────────
bot.onText(/\/listaccounts/, (msg) => {
  if (msg.from.id.toString() !== config.ADMIN_ID.toString()) return;
  const db = loadDB();
  if (db.accounts.length === 0) return bot.sendMessage(msg.chat.id, '📭 No active accounts.');
  let text = `📋 All Active Accounts\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  for (const acc of db.accounts) {
    text += `👤 ${acc.username} — ${acc.type.toUpperCase()} — User ${acc.userId}\n`;
    text += `📅 Expires: ${formatDate(acc.expiry)}\n\n`;
  }
  bot.sendMessage(msg.chat.id, text);
});

console.log('🤖 Bot is running on ' + (config.SERVER_HOST || 'VPS') + '...');
