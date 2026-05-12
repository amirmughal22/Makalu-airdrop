import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from "pg";
import { ensureDatabaseUrl } from "./database-url-env";
import { ensureGeneratedWalletTables } from "./generated-wallet-schema";
import { ensureQueueJobsSchema } from "./queue/postgres-queue-schema";

ensureDatabaseUrl();

function envInt(name: string, fallback: number, min: number, max: number): number {
  const n = parseInt(process.env[name]?.trim() ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Convert `?` placeholders (mysql2 style) to PostgreSQL `$1..$n`. */
export function toPgText(sql: string, paramCount: number): string {
  let i = 0;
  const text = sql.replace(/\?/g, () => {
    i += 1;
    return `$${i}`;
  });
  if (i !== paramCount) {
    throw new Error(`SQL placeholder mismatch: found ${i} "?" but ${paramCount} parameter(s)`);
  }
  return text;
}

export async function pgQuery<T extends QueryResultRow>(
  executor: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const { rows } = await executor.query<T>(toPgText(sql, params.length), params);
  return rows;
}

export async function pgExecute(
  executor: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  sql: string,
  params: unknown[] = [],
): Promise<{ rowCount: number }> {
  const res = await executor.query(toPgText(sql, params.length), params);
  return { rowCount: res.rowCount ?? 0 };
}

function poolConfigFromDatabaseUrl(): PoolConfig | null {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return null;
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    throw new Error("DATABASE_URL must be a PostgreSQL connection string (postgresql://...)");
  }
  return {
    connectionString: url,
    max: envInt("AIRDROP_DB_CONNECTION_LIMIT", 8, 1, 100),
    idleTimeoutMillis: envInt("AIRDROP_DB_IDLE_TIMEOUT_MS", 30_000, 1000, 600_000),
    connectionTimeoutMillis: envInt("AIRDROP_DB_CONNECT_TIMEOUT_MS", 10_000, 1000, 120_000),
  };
}

const CREATE_AIRDROP_JOBS_SQL = `
CREATE TABLE IF NOT EXISTS airdrop_jobs (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  owner VARCHAR(66) NOT NULL,
  "signerAddress" VARCHAR(66) NULL,
  status VARCHAR(32) NOT NULL,
  mode VARCHAR(16) NOT NULL,
  "tokenAddress" VARCHAR(42) NULL,
  "chainId" INT NULL,
  "scheduledAt" TIMESTAMPTZ NULL,
  "queuedAt" TIMESTAMPTZ NULL,
  paused BOOLEAN NOT NULL DEFAULT FALSE,
  "resultsJson" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "signerAddressesJson" JSONB NULL,
  "targetRunCount" INT NULL,
  "currentRun" INT NULL,
  migrated_to_queue BOOLEAN NOT NULL DEFAULT FALSE
)`;

async function ignorePgCodes(op: () => Promise<unknown>, codes: string[]): Promise<void> {
  try {
    await op();
  } catch (e: unknown) {
    const code = e && typeof e === "object" && "code" in e ? String((e as { code: string }).code) : "";
    if (!codes.includes(code)) throw e;
  }
}

let pool: Pool | null = null;
let schemaReady: Promise<void> | null = null;

/** Serialize DDL across processes (Next, workers, PM2) — avoids PG `XX000` / tuple concurrently updated on catalog. */
const SCHEMA_BOOTSTRAP_ADVISORY_CLASS = 8_420_003;
const SCHEMA_BOOTSTRAP_ADVISORY_KEY = 1;

type SchemaBootstrapConn = Pick<Pool, "query">;

export async function getPostgresPool(): Promise<Pool> {
  const cfg = poolConfigFromDatabaseUrl();
  if (!cfg) throw new Error("DATABASE_URL is not configured");
  if (!pool) pool = new Pool(cfg);
  if (!schemaReady) {
    schemaReady = (async () => {
      const conn = await pool!.connect();
      try {
        await conn.query(`SELECT pg_advisory_lock($1::integer, $2::integer)`, [
          SCHEMA_BOOTSTRAP_ADVISORY_CLASS,
          SCHEMA_BOOTSTRAP_ADVISORY_KEY,
        ]);
        try {
          await runPostgresSchemaBootstrap(conn);
        } finally {
          await conn
            .query(`SELECT pg_advisory_unlock($1::integer, $2::integer)`, [
              SCHEMA_BOOTSTRAP_ADVISORY_CLASS,
              SCHEMA_BOOTSTRAP_ADVISORY_KEY,
            ])
            .catch(() => {});
        }
      } finally {
        conn.release();
      }
    })();
  }
  await schemaReady;
  return pool;
}

async function runPostgresSchemaBootstrap(db: SchemaBootstrapConn): Promise<void> {
  await db.query(CREATE_AIRDROP_JOBS_SQL);
  await ignorePgCodes(() => db.query(`ALTER TABLE airdrop_jobs ADD COLUMN "chainId" INT NULL`), ["42701"]);
  await ignorePgCodes(() => db.query(`ALTER TABLE airdrop_jobs ADD COLUMN "signerAddress" VARCHAR(66) NULL`), [
    "42701",
  ]);
  await ignorePgCodes(() => db.query(`ALTER TABLE airdrop_jobs ADD COLUMN "scheduledAt" TIMESTAMPTZ NULL`), [
    "42701",
  ]);
  await ignorePgCodes(() => db.query(`ALTER TABLE airdrop_jobs ADD COLUMN "queuedAt" TIMESTAMPTZ NULL`), [
    "42701",
  ]);
  await ignorePgCodes(() => db.query(`ALTER TABLE airdrop_jobs ADD COLUMN "signerAddressesJson" JSONB NULL`), [
    "42701",
  ]);
  await ignorePgCodes(() => db.query(`ALTER TABLE airdrop_jobs ADD COLUMN "targetRunCount" INT NULL`), ["42701"]);
  await ignorePgCodes(() => db.query(`ALTER TABLE airdrop_jobs ADD COLUMN "currentRun" INT NULL`), ["42701"]);
  await ignorePgCodes(
    () => db.query(`ALTER TABLE airdrop_jobs ADD COLUMN migrated_to_queue BOOLEAN NOT NULL DEFAULT FALSE`),
    ["42701"],
  );
  await ignorePgCodes(() => db.query(`CREATE INDEX IF NOT EXISTS idx_airdrop_jobs_owner ON airdrop_jobs (owner)`), [
    "42P07",
  ]);
  await ignorePgCodes(
    () => db.query(`CREATE INDEX IF NOT EXISTS idx_airdrop_jobs_owner_created ON airdrop_jobs (owner, "createdAt")`),
    ["42P07"],
  );
  await ignorePgCodes(
    () =>
      db.query(
        `CREATE INDEX IF NOT EXISTS idx_airdrop_jobs_owner_status_created ON airdrop_jobs (owner, status, "createdAt")`,
      ),
    ["42P07"],
  );
  await ignorePgCodes(
    () =>
      db.query(
        `CREATE INDEX IF NOT EXISTS idx_airdrop_jobs_queue ON airdrop_jobs (status, paused, "scheduledAt", "queuedAt", "createdAt", id)`,
      ),
    ["42P07"],
  );
  await ignorePgCodes(
    () => db.query(`CREATE INDEX IF NOT EXISTS idx_airdrop_jobs_running_updated ON airdrop_jobs (status, "updatedAt")`),
    ["42P07"],
  );
  await ignorePgCodes(
    () => db.query(`CREATE INDEX IF NOT EXISTS idx_airdrop_jobs_migrated ON airdrop_jobs (migrated_to_queue, status)`),
    ["42P07"],
  );
  await ensureQueueJobsSchema(db);
  await ensureGeneratedWalletTables(db);
}

/** Legacy jobs table row shape (camelCase columns from `airdrop_jobs`). */
export type JobRow = {
  id: string;
  owner: string;
  signerAddress: string | null;
  signerAddressesJson?: unknown;
  status: string;
  mode: string;
  tokenAddress: string | null;
  chainId: number | null;
  scheduledAt: Date | null;
  queuedAt: Date | null;
  paused: boolean;
  resultsJson: unknown;
  createdAt: Date;
  updatedAt: Date;
  targetRunCount?: number | null;
  currentRun?: number | null;
  migrated_to_queue?: boolean | null;
};
