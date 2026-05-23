import "dotenv/config";
import express from "express";
import pino from "pino";
import QRCode from "qrcode";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
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
let latestQr = null;
let latestQrAt = null;
let startedAt = new Date().toISOString();
let processedQueue = Promise.resolve();
let waiters = [];

function cleanNumber(value) {
  return String(value).replace(/[^\d]/g, "");
}

function isAdmin(req) {
  return req.query.key && req.query.key === ADMIN_KEY;
}

function notifyWaiters() {
  const all = waiters;
  waiters = [];
  for (const resolve of all) resolve();
}

function enqueue(task) {
  const run = processedQueue.then(task, task);
  processedQueue = run.catch(() => {});
  return run;
}

async function ensureFreshSocket() {
  if (sock && ["open", "connecting"].includes(connectionState)) return sock;
  return restartSocket({ clearSession: false });
}

async function restartSocket({ clearSession = false } = {}) {
  try {
    if (sock?.ws?.close) sock.ws.close();
  } catch {}

  if (clearSession) {
    await clearAuthState();
  }

  sock = null;
  connecting = false;
  latestQr = null;
  latestQrAt = null;
  connectionState = "restarting";

  return startSocket();
}

async function startSocket() {
  if (connecting) return sock;
  connecting = true;

  try {
    const { state, saveCreds } = await useTursoAuthState();
    const { version, isLatest } = await fetchLatestBaileysVersion().catch((error) => {
      logger.warn({ error: String(error) }, "Failed to fetch latest Baileys version; using default.");
      return { version: undefined, isLatest: false };
    });

    logger.info({ version, isLatest }, "Starting WhatsApp socket");

    sock = makeWASocket({
      auth: state,
      logger,
      ...(version ? { version } : {}),
      browser: Browsers.macOS("Google Chrome"),
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
      const { connection, lastDisconnect, qr } = update;

      if (connection) {
        connectionState = connection;
        notifyWaiters();
      }

      if (qr) {
        latestQr = qr;
        latestQrAt = new Date().toISOString();
        logger.info("New QR received");
        notifyWaiters();
      }

      if (connection === "open") {
        latestQr = null;
        latestQrAt = null;
        lastDisconnectReason = "";
        logger.info("WhatsApp connected");
        await logEvent("connection", "open");
      }

      if (connection === "close") {
        latestQr = null;
        latestQrAt = null;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        lastDisconnectReason = String(statusCode || lastDisconnect?.error || "unknown");
        logger.warn({ statusCode, error: String(lastDisconnect?.error) }, "WhatsApp disconnected");

        await logEvent("connection_close", lastDisconnectReason);

        const shouldReconnect =
          statusCode !== DisconnectReason.loggedOut &&
          statusCode !== DisconnectReason.connectionReplaced &&
          statusCode !== 401 &&
          statusCode !== 440;

        // This makes old closed sockets unusable for /pair and /qr.
        sock = null;
        connecting = false;
        notifyWaiters();

        if (shouldReconnect) {
          setTimeout(() => {
            startSocket().catch((err) => logger.error(err, "reconnect failed"));
          }, 2_000);
        } else {
          logger.error("Session logged out/replaced. Clear session and pair again if needed.");
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

async function waitForPairingReady(timeoutMs = 25_000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (latestQr || connectionState === "connecting") return true;
    if (connectionState === "open") return true;

    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 500);
      waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  return false;
}

async function requestPairingCode() {
  await ensureFreshSocket();

  if (!sock) throw new Error("Socket is not ready");
  if (sock.authState.creds.registered || connectionState === "open") {
    return { registered: true, code: null };
  }

  const ready = await waitForPairingReady(25_000);
  if (!ready) {
    throw new Error("Socket not ready for pairing. Try /restart then /pair again, or use /qr.");
  }

  if (!sock) throw new Error("Socket closed before requesting pairing code");

  const code = await sock.requestPairingCode(BOT_PHONE_NUMBER);
  lastPairingCode = code;
  lastPairingAt = new Date().toISOString();

  await logEvent("pairing_code", "Pairing code generated");
  return { registered: false, code };
}

async function getQrDataUrl() {
  await ensureFreshSocket();

  if (connectionState === "open") return null;

  const ready = await waitForPairingReady(25_000);
  if (!ready || !latestQr) {
    throw new Error("QR not ready yet. Refresh this endpoint in a few seconds or call /restart.");
  }

  return QRCode.toDataURL(latestQr, {
    errorCorrectionLevel: "M",
    margin: 2,
    scale: 8
  });
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
    hasQr: Boolean(latestQr),
    latestQrAt,
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
          <p>Pairing code: <code>/pair?key=ADMIN_KEY</code></p>
          <p>QR fallback: <code>/qr?key=ADMIN_KEY</code></p>
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
        error: String(error?.message || error),
        suggestion: "Call POST /restart?key=ADMIN_KEY, wait 5 seconds, then try /pair again. If it still fails, use /qr."
      });
    }
  });

  app.get("/qr", async (req, res) => {
    if (!isAdmin(req)) return res.status(401).send("Unauthorized");

    try {
      const dataUrl = await getQrDataUrl();

      if (!dataUrl) {
        return res.type("html").send(`
          <html>
            <body style="font-family: system-ui; max-width: 720px; margin: 40px auto;">
              <h1>Already connected</h1>
              <p>WhatsApp state is <b>${connectionState}</b>.</p>
            </body>
          </html>
        `);
      }

      res.type("html").send(`
        <html>
          <head>
            <title>WA Sticker Bot QR</title>
            <meta name="viewport" content="width=device-width, initial-scale=1" />
          </head>
          <body style="font-family: system-ui; max-width: 720px; margin: 32px auto; text-align: center; line-height: 1.5;">
            <h1>Scan QR WhatsApp</h1>
            <p>QR ini cepat kedaluwarsa. Kalau gagal, refresh halaman.</p>
            <img src="${dataUrl}" style="width: min(88vw, 420px); height: auto; image-rendering: pixelated;" />
            <p><small>State: ${connectionState} | QR at: ${latestQrAt || "-"}</small></p>
          </body>
        </html>
      `);
    } catch (error) {
      logger.error(error, "qr failed");
      res.status(500).type("html").send(`
        <html>
          <body style="font-family: system-ui; max-width: 720px; margin: 40px auto;">
            <h1>QR belum siap</h1>
            <pre>${String(error?.message || error)}</pre>
            <p>Coba refresh halaman, atau panggil POST /restart?key=ADMIN_KEY.</p>
          </body>
        </html>
      `);
    }
  });

  app.post("/restart", async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: "Unauthorized" });

    try {
      await restartSocket({ clearSession: false });
      res.json({ ok: true, message: "Socket restarted. Wait a few seconds, then open /pair or /qr." });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.post("/logout", async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: "Unauthorized" });

    try {
      if (sock?.logout) {
        await sock.logout().catch(() => {});
      }
      await restartSocket({ clearSession: true });
      res.json({ ok: true, message: "Session cleared. Wait a few seconds, then open /pair or /qr." });
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
