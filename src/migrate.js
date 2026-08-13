import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import { createPgConfig } from "./dbConfig.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "..", "sql", "migrations");

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    return [];
  }

  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d+_.+\.sql$/i.test(name))
    .sort();
}

async function migrate() {
  let client;

  try {
    const config = await createPgConfig();
    if (typeof config.password === "function") {
      config.password = await config.password();
    }

    client = new pg.Client(config);
    await client.connect();

    await ensureMigrationsTable(client);

    const applied = await client.query(
      `SELECT id FROM schema_migrations ORDER BY id`,
    );
    const appliedIds = new Set(applied.rows.map((row) => row.id));

    const files = listMigrationFiles();
    if (files.length === 0) {
      console.log("No migration files found in sql/migrations.");
      return;
    }

    let ran = 0;

    for (const file of files) {
      if (appliedIds.has(file)) {
        console.log(`skip  ${file}`);
        continue;
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migrations (id) VALUES ($1)`,
          [file],
        );
        await client.query("COMMIT");
        console.log(`apply ${file}`);
        ran += 1;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }

    if (ran === 0) {
      console.log("Schema is up to date.");
    } else {
      console.log(`Applied ${ran} migration(s).`);
    }
  } catch (err) {
    console.error("Failed to apply migrations:", err.message);
    process.exitCode = 1;
  } finally {
    if (client) {
      await client.end().catch(() => {});
    }
  }
}

migrate();
