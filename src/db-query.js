import "dotenv/config";
import pg from "pg";
import { createPgConfig } from "./dbConfig.js";

const sql =
  process.argv.slice(2).join(" ") ||
  "SELECT id, email, created_at FROM users ORDER BY created_at DESC;";

function printRows(rows) {
  // Pretty-print full JSON so jsonb columns are not shown as [object Object]
  console.log(JSON.stringify(rows, null, 2));
}

async function main() {
  const config = await createPgConfig();
  if (typeof config.password === "function") {
    config.password = await config.password();
  }

  const client = new pg.Client(config);
  try {
    await client.connect();
    const result = await client.query(sql);
    if (result.rows?.length) {
      printRows(result.rows);
      console.log(`\n(${result.rowCount} row(s))`);
    } else {
      console.log(result.command || "OK", `(${result.rowCount ?? 0} rows)`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
