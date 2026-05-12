/**
 * Quick DATABASE_URL connectivity check for PostgreSQL (Coolify / Docker).
 * Usage: node --env-file=.env scripts/check-db-connection.js
 */
const { ensureDatabaseUrl } = require("../database-url.js");
ensureDatabaseUrl();

async function main() {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) {
    console.error("DATABASE_URL is not set (and DB_HOST/DB_USER/DB_DATABASE could not build one).");
    process.exit(1);
  }
  if (!/^postgres(ql)?:\/\//i.test(raw)) {
    console.error("DATABASE_URL must be a postgresql:// connection string.");
    process.exit(1);
  }
  const { Client } = require("pg");
  const client = new Client({ connectionString: raw });
  try {
    await client.connect();
    const { rows } = await client.query("SELECT current_database() AS db, current_schema() AS schema, NOW() AS now");
    console.log("OK:", rows[0]);
  } catch (e) {
    console.error("Connection failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
