"use strict";

const https = require("https");
const fs = require("fs");
const path = require("path");
const config = require("./config");

// ============================================================
// DATABASE HELPERS
// ============================================================
const DB_USER = path.join(__dirname, "user.json");
const DB_TRANSAKSI = path.join(__dirname, "transaksi.json");
const SCRIPTS_DIR = path.join(__dirname, "scripts");

if (!fs.existsSync(SCRIPTS_DIR)) fs.mkdirSync(SCRIPTS_DIR);

function readDB(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return file === DB_USER ? { users: {} } : { transaksi: [], total: 0 };
  }
}

function writeDB(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function getUsers() { return readDB(DB_USER); }
function saveUsers(d) { writeDB(DB_USER, d); }
function getTranDB() { return readDB(DB_TRANSAKSI); }
function saveTranDB(d) { writeDB(DB_TRANSAKSI, d); }

// [FIX] Refresh data user lama + update last_seen
function registerUser(user) {
  const db = getUsers();
  const isNew = !db.users[user.id];
  const existing = db.users[user.id] || {};
  db.users[user.id] = {
    id: user.id,
    first_name: user.first_name || existing.first_name || "",
    username: user.username || existing.username || "",
    registered_at: existing.registered_at || new Date().toISOString(),
    last_seen: new Date().toISOString(),
  };
  saveUsers(db);
  return isNew;
}

function getAllUserIds() {
  const db = getUsers();
  return Object.keys(db.users).map(Number);
}

function totalUsers() {
  return Object.keys(getUsers().users).length;
}

function totalTranCount() {
  return getTranDB().total || 0;
}

function generateOrderId() {
  return "ORD" + Date.now();
}

function saveTransaksi(data) {
  const db = getTranDB();
  db.transaksi.push(data);
  db.total = (db.total || 0) + 1;
  saveTranDB(db);
}

function getTransaksiByOrderId(orderId) {
  const db = getTranDB();
  return db.transaksi.find((t) => t.orderId === orderId) || null;
}

// [FIX] Cari order pending milik user (untuk order-lock)
function getPendingOrderForUser(userId) {
  const db = getTranDB();
  return (
    db.transaksi.find(
      (t) =>
        t.userId === userId &&
        (t.status === "pending_payment" || t.status === "waiting_confirmation")
    ) || null
  );
}

function updateTransaksi(orderId, fields) {
  const db = getTranDB();
  const idx = db.transaksi.findIndex((t) => t.orderId === orderId);
  if (idx !== -1) {
    db.transaksi[idx] = { ...db.transaksi[idx], ...fields };
    saveTranDB(db);
    return db.transaksi[idx];
  }
  return null;
}

function getScripts() {
  const f = path.join(SCRIPTS_DIR, "list.json");
  try { return JSON.parse(fs.readFileSync(f, "utf8")); }
  catch { return []; }
}

function saveScripts(arr) {
  fs.writeFileSync(path.join(SCRIPTS_DIR, "list.json"), JSON.stringify(arr, null, 2));
}

// ============================================================
// TELEGRAM API WRAPPER
// ============================================================
function apiRequest(method, params, fileBuffer, fileField, fileName) {
  return new Promise((resolve, reject) => {
    let postData;
    let contentType;

    if (fileBuffer) {
      const boundary = "----FormBoundary" + Math.random().toString(36).slice(2);
      contentType = "multipart/form-data; boundary=" + boundary;
      const parts = [];

      for (const [key, val] of Object.entries(params)) {
        parts.push(
          `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}`
        );
      }
      parts.push(
        `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n`
      );

      const prefix = Buffer.from(parts.join("\r\n") + "\r\n");
      const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
      postData = Buffer.concat([prefix, fileBuffer, suffix]);
    } else {
      postData = Buffer.from(JSON.stringify(params));
      contentType = "application/json";
    }

    const options = {
      hostname: "api.telegram.org",
      path: `/bot${config.BOT_TOKEN}/${method}`,
      method: "POST",
      headers: {
        "Content-Type": contentType,
        "Content-Length": postData.length,
      },
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error("Parse error: " + body)); }
      });
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

const tg = {
  sendMessage: (p) => apiRequest("sendMessage", p),
  editMessageText: (p) => apiRequest("editMessageText", p),
  editMessageCaption: (p) => apiRequest("editMessageCaption", p),
  editMessageReplyMarkup: (p) => apiRequest("editMessageReplyMarkup", p),
  sendPhoto: (p) => apiRequest("sendPhoto", p),
  sendDocument: (p) => apiRequest("sendDocument", p),
  answerCallbackQuery: (p) => apiRequest("answerCallbackQuery", p),
  getFile: (p) => apiRequest("getFile", p),
  forwardMessage: (p) => apiRequest("forwardMessage", p),
  getUpdates: (p) => apiRequest("getUpdates", p),
};

function downloadFile(fileId) {
  return new Promise(async (resolve, reject) => {
    try {
      const res = await tg.getFile({ file_id: fileId });
      if (!res.ok) return reject(new Error("getFile failed"));
      const filePath = res.result.file_path;
      const url = `https://api.telegram.org/file/bot${config.BOT_TOKEN}/${filePath}`;
      https.get(url, (r) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => resolve({ buffer: Buffer.concat(chunks), filePath }));
        r.on("error", reject);
      });
    } catch (e) { reject(e); }
  });
}

// ============================================================
// INLINE KEYBOARDS
// ============================================================
function kb(buttons) {
  return { inline_keyboard: buttons };
}

const KEY_MAIN_USER = kb([
  [{ text: "🛒 𝙿𝚁𝙾𝙳𝚄𝙺", callback_data: "menu_produk", style: "primary" }],
  [{ text: "📢 𝙲𝙷𝙰𝙽𝙽𝙴𝙻 𝙾𝚆𝙽𝙴𝚁", url: config.OWNER_CHANNEL, style: "primary" }],
]);

