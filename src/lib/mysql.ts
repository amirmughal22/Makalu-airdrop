import mysql from "mysql2/promise";
import type { PoolOptions } from "mysql2";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { ensureQueueJobsSchema } from "./queue/mysql-queue-schema";

const { ensureDatabaseUrl } = require("../../database-url.js") as { ensureDatabaseUrl: () => void };
ensureDatabaseUrl();

function envInt(name: string, fallback: number, min: number, max: number): number {
  const n = parseInt(process.env[name]?.trim() ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function poolOptionsFromEnv(): PoolOptions | null {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return null;
  const normalized = url.replace(/^mysql:\/\//i, "http://");
  try {
    const u = new URL(normalized);
    const database = decodeURIComponent(u.pathname.replace(/^\//, "") || "").split("/")[0] || "";
    if (!database) return null;
    return {
      host: u.hostname,
      port: u.port ? parseInt(u.port, 10) : 3306,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database,
      waitForConnections: true,
      connectionLimit: envInt("AIRDROP_DB_CONNECTION_LIMIT", 10, 1, 100),
    };
  } catch {
    return null;
  }
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS airdrop_jobs (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  owner VARCHAR(66) NOT NULL,
  signerAddress VARCHAR(66) NULL,
  status VARCHAR(32) NOT NULL,
  mode VARCHAR(16) NOT NULL,
  tokenAddress VARCHAR(42) NULL,
  chainId INT NULL,
  scheduledAt DATETIME(3) NULL,
  queuedAt DATETIME(3) NULL,
  paused TINYINT(1) NOT NULL DEFAULT 0,
  resultsJson JSON NOT NULL,
  createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_airdrop_jobs_owner (owner),
  INDEX idx_airdrop_jobs_owner_created (owner, createdAt),
  INDEX idx_airdrop_jobs_owner_status_created (owner, status, createdAt),
  INDEX idx_airdrop_jobs_queue (status, paused, scheduledAt, queuedAt, createdAt, id),
  INDEX idx_airdrop_jobs_running_updated (status, updatedAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

let pool: Pool | null = null;
let schemaReady: Promise<void> | null = null;

async function ignoreMysqlCodes(op: () => Promise<unknown>, codes: string[]): Promise<void> {
  try {
    await op();
  } catch (e: unknown) {
    const code = e && typeof e === "object" && "code" in e ? (e as { code: string }).code : "";
    if (!codes.includes(code)) throw e;
  }
}

export async function getMysqlPool(): Promise<Pool> {
  const opts = poolOptionsFromEnv();
  if (!opts) throw new Error("DATABASE_URL is not configured");
  if (!pool) pool = mysql.createPool(opts);
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool!.query(CREATE_TABLE_SQL);
      await ignoreMysqlCodes(() => pool!.query("ALTER TABLE airdrop_jobs ADD COLUMN chainId INT NULL"), ["ER_DUP_FIELDNAME"]);
      await ignoreMysqlCodes(() => pool!.query("ALTER TABLE airdrop_jobs ADD COLUMN signerAddress VARCHAR(66) NULL"), ["ER_DUP_FIELDNAME"]);
      await ignoreMysqlCodes(() => pool!.query("ALTER TABLE airdrop_jobs ADD COLUMN scheduledAt DATETIME(3) NULL"), ["ER_DUP_FIELDNAME"]);
      await ignoreMysqlCodes(() => pool!.query("ALTER TABLE airdrop_jobs ADD COLUMN queuedAt DATETIME(3) NULL"), ["ER_DUP_FIELDNAME"]);
      await ignoreMysqlCodes(() => pool!.query("ALTER TABLE airdrop_jobs ADD COLUMN signerAddressesJson JSON NULL"), ["ER_DUP_FIELDNAME"]);
      await ignoreMysqlCodes(() => pool!.query("ALTER TABLE airdrop_jobs ADD COLUMN targetRunCount INT NULL"), ["ER_DUP_FIELDNAME"]);
      await ignoreMysqlCodes(() => pool!.query("ALTER TABLE airdrop_jobs ADD COLUMN currentRun INT NULL"), ["ER_DUP_FIELDNAME"]);
      await ignoreMysqlCodes(
        () => pool!.query("ALTER TABLE airdrop_jobs ADD INDEX idx_airdrop_jobs_owner_created (owner, createdAt)"),
        ["ER_DUP_KEYNAME"],
      );
      await ignoreMysqlCodes(
        () => pool!.query("ALTER TABLE airdrop_jobs ADD INDEX idx_airdrop_jobs_owner_status_created (owner, status, createdAt)"),
        ["ER_DUP_KEYNAME"],
      );
      await ignoreMysqlCodes(
        () => pool!.query("ALTER TABLE airdrop_jobs ADD INDEX idx_airdrop_jobs_queue (status, paused, scheduledAt, queuedAt, createdAt, id)"),
        ["ER_DUP_KEYNAME"],
      );
      await ignoreMysqlCodes(
        () => pool!.query("ALTER TABLE airdrop_jobs ADD INDEX idx_airdrop_jobs_running_updated (status, updatedAt)"),
        ["ER_DUP_KEYNAME"],
      );
      await ignoreMysqlCodes(
        () =>
          pool!.query(
            "ALTER TABLE airdrop_jobs ADD COLUMN migrated_to_queue TINYINT(1) NOT NULL DEFAULT 0",
          ),
        ["ER_DUP_FIELDNAME"],
      );
      await ignoreMysqlCodes(
        () =>
          pool!.query(
            "ALTER TABLE airdrop_jobs ADD INDEX idx_airdrop_jobs_migrated (migrated_to_queue, status)",
          ),
        ["ER_DUP_KEYNAME"],
      );
      await ensureQueueJobsSchema(pool!);
    })();
  }
  await schemaReady;
  return pool;
}

export type JobRow = RowDataPacket & {
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
  paused: number | boolean;
  resultsJson: unknown;
  createdAt: Date;
  updatedAt: Date;
  targetRunCount?: number | null;
  currentRun?: number | null;
  /** 1 when copied to `jobs` / `job_wallets` (legacy runner must skip). */
  migrated_to_queue?: number | boolean | null;
};
