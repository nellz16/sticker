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

const BUILD_VERSION = "7.0.0";
const PORT = Number(process.env.PORT || 8000);
const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const ADMIN_KEY = process.env.ADMIN_KEY;
const BOT_PHONE_NUMBER = cleanNumber(process.env.BOT_PHONE_NUMBER || "");
const OWNER_NUMBERS = (process.env.OWNER_NUMBERS || "")
  .split(",")
  .map(cleanNumber)
  .filter(Boolean);

const OWNER_LIDS = (process.env.OWNER_LIDS || "")
  .split(",")
  .map(cleanNumber)
  .filter(Boolean);

const ALLOW_ALL_PRIVATE = String(process.env.ALLOW_ALL_PRIVATE || "false").toLowerCase() === "true";

const PAIRING_DELAY_MS = Number(process.env.PAIRING_DELAY_MS || 5000);
const QR_WAIT_TIMEOUT_MS = Number(process.env.QR_WAIT_TIMEOUT_MS || 35000);
const WA_COUNTRY_CODE = process.env.WA_COUNTRY_CODE || "ID";
const WA_BROWSER = (process.env.WA_BROWSER || "ubuntu").toLowerCase();

const logger = pino({ level: LOG_LEVEL });

if (!ADMIN_KEY) throw new Error("Missing ADMIN_KEY");
if (!BOT_PHONE_NUMBER) throw new Error("Missing BOT_PHONE_NUMBER");

let sock = null;
let connecting = false;
let connectionState = "booting";
let lastDisconnectReason = "";
let lastDisconnectStatusCode = null;
let lastPairingCode = null;
let lastPairingAt = null;
let latestQr = null;
let latestQrAt = null;
let startedAt = new Date().toISOString();
let processedQueue = Promise.resolve();
let waiters = [];
let activePairingUntil = 0;

