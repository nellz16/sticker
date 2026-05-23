import { createClient } from "@libsql/client";

const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!TURSO_DATABASE_URL || !TURSO_AUTH_TOKEN) {
  throw new Error("Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN");
}

export const db = createClient({
  url: TURSO_DATABASE_URL,
  authToken: TURSO_AUTH_TOKEN
});

export async function initDb() {
  await db.batch(
    [
      `CREATE TABLE IF NOT EXISTS bot_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )`,
      `CREATE TABLE IF NOT EXISTS bot_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        message TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )`,
      `CREATE TABLE IF NOT EXISTS bot_owners (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK(type IN ('pn', 'lid')),
        value TEXT NOT NULL,
        label TEXT,
        source TEXT NOT NULL DEFAULT 'command',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(type, value)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_bot_events_created_at ON bot_events(created_at)`
    ],
    "write"
  );
}

export async function getKv(key) {
  const result = await db.execute({
    sql: "SELECT value FROM bot_kv WHERE key = ?",
    args: [key]
  });

  return result.rows[0]?.value ?? null;
}

export async function setKv(key, value) {
  await db.execute({
    sql: `INSERT INTO bot_kv (key, value, updated_at)
          VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at`,
    args: [key, value]
  });
}

export async function deleteKv(key) {
  await db.execute({
    sql: "DELETE FROM bot_kv WHERE key = ?",
    args: [key]
  });
}

export async function deleteKvPrefix(prefix) {
  await db.execute({
    sql: "DELETE FROM bot_kv WHERE key LIKE ?",
    args: [`${prefix}%`]
  });
}

export async function logEvent(type, message = "") {
  try {
    await db.execute({
      sql: "INSERT INTO bot_events (type, message) VALUES (?, ?)",
      args: [type, String(message).slice(0, 1000)]
    });
  } catch {
    // Logging should never crash the bot.
  }
}


export async function addOwner(type, value, label = "", source = "command") {
  const cleanType = type === "lid" ? "lid" : "pn";
  const cleanValue = String(value || "").replace(/[^\d]/g, "");
  if (!cleanValue) throw new Error("Owner value is empty");

  await db.execute({
    sql: `INSERT INTO bot_owners (type, value, label, source)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(type, value) DO UPDATE SET
            label = excluded.label,
            source = excluded.source`,
    args: [cleanType, cleanValue, label || null, source]
  });

  return { type: cleanType, value: cleanValue, label, source };
}

export async function removeOwner(type, value) {
  const cleanType = type === "lid" ? "lid" : "pn";
  const cleanValue = String(value || "").replace(/[^\d]/g, "");
  const result = await db.execute({
    sql: "DELETE FROM bot_owners WHERE type = ? AND value = ?",
    args: [cleanType, cleanValue]
  });

  return result.rowsAffected || 0;
}

export async function listOwners() {
  const result = await db.execute({
    sql: "SELECT type, value, label, source, created_at FROM bot_owners ORDER BY id ASC",
    args: []
  });

  return result.rows.map((row) => ({
    type: row.type,
    value: row.value,
    label: row.label,
    source: row.source,
    created_at: row.created_at
  }));
}

export async function isDbOwner(type, value) {
  const cleanType = type === "lid" ? "lid" : "pn";
  const cleanValue = String(value || "").replace(/[^\d]/g, "");
  if (!cleanValue) return false;

  const result = await db.execute({
    sql: "SELECT 1 FROM bot_owners WHERE type = ? AND value = ? LIMIT 1",
    args: [cleanType, cleanValue]
  });

  return Boolean(result.rows[0]);
}
