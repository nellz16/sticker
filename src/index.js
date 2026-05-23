import "dotenv/config";
import express from "express";
import pino from "pino";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  jidNormalizedUser,
  normalizeMessageContent
} from "baileys";

import { initDb, logEvent } from "./db.js";
import { useTursoAuthState, clearAuthState } from "./auth-turso.js";
import { makeSticker, parseStickerOptions } from "./sticker.js";

const PORT = Number(process.env.PORT || 8000);
const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const ADMIN_KEY = process.env.ADMIN_KEY;
const BOT_PHONE_NUMBER = cleanNumber(process.env.BOT_PHONE_NUMBER || "");
const OWNER_NUMBERS = (process.env.OWNER_NUMBERS || "")
  .split(",")
  .map(cleanNumber)
  .filter(Boolean);

const logger = pino({ level: LOG_LEVEL });

if (!ADMIN_KEY) throw new Error("Missing ADMIN_KEY");
if (!BOT_PHONE_NUMBER) throw new Error("Missing BOT_PHONE_NUMBER");

let sock = null;
let connecting = false;
let connectionState = "init";
let lastDisconnectReason = "";
let lastPairingCode = null;
let lastPairingAt = null;
let startedAt = new Date().toISOString();
let processedQueue = Promise.resolve();

function cleanNumber(value) {
  return String(value).replace(/[^\d]/g, "");
}

function isAdmin(req) {
  return req.query.key && req.query.key === ADMIN_KEY;
}

function enqueue(task) {
  const run = processedQueue.then(task, task);
  processedQueue = run.catch(() => {});
  return run;
}

async function startSocket() {
  if (connecting) return sock;
  connecting = true;

  try {
    const { state, saveCreds } = await useTursoAuthState();

    sock = makeWASocket({
      auth: state,
      logger,
      browser: Browsers.macOS("Google Chrome"),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60_000,
      keepAliveIntervalMs: 20_000,
      defaultQueryTimeoutMs: 60_000,
      getMessage: async () => undefined
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection) connectionState = connection;

      if (connection === "open") {
        lastDisconnectReason = "";
        logger.info("WhatsApp connected");
        await logEvent("connection", "open");
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        lastDisconnectReason = String(statusCode || lastDisconnect?.error || "unknown");
        logger.warn({ statusCode, error: String(lastDisconnect?.error) }, "WhatsApp disconnected");

        await logEvent("connection_close", lastDisconnectReason);

        const shouldReconnect =
          statusCode !== DisconnectReason.loggedOut &&
          statusCode !== DisconnectReason.connectionReplaced;
        if (shouldReconnect) {
          setTimeout(() => {
            connecting = false;
            startSocket().catch((err) => logger.error(err, "reconnect failed"));
          }, 5_000);
        } else {
          logger.error("Session logged out/replaced. Clear session and pair again.");
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        enqueue(() => handleIncomingMessage(msg)).catch((err) => {
          logger.error(err, "message handling failed");
        });
      }
    });

    return sock;
  } finally {
    connecting = false;
  }
}

async function requestPairingCode() {
  if (!sock) await startSocket();

  if (sock.authState.creds.registered) {
    return { registered: true, code: null };
  }

  await waitForSocketBeforePairing(12_000);

  const code = await sock.requestPairingCode(BOT_PHONE_NUMBER);
  lastPairingCode = code;
  lastPairingAt = new Date().toISOString();

  await logEvent("pairing_code", "Pairing code generated");
  return { registered: false, code };
}

async function waitForSocketBeforePairing(timeoutMs) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (!sock) break;
    if (connectionState === "connecting" || connectionState === "open") return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function getReadableContent(message) {
  const normalized = normalizeMessageContent(message?.message);
  return normalized || {};
}

function getPrivateNumberFromJid(jid) {
  const normalized = jidNormalizedUser(jid || "");
  if (!normalized.endsWith("@s.whatsapp.net")) return "";
  return normalized.split("@")[0].split(":")[0];
}

function isAllowedSender(jid) {
  if (OWNER_NUMBERS.length === 0) return true;
  const number = getPrivateNumberFromJid(jid);
  return OWNER_NUMBERS.includes(number);
}

