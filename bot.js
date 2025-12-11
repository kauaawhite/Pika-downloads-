// bot.js — Improved DeepLink File Delivery (Telegraf + Express)
// Option A — fixed & persistent version of earlier code
// Dependencies: telegraf, express
// Install: npm i telegraf express

import express from "express";
import fs from "fs";
import path from "path";
import { Telegraf } from "telegraf";

const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME || ''; // optional
const ADMIN_ID = String(process.env.ADMIN_ID || '');
const ADMIN_PASS = String(process.env.ADMIN_PASS || '');
const PORT = Number(process.env.PORT || 3000);
const INACTIVE_DAYS = Number(process.env.INACTIVE_DAYS || 2);

if (!BOT_TOKEN) { console.error("Missing BOT_TOKEN env"); process.exit(1); }
if (!ADMIN_ID) { console.error("Missing ADMIN_ID env"); process.exit(1); }
if (!ADMIN_PASS) { console.error("Missing ADMIN_PASS env"); process.exit(1); }

const bot = new Telegraf(BOT_TOKEN);

// DB path + ensure
const DB_PATH = path.join(process.cwd(), "database.json");
const BACKUP_DIR = path.join(process.cwd(), "backups");
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

function defaultDB() {
  return {
    mappings: {}, // code -> { file_id, file_type, file_name, addedBy, addedAt }
    users: {},    // chatId -> { firstSeen, lastActive, downloads }
    downloadCount: 0,
    welcome: "👋 Welcome! Use the deep link from channel to get your file.",
    inactiveMessage: "👋 It's been a while. Need the file again? Open link or message admin.",
    settings: { inactiveDays: INACTIVE_DAYS }
  };
}

function readDB() {
  try {
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const j = JSON.parse(raw || "{}");
    return Object.assign(defaultDB(), j);
  } catch (e) {
    const d = defaultDB();
    fs.writeFileSync(DB_PATH, JSON.stringify(d, null, 2));
    return d;
  }
}
function writeDB(db) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error("writeDB err", e);
  }
}

// small backup rotation
function backupDB() {
  try {
    if (!fs.existsSync(DB_PATH)) return;
    const dest = path.join(BACKUP_DIR, `backup-${Date.now()}.json`);
    fs.copyFileSync(DB_PATH, dest);
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith("backup-")).sort();
    if (files.length > 200) {
      const remove = files.slice(0, files.length - 200);
      remove.forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
    }
  } catch (e) {
    console.error("backupDB err", e);
  }
}
setInterval(backupDB, 6 * 60 * 60 * 1000); // every 6 hours

// pending interactive map per admin (safe)
const pending = {}; // chatId -> { action: 'setfile'|'broadcasttext'|'broadcastmedia', meta: {...}, timeout }

function setPending(adminId, obj, ms = 2 * 60 * 1000) {
  if (pending[adminId] && pending[adminId].timeout) clearTimeout(pending[adminId].timeout);
  const to = setTimeout(() => { delete pending[adminId]; try { bot.telegram.sendMessage(adminId, "⏳ Action timed out."); } catch {} }, ms);
  pending[adminId] = Object.assign({}, obj, { timeout: to });
}

// simple rate limiter for deep-link requests (per user)
const rateMap = {}; // chatId -> timestamps
function rateAllow(chatId) {
  const WINDOW = 5000; // 5s
  const MAX = 3;
  const arr = rateMap[chatId] || [];
  const cutoff = Date.now() - WINDOW;
  const keep = arr.filter(ts => ts > cutoff);
  if (keep.length >= MAX) { rateMap[chatId] = keep; return false; }
  keep.push(Date.now());
  rateMap[chatId] = keep;
  return true;
}