function cleanNumber(value) {
  return String(value).replace(/[^\d]/g, "");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function isPairingActive() {
  return Date.now() < activePairingUntil;
}

function markPairingActive(minutes = 4) {
  activePairingUntil = Date.now() + minutes * 60_000;
}

async function isRegisteredInDb() {
  try {
    const { state } = await useTursoAuthState();
    return Boolean(state?.creds?.registered);
  } catch {
    return false;
  }
}

function browserConfig() {
  if (WA_BROWSER === "windows") return Browsers.windows("Chrome");
  if (WA_BROWSER === "macos") return Browsers.macOS("Google Chrome");
  return Browsers.ubuntu("Chrome");
}

function getWaVersionFromEnv() {
  const raw = process.env.WA_VERSION || "";
  if (!raw.trim()) return null;

  const parts = raw.split(",").map((x) => Number(x.trim()));
  if (parts.length !== 3 || parts.some((x) => !Number.isInteger(x))) {
    throw new Error("Invalid WA_VERSION. Use format like: 2,3000,1035194821");
  }

  return parts;
}

async function getWaVersion() {
  const override = getWaVersionFromEnv();
  if (override) {
    return { version: override, isLatest: false, source: "env" };
  }

  try {
    const { version, isLatest } = await fetchLatestBaileysVersion();
    return { version, isLatest, source: "fetchLatestBaileysVersion" };
  } catch (error) {
    logger.warn({ error: String(error) }, "Failed to fetch latest Baileys version; using Baileys default.");
    return { version: undefined, isLatest: false, source: "default" };
  }
}

async function ensureSocket({ allowCreate = true } = {}) {
  if (sock && ["open", "connecting"].includes(connectionState)) return sock;
  if (!allowCreate) return null;
  return startSocket();
}

async function closeSocketOnly() {
  try {
    if (sock?.ws?.close) sock.ws.close();
  } catch {}

  sock = null;
  connecting = false;
  latestQr = null;
  latestQrAt = null;
}

async function restartSocket({ clearSession = false, forPairing = false } = {}) {
  await closeSocketOnly();

  if (clearSession) {
    await clearAuthState();
  }

  if (forPairing) {
    markPairingActive();
  }

  connectionState = forPairing ? "pairing_starting" : "restarting";
  return startSocket();
}

async function startSocket() {
  if (connecting) return sock;
  connecting = true;

  try {
    const { state, saveCreds } = await useTursoAuthState();
    const { version, isLatest, source } = await getWaVersion();

    logger.info(
      {
        buildVersion: BUILD_VERSION,
        version,
        isLatest,
        versionSource: source,
        browser: browserConfig(),
        registered: Boolean(state?.creds?.registered)
      },
      "Starting WhatsApp socket"
    );

    sock = makeWASocket({
      auth: state,
      logger,
      ...(version ? { version } : {}),
      browser: browserConfig(),
      countryCode: WA_COUNTRY_CODE,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60_000,
      keepAliveIntervalMs: 20_000,
      defaultQueryTimeoutMs: 60_000,
      retryRequestDelayMs: 2000,
      maxMsgRetryCount: 3,
      getMessage: async () => undefined
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr, isNewLogin } = update;

      if (connection) {
        connectionState = connection;
        notifyWaiters();
      }

      if (qr) {
        latestQr = qr;
        latestQrAt = new Date().toISOString();
        markPairingActive();
        logger.info("New QR received");
        notifyWaiters();
      }

      if (isNewLogin) {
        logger.info("New login detected; waiting for forced reconnect/open.");
        markPairingActive();
      }

      if (connection === "open") {
        latestQr = null;
        latestQrAt = null;
        activePairingUntil = 0;
        lastDisconnectReason = "";
        lastDisconnectStatusCode = null;
        logger.info("WhatsApp connected");
        await logEvent("connection", "open");
      }

      if (connection === "close") {
        latestQr = null;
        latestQrAt = null;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        lastDisconnectStatusCode = statusCode || null;
        lastDisconnectReason = String(statusCode || lastDisconnect?.error || "unknown");
        logger.warn({ statusCode, error: String(lastDisconnect?.error) }, "WhatsApp disconnected");

        await logEvent("connection_close", lastDisconnectReason);

        const status = statusCode;
        const replacedByAnotherConnection =
          status === DisconnectReason.connectionReplaced ||
          status === 440 ||
          String(lastDisconnect?.error || "").toLowerCase().includes("conflict");

        const hardInvalid =
          status === DisconnectReason.loggedOut ||
          status === 401;

        const shouldReconnect =
          status === DisconnectReason.restartRequired ||
          status === 515 ||
          (
            !hardInvalid &&
            !replacedByAnotherConnection &&
            (
              await isRegisteredInDb() ||
              isPairingActive()
            )
          );

        sock = null;
        connecting = false;
        notifyWaiters();

        if (replacedByAnotherConnection) {
          logger.warn("Connection was replaced by another active instance. This is normal during Koyeb redeploy; auth state is kept intact.");
          connectionState = "replaced_by_another_instance";
          activePairingUntil = 0;
          return;
        }

        if (hardInvalid) {
          logger.error("Auth/session logged out. Clearing auth state. Use /pair?fresh=1 or /qr?fresh=1.");
          await clearAuthState().catch((err) => logger.error(err, "failed to clear invalid auth state"));
          connectionState = "auth_cleared";
          activePairingUntil = 0;
          return;
        }

        if (shouldReconnect) {
          const reconnectDelay = status === DisconnectReason.restartRequired || status === 515 ? 1500 : 5000;
          setTimeout(() => {
            startSocket().catch((err) => logger.error(err, "reconnect failed"));
          }, reconnectDelay);
          return;
        }

        connectionState = "unpaired_idle";
        logger.info("No valid session and no active pairing window; staying idle until /pair or /qr.");
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

async function waitForPairingSignal(timeoutMs = QR_WAIT_TIMEOUT_MS) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (latestQr || connectionState === "connecting" || connectionState === "open") return true;

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

async function requestPairingCode({ fresh = false } = {}) {
  markPairingActive();

  if (fresh) {
    await restartSocket({ clearSession: true, forPairing: true });
  } else {
    await ensureSocket();
  }

  if (!sock) throw new Error("Socket is not ready");
  if (sock.authState.creds.registered || connectionState === "open") {
    return { registered: true, code: null };
  }

  const ready = await waitForPairingSignal(QR_WAIT_TIMEOUT_MS);
  if (!ready) {
    throw new Error("Socket not ready for pairing. Try /restart then /pair?fresh=1, or use /qr?fresh=1.");
  }

  if (!sock) throw new Error("Socket closed before requesting pairing code");

  // Workaround for Baileys v7 pairing race:
  // wait after connecting/QR before requestPairingCode().
  await delay(PAIRING_DELAY_MS);

  if (!sock || connectionState === "close" || connectionState === "auth_cleared") {
    throw new Error("Socket closed during pairing delay. Try /pair?fresh=1 again.");
  }

  const code = await sock.requestPairingCode(BOT_PHONE_NUMBER);
  lastPairingCode = code;
  lastPairingAt = new Date().toISOString();

  await logEvent("pairing_code", "Pairing code generated");
  return { registered: false, code };
}

async function getQrDataUrl({ fresh = false } = {}) {
  markPairingActive();

  if (fresh) {
    await restartSocket({ clearSession: true, forPairing: true });
  } else {
    await ensureSocket();
  }

  if (connectionState === "open") return null;

  const ready = await waitForPairingSignal(QR_WAIT_TIMEOUT_MS);
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

function normalizeAnyJid(jid) {
  if (!jid || typeof jid !== "string") return "";
  try {
    return jidNormalizedUser(jid);
  } catch {
    return jid;
  }
}

function idPartFromJid(jid) {
  const normalized = normalizeAnyJid(jid);
  return normalized.split("@")[0].split(":")[0].replace(/[^\d]/g, "");
}

function jidType(jid) {
  const normalized = normalizeAnyJid(jid);
  if (normalized.endsWith("@s.whatsapp.net")) return "pn";
  if (normalized.endsWith("@lid")) return "lid";
  if (normalized.endsWith("@g.us")) return "group";
  return "unknown";
}

function collectCandidateJids(msg) {
  const key = msg?.key || {};
  const candidates = [
    key.remoteJid,
    key.participant,
    key.remoteJidAlt,
    key.participantAlt,
    key.senderPn,
    key.senderLid
  ].filter(Boolean);

  return [...new Set(candidates.map(normalizeAnyJid).filter(Boolean))];
}

function getSenderIdentity(msg) {
  const jids = collectCandidateJids(msg);
  const pnJids = jids.filter((jid) => jidType(jid) === "pn");
  const lidJids = jids.filter((jid) => jidType(jid) === "lid");

  return {
    jids,
    pnNumbers: pnJids.map(idPartFromJid).filter(Boolean),
    lidIds: lidJids.map(idPartFromJid).filter(Boolean)
  };
}

function isAllowedMessage(msg) {
  if (ALLOW_ALL_PRIVATE) return true;
  if (OWNER_NUMBERS.length === 0 && OWNER_LIDS.length === 0) return true;

  const identity = getSenderIdentity(msg);

  const pnAllowed = identity.pnNumbers.some((number) => OWNER_NUMBERS.includes(number));
  const lidAllowed = identity.lidIds.some((lid) => OWNER_LIDS.includes(lid));

  return pnAllowed || lidAllowed;
}

function ownerHint(msg) {
  const identity = getSenderIdentity(msg);
  const lines = [
    "Sender belum masuk whitelist OWNER_NUMBERS/OWNER_LIDS.",
    "",
    `Detected JIDs: ${identity.jids.join(", ") || "-"}`,
    `Detected PN numbers: ${identity.pnNumbers.join(", ") || "-"}`,
    `Detected LID IDs: ${identity.lidIds.join(", ") || "-"}`,
    "",
    "Tambahkan LID yang sesuai ke environment variable Koyeb:",
    `OWNER_LIDS=${identity.lidIds.join(",") || "ISI_LID_DI_SINI"}`,
    "",
    "Lalu redeploy."
  ];

  return lines.join("\\n");
}

async function handleIncomingMessage(msg) {
  if (!msg?.message || msg.key?.fromMe) return;

  const jid = msg.key.remoteJid;
  if (!jid || jid.endsWith("@g.us") || jid === "status@broadcast") return;

  const content = getReadableContent(msg);

  const text =
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.documentMessage?.caption ||
    "";

  if (text.trim().toLowerCase() === "/whoami") {
    await sock.sendMessage(jid, { text: ownerHint(msg) }, { quoted: msg });
    return;
  }

  if (!isAllowedMessage(msg)) {
    logger.warn({ jid, identity: getSenderIdentity(msg) }, "Ignoring non-owner sender");
    return;
  }

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
    "Command:",
    "/status = cek status bot",
    "/whoami = lihat ID pengirim untuk whitelist OWNER_LIDS",
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
    `build: ${BUILD_VERSION}`,
    `state: ${connectionState}`,
    `started: ${startedAt}`,
    `last disconnect: ${lastDisconnectReason || "-"}`,
    `memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`
  ].join("\n");
}

function publicStatus() {
  return {
    ok: true,
    buildVersion: BUILD_VERSION,
    state: connectionState,
    startedAt,
    lastDisconnectReason: lastDisconnectReason || null,
    lastDisconnectStatusCode,
    lastPairingAt,
    hasQr: Boolean(latestQr),
    latestQrAt,
    pairingDelayMs: PAIRING_DELAY_MS,
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    ownerNumbersConfigured: OWNER_NUMBERS.length,
    ownerLidsConfigured: OWNER_LIDS.length,
    allowAllPrivate: ALLOW_ALL_PRIVATE
  };
}


async function gracefulShutdown(signal) {
  logger.warn({ signal }, "Graceful shutdown requested. Closing socket without logging out or clearing auth.");
  try {
    if (sock?.ws?.close) sock.ws.close();
  } catch (error) {
    logger.warn({ error: String(error) }, "Error while closing socket during shutdown");
  }

  setTimeout(() => process.exit(0), 500).unref();
}

process.once("SIGTERM", () => {
  gracefulShutdown("SIGTERM").catch(() => process.exit(0));
});

process.once("SIGINT", () => {
  gracefulShutdown("SIGINT").catch(() => process.exit(0));
});

async function main() {
  await initDb();

  if (await isRegisteredInDb()) {
    connectionState = "registered_starting";
    await startSocket();
  } else {
    connectionState = "unpaired_idle";
    logger.info({ buildVersion: BUILD_VERSION }, "No registered session. Socket will start only when /pair or /qr is opened.");
  }

  const app = express();
  app.use(express.json());

  app.get("/", (req, res) => {
    res.type("html").send(`
      <html>
        <head><title>WA Sticker Bot</title></head>
        <body style="font-family: system-ui; max-width: 760px; margin: 40px auto; line-height: 1.6;">
          <h1>WA Sticker Bot</h1>
          <p>Build: <b>${BUILD_VERSION}</b></p>
          <p>Status: <b>${connectionState}</b></p>
          <p>Health: <a href="/health">/health</a></p>
          <p>Pairing code fresh: <code>/pair?key=ADMIN_KEY&fresh=1</code></p>
          <p>QR fresh: <code>/qr?key=ADMIN_KEY&fresh=1</code></p>
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
      const result = await requestPairingCode({ fresh: req.query.fresh === "1" });

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
        pairingDelayMs: PAIRING_DELAY_MS,
        expiresHint: "Masukkan kode ini secepatnya di WhatsApp > Perangkat tertaut > Tautkan dengan nomor telepon."
      });
    } catch (error) {
      logger.error(error, "pairing code failed");
      res.status(500).json({
        ok: false,
        error: String(error?.message || error),
        suggestion: "Call /pair?key=ADMIN_KEY&fresh=1 once. If it still fails, try /qr?key=ADMIN_KEY&fresh=1 from a second screen."
      });
    }
  });

  app.get("/qr", async (req, res) => {
    if (!isAdmin(req)) return res.status(401).send("Unauthorized");

    try {
      const dataUrl = await getQrDataUrl({ fresh: req.query.fresh === "1" });

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
            <meta http-equiv="refresh" content="25">
          </head>
          <body style="font-family: system-ui; max-width: 720px; margin: 32px auto; text-align: center; line-height: 1.5;">
            <h1>Scan QR WhatsApp</h1>
            <p>QR akan refresh otomatis tiap 25 detik. Scan dari layar kedua lebih stabil.</p>
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
            <p>Coba refresh halaman, atau buka <code>/qr?key=ADMIN_KEY&fresh=1</code>.</p>
          </body>
        </html>
      `);
    }
  });

  app.post("/restart", async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: "Unauthorized" });

    try {
      await restartSocket({ clearSession: false, forPairing: false });
      res.json({ ok: true, message: "Socket restarted. Wait a few seconds, then open /pair?fresh=1 or /qr?fresh=1." });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.post("/reset-auth", async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: "Unauthorized" });

    try {
      await closeSocketOnly();
      await clearAuthState();
      connectionState = "unpaired_idle";
      activePairingUntil = 0;
      res.json({ ok: true, message: "Auth state cleared. Open /pair?fresh=1 or /qr?fresh=1." });
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
      await closeSocketOnly();
      await clearAuthState();
      connectionState = "unpaired_idle";
      activePairingUntil = 0;
      res.json({ ok: true, message: "Logged out and session cleared. Open /pair?fresh=1 or /qr?fresh=1." });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error?.message || error) });
    }
  });

  app.listen(PORT, "0.0.0.0", () => {
    logger.info({ buildVersion: BUILD_VERSION, port: PORT }, "HTTP server listening");
  });
}

main().catch((error) => {
  logger.fatal(error, "Fatal startup error");
  process.exit(1);
});