const KEY_MAIN_OWNER = kb([
  [{ text: "🛒 𝙿𝚁𝙾𝙳𝚄𝙺", callback_data: "menu_produk", style: "primary" }],
  [{ text: "📢 𝙲𝙷𝙰𝙽𝙽𝙴𝙻 𝙾𝚆𝙽𝙴𝚁", url: config.OWNER_CHANNEL, style: "primary" }],
  [{ text: "⚙️ 𝙼𝙴𝙽𝚄 𝙾𝚆𝙽𝙴𝚁", callback_data: "owner_panel", style: "primary" }],
]);

const KEY_PRODUK = kb([
  [{ text: "🖥️ 𝙱𝚄𝚈 𝙿𝙰𝙽𝙴𝙻", callback_data: "menu_panel", style: "danger" }],
  [{ text: "📦 𝙱𝚄𝚈 𝚂𝙲𝚁𝙸𝙿𝚃", callback_data: "menu_script", style: "danger" }],
  [{ text: "🔙 𝙺𝙴𝙼𝙱𝙰𝙻𝙸", callback_data: "menu_utama", style: "danger" }],
]);

const KEY_PANEL_ROLES = kb([
  [{ text: "🚀 𝚁𝙴𝚂𝙴𝙻𝙻𝙴𝚁 — Rp 1.000", callback_data: "buy_RESELLER", style: "danger" }],
  [{ text: "🛰️ 𝙿𝚁𝙴𝙼𝙸𝚄𝙼 — Rp 3.000", callback_data: "buy_PREMIUM", style: "danger" }],
  [{ text: "🌙 𝙾𝚆𝙽𝙴𝚁 — Rp 6.000", callback_data: "buy_OWNER", style: "danger" }],
  [{ text: "🪐 𝙿𝙰𝚃𝙽𝙴𝚁 — Rp 4.000", callback_data: "buy_PARTNER", style: "danger" }],
  [{ text: "☄️ 𝚃𝙰𝙽𝙶𝙰𝙽 𝙺𝙰𝙽𝙰𝙽 — Rp 9.000", callback_data: "buy_TANGAN_KANAN", style: "danger" }],
  [{ text: "⭐ 𝙲𝙴𝙾 — Rp 12.000", callback_data: "buy_CEO", style: "danger" }],
  [{ text: "🚀 𝙳𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁 — Rp 15.000", callback_data: "buy_DEVELOPER", style: "danger" }],
  [{ text: "🔙 𝙺𝙴𝙼𝙱𝙰𝙻𝙸", callback_data: "menu_produk", style: "primary" }],
]);

const KEY_OWNER_PANEL = kb([
  [{ text: "➕ 𝙰𝙳𝙳 𝚂𝙲𝚁𝙸𝙿𝚃", callback_data: "owner_add_script", style: "danger" }],
  [{ text: "📢 𝙱𝚁𝙾𝙰𝙳𝙲𝙰𝚂𝚃", callback_data: "owner_broadcast", style: "danger" }],
  [{ text: "🔙 𝙺𝙴𝙼𝙱𝙰𝙻𝙸", callback_data: "menu_utama", style: "primary" }],
]);

function keyScriptList() {
  const scripts = getScripts();
  if (scripts.length === 0) return null;

  const buttons = scripts.map((s, i) => ([{
    text: `📦 ${s.name} — ${formatRp(s.price)}`,
    callback_data: `buy_script_${i}`, style: "danger"
  }]));

  buttons.push([{ text: "🔙 𝙺𝙴𝙼𝙱𝙰𝙻𝙸", callback_data: "menu_produk", style: "primary" }]);
  return kb(buttons);
}

function keyQris(orderId) {
  return kb([[{ text: "❌ 𝙲𝙰𝙽𝙲𝙴𝙻", callback_data: "cancel_order_" + orderId, style: "danger" }]]);
}

// [FIX] Tombol batal untuk state menunggu screenshot
function keyAwaitScreenshot(orderId) {
  return kb([[{ text: "🚫 𝙱𝙰𝚃𝙰𝙻", callback_data: "cancel_order_" + orderId, style: "danger" }]]);
}

function keyConfirmOrder(orderId) {
  return kb([
    [{ text: "✅ 𝙺𝙾𝙽𝙵𝙸𝚁𝙼𝙰𝚂𝙸", callback_data: "confirm_order_" + orderId, style: "success" }],
    [{ text: "❌ 𝚃𝙾𝙻𝙰𝙺", callback_data: "reject_order_" + orderId, style: "danger" }],
  ]);
}

// ============================================================
// FORMATTERS
// ============================================================
function formatRp(n) {
  return "Rp " + Number(n).toLocaleString("id-ID");
}

