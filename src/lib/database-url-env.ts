/**
 * Builds `process.env.DATABASE_URL` from `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_DATABASE`
 * (or `DB_NAME`) when `DATABASE_URL` is unset — Docker / Coolify split env.
 *
 * Keep in sync with `database-url.js` (plain Node entrypoints still require that file).
 */
export function ensureDatabaseUrl(): void {
  if (process.env.DATABASE_URL?.trim()) return;

  const host = process.env.DB_HOST?.trim();
  const user = process.env.DB_USER?.trim();
  const password = process.env.DB_PASSWORD ?? "";
  const database = (process.env.DB_DATABASE || process.env.DB_NAME)?.trim();
  const port = (process.env.DB_PORT || "5432").trim();

  if (!host || !user || !database) return;

  const u = encodeURIComponent(user);
  const p = encodeURIComponent(password);
  process.env.DATABASE_URL = `postgresql://${u}:${p}@${host}:${port}/${database}`;
}