// utility
function isAdmin(ctx) { return String(ctx.from?.id) === String(ADMIN_ID); }
function escapeMd(s='') { return String(s).replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1"); }

// ---------------- BOT COMMANDS ---------------- //

// /start [CODE] -> deep link delivery
bot.start(async (ctx) => {
  try {
    const param = (ctx.startPayload || "").trim(); // telegraf exposes startPayload
    const chatId = String(ctx.chat.id);
    const db = readDB();

    // register user
    if (!db.users[chatId]) db.users[chatId] = { firstSeen: Date.now(), lastActive: Date.now(), downloads: 0 };
    else db.users[chatId].lastActive = Date.now();
    writeDB(db);

    if (!param) {
      return ctx.reply(db.welcome);
    }

    if (!rateAllow(chatId)) return ctx.reply("⚠️ You're requesting too fast. Try again in a moment.");

    const code = String(param).replace(/[^A-Za-z0-9_-]/g, "");
    const map = db.mappings && db.mappings[code];
    if (!map) {
      return ctx.reply(`❌ No file found for code: ${escapeMd(code)}`, { parse_mode: "Markdown" });
    }

    // attempt send
    try {
      const fid = map.file_id;
      const ftype = map.file_type || "document";
      const fname = map.file_name || "";

      if (ftype === "photo") await ctx.replyWithPhoto(fid, { caption: fname || undefined });
      else if (ftype === "video") await ctx.replyWithVideo(fid, { caption: fname || undefined });
      else if (ftype === "audio") await ctx.replyWithAudio(fid, { caption: fname || undefined });
      else if (ftype === "voice") await ctx.replyWithVoice(fid, { caption: fname || undefined });
      else await ctx.replyWithDocument(fid, { caption: fname || undefined });

      // stats update
      db.downloadCount = (db.downloadCount || 0) + 1;
      db.users[chatId].downloads = (db.users[chatId].downloads || 0) + 1;
      db.users[chatId].lastActive = Date.now();
      writeDB(db);
    } catch (e) {
      console.error("send mapped err", e);
      return ctx.reply("❌ Failed to send file. It may have been removed or Telegram blocked it.");
    }

  } catch (e) {
    console.error("/start err", e);
  }
});

// /admin -> start admin login conversation
bot.command("admin", async (ctx) => {
  if (!isAdmin(ctx)) return; // only allowed chat id can initiate
  setPending(String(ctx.chat.id), { action: "adminlogin" }, 3 * 60 * 1000);
  return ctx.reply("🔒 Send admin password (reply). You have 3 minutes.");
});

// capture replies for pending actions and admin messages
bot.on("message", async (ctx) => {
  try {
    if (!ctx.message) return;
    const chatId = String(ctx.chat.id);
    const db = readDB();

    // update lastActive for all users (and record)
    if (!db.users[chatId]) db.users[chatId] = { firstSeen: Date.now(), lastActive: Date.now(), downloads: 0 };
    else db.users[chatId].lastActive = Date.now();
    writeDB(db);

    // ignore commands text because telegraf already handles them
    if (ctx.message.text && ctx.message.text.startsWith("/")) {
      // allow /listfiles /setfile etc to be processed by onText handlers below
      return;
    }

    if (pending[chatId]) {
      const p = pending[chatId];
      clearTimeout(p.timeout);
      delete pending[chatId];

      // admin login flow
      if (p.action === "adminlogin") {
        const pw = ctx.message.text?.trim() || "";
        if (pw === ADMIN_PASS) {
          // mark admin session stored in DB with expiry time (not persistent across reloads)
          // We'll store a short session token in memory per admin for this runtime
          p.session = true; // just used inside block
          // Instead of global adminLogged, store in memory sessions
          sessions[chatId] = { loggedAt: Date.now(), expiresAt: Date.now() + 30 * 60 * 1000 }; // 30 min session
          await ctx.reply("✅ Admin logged in. You can now use admin commands.");
        } else {
          await ctx.reply("❌ Wrong password. Use /admin to try again.");
        }
        return;
      }

      // setfile flow (admin sends actual file after /setfile CODE)
      if (p.action === "setfile") {
        if (!isAdmin(ctx)) { ctx.reply("❌ Not authorized."); return; }
        try {
          let file_id = null, file_type = "document", file_name = "";
          if (ctx.message.document) {
            file_id = ctx.message.document.file_id;
            file_type = "document";
            file_name = ctx.message.document.file_name || "file";
          } else if (ctx.message.photo) {
            const ph = ctx.message.photo[ctx.message.photo.length - 1];
            file_id = ph.file_id; file_type = "photo"; file_name = ctx.message.caption || "photo";
          } else if (ctx.message.video) {
            file_id = ctx.message.video.file_id; file_type = "video"; file_name = ctx.message.caption || "video";
          } else if (ctx.message.audio) {
            file_id = ctx.message.audio.file_id; file_type = "audio"; file_name = ctx.message.audio.file_name || "audio";
          } else if (ctx.message.voice) {
            file_id = ctx.message.voice.file_id; file_type = "voice"; file_name = "voice";
          } else {
            await ctx.reply("❌ Please send a supported file (document/photo/video/audio/voice). Operation cancelled.");
            return;
          }

          const code = p.meta?.code;
          if (!code) return ctx.reply("❌ Missing code metadata. Please retry.");

          db.mappings = db.mappings || {};
          db.mappings[code] = { file_id, file_type, file_name, addedBy: chatId, addedAt: Date.now() };
          writeDB(db);

          await ctx.reply(`✅ File saved for code *${escapeMd(code)}*.\nShare: https://t.me/${BOT_USERNAME || "<bot_username>"}?start=${code}`, { parse_mode: "Markdown" });
        } catch (e) {
          console.error("setfile capture err", e);
          await ctx.reply("❌ Error saving file.");
        }
        return;
      }

      // broadcast text
      if (p.action === "broadcasttext") {
        const text = ctx.message.text || ctx.message.caption || "";
        if (!text) { await ctx.reply("❌ Please send the text to broadcast."); return; }
        const users = Object.keys(readDB().users || {});
        await ctx.reply(`Broadcasting to ${users.length} users...`);
        (async ()=>{
          let sent=0, failed=0;
          for (let i=0;i<users.length;i++){
            try { await bot.telegram.sendMessage(users[i], text); sent++; } catch(e){ failed++; }
            if (i % 25 === 0) await new Promise(r => setTimeout(r, 900));
          }
          await ctx.reply(`✅ Broadcast done. Sent:${sent} Failed:${failed}`);
        })();
        return;
      }

      // broadcast media
      if (p.action === "broadcastmedia") {
        // capture media similar to setfile
        try {
          let file_id = null, file_type = "document", caption = ctx.message.caption || "";
          if (ctx.message.document) { file_id = ctx.message.document.file_id; file_type = "document"; }
          else if (ctx.message.photo) { file_id = ctx.message.photo[ctx.message.photo.length-1].file_id; file_type='photo'; }
          else if (ctx.message.video) { file_id = ctx.message.video.file_id; file_type='video'; }
          else { await ctx.reply("❌ Send a photo/video/document to broadcast."); return; }

          const users = Object.keys(readDB().users || {});
          await ctx.reply(`Broadcasting media to ${users.length} users...`);
          (async ()=>{
            let sent=0, failed=0;
            for (let i=0;i<users.length;i++){
              const uid = users[i];
              try {
                if (file_type === 'photo') await bot.telegram.sendPhoto(uid, file_id, { caption });
                else if (file_type === 'video') await bot.telegram.sendVideo(uid, file_id, { caption });
                else await bot.telegram.sendDocument(uid, file_id, { caption });
                sent++;
              } catch(e){ failed++; }
              if (i % 25 === 0) await new Promise(r => setTimeout(r, 900));
            }
            await ctx.reply(`✅ Media broadcast done. Sent:${sent} Failed:${failed}`);
          })();
        } catch (e) { console.error("broadcast capture err", e); await ctx.reply("❌ Error broadcasting media."); }
        return;
      }

    } // end pending
  } catch (e) {
    console.error("message handler err", e);
  }
});

// sessions in memory for admin (not persisted)
const sessions = {}; // chatId -> { loggedAt, expiresAt }
function isSessionActive(chatId) {
  const s = sessions[String(chatId)];
  if (!s) return false;
  if (Date.now() > s.expiresAt) { delete sessions[chatId]; return false; }
  return true;
}

// admin-only commands that require session
bot.command("setfile", async (ctx) => {
  if (!isAdmin(ctx)) return;
  if (!isSessionActive(String(ctx.chat.id))) { return ctx.reply("🔒 Please login: send /admin and provide password."); }
  const parts = (ctx.message.text || "").split(/\s+/);
  const code = parts[1];
  if (!code) return ctx.reply("Usage: /setfile CODE\nExample: /setfile apk123");
  setPending(String(ctx.chat.id), { action: "setfile", meta: { code } });
  await ctx.reply(`Send the file now to map to code: *${escapeMd(code)}* (2 minutes)`, { parse_mode: "Markdown" });
});

bot.command("removefile", async (ctx) => {
  if (!isAdmin(ctx)) return;
  if (!isSessionActive(String(ctx.chat.id))) { return ctx.reply("🔒 Login first (/admin)"); }
  const parts = (ctx.message.text || "").split(/\s+/);
  const code = parts[1];
  if (!code) return ctx.reply("Usage: /removefile CODE");
  const db = readDB();
  if (db.mappings && db.mappings[code]) {
    delete db.mappings[code];
    writeDB(db);
    return ctx.reply(`✅ Mapping removed for ${escapeMd(code)}`, { parse_mode: "Markdown" });
  } else return ctx.reply("❌ No mapping found for that code.");
});

bot.command("listfiles", (ctx) => {
  if (!isAdmin(ctx)) return;
  if (!isSessionActive(String(ctx.chat.id))) { return ctx.reply("🔒 Login first (/admin)"); }
  const db = readDB();
  const keys = Object.keys(db.mappings || {});
  if (!keys.length) return ctx.reply("No files mapped yet.");
  let text = "*Mapped Files:*\n\n";
  keys.forEach(k => {
    const m = db.mappings[k];
    text += `• *${escapeMd(k)}* — ${escapeMd(m.file_name || m.file_type || 'file')} (added ${new Date(m.addedAt).toLocaleString()})\n`;
  });
  ctx.reply(text, { parse_mode: "Markdown" });
});

bot.command("getfile", async (ctx) => {
  if (!isAdmin(ctx)) return;
  if (!isSessionActive(String(ctx.chat.id))) { return ctx.reply("🔒 Login first (/admin)"); }
  const parts = (ctx.message.text || "").split(/\s+/);
  const code = parts[1];
  if (!code) return ctx.reply("Usage: /getfile CODE");
  const db = readDB();
  const map = db.mappings[code];
  if (!map) return ctx.reply("No mapping for that code.");
  try {
    const fid = map.file_id, ftype = map.file_type || 'document', fname = map.file_name || '';
    if (ftype === 'photo') await ctx.replyWithPhoto(fid, { caption: fname || undefined });
    else if (ftype === 'video') await ctx.replyWithVideo(fid, { caption: fname || undefined });
    else if (ftype === 'audio') await ctx.replyWithAudio(fid, { caption: fname || undefined });
    else if (ftype === 'voice') await ctx.replyWithVoice(fid, { caption: fname || undefined });
    else await ctx.replyWithDocument(fid, { caption: fname || undefined });
  } catch (e) { console.error("/getfile err", e); ctx.reply("Failed to send file."); }
});

bot.command("broadcasttext", (ctx) => {
  if (!isAdmin(ctx)) return;
  if (!isSessionActive(String(ctx.chat.id))) { return ctx.reply("🔒 Login first"); }
  setPending(String(ctx.chat.id), { action: "broadcasttext" });
  ctx.reply("📣 Send the text you want to broadcast to all users (2 minutes).");
});

bot.command("broadcastmedia", (ctx) => {
  if (!isAdmin(ctx)) return;
  if (!isSessionActive(String(ctx.chat.id))) { return ctx.reply("🔒 Login first"); }
  setPending(String(ctx.chat.id), { action: "broadcastmedia" });
  ctx.reply("📣 Send the media (photo/video/document) to broadcast to all users (2 minutes).");
});

bot.command("stats", (ctx) => {
  if (!isAdmin(ctx)) return;
  if (!isSessionActive(String(ctx.chat.id))) { return ctx.reply("🔒 Login first"); }
  const db = readDB();
  const totalUsers = Object.keys(db.users || {}).length;
  const downloads = db.downloadCount || 0;
  const mappings = Object.keys(db.mappings || {}).length;
  ctx.reply(`📈 Stats\nTotal users: ${totalUsers}\nTotal downloads: ${downloads}\nMappings: ${mappings}`);
});

bot.command("sendinactive", (ctx) => {
  if (!isAdmin(ctx)) return;
  if (!isSessionActive(String(ctx.chat.id))) { return ctx.reply("🔒 Login first"); }
  const db = readDB();
  const days = db.settings?.inactiveDays || INACTIVE_DAYS;
  const cutoff = Date.now() - days * 24*60*60*1000;
  const list = Object.keys(db.users || {}).filter(u => (db.users[u].lastActive || 0) < cutoff);
  if (!list.length) return ctx.reply("No inactive users.");
  ctx.reply(`Sending inactive message to ${list.length} users...`);
  (async ()=>{
    let s=0,f=0;
    for (let i=0;i<list.length;i++){
      try { await bot.telegram.sendMessage(list[i], db.inactiveMessage || "Hello!"); s++; } catch(e){ f++; }
      if (i%25===0) await new Promise(r=>setTimeout(r, 900));
    }
    ctx.reply(`Done. Sent:${s} Failed:${f}`);
  })();
});

// Admin login verification is by pending admin flow: we used /admin which sets pending.adminlogin
// But we still need to accept the password text -> handled in message handler and fills sessions

// Lightweight express health server
const app = express();
app.use(express.json());

app.get("/", (req, res) => res.send("PikaDownloads Bot running"));
app.listen(PORT, () => console.log(`HTTP server up on ${PORT}`));

// graceful shutdown & save
async function shutdown() {
  console.log("Shutting down...");
  try { writeDB(readDB()); } catch (e) {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// launch bot
(async () => {
  try {
    await bot.launch();
    console.log("Bot started");
    console.log("Admin ID:", ADMIN_ID);
  } catch (e) {
    console.error("Bot launch error", e);
  }
})();
