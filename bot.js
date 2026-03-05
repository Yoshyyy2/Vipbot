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
  if (!fs.existsSync(DB_FILE)) return { accounts: [], pendingRequests: [] };
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
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
function generatePassword() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}

// ─── CREATE SSH ACCOUNT via expect ────────────────────────────────────────
function createSSHAccount(username, password) {
  return new Promise((resolve, reject) => {
    const script = `
set timeout 30
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
    const tmpScript = `/tmp/create_ssh_${Date.now()}.exp`;
    fs.writeFileSync(tmpScript, script);

    const proc = spawn('expect', [tmpScript]);
    let output = '';
    proc.stdout.on('data', d => output += d.toString());
    proc.stderr.on('data', d => output += d.toString());
    proc.on('close', code => {
      fs.unlinkSync(tmpScript);
      if (output.includes('USER CREATED') || output.includes('user created') || output.toLowerCase().includes('created')) {
        resolve(output);
      } else {
        reject('SSH creation failed. Output:\n' + output);
      }
    });
  });
}

// ─── DELETE SSH ACCOUNT ────────────────────────────────────────────────────
function deleteSSHAccount(username) {
  return new Promise((resolve) => {
    const script = `
set timeout 30
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
    const tmpScript = `/tmp/del_ssh_${Date.now()}.exp`;
    fs.writeFileSync(tmpScript, script);
    const proc = spawn('expect', [tmpScript]);
    proc.on('close', () => {
      fs.unlinkSync(tmpScript);
      resolve();
    });
  });
}

// ─── CREATE VLESS ACCOUNT via expect ──────────────────────────────────────
function createVLESSAccount(username, sni) {
  return new Promise((resolve, reject) => {
    const script = `
set timeout 30
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
    const tmpScript = `/tmp/create_vless_${Date.now()}.exp`;
    fs.writeFileSync(tmpScript, script);

    const proc = spawn('expect', [tmpScript]);
    let output = '';
    proc.stdout.on('data', d => output += d.toString());
    proc.stderr.on('data', d => output += d.toString());
    proc.on('close', code => {
      fs.unlinkSync(tmpScript);
      // Extract the vless:// links from output
      const tlsMatch = output.match(/vless:\/\/[^\s]+443[^\s]+/);
      const nonTlsMatch = output.match(/vless:\/\/[^\s]+:80[^\s]+/);
      const expireDateMatch = output.match(/Expire Date\s*:\s*(.+)/);

      if (tlsMatch || nonTlsMatch) {
        resolve({
          tls: tlsMatch ? tlsMatch[0].trim() : null,
          nonTls: nonTlsMatch ? nonTlsMatch[0].trim() : null,
          expireDate: expireDateMatch ? expireDateMatch[1].trim() : null,
          rawOutput: output
        });
      } else {
        reject('VLESS creation failed. Output:\n' + output);
      }
    });
  });
}

// ─── DELETE VLESS ACCOUNT ─────────────────────────────────────────────────
function deleteVLESSAccount(username) {
  return new Promise((resolve) => {
    const script = `
set timeout 30
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
    const tmpScript = `/tmp/del_vless_${Date.now()}.exp`;
    fs.writeFileSync(tmpScript, script);
    const proc = spawn('expect', [tmpScript]);
    proc.on('close', () => {
      fs.unlinkSync(tmpScript);
      resolve();
    });
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
        `⚠️ Your *${acc.type.toUpperCase()}* account \`${acc.username}\` has *expired* and been deleted.\n\nYou may request a new one anytime!`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});

      console.log(`[EXPIRED] Deleted ${acc.type}: ${acc.username}`);
    } catch (e) {
      console.error(`[ERROR] Failed to delete ${acc.username}:`, e);
    }
  }

  db.accounts = db.accounts.filter(a => new Date(a.expiry) > now);
  saveDB(db);
}

