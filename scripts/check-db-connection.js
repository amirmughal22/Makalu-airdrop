/**
 * Usage (from project root): node --env-file=.env scripts/check-db-connection.js
 * Checks DATABASE_URL built from DB_* vars (same as the app).
 */
const mysql = require("mysql2/promise");
const { ensureDatabaseUrl } = require("../database-url.js");

ensureDatabaseUrl();
const raw = process.env.DATABASE_URL?.trim();
if (!raw) {
  console.error("FAIL: DATABASE_URL missing — set DB_HOST, DB_USER, DB_DATABASE (and DB_PASSWORD if needed).");
  process.exit(1);
}

async function main() {
  const normalized = raw.replace(/^mysql:\/\//i, "http://");
  const u = new URL(normalized);
  const database = decodeURIComponent(u.pathname.replace(/^\//, "").split("/")[0] || "");
  const conn = await mysql.createConnection({
    host: u.hostname,
    port: parseInt(u.port || "3306", 10),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database,
  });
  await conn.ping();
  const [rows] = await conn.query("SELECT DATABASE() AS db, VERSION() AS ver");
  const row = rows[0];
  console.log("OK: connected to MariaDB/MySQL.");
  console.log("  Using database:", row.db);
  console.log("  Server:", String(row.ver).split(",")[0]);
  await conn.end();
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
