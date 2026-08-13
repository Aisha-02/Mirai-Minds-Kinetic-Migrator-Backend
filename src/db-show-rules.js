import "dotenv/config";
import pg from "pg";
import { createPgConfig } from "./dbConfig.js";
import { toPersistableAiRules } from "./services/assembleRules.js";

async function main() {
  const limit = Number(process.argv[2] || 1);
  const config = await createPgConfig();
  if (typeof config.password === "function") {
    config.password = await config.password();
  }

  const client = new pg.Client(config);
  try {
    await client.connect();
    const result = await client.query(
      `SELECT id, business_object, rules, created_at
       FROM validation_rules
       ORDER BY created_at DESC
       LIMIT $1`,
      [Math.min(Math.max(limit, 1), 20)],
    );

    if (!result.rows.length) {
      console.log("No rows in validation_rules yet. Generate + Save from the Admin UI first.");
      return;
    }

    for (const row of result.rows) {
      const normalized = toPersistableAiRules(row.business_object, row.rules);

      console.log("=".repeat(72));
      console.log(`id: ${row.id}`);
      console.log(`business_object: ${row.business_object}`);
      console.log(`created_at: ${row.created_at?.toISOString?.() || row.created_at}`);
      console.log(`fields: ${normalized.fields.length}`);
      console.log("-".repeat(72));
      console.log(JSON.stringify(normalized, null, 2));
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
