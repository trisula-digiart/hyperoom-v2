import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

function makePool(database: string): pg.Pool {
  return new Pool({
    host: config.pg.host,
    port: config.pg.port,
    user: config.pg.user,
    password: config.pg.password,
    database,
    max: 5,
    idleTimeoutMillis: 30000,
  });
}

export const pools = {
  core: makePool(config.pg.databases.core),
  chat: makePool(config.pg.databases.chat),
  storage: makePool(config.pg.databases.storage),
};

export async function checkZone(zone: keyof typeof pools): Promise<{ zone: string; status: "CONNECTED" | "FAILED"; detail?: string }> {
  try {
    const r = await pools[zone].query("SELECT 1");
    return r.rows[0]["?column?"] === 1
      ? { zone, status: "CONNECTED" }
      : { zone, status: "FAILED", detail: "unexpected response" };
  } catch (err) {
    return { zone, status: "FAILED", detail: (err as Error).message };
  }
}