import pg from "pg";
import { createPgConfig } from "./dbConfig.js";

const { Pool } = pg;

let poolPromise;

async function getPool() {
  if (!poolPromise) {
    poolPromise = createPgConfig().then((config) => new Pool(config));
  }
  return poolPromise;
}

export async function query(text, params) {
  const pool = await getPool();
  return pool.query(text, params);
}

export async function getClient() {
  const pool = await getPool();
  return pool.connect();
}