function nowWIB() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
  const hari = ["Minggu","Senin","Selasa","Rabu","Kamis","Jumat","Sabtu"][now.getDay()];
  const bln = ["Januari","Februari","Maret","April","Mei","Juni","Juli","Agustus","September","Oktober","November","Desember"][now.getMonth()];
  const pad = (n) => String(n).padStart(2, "0");
  return `${hari}, ${now.getDate()} ${bln} ${now.getFullYear()} pukul ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function welcomeText(user) {
  const uname = user.username ? "@" + user.username : user.first_name;
  return (
    `<blockquote>` +
    `🌸 ───《 ❝ 𝗪𝗘𝗟𝗖𝗢𝗠𝗘 ❞ 》─── 🌸\n\n` +
    `🚀 <b>𝗜𝗡𝗙𝗢𝗥𝗠𝗔𝗦𝗜 𝗕𝗢𝗧</b>\n` +
    ` 👤 OwnerBot : <b>${config.OWNER_USERNAME}</b>\n` +
    ` 🤖 𝖡𝗈𝗍 𝖭𝖺𝗆𝖾 : <b>𝗥𝗔𝗡𝗡 𝗔𝗨𝗧𝗢 𝗢𝗥𝗗𝗘𝗥</b>\n` +
    ` 🔖 𝖵𝖾𝗋𝗌𝗂𝗈𝗇 : <b>${config.BOT_VERSION}</b>\n\n` +
    `📊 <b>𝗦𝗧𝗔𝗧𝗜𝗦𝗧𝗜𝗞 𝗕𝗢𝗧</b>\n` +
    ` 👥 𝖳𝗈𝗍𝖺𝗅 𝖴𝗌𝖾𝗋 : <b>${totalUsers()}</b>\n` +
    ` 💳 Total Transaksi : <b>${totalTranCount()}</b>\n\n` +
    `[ 𐚁 ] <b>𝗢𝗹𝗮𝗮, 𝗪𝗲𝗹𝗰𝗼𝗺𝗲 𝗧𝗼 𝗕𝗼𝘁 𝗥𝗮𝗻𝗻 𝗔𝘂𝘁𝗼 𝗢𝗿𝗱𝗲𝗿</b>\n` +
    `Halo ${uname}! Silahkan pilih menu di bawah ini.` +
    `</blockquote>`
  );
}

function produkText() {
  return (
    `<blockquote expandable>` +
    `🛒 <b>𝚂𝚃𝙾𝚁𝙴 𝙼𝙴𝙽𝚄</b>\n\n` +
    `📌 𝗣𝗿𝗼𝗱𝘂𝗸 𝗬𝗮𝗻𝗴 𝗧𝗲𝗿𝘀𝗲𝗱𝗶𝗮:\n\n` +
    `🖥️ 𝙱𝚄𝚈 𝙿𝙰𝙽𝙴𝙻 𝙿𝚃𝙴𝚁𝙾𝙳𝙰𝙲𝚃𝚈𝙻\n` +
    `📦 𝙱𝚄𝚈 𝚂𝙲𝚁𝙸𝙿𝚃\n\n` +
    `Pilih menu melalui tombol yang tersedia di bawah pesan ini.` +
    `</blockquote>`
  );
}

function panelText() {
  return (
    `<blockquote>` +
    `🚀 <b>𝙱𝚄𝚈 𝙿𝙰𝙽𝙴𝙻 𝙿𝚃𝙴𝚁𝙾𝙳𝙰𝙲𝚃𝚈𝙻</b>\n\n` +
    `Pilih role yang ingin kamu beli:\n\n` +
    `🛰️ <b>𝚁𝙴𝚂𝙴𝙻𝙻𝙴𝚁</b> — ${formatRp(config.QRIS_NOMINAL.RESELLER)}\n` +
    `🌙 <b>𝙿𝚁𝙴𝙼𝙸𝚄𝙼</b> — ${formatRp(config.QRIS_NOMINAL.PREMIUM)}\n` +
    `🪐 <b>𝙾𝚆𝙽𝙴𝚁</b> — ${formatRp(config.QRIS_NOMINAL.OWNER)}\n` +
    `☄️ <b>𝙿𝙰𝚃𝙽𝙴𝚁</b> — ${formatRp(config.QRIS_NOMINAL.PARTNER)}\n` +
    `⭐ <b>𝚃𝙰𝙽𝙶𝙰𝙽 𝙺𝙰𝙽𝙰𝙽</b> — ${formatRp(config.QRIS_NOMINAL.TANGAN_KANAN)}\n` +
    `🚀 <b>𝙲𝙴𝙾</b> — ${formatRp(config.QRIS_NOMINAL.CEO)}\n` +
    `👨‍🚀 <b>𝙳𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁</b> — ${formatRp(config.QRIS_NOMINAL.DEVELOPER)}\n\n` +
    `Tekan tombol di bawah untuk memilih role.` +
    `</blockquote>`
  );
}

function scriptMenuText() {
  const scripts = getScripts();
  if (scripts.length === 0) {
    return `<blockquote>📦 <b>𝙱𝚄𝚈 𝚂𝙲𝚁𝙸𝙿𝚃</b>\n\nBelum ada script tersedia saat ini.\nSilahkan cek lagi nanti! 😊</blockquote>`;
  }

  let text =
    `<blockquote>` +
    `📦 <b>𝙱𝚄𝚈 𝚂𝙲𝚁𝙸𝙿𝚃</b>\n\n` +
    `Pilih script yang ingin kamu beli:\n\n`;

  scripts.forEach((s, i) => {
    text += `${i + 1}. <b>${s.name}</b>\n`;
    text += `   💰 ${formatRp(s.price)}\n`;
    text += `   📝 ${s.description}\n\n`;
  });

  text += `Pilih Script Yang Ingin Dibeli.`;
  text += `</blockquote>`;
  return text;
}

function ownerPanelText() {
  return (
    `<blockquote>` +
    `⚙️ <b>OWNER PANEL</b>\n\n` +
    `Selamat datang, Owner! Kelola bot di sini.\n\n` +
    `➕ <b>ADD SCRIPT</b> — Tambah script baru ke katalog\n` +
    `📢 <b>BROADCAST</b> — Kirim pesan ke semua user` +
    `</blockquote>`
  );
}

function addScriptText() {
  return (
    `<blockquote>` +
    `📥 <b>CARA TAMBAH SCRIPT</b>\n\n` +
    `1. Silahkan kirim file <b>.zip</b> sekarang.\n` +
    `2. Setelah file terkirim, bot akan meminta detail produk.\n\n` +
    `⚠️ Tekan <b>BATAL</b> untuk membatalkan.` +
    `</blockquote>`
  );
}

function qrisText(role, nominal, orderId) {
  return (
    `<blockquote>` +
    `💳 <b>PEMBAYARAN QRIS</b>\n\n` +
    `📦 Barang: <b>${role}</b>\n` +
    `💰 Nominal: <b>${formatRp(nominal)}</b>\n` +
    `🆔 Order ID: <code>${orderId}</code>\n\n` +
    `📸 Silakan scan QRIS di atas lalu lakukan pembayaran.\n` +
    `📤 Setelah transfer, kirim screenshot bukti pembayaran.\n` +
    `⏳ Admin akan memverifikasi pembayaran Anda.` +
    `</blockquote>`
  );
}

// ============================================================
// STATE MANAGEMENT (in-memory + TTL)
// ============================================================
const userState = {};
const STATE_TTL_MS = 30 * 60 * 1000; // [FIX] 30 menit

function setState(uid, state) {
  userState[uid] = { ...state, expiresAt: Date.now() + STATE_TTL_MS };
}

function getState(uid) {
  const s = userState[uid];
  if (!s) return null;
  if (s.expiresAt && Date.now() > s.expiresAt) {
    delete userState[uid];
    return null;
  }
  return s;
}

function clearState(uid) {
  delete userState[uid];
}

// [FIX] Auto-cleanup state kedaluwarsa
setInterval(() => {
  const now = Date.now();
  for (const uid of Object.keys(userState)) {
    if (userState[uid].expiresAt && now > userState[uid].expiresAt) {
      delete userState[uid];
    }
  }
}, 60 * 1000);

// ============================================================
// LOG TO CHANNEL
// ============================================================
async function logNewUser(user) {
  const uname = user.username ? "@" + user.username : "—";
  const text =
    `<blockquote>` +
    `🔔 <b>𝗡𝗘𝗪 𝗣𝗘𝗡𝗚𝗚𝗨𝗡𝗔</b>\n\n` +
    `╭─ 👤 <b>𝗜𝗡𝗙𝗢 𝗣𝗘𝗟𝗔𝗡𝗚𝗚𝗔𝗡</b>\n` +
    `├ 🧑 𝗡𝗮𝗺𝗮: <b>${user.first_name || ""}</b>\n` +
    `├ 🆔 𝗜𝗗: <code>${user.id}</code>\n` +
    `├ 📛 𝗨𝘀𝗲𝗿𝗻𝗮𝗺𝗲: ${uname}\n` +
    `├ ⏰ 𝗪𝗮𝗸𝘁𝘂: ${nowWIB()}\n` +
    `╰─` +
    `</blockquote>`;

  try {
    await tg.sendMessage({
      chat_id: config.LOG_CHANNEL_ID,
      text,
      parse_mode: "HTML",
      reply_markup: JSON.stringify(
        kb([[{ text: "🖥️ 𝗕𝗨𝗬 𝗣𝗔𝗡𝗘𝗟 𝗣𝗧𝗘𝗥𝗢𝗗𝗔𝗖𝗧𝗬𝗟", url: `https://t.me/${config.BOT_USERNAME}`, style: "primary" }]])
      ),
    });
  } catch (e) {
    console.error("logNewUser error:", e.message);
  }
}