async function handleIncomingMessage(msg) {
  if (!msg?.message || msg.key?.fromMe) return;

  const jid = msg.key.remoteJid;
  if (!jid || jid.endsWith("@g.us") || jid === "status@broadcast") return;

  if (!isAllowedSender(jid)) {
    logger.warn({ jid }, "Ignoring non-owner sender");
    return;
  }

  const content = getReadableContent(msg);

  const text =
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.documentMessage?.caption ||
    "";

  if (text.trim().toLowerCase() === "/help") {
    await sock.sendMessage(jid, { text: helpText() }, { quoted: msg });
    return;
  }

  if (text.trim().toLowerCase() === "/status") {
    await sock.sendMessage(jid, { text: statusText() }, { quoted: msg });
    return;
  }

  const imageMessage = content.imageMessage;
  const documentMessage = content.documentMessage;
  const isImageDocument = documentMessage?.mimetype?.startsWith("image/");

  if (!imageMessage && !isImageDocument) {
    await sock.sendMessage(jid, { text: helpText() }, { quoted: msg });
    return;
  }

  await sock.sendPresenceUpdate("composing", jid);

  const mediaBuffer = await downloadMediaMessage(
    msg,
    "buffer",
    {},
    {
      logger,
      reuploadRequest: sock.updateMediaMessage
    }
  );

  const caption = imageMessage?.caption || documentMessage?.caption || "";
  const options = parseStickerOptions(caption);
  const result = await makeSticker(mediaBuffer, options);

  await sock.sendMessage(
    jid,
    {
      sticker: result.buffer
    },
    { quoted: msg }
  );

  await logEvent("sticker_sent", `${result.bytes} bytes, q=${result.quality}, box=${result.boxSize}`);
}

function helpText() {
  return [
    "Kirim gambar/foto, nanti aku balas sebagai sticker.",
    "",
    "Caption opsional:",
    "contain = gambar utuh, default",
    "cover   = crop penuh 512x512",
    "text    = bagus untuk screenshot/tulisan",
    "icon    = bagus untuk logo/icon",
    "photo   = bagus untuk foto",
    "pixel   = pixel art biar tidak blur",
    "white   = background putih",
    "nopad   = minim padding",
    "",
    "Contoh caption: text nopad"
  ].join("\n");
}

function statusText() {
  return [
    `state: ${connectionState}`,
    `started: ${startedAt}`,
    `last disconnect: ${lastDisconnectReason || "-"}`,
    `memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`
  ].join("\n");
}

function publicStatus() {
  return {
    ok: true,
    state: connectionState,
    startedAt,
    lastDisconnectReason: lastDisconnectReason || null,
    lastPairingAt,
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024)
  };
}

async function main() {
  await initDb();
  await startSocket();

  const app = express();
  app.use(express.json());

  app.get("/", (req, res) => {
    res.type("html").send(`
      <html>
        <head><title>WA Sticker Bot</title></head>
        <body style="font-family: system-ui; max-width: 760px; margin: 40px auto; line-height: 1.6;">
          <h1>WA Sticker Bot</h1>
          <p>Status: <b>${connectionState}</b></p>
          <p>Health: <a href="/health">/health</a></p>
          <p>Pairing: <code>/pair?key=ADMIN_KEY</code></p>
        </body>
      </html>
    `);
  });

  app.get("/health", (req, res) => {
    res.json(publicStatus());
  });

  app.get("/status", (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: "Unauthorized" });
    res.json(publicStatus());
  });

  app.get("/pair", async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: "Unauthorized" });

    try {
      const result = await requestPairingCode();

      if (result.registered) {
        return res.json({
          ok: true,
          registered: true,
          message: "Already paired. No pairing code needed."
        });
      }

      res.json({
        ok: true,
        registered: false,
        pairingCode: result.code,
        phoneNumber: BOT_PHONE_NUMBER,
        expiresHint: "Masukkan kode ini secepatnya di WhatsApp > Perangkat tertaut > Tautkan dengan nomor telepon."
      });
    } catch (error) {
      logger.error(error, "pairing code failed");
      res.status(500).json({
        ok: false,
        error: String(error?.message || error)
      });
    }
  });

  app.post("/logout", async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: "Unauthorized" });

    try {
      if (sock?.logout) {
        await sock.logout().catch(() => {});
      }
      await clearAuthState();
      sock = null;
      connectionState = "logged_out";
      res.json({ ok: true, message: "Session cleared. Restart service, then open /pair again." });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.listen(PORT, "0.0.0.0", () => {
    logger.info({ port: PORT }, "HTTP server listening");
  });
}

main().catch((error) => {
  logger.fatal(error, "Fatal startup error");
  process.exit(1);
});
