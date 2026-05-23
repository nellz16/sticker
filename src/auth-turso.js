import { BufferJSON, initAuthCreds, proto } from "@whiskeysockets/baileys";
import { getKv, setKv, deleteKv, deleteKvPrefix } from "./db.js";

const SESSION_ID = process.env.SESSION_ID || "main";
const AUTH_PREFIX = `auth:${SESSION_ID}:`;

function authKey(key) {
  return `${AUTH_PREFIX}${key}`;
}

async function readData(key) {
  const raw = await getKv(authKey(key));
  if (!raw) return null;
  return JSON.parse(raw, BufferJSON.reviver);
}

async function writeData(key, data) {
  await setKv(authKey(key), JSON.stringify(data, BufferJSON.replacer));
}

async function removeData(key) {
  await deleteKv(authKey(key));
}

export async function clearAuthState() {
  await deleteKvPrefix(AUTH_PREFIX);
}

export async function useTursoAuthState() {
  const creds = (await readData("creds")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};

          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);

              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }

              data[id] = value;
            })
          );

          return data;
        },

        set: async (data) => {
          const tasks = [];

          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              const key = `${category}-${id}`;

              tasks.push(value ? writeData(key, value) : removeData(key));
            }
          }

          await Promise.all(tasks);
        }
      }
    },

    saveCreds: async () => {
      await writeData("creds", creds);
    }
  };
}
