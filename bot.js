import express from "express";
import { Telegraf } from "telegraf";
import fs from "fs";

// ---------------- ENV ---------------- //
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const ADMIN_PASS = process.env.ADMIN_PASS;
const BOT_USERNAME = process.env.BOT_USERNAME;

// ---------------- BOT INIT ---------------- //
const bot = new Telegraf(BOT_TOKEN);

// ---------------- DATABASE ---------------- //
const DB_FILE = "database.json";

function loadDB() {
    if (!fs.existsSync(DB_FILE)) {
        return {
            users: [],
            files: {},
            adsSent: 0,
            lastBroadcast: "Never"
        };
    }
    return JSON.parse(fs.readFileSync(DB_FILE));
}

function saveDB() {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

let db = loadDB();

// ---------------- ADMIN SESSION ---------------- //
let adminLogged = false;

// -------------- Helper: Delay ---------------- //
function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

// -------------- SAFE BROADCAST ---------------- //
async function safeBroadcast(fn) {
    for (let user of db.users) {
        try {
            await fn(user);
            await delay(200 + Math.random() * 250);
        } catch (err) {
            console.log("Send fail:", user, err.message);
        }
    }
    db.adsSent++;
    db.lastBroadcast = new Date().toLocaleString();
    saveDB();
}

// ------------------- START ------------------- //
bot.start(async (ctx) => {
    const uid = ctx.chat.id;
    const args = ctx.message.text.split(" ");

    // Save user
    if (!db.users.includes(uid)) {
        db.users.push(uid);
        saveDB();
    }

    // Deep link download
    if (args.length > 1) {
        const code = args[1];
        const fileObj = db.files[code];
        if (fileObj) {
            return ctx.replyWithDocument(fileObj.file_id, {
                caption: `📥 *Your Download is Ready!*\n\n📦 *File:* ${fileObj.name}\n📏 Size: ${fileObj.size} bytes`,
                parse_mode: "Markdown"
            });
        } else {
            return ctx.reply("❌ Link expired or invalid.");
        }
    }

    // Normal welcome
    return ctx.replyWithMarkdown(
        `👋 Hello *${ctx.from.first_name || "there"}!*  
Send /help to see features.`
    );
});

// ------------------- HELP ------------------- //
bot.command("help", (ctx) => {
    ctx.reply(
`📘 *Bot Commands:*
/start - Start bot
/help - Show help

For deep downloads: click provided links.

*Admin Commands:* (Admin only)
 /admin  
 /upload  
 /stats  
 /listfiles  
 /removefile CODE  
 /sendads  
 /sendimgads  
 /sendvidads  
 /resend CODE  
 /sendto CHATID TEXT  
 /sendfileto CHATID CODE`,
        { parse_mode: "Markdown" }
    );
});

// ------------------- ADMIN LOGIN ------------------- //
bot.command("admin", async (ctx) => {
    if (ctx.chat.id !== ADMIN_ID) return;
    adminLogged = false;
    return ctx.reply("Enter admin password:");
});

// ------------------- ADMIN PASSWORD CATCH ------------------- //
bot.on("text", async (ctx, next) => {
    if (ctx.chat.id === ADMIN_ID && !adminLogged) {
        if (ctx.message.text === ADMIN_PASS) {
            adminLogged = true;
            return ctx.reply("✅ Admin Logged In!");
        } else {
            return ctx.reply("❌ Wrong Password");
        }
    }
    return next();
});

// ------------------- UPLOAD FILE ------------------- //
bot.command("upload", (ctx) => {
    if (ctx.chat.id !== ADMIN_ID || !adminLogged) return;
    ctx.reply("📤 Send the file now:");
});

// ------------------- FILE RECEIVER ------------------- //
bot.on("document", async (ctx) => {
    if (ctx.chat.id !== ADMIN_ID || !adminLogged) return;

    const f = ctx.message.document;
    const code = Math.random().toString(36).slice(2, 10);

    db.files[code] = {
        file_id: f.file_id,
        name: f.file_name,
        size: f.file_size
    };
    saveDB();

    return ctx.reply(
`✅ File uploaded!

🔗 User link:
https://t.me/${BOT_USERNAME}?start=${code}

File Code: *${code}*`,
        { parse_mode: "Markdown" }
    );
});

// ------------------- TEXT ADS ------------------- //
bot.command("sendads", (ctx) => {
    if (ctx.chat.id !== ADMIN_ID || !adminLogged) return;
    ctx.reply("Send ad text:");
    bot.once("text", async (msg) => {
        await safeBroadcast((u) =>
            bot.telegram.sendMessage(u, msg.message.text)
        );
        msg.reply("📢 Text Ad sent!");
    });
});

// ------------------- IMG ADS ------------------- //
bot.command("sendimgads", (ctx) => {
    if (ctx.chat.id !== ADMIN_ID || !adminLogged) return;
    ctx.reply("Send image:");
    bot.once("photo", async (msg) => {
        const fid = msg.message.photo.pop().file_id;
        await safeBroadcast((u) => bot.telegram.sendPhoto(u, fid));
        msg.reply("📢 Image Ad sent!");
    });
});

// ------------------- VIDEO ADS ------------------- //
bot.command("sendvidads", (ctx) => {
    if (ctx.chat.id !== ADMIN_ID || !adminLogged) return;
    ctx.reply("Send video:");
    bot.once("video", async (msg) => {
        const fid = msg.message.video.file_id;
        await safeBroadcast((u) => bot.telegram.sendVideo(u, fid));
        msg.reply("📢 Video Ad sent!");
    });
});

// ------------------- STATS ------------------- //
bot.command("stats", (ctx) => {
    if (ctx.chat.id !== ADMIN_ID || !adminLogged) return;

    ctx.replyWithMarkdown(
`📊 *BOT STATS*

👥 Users: *${db.users.length}*
📁 Files: *${Object.keys(db.files).length}*
📢 Ads Sent: *${db.adsSent}*
⏱ Last Broadcast: *${db.lastBroadcast}*`
    );
});

// ------------------- LIST FILES ------------------- //
bot.command("listfiles", (ctx) => {
    if (ctx.chat.id !== ADMIN_ID || !adminLogged) return;
    let out = "📂 *Uploaded Files:*\n\n";
    for (let c in db.files) {
        out += `• *${c}* — ${db.files[c].name}\n`;
    }
    ctx.replyWithMarkdown(out || "No files stored.");
});

// ------------------- REMOVE FILE ------------------- //
bot.command("removefile", (ctx) => {
    if (ctx.chat.id !== ADMIN_ID || !adminLogged) return;

    const code = ctx.message.text.split(" ")[1];
    if (!code) return ctx.reply("❌ Provide file code.");

    if (!db.files[code]) return ctx.reply("❌ File not found.");

    delete db.files[code];
    saveDB();
    ctx.reply("🗑 File removed.");
});

// ------------------- SEND TO SINGLE USER ------------------- //
bot.command("sendto", (ctx) => {
    if (ctx.chat.id !== ADMIN_ID || !adminLogged) return;

    const args = ctx.message.text.split(" ");
    const chatId = Number(args[1]);
    const text = args.slice(2).join(" ");

    if (!chatId || !text) {
        return ctx.reply("❌ Usage: /sendto CHATID text");
    }

    bot.telegram.sendMessage(chatId, text);
    ctx.reply("✅ Sent!");
});

// ------------------- SEND FILE TO USER ------------------- //
bot.command("sendfileto", (ctx) => {
    if (ctx.chat.id !== ADMIN_ID || !adminLogged) return;

    const args = ctx.message.text.split(" ");
    const chatId = Number(args[1]);
    const code = args[2];

    if (!chatId || !code) {
        return ctx.reply("❌ Usage: /sendfileto CHATID CODE");
    }

    if (!db.files[code]) return ctx.reply("❌ File not found.");

    const f = db.files[code];
    bot.telegram.sendDocument(chatId, f.file_id, {
        caption: `${f.name}`
    });

    ctx.reply("📤 File delivered!");
});

// ------------------- RESEND FILE ------------------- //
bot.command("resend", (ctx) => {
    if (ctx.chat.id !== ADMIN_ID || !adminLogged) return;

    const code = ctx.message.text.split(" ")[1];
    if (!code) return ctx.reply("❌ Provide code.");

    const f = db.files[code];
    if (!f) return ctx.reply("❌ File not found.");

    ctx.replyWithDocument(f.file_id, { caption: f.name });
});

// ------------------- SERVER ------------------- //
const app = express();
app.get("/", (req, res) => res.send("Bot Running!"));
app.listen(process.env.PORT || 8080);

// ------------------- LAUNCH ------------------- //
bot.launch();
console.log("BOT RUNNING V19 ULTRA-ADVANCED");