setInterval(checkExpiredAccounts, 60 * 60 * 1000);
checkExpiredAccounts();

// ─── BOT COMMANDS ─────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  const name = msg.from.first_name || 'there';
  bot.sendMessage(msg.chat.id,
    `👋 Hello *${name}*! Welcome to *${config.SERVER_HOST}* VPN Bot!\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🔑 /requestssh — Request SSH account\n` +
    `🌐 /requestvless — Request VLESS account\n` +
    `📋 /myaccounts — View your active accounts\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⏳ All accounts expire in *${EXPIRY_DAYS} days*`,
    { parse_mode: 'Markdown' }
  );
});

// /requestssh — ask for username + password
bot.onText(/\/requestssh/, (msg) => {
  const userId = msg.from.id;
  const db = loadDB();

  if (db.pendingRequests.find(r => r.userId === userId && r.type === 'ssh')) {
    return bot.sendMessage(msg.chat.id, '⏳ You already have a pending SSH request. Please wait for admin approval.');
  }
  if (db.accounts.find(a => a.userId === userId && a.type === 'ssh')) {
    return bot.sendMessage(msg.chat.id, '❌ You already have an active SSH account. Wait for it to expire before requesting a new one.');
  }

  bot.sendMessage(msg.chat.id,
    `🔑 *SSH Account Request*\n\nPlease reply with your desired username and password in this format:\n\n\`username password\`\n\n_Example: \`john mypass123\`_`,
    { parse_mode: 'Markdown' }
  );

  // Wait for their next message with username + password
  bot.once('message', (reply) => {
    if (reply.chat.id !== msg.chat.id) return;
    const parts = reply.text && reply.text.trim().split(/\s+/);
    if (!parts || parts.length < 2) {
      return bot.sendMessage(msg.chat.id, '❌ Invalid format. Please use: /requestssh and try again.');
    }

    const [username, password] = parts;
    if (!/^[a-zA-Z0-9_]{3,16}$/.test(username)) {
      return bot.sendMessage(msg.chat.id, '❌ Username must be 3-16 characters (letters, numbers, underscore only). Try /requestssh again.');
    }

    const requestId = uuidv4().slice(0, 8);
    const db2 = loadDB();
    db2.pendingRequests.push({ requestId, userId, username, password, type: 'ssh', requestedAt: new Date().toISOString() });
    saveDB(db2);

    bot.sendMessage(msg.chat.id,
      `✅ *SSH Request Submitted!*\n\n🆔 Request ID: \`${requestId}\`\n👤 Username: \`${username}\`\n⏳ Waiting for admin approval...`,
      { parse_mode: 'Markdown' }
    );

    bot.sendMessage(config.ADMIN_ID,
      `🔔 *New SSH Request*\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 User: [${msg.from.first_name}](tg://user?id=${userId})\n` +
      `🆔 User ID: \`${userId}\`\n` +
      `🔑 Username: \`${username}\`\n` +
      `🔐 Password: \`${password}\`\n` +
      `🆔 Request ID: \`${requestId}\`\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `✅ Approve: /approve_${requestId}\n` +
      `❌ Reject: /reject_${requestId}`,
      { parse_mode: 'Markdown' }
    );
  });
});

// /requestvless — ask for username + SNI
bot.onText(/\/requestvless/, (msg) => {
  const userId = msg.from.id;
  const db = loadDB();

  if (db.pendingRequests.find(r => r.userId === userId && r.type === 'vless')) {
    return bot.sendMessage(msg.chat.id, '⏳ You already have a pending VLESS request. Please wait for admin approval.');
  }
  if (db.accounts.find(a => a.userId === userId && a.type === 'vless')) {
    return bot.sendMessage(msg.chat.id, '❌ You already have an active VLESS account. Wait for it to expire before requesting a new one.');
  }

  bot.sendMessage(msg.chat.id,
    `🌐 *VLESS Account Request*\n\nPlease reply with your desired username:\n\n_Example: \`john\`_`,
    { parse_mode: 'Markdown' }
  );

  bot.once('message', (reply) => {
    if (reply.chat.id !== msg.chat.id) return;
    const username = reply.text && reply.text.trim().split(/\s+/)[0];
    if (!username || !/^[a-zA-Z0-9_]{3,16}$/.test(username)) {
      return bot.sendMessage(msg.chat.id, '❌ Invalid username. Try /requestvless again.');
    }

    const sni = config.SERVER_HOST; // use default SNI from config
    const requestId = uuidv4().slice(0, 8);
    const db2 = loadDB();
    db2.pendingRequests.push({ requestId, userId, username, sni, type: 'vless', requestedAt: new Date().toISOString() });
    saveDB(db2);

    bot.sendMessage(msg.chat.id,
      `✅ *VLESS Request Submitted!*\n\n🆔 Request ID: \`${requestId}\`\n👤 Username: \`${username}\`\n⏳ Waiting for admin approval...`,
      { parse_mode: 'Markdown' }
    );

    bot.sendMessage(config.ADMIN_ID,
      `🔔 *New VLESS Request*\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 User: [${msg.from.first_name}](tg://user?id=${userId})\n` +
      `🆔 User ID: \`${userId}\`\n` +
      `🌐 Username: \`${username}\`\n` +
      `🔗 SNI: \`${sni}\`\n` +
      `🆔 Request ID: \`${requestId}\`\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `✅ Approve: /approve_${requestId}\n` +
      `❌ Reject: /reject_${requestId}`,
      { parse_mode: 'Markdown' }
    );
  });
});

// /myaccounts
bot.onText(/\/myaccounts/, (msg) => {
  const db = loadDB();
  const userAccounts = db.accounts.filter(a => a.userId === msg.from.id);

  if (userAccounts.length === 0) {
    return bot.sendMessage(msg.chat.id, '📭 You have no active accounts.');
  }

  let text = `📋 *Your Active Accounts*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  for (const acc of userAccounts) {
    text += `📡 *Type:* ${acc.type.toUpperCase()}\n`;
    text += `👤 *Username:* \`${acc.username}\`\n`;
    text += `📅 *Expires:* ${formatDate(acc.expiry)}\n\n`;
  }
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

// Admin: /approve_<id>
bot.onText(/\/approve_(.+)/, async (msg, match) => {
  if (msg.from.id.toString() !== config.ADMIN_ID.toString()) return;

  const requestId = match[1];
  const db = loadDB();
  const req = db.pendingRequests.find(r => r.requestId === requestId);

  if (!req) return bot.sendMessage(msg.chat.id, `❌ Request \`${requestId}\` not found.`, { parse_mode: 'Markdown' });

  bot.sendMessage(msg.chat.id, `⏳ Creating ${req.type.toUpperCase()} account for \`${req.username}\`...`, { parse_mode: 'Markdown' });

  try {
    if (req.type === 'ssh') {
      await createSSHAccount(req.username, req.password);

      const expiry = expiryISO();
      db.accounts.push({ requestId, userId: req.userId, username: req.username, type: 'ssh', expiry, createdAt: new Date().toISOString() });
      db.pendingRequests = db.pendingRequests.filter(r => r.requestId !== requestId);
      saveDB(db);

      const expireStr = formatDate(expiry);

      await bot.sendMessage(req.userId,
        `✅ *SSH ACCOUNT CREATED*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 Username   : \`${req.username}\`\n` +
        `🔐 Password   : \`${req.password}\`\n` +
        `⏳ Duration   : ${EXPIRY_DAYS} Day/s\n` +
        `📅 Expires    : ${expireStr}\n` +
        `🕐 Timezone   : Asia/Manila\n` +
        `🌐 Host       : \`${config.SERVER_HOST}\`\n` +
        `🔑 Nameserver : \`${config.SERVER_NS}\`\n` +
        `🔐 Public Key : \`${config.SERVER_PUBKEY}\`\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🖥️ Connect: \`ssh ${req.username}@${config.SERVER_HOST}\``,
        { parse_mode: 'Markdown' }
      );
      bot.sendMessage(msg.chat.id, `✅ SSH account created and user notified!`);

    } else if (req.type === 'vless') {
      const result = await createVLESSAccount(req.username, req.sni);

      const expiry = expiryISO();
      db.accounts.push({ requestId, userId: req.userId, username: req.username, type: 'vless', expiry, createdAt: new Date().toISOString() });
      db.pendingRequests = db.pendingRequests.filter(r => r.requestId !== requestId);
      saveDB(db);

      const expireStr = formatDate(expiry);

      await bot.sendMessage(req.userId,
        `✅ *VLESS ACCOUNT CREATED*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📧 Email      : \`${req.username}\`\n` +
        `⏳ Expiration : ${EXPIRY_DAYS} days\n` +
        `📅 Expire Date: ${expireStr}\n` +
        `🌐 Domain     : \`${config.SERVER_HOST}\`\n` +
        `🔗 SNI        : \`${req.sni}\`\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🔒 *TLS (443):*\n\`${result.tls || 'N/A'}\`\n\n` +
        `🔓 *Non-TLS (80):*\n\`${result.nonTls || 'N/A'}\``,
        { parse_mode: 'Markdown' }
      );
      bot.sendMessage(msg.chat.id, `✅ VLESS account created and user notified!`);
    }

  } catch (e) {
    console.error(e);
    bot.sendMessage(msg.chat.id, `❌ Error creating account:\n\`${e}\``, { parse_mode: 'Markdown' });
  }
});

// Admin: /reject_<id>
bot.onText(/\/reject_(.+)/, (msg, match) => {
  if (msg.from.id.toString() !== config.ADMIN_ID.toString()) return;

  const requestId = match[1];
  const db = loadDB();
  const req = db.pendingRequests.find(r => r.requestId === requestId);

  if (!req) return bot.sendMessage(msg.chat.id, `❌ Request \`${requestId}\` not found.`, { parse_mode: 'Markdown' });

  db.pendingRequests = db.pendingRequests.filter(r => r.requestId !== requestId);
  saveDB(db);

  bot.sendMessage(req.userId, `❌ Your *${req.type.toUpperCase()}* account request has been *rejected* by the admin.`, { parse_mode: 'Markdown' });
  bot.sendMessage(msg.chat.id, `✅ Request rejected and user notified.`);
});

// Admin: /pending
bot.onText(/\/pending/, (msg) => {
  if (msg.from.id.toString() !== config.ADMIN_ID.toString()) return;
  const db = loadDB();

  if (db.pendingRequests.length === 0) return bot.sendMessage(msg.chat.id, '📭 No pending requests.');

  let text = `⏳ *Pending Requests*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  for (const req of db.pendingRequests) {
    text += `🆔 \`${req.requestId}\` — ${req.type.toUpperCase()} — User \`${req.userId}\`\n`;
    text += `✅ /approve_${req.requestId}  ❌ /reject_${req.requestId}\n\n`;
  }
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

// Admin: /listaccounts
bot.onText(/\/listaccounts/, (msg) => {
  if (msg.from.id.toString() !== config.ADMIN_ID.toString()) return;
  const db = loadDB();

  if (db.accounts.length === 0) return bot.sendMessage(msg.chat.id, '📭 No active accounts.');

  let text = `📋 *All Active Accounts*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  for (const acc of db.accounts) {
    text += `👤 \`${acc.username}\` — ${acc.type.toUpperCase()} — User \`${acc.userId}\`\n`;
    text += `📅 Expires: ${formatDate(acc.expiry)}\n\n`;
  }
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

console.log('🤖 Bot is running on ' + (config.SERVER_HOST || 'VPS') + '...');