async function logTransaksiSuccess(tran, screenshotFileId) {
  const text =
    `<blockquote>` +
    `🎉 <b>𝗧𝗿𝗮𝗻𝘀𝗮𝗸𝘀𝗶 𝗕𝗲𝗿𝗵𝗮𝘀𝗶𝗹</b>\n\n` +
    `👤 <b>𝗗𝗮𝘁𝗮 𝗣𝗲𝗺𝗯𝗲𝗹𝗶</b>\n` +
    `├ Username : ${tran.username ? "@" + tran.username : "-"}\n` +
    `└ User ID : <code>${tran.userId}</code>\n\n` +
    `📦 <b>𝗣𝗿𝗼𝗱𝘂𝗸</b>\n` +
    `└ ${tran.role}\n\n` +
    `💳 <b>𝗗𝗲𝘁𝗮𝗶𝗹 𝗣𝗲𝗺𝗯𝗮𝘆𝗮𝗿𝗮𝗻</b>\n` +
    `├ Nominal : <b>${formatRp(tran.nominal)}</b>\n` +
    `├ Metode : QRIS\n` +
    `├ Order ID : <code>${tran.orderId}</code>\n` +
    `└ Status : <b>SUCCESS</b>\n\n` +
    `🚀 Produk berhasil diproses dan telah diterima pembeli.\n\n` +
    `🛒 <b>Mau order juga?</b>\n` +
    `Kunjungi bot kami dan lakukan pemesanan dengan mudah, cepat, dan aman.` +
    `</blockquote>`;

  const keyboard = kb([[{ text: "🛒 𝗕𝗨𝗬 𝗟𝗔𝗚𝗜", url: `https://t.me/${config.BOT_USERNAME}`, style: "primary" }]]);

  try {
    if (screenshotFileId) {
      await tg.sendPhoto({
        chat_id: config.LOG_CHANNEL_ID,
        photo: screenshotFileId,
        caption: text,
        parse_mode: "HTML",
        reply_markup: JSON.stringify(keyboard),
      });
    } else {
      await tg.sendMessage({
        chat_id: config.LOG_CHANNEL_ID,
        text,
        parse_mode: "HTML",
        reply_markup: JSON.stringify(keyboard),
      });
    }
  } catch (e) {
    console.error("logTransaksiSuccess error:", e.message);
  }
}

// ============================================================
// HANDLE /start
// ============================================================
async function handleStart(msg) {
  const user = msg.from;
  const chatId = msg.chat.id;
  const isNew = registerUser(user);
  if (isNew) await logNewUser(user);

  const isOwner = user.id === config.OWNER_ID;
  const markup = JSON.stringify(isOwner ? KEY_MAIN_OWNER : KEY_MAIN_USER);

  try {
    await tg.sendPhoto({
      chat_id: chatId,
      photo: config.WELCOME_IMAGE_URL,
      caption: welcomeText(user),
      parse_mode: "HTML",
      reply_markup: markup,
    });
  } catch {
    await tg.sendMessage({
      chat_id: chatId,
      text: welcomeText(user),
      parse_mode: "HTML",
      reply_markup: markup,
    });
  }
}

