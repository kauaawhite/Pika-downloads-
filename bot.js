import express from "express";
import { Telegraf } from "telegraf";
import fs from "fs";

const app = express();
app.use(express.json());

/* ------------------ ENV VARIABLES ------------------ */
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const ADMIN_PASS = process.env.ADMIN_PASS;
const BOT_USERNAME = process.env.BOT_USERNAME;

/* ------------------ BOT INIT ------------------ */
const bot = new Telegraf(BOT_TOKEN);

/* ------------------ DATABASE ------------------ */
const DB_FILE = "database.json";

function loadDB() {
    if (!fs.existsSync(DB_FILE)) {
        return { files: {}, users: [] };
    }
    return JSON.parse(fs.readFileSync(DB_FILE));
}

function saveDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

let db = loadDB();

/* ------------------ ADMIN SESSION ------------------ */
let adminLogged = false;

/* ------------------ /start ------------------ */
bot.start(async (ctx) => {
    const uid = ctx.chat.id;

    if (!db.users.includes(uid)) {
        db.users.push(uid);
        saveDB(db);
    }

    await ctx.reply(
        `👋 Welcome to *Pika Downloads Bot*!\n\nSend me a valid deep link to download your file.`,
        { parse_mode: "Markdown" }
    );
});

/* ------------------ /admin ------------------ */
bot.command("admin", async (ctx) => {
    if (ctx.chat.id !== ADMIN_ID) return;
    adminLogged = false;
    return ctx.reply("Enter admin password:");
});

/* ------------------ ADMIN PASSWORD LISTENER ------------------ */
bot.hears(/.+/, async (ctx, next) => {
    if (ctx.chat.id === ADMIN_ID && adminLogged === false) {
        if (ctx.message.text === ADMIN_PASS) {
            adminLogged = true;
            return ctx.reply("🔐 Admin Login Successful!");
        } else {
            return ctx.reply("❌ Wrong password.");
        }
    }
    return next();
});

/* ------------------ /upload ------------------ */
bot.command("upload", async (ctx) => {
    if (ctx.chat.id !== ADMIN_ID || !adminLogged) return;
    return ctx.reply("Send the file you want to upload:");
});

/* ------------------ HANDLE ANY FILE UPLOAD ------------------ */
bot.on("document", async (ctx) => {
    if (ctx.chat.id !== ADMIN_ID || !adminLogged) return;

    const fileId = ctx.message.document.file_id;
    const code = Math.random().toString(36).substring(2, 10);

    db.files[code] = {
        file_id: fileId,
        name: ctx.message.document.file_name,
        size: ctx.message.document.file_size
    };

    saveDB(db);

    return ctx.reply(
        `✅ File uploaded!\n\nUser download link:\nhttps://t.me/${BOT_USERNAME}?start=${code}`
    );
});

/* ------------------ FILE DELIVERY ------------------ */
bot.on("text", async (ctx, next) => {
    const text = ctx.message.text;

    if (text.startsWith("/start ")) {
        const code = text.split(" ")[1];

        if (db.files[code]) {
            const file = db.files[code];
            return ctx.replyWithDocument(file.file_id, {
                caption: `📥 *Your Download Is Ready!*\n\n📄 *File:* ${file.name}\n📦 *Size:* ${file.size} bytes`,
                parse_mode: "Markdown"
            });
        } else {
            return ctx.reply("❌ Invalid or expired link.");
        }
    }

    return next();
});

/* ------------------ TEXT ADS ------------------ */
bot.command("sendads", async (ctx) => {
    if (ctx.chat.id !== ADMIN_ID || !adminLogged) return;
    ctx.reply("Send ad message:");
    bot.once("text", async (msg) => {
        db.users.forEach((u) => bot.telegram.sendMessage(u, msg.message.text));
        msg.reply("📢 Ads sent!");
    });
});

/* ------------------ IMAGE ADS ------------------ */
bot.command("sendimgads", async (ctx) => {
    if (ctx.chat.id !== ADMIN_ID || !adminLogged) return;
    ctx.reply("Send image:");
    bot.once("photo", async (msg) => {
        const fileId = msg.message.photo.pop().file_id;
        db.users.forEach((u) => bot.telegram.sendPhoto(u, fileId));
        msg.reply("📢 Image ads sent!");
    });
});

/* ------------------ VIDEO ADS ------------------ */
bot.command("sendvidads", async (ctx) => {
    if (ctx.chat.id !== ADMIN_ID || !adminLogged) return;
    ctx.reply("Send video:");
    bot.once("video", async (msg) => {
        const fileId = msg.message.video.file_id;
        db.users.forEach((u) => bot.telegram.sendVideo(u, fileId));
        msg.reply("📢 Video ads sent!");
    });
});

/* ------------------ EXPRESS (Polling only) ------------------ */
app.get("/", (req, res) => res.send("Bot Running (Polling Mode)"));

app.listen(process.env.PORT || 8080, () => {
    console.log("HTTP server running.");
});

/* ------------------ START BOT (POLLING) ------------------ */
bot.launch();
console.log("Bot Started Successfully (Polling Mode).");