// ============================================================
// HANDLE CALLBACKS
// ============================================================
async function handleCallback(cb) {
  const chatId = cb.message.chat.id;
  const msgId = cb.message.message_id;
  const userId = cb.from.id;
  const data = cb.data;
  const isOwner = userId === config.OWNER_ID;

  // [FIX] answerCallbackQuery aman (sekali + bisa alert)
  let _answered = false;
  async function answerOnce(text, showAlert) {
    if (_answered) return;
    _answered = true;
    try {
      await tg.answerCallbackQuery({
        callback_query_id: cb.id,
        ...(text ? { text } : {}),
        ...(showAlert ? { show_alert: true } : {}),
      });
    } catch {}
  }
  await answerOnce();

  // [FIX] editMsg fallback ke pesan baru jika dua-duanya gagal
  async function editMsg(text, markup) {
    try {
      const r = await tg.editMessageCaption({ chat_id: chatId, message_id: msgId, caption: text, parse_mode: "HTML", reply_markup: markup });
      if (r.ok) return;
      throw new Error("caption edit failed");
    } catch {
      try {
        const r = await tg.editMessageText({ chat_id: chatId, message_id: msgId, text, parse_mode: "HTML", reply_markup: markup });
        if (r.ok) return;
        throw new Error("text edit failed");
      } catch {
        await tg.sendMessage({ chat_id: chatId, text, parse_mode: "HTML", reply_markup: markup });
      }
    }
  }

  // ─── MENU UTAMA ───
  if (data === "menu_utama") {
    const markup = JSON.stringify(isOwner ? KEY_MAIN_OWNER : KEY_MAIN_USER);
    await editMsg(welcomeText(cb.from), markup);
    return;
  }

  // ─── MENU PRODUK ───
  if (data === "menu_produk") {
    await editMsg(produkText(), JSON.stringify(KEY_PRODUK));
    return;
  }

  // ─── MENU PANEL ───
  if (data === "menu_panel") {
    await editMsg(panelText(), JSON.stringify(KEY_PANEL_ROLES));
    return;
  }

  // ─── MENU SCRIPT ───
  if (data === "menu_script") {
    const scripts = getScripts();
    const text = scriptMenuText();
    const markup = scripts.length > 0
      ? JSON.stringify(keyScriptList())
      : JSON.stringify(kb([[{ text: "🔙 𝙺𝙴𝙼𝙱𝙰𝙻𝙸", callback_data: "menu_produk", style: "primary" }]]));
    await editMsg(text, markup);
    return;
  }

  // ─── BUY PANEL ROLE ───
  if (data.startsWith("buy_") && !data.startsWith("buy_script_")) {
    // [FIX] Order-lock: cegah order ganda
    const pending = getPendingOrderForUser(userId);
    if (pending) {
      await answerOnce(
        `⚠️ Kamu masih punya order pending (${pending.orderId}).\nSelesaikan atau batalkan dulu.`,
        true
      );
      return;
    }

    const role = data.replace("buy_", "");
    const nominal = config.QRIS_NOMINAL[role];
    if (!nominal) return;

    const orderId = generateOrderId();
    saveTransaksi({
      orderId,
      userId,
      username: cb.from.username || "",
      firstName: cb.from.first_name || "",
      role,
      nominal,
      type: "panel",
      status: "pending_payment",
      screenshotFileId: null,
      createdAt: new Date().toISOString(),
    });

    setState(userId, { action: "awaiting_screenshot", orderId, role, nominal, chatId, qrisMsgId: null });

    const text = qrisText(role, nominal, orderId);
    const markup = JSON.stringify(keyQris(orderId));

    try {
      const sent = await tg.sendPhoto({ chat_id: chatId, photo: config.QRIS_IMAGE_URL, caption: text, parse_mode: "HTML", reply_markup: markup });
      if (sent.ok) userState[userId].qrisMsgId = sent.result.message_id;
    } catch {
      const sent = await tg.sendMessage({ chat_id: chatId, text, parse_mode: "HTML", reply_markup: markup });
      if (sent.ok) userState[userId].qrisMsgId = sent.result.message_id;
    }
    return;
  }

  // ─── BUY SCRIPT ───
  if (data.startsWith("buy_script_")) {
    // [FIX] Order-lock
    const pending = getPendingOrderForUser(userId);
    if (pending) {
      await answerOnce(
        `⚠️ Kamu masih punya order pending (${pending.orderId}).\nSelesaikan atau batalkan dulu.`,
        true
      );
      return;
    }

    const idx = parseInt(data.replace("buy_script_", ""), 10);
    const scripts = getScripts();
    const script = scripts[idx];
    if (!script) {
      await answerOnce("⚠️ Script tidak tersedia.", true);
      return;
    }

    const orderId = generateOrderId();
    saveTransaksi({
      orderId,
      userId,
      username: cb.from.username || "",
      firstName: cb.from.first_name || "",
      role: `SCRIPT: ${script.name}`,
      nominal: script.price,
      type: "script",
      scriptIdx: idx,
      scriptFileId: script.fileId,
      scriptFileName: script.fileName,
      status: "pending_payment",
      screenshotFileId: null,
      createdAt: new Date().toISOString(),
    });

    setState(userId, {
      action: "awaiting_screenshot",
      orderId,
      role: `SCRIPT: ${script.name}`,
      nominal: script.price,
      chatId,
      qrisMsgId: null,
    });

    const text = qrisText(`SCRIPT: ${script.name}`, script.price, orderId);
    const markup = JSON.stringify(keyQris(orderId));

    try {
      const sent = await tg.sendPhoto({ chat_id: chatId, photo: config.QRIS_IMAGE_URL, caption: text, parse_mode: "HTML", reply_markup: markup });
      if (sent.ok) userState[userId].qrisMsgId = sent.result.message_id;
    } catch {
      const sent = await tg.sendMessage({ chat_id: chatId, text, parse_mode: "HTML", reply_markup: markup });
      if (sent.ok) userState[userId].qrisMsgId = sent.result.message_id;
    }
    return;
  }

  // ─── CANCEL ORDER ───
  if (data.startsWith("cancel_order_")) {
    const orderId = data.replace("cancel_order_", "");
    updateTransaksi(orderId, { status: "cancelled" });
    clearState(userId);
    const text = `<blockquote>❌ <b>Pesanan Dibatalkan</b>\n\nOrder ID: <code>${orderId}</code>\n\nPesanan kamu telah dibatalkan.</blockquote>`;
    await editMsg(text, JSON.stringify(kb([[{ text: "🔙 KEMBALI KE MENU", callback_data: "menu_utama", style: "primary" }]])));
    return;
  }

  // ─── OWNER: CONFIRM ORDER ───
  if (data.startsWith("confirm_order_") && isOwner) {
    const orderId = data.replace("confirm_order_", "");
    const tran = getTransaksiByOrderId(orderId);
    if (!tran) {
      await tg.sendMessage({ chat_id: chatId, text: "<blockquote>⚠️ Transaksi tidak ditemukan.</blockquote>", parse_mode: "HTML" });
      return;
    }

    updateTransaksi(orderId, { status: "confirmed" });

    let userText;
    if (tran.type === "script") {
      userText =
        `<blockquote>` +
        `✅ <b>PESANAN DIKONFIRMASI!</b>\n\n` +
        `🎉 Selamat! Pembelian kamu telah dikonfirmasi oleh owner.\n\n` +
        `🛒 Item: <b>${tran.role}</b>\n` +
        `💰 Nominal: <b>${formatRp(tran.nominal)}</b>\n` +
        `🔖 Order ID: <code>${orderId}</code>\n\n` +
        `📦 File script akan segera dikirimkan ke kamu.\n` +
        `Terima kasih telah berbelanja! 🙏` +
        `</blockquote>`;
    } else {
      const groupLink = config.GROUP_LINKS[tran.role] || "—";
      userText =
        `<blockquote>` +
        `✅ <b>PESANAN DIKONFIRMASI!</b>\n\n` +
        `🎉 Selamat! Pembelian kamu telah dikonfirmasi oleh owner.\n\n` +
        `🛒 Item: <b>${tran.role}</b>\n` +
        `💰 Nominal: <b>${formatRp(tran.nominal)}</b>\n` +
        `🔖 Order ID: <code>${orderId}</code>\n\n` +
        `🔗 <b>Link Group kamu:</b>\n${groupLink}\n\n` +
        `Terima kasih telah berbelanja! 🙏` +
        `</blockquote>`;
    }

    try {
      await tg.sendMessage({ chat_id: tran.userId, text: userText, parse_mode: "HTML" });

      if (tran.type === "script" && tran.scriptFileId) {
        await tg.sendDocument({
          chat_id: tran.userId,
          document: tran.scriptFileId,
          caption:
            `<blockquote>` +
            `📦 <b>File Script: ${tran.scriptFileName || "script.zip"}</b>\n\n` +
            `Terima kasih telah membeli! Simpan file ini baik-baik. 🙏` +
            `</blockquote>`,
          parse_mode: "HTML",
        });
      }
    } catch (e) { console.error("Send to user error:", e.message); }

    await logTransaksiSuccess(tran, tran.screenshotFileId);

    await editMsg(
      `<blockquote>✅ <b>Pesanan <code>${orderId}</code> sudah dikonfirmasi dan produk telah dikirim ke user.</b></blockquote>`,
      JSON.stringify(kb([]))
    );
    return;
  }

  // ─── OWNER: REJECT ORDER ───
  if (data.startsWith("reject_order_") && isOwner) {
    const orderId = data.replace("reject_order_", "");
    const tran = getTransaksiByOrderId(orderId);
    if (!tran) return;

    updateTransaksi(orderId, { status: "rejected" });

    const userText =
      `<blockquote>` +
      `❌ <b>PESANAN DITOLAK</b>\n\n` +
      `Maaf, pesanan kamu dengan Order ID <code>${orderId}</code> ditolak oleh owner.\n\n` +
      `Silahkan hubungi owner untuk informasi lebih lanjut.` +
      `</blockquote>`;

    try {
      await tg.sendMessage({ chat_id: tran.userId, text: userText, parse_mode: "HTML" });
    } catch (e) { console.error("reject send error:", e.message); }

    await editMsg(
      `<blockquote>❌ <b>Pesanan <code>${orderId}</code> telah ditolak.</b></blockquote>`,
      JSON.stringify(kb([]))
    );
    return;
  }

  // ─── OWNER PANEL ───
  if (data === "owner_panel" && isOwner) {
    await editMsg(ownerPanelText(), JSON.stringify(KEY_OWNER_PANEL));
    return;
  }

  // ─── OWNER ADD SCRIPT ───
  if (data === "owner_add_script" && isOwner) {
    setState(userId, { action: "awaiting_script_file" });
    await editMsg(addScriptText(), JSON.stringify(kb([[{ text: "🚫 BATAL", callback_data: "cancel_add_script", style: "danger" }]])));
    return;
  }

  // ─── CANCEL ADD SCRIPT ───
  if (data === "cancel_add_script" && isOwner) {
    clearState(userId);
    await editMsg(ownerPanelText(), JSON.stringify(KEY_OWNER_PANEL));
    return;
  }

  // ─── OWNER BROADCAST ───
  if (data === "owner_broadcast" && isOwner) {
    setState(userId, { action: "awaiting_broadcast" });
    await tg.sendMessage({
      chat_id: chatId,
      text: `<blockquote>📢 <b>BROADCAST</b>\n\nKetik pesan yang ingin kamu broadcast ke semua user.\n\nKirim pesan sekarang:</blockquote>`,
      parse_mode: "HTML",
      reply_markup: JSON.stringify(kb([[{ text: "🚫 BATAL", callback_data: "cancel_broadcast", style: "danger" }]])),
    });
    return;
  }

  // ─── CANCEL BROADCAST ───
  if (data === "cancel_broadcast" && isOwner) {
    clearState(userId);
    await tg.sendMessage({
      chat_id: chatId,
      text: `<blockquote>🚫 Broadcast dibatalkan.</blockquote>`,
      parse_mode: "HTML",
    });
    return;
  }
}

// ============================================================
// HANDLE MESSAGES (text / document / photo)
// ============================================================
async function handleMessage(msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const isOwner = userId === config.OWNER_ID;
  const state = getState(userId);

  // ─── /start command ───
  if (msg.text && msg.text.startsWith("/start")) {
    // [FIX] Reset state agar user tidak nyangkut di flow sebelumnya
    if (state) clearState(userId);
    return handleStart(msg);
  }

  // ─── AWAITING SCREENSHOT ───
  if (state && state.action === "awaiting_screenshot") {
    if (!msg.photo) {
      // [FIX] Sertakan tombol batal agar user tidak terjebak
      await tg.sendMessage({
        chat_id: chatId,
        text: `<blockquote>⚠️ Harap kirim <b>screenshot</b> bukti transfer kamu.\n\nAtau tekan tombol di bawah untuk membatalkan pesanan.</blockquote>`,
        parse_mode: "HTML",
        reply_markup: JSON.stringify(keyAwaitScreenshot(state.orderId)),
      });
      return;
    }

    const photo = msg.photo[msg.photo.length - 1];
    const fileId = photo.file_id;
    const { orderId, role, nominal } = state;

    updateTransaksi(orderId, { screenshotFileId: fileId, status: "waiting_confirmation" });

    await tg.sendMessage({
      chat_id: chatId,
      text:
        `<blockquote>` +
        `📨 <b>Bukti transfer diterima!</b>\n\n` +
        `Pesanan kamu sedang dalam review oleh owner.\n` +
        `🔖 Order ID: <code>${orderId}</code>\n\n` +
        `Harap tunggu konfirmasi dari owner. ✅` +
        `</blockquote>`,
      parse_mode: "HTML",
    });

    const ownerText =
      `<blockquote>` +
      `🔔 <b>PESANAN BARU MASUK!</b>\n\n` +
      `👤 Username: ${msg.from.username ? "@" + msg.from.username : "—"}\n` +
      `🆔 User ID: <code>${userId}</code>\n\n` +
      `🛒 Item: <b>${role}</b>\n` +
      `💰 Nominal: <b>${formatRp(nominal)}</b>\n` +
      `🔖 Order ID: <code>${orderId}</code>\n\n` +
      `📸 Screenshot transfer terlampir di atas.\n` +
      `Silahkan konfirmasi atau tolak pesanan ini.` +
      `</blockquote>`;

    try {
      await tg.sendPhoto({
        chat_id: config.OWNER_ID,
        photo: fileId,
        caption: ownerText,
        parse_mode: "HTML",
        reply_markup: JSON.stringify(keyConfirmOrder(orderId)),
      });
    } catch (e) { console.error("Send to owner error:", e.message); }

    clearState(userId);
    return;
  }

  // ─── AWAITING SCRIPT FILE (OWNER) ───
  if (state && state.action === "awaiting_script_file" && isOwner) {
    if (!msg.document) {
      await tg.sendMessage({
        chat_id: chatId,
        text: `<blockquote>⚠️ Harap kirim file <b>.zip</b> untuk script.</blockquote>`,
        parse_mode: "HTML",
      });
      return;
    }

    const doc = msg.document;
    if (!doc.file_name.endsWith(".zip")) {
      await tg.sendMessage({
        chat_id: chatId,
        text: `<blockquote>⚠️ File harus berformat <b>.zip</b>!</blockquote>`,
        parse_mode: "HTML",
      });
      return;
    }

    setState(userId, {
      action: "awaiting_script_detail",
      fileId: doc.file_id,
      fileName: doc.file_name,
    });

    await tg.sendMessage({
      chat_id: chatId,
      text:
        `<blockquote>` +
        `✅ File diterima: <b>${doc.file_name}</b>\n\n` +
        `Sekarang kirim detail script dengan format:\n\n` +
        `<code>NAMA SCRIPT | HARGA | DESKRIPSI</code>\n\n` +
        `Contoh:\n` +
        `<code>Script Login | 15000 | Script login keren untuk panel</code>` +
        `</blockquote>`,
      parse_mode: "HTML",
      reply_markup: JSON.stringify(kb([[{ text: "🚫 BATAL", callback_data: "cancel_add_script", style: "danger" }]])),
    });
    return;
  }

  // ─── AWAITING SCRIPT DETAIL (OWNER) ───
  if (state && state.action === "awaiting_script_detail" && isOwner) {
    if (!msg.text) return;
    const parts = msg.text.split("|").map((s) => s.trim());
    if (parts.length < 3) {
      await tg.sendMessage({
        chat_id: chatId,
        text: `<blockquote>⚠️ Format salah! Gunakan:\n<code>NAMA SCRIPT | HARGA | DESKRIPSI</code></blockquote>`,
        parse_mode: "HTML",
      });
      return;
    }

    const [name, priceRaw, description] = parts;
    const price = parseInt(priceRaw.replace(/[^0-9]/g, ""), 10);
    if (isNaN(price)) {
      await tg.sendMessage({
        chat_id: chatId,
        text: `<blockquote>⚠️ Harga tidak valid! Gunakan angka, contoh: <code>15000</code></blockquote>`,
        parse_mode: "HTML",
      });
      return;
    }

    const scripts = getScripts();
    scripts.push({
      name,
      price,
      description,
      fileId: state.fileId,
      fileName: state.fileName,
      addedAt: new Date().toISOString(),
    });
    saveScripts(scripts);
    clearState(userId);

    await tg.sendMessage({
      chat_id: chatId,
      text:
        `<blockquote>` +
        `✅ <b>Sukses Menambah Script!</b>\n\n` +
        `📂 Nama: <b>${name}</b>\n` +
        `💰 Harga: <b>${formatRp(price)}</b>\n` +
        `📄 File: <b>${state.fileName}</b>\n` +
        `📝 Deskripsi: ${description}` +
        `</blockquote>`,
      parse_mode: "HTML",
      reply_markup: JSON.stringify(KEY_OWNER_PANEL),
    });
    return;
  }

  // ─── AWAITING BROADCAST (OWNER) ───
  if (state && state.action === "awaiting_broadcast" && isOwner) {
    if (!msg.text) return;
    const broadcastMsg = msg.text;
    clearState(userId);

    const allIds = getAllUserIds();
    let sukses = 0, gagal = 0;

    await tg.sendMessage({
      chat_id: chatId,
      text: `<blockquote>📢 Memulai broadcast ke <b>${allIds.length}</b> user...</blockquote>`,
      parse_mode: "HTML",
    });

    // [FIX] Tangani error 429 (rate limit) + akurasi hitungan sukses
    for (const uid of allIds) {
      const payload = {
        chat_id: uid,
        text: `<blockquote>📢 <b>𝗣𝗘𝗦𝗔𝗡 𝗗𝗔𝗥𝗜 𝗢𝗪𝗡𝗘𝗥</b>\n\n${broadcastMsg}</blockquote>`,
        parse_mode: "HTML",
      };
      try {
        const r = await tg.sendMessage(payload);
        if (r.ok) {
          sukses++;
        } else if (r.error_code === 429) {
          const wait = ((r.parameters && r.parameters.retry_after) || 1) * 1000;
          await sleep(wait);
          const r2 = await tg.sendMessage(payload);
          if (r2.ok) sukses++; else gagal++;
        } else {
          gagal++;
        }
      } catch { gagal++; }
      await sleep(50);
    }

    await tg.sendMessage({
      chat_id: chatId,
      text:
        `<blockquote>` +
        `✅ <b>Broadcast Selesai!</b>\n\n` +
        `📨 Berhasil: <b>${sukses}</b>\n` +
        `❌ Gagal: <b>${gagal}</b>\n` +
        `👥 Total: <b>${allIds.length}</b>` +
        `</blockquote>`,
      parse_mode: "HTML",
    });
    return;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ============================================================
// ADZAN SCHEDULER
// ============================================================
// [FIX] Track anti-dobel per jadwal per hari
const adzanSentToday = {};

function startAdzanScheduler() {
  setInterval(async () => {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
    const h = now.getHours();
    const m = now.getMinutes();
    const todayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;

    for (const [key, sched] of Object.entries(config.ADZAN_SCHEDULE)) {
      if (sched.hour === h && sched.minute === m) {
        const stamp = `${todayKey}:${key}`;
        if (adzanSentToday[stamp]) continue;
        adzanSentToday[stamp] = true;
        await sendAdzanBroadcast(sched);
      }
    }

    // Bersihkan entri hari lalu agar memori tetap ringan
    const keys = Object.keys(adzanSentToday);
    for (const k of keys) {
      if (!k.startsWith(todayKey)) delete adzanSentToday[k];
    }
  }, 1000);
}

async function sendAdzanBroadcast(sched) {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
  const pad = (n) => String(n).padStart(2, "0");
  const waktu = `${pad(now.getHours())}:${pad(now.getMinutes())} WIB`;

  const text =
    `<blockquote>` +
    `🕌 <b>WAKTU SHOLAT ${sched.name} TELAH TIBA</b>\n\n` +
    `Saat waktu ${sched.name.toLowerCase()} tiba, segeralah tunaikan kewajibanmu.\n\n` +
    `⏰ Waktu: <b>${waktu}</b>\n` +
    `📍 Wilayah: <b>${config.ADZAN_WILAYAH}</b>\n\n` +
    `${sched.ayat}\n\n` +
    `📚 <b>Keutamaan Sholat:</b>\n` +
    `• Mendapat pahala besar dari Allah\n` +
    `• Menjaga diri dari perbuatan maksiat\n` +
    `• Membersihkan hati dan pikiran\n` +
    `• Mendatangkan ketenangan jiwa\n\n` +
    `Jangan tunda-tunda sholatmu! 🤲\n` +
    `━━━━━━━━━━━━━━━━━━━━━━` +
    `</blockquote>`;

  const allIds = getAllUserIds();
  for (const uid of allIds) {
    try {
      await tg.sendMessage({ chat_id: uid, text, parse_mode: "HTML" });
      await sleep(50);
    } catch {}
  }
  console.log(`[ADZAN] ${sched.name} broadcast dikirim ke ${allIds.length} user.`);
}

// ============================================================
// POLLING
// ============================================================
let offset = 0;

async function poll() {
  try {
    const res = await tg.getUpdates({
      offset,
      timeout: 30,
      allowed_updates: JSON.stringify(["message", "callback_query"]),
    });

    if (!res.ok) {
      await sleep(2000);
      return;
    }

    // [FIX] Jika kosong (long-poll timeout), beri jeda kecil sebelum loop lagi
    if (!res.result || res.result.length === 0) {
      await sleep(200);
      return;
    }

    for (const update of res.result) {
      offset = update.update_id + 1;
      try {
        if (update.callback_query) {
          await handleCallback(update.callback_query);
        } else if (update.message) {
          await handleMessage(update.message);
        }
      } catch (e) {
        console.error("Update handler error:", e.message);
      }
    }
  } catch (e) {
    console.error("Poll error:", e.message);
    await sleep(3000);
  }
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.clear();
  console.log(`
\x1b[31m
　　　⣀⠤⠔⠒⠒⠒⠒⠒⠒⠒⠦⢄⣀⠀⠀⠀⠀
　⢀⡴⠋　　　　　　　　⠈⠑⢄⠀⠀
⢀⠎　　　　　　　　　　　⠈⢣⠀
⢸　⡄　　　　　　　　　　⢢⠈⡇
⢸　⣇　　　　　　　　　　⡼　⡇
⠘⡆⢸　⢀⣀⣤⣄⡀　　⢀⣤⣤⣄⡀　⡇⡸⠀
　⠘⣾⠀⣿⣿⣿⣿⣿　　⣿⣿⣿⣿⣿　⡗⠁⠀
　⢸⣿⠀⠙⢿⣿⠿⠃⢠⢠⡀⠙⠿⣿⠿⠃　⡇⠀⠀
　⠁⢸⣄　　　⢠⣿⢸⣿⠀⠀⠀⠀⠀⣠⠇⠀⠀
　　⡏⢷⡄　　⠘⠟⠈⠿⠁⠀⠀⢠⡞⡹⠁⠀⠀⠀
　　⢹⠀⠸⠘⢢⢠⠤⠤⡤⡄⢰⢡⠁⠀⡇⠀⠀⠀⠀
　　⢸⠀⠀⠣⣹⢸⠒⠒⡗⡇⣩⠌⢀⠀⡇⠀⠀⠀⠀
　　⠈⢧⡀⠀⠀⠉⠉⠉⠉⠁⠀⠀⣀⠜⠀⠀⠀⠀⠀
　　　　⠉⠓⠢⠤⠤⠤⠔⠊⠁⠀⠀⠀⠀⠀⠀

      𝗔𝗢𝗨𝗧𝗢 𝗢𝗥𝗗𝗘𝗥 𝗥𝗔𝗡𝗡
\x1b[0m
`);

  startAdzanScheduler();

  while (true) {
    await poll();
  }
}

// [FIX] Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[SIGINT] Bot dimatikan dengan rapi.");
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("\n[SIGTERM] Bot dimatikan dengan rapi.");
  process.exit(0);
});
process.on("uncaughtException", (e) => {
  console.error("[uncaughtException]", e);
});
process.on("unhandledRejection", (e) => {
  console.error("[unhandledRejection]", e);
});

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
