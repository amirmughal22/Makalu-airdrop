import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import path from "node:path";
import { userInfo } from "node:os";
import type { Pool } from "pg";
import { isAirdropQueueV2EnvEnabled } from "./config";

export function isRuntimeQueueDiagEnabled(): boolean {
  const v = process.env.AIRDROP_QUEUE_RUNTIME_DIAG?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function isSqlExplainEnabled(): boolean {
  const v = process.env.AIRDROP_QUEUE_SQL_EXPLAIN?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** PUBLIC_CLAIM_SQL matches {@link claimWalletBatch} SELECT shape for EXPLAIN (no FOR UPDATE). */
export const CLAIM_SELECT_DIAG_SQL = `SELECT jw.id AS id, jw.job_id AS jobId
       FROM job_wallets jw
       INNER JOIN jobs j ON j.id = jw.job_id
       WHERE jw.status = 'pending'
         AND (jw.next_attempt_at IS NULL OR jw.next_attempt_at <= NOW())
         AND jw.retry_count < ?
         AND j.status IN ('queued', 'running')
         AND NOT j.paused
       ORDER BY jw.job_id, jw.id
       LIMIT ?`;

export function maskDatabaseUrlHostDb(url: string): string {
  try {
    const normalized = url.replace(/^postgres(ql)?:\/\//i, "http://");
    const u = new URL(normalized);
    const db = decodeURIComponent(u.pathname.replace(/^\//, "") || "").split("/")[0] || "?";
    return `${u.hostname}:${u.port || "5432"}/${db}`;
  } catch {
    return "(unparseable)";
  }
}

export function appendStartupDebugLine(projectRoot: string, line: string): void {
  try {
    const dir = path.join(projectRoot, "logs");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, "startup-debug.log"), `[${new Date().toISOString()}] ${line}\n`, "utf8");
  } catch {
    /* ignore */
  }
}

export type StartupDiagPackage = {
  cwd: string;
  dirnameContext: string;
  nodeEnv: string | undefined;
  nodeVersion: string;
  execPath: string;
  platform: string;
  arch: string;
  user: string;
  uid: number | undefined;
  gid: number | undefined;
  rssMb: number;
  heapMb: number;
  tsxCandidate: boolean;
  pm2Meta: Record<string, string | undefined>;
  databaseUrlFingerprint: string;
  envFileHints: string;
  argvSnapshot: string[];
  resourceLimitsSummary: string;
  loadedEnvFilesSummary: string;
};

function summarizeResourceLimits(): string {
  try {
    const r = (process as NodeJS.Process & { resourceLimits?: Record<string, unknown> }).resourceLimits;
    if (!r || typeof r !== "object") return "(unavailable)";
    const pick = ["max_memory_size", "max_open_files", "max_core_file_size"] as const;
    const parts: string[] = [];
    for (const k of pick) {
      const v = (r as Record<string, unknown>)[k];
      if (typeof v === "number" && v >= 0) parts.push(`${k}=${v === Infinity ? "∞" : v}`);
    }
    return parts.length ? parts.join(" ") : JSON.stringify(r);
  } catch {
    return "(error)";
  }
}

export function collectStartupDiagnostics(
  projectRoot: string,
  dirnameContext: string,
  loadedEnvFiles: string[] = [],
): StartupDiagPackage {
  const mem = process.memoryUsage();
  const ui = userInfo();
  const dbUrl = process.env.DATABASE_URL?.trim();
  const pm2Meta: Record<string, string | undefined> = {};
  for (const k of ["PM2_HOME", "PM2_INSTANCE_ID", "pm_id", "namespace", "vizion_running"]) {
    if (process.env[k] !== undefined) pm2Meta[k] = process.env[k];
  }
  let tsxCandidate = false;
  try {
    const argv = process.argv.join(" ");
    tsxCandidate = argv.includes("tsx") || argv.includes("cli.mjs");
  } catch {
    /* ignore */
  }

  return {
    cwd: process.cwd(),
    dirnameContext,
    nodeEnv: process.env.NODE_ENV,
    nodeVersion: process.version,
    execPath: process.execPath,
    platform: process.platform,
    arch: process.arch,
    user: ui.username,
    uid: typeof ui.uid === "number" ? ui.uid : undefined,
    gid: typeof ui.gid === "number" ? ui.gid : undefined,
    rssMb: Math.round(mem.rss / 1024 / 1024),
    heapMb: Math.round(mem.heapUsed / 1024 / 1024),
    tsxCandidate,
    pm2Meta,
    databaseUrlFingerprint: dbUrl ? maskDatabaseUrlHostDb(dbUrl) : "(missing)",
    envFileHints: path.join(projectRoot, ".env"),
    argvSnapshot: [...process.argv],
    resourceLimitsSummary: summarizeResourceLimits(),
    loadedEnvFilesSummary: loadedEnvFiles.length ? loadedEnvFiles.join(", ") : "(none reported — call after bootstrap)",
  };
}

export function printAndLogStartupDiagnostics(
  projectRoot: string,
  dirnameContext: string,
  loadedEnvFiles: string[] = [],
): StartupDiagPackage {
  const p = collectStartupDiagnostics(projectRoot, dirnameContext, loadedEnvFiles);
  const lines = [
    `cwd=${p.cwd}`,
    `dirnameContext=${p.dirnameContext}`,
    `NODE_ENV=${p.nodeEnv}`,
    `node=${p.nodeVersion} execPath=${p.execPath}`,
    `platform=${p.platform} arch=${p.arch}`,
    `user=${p.user} uid=${p.uid} gid=${p.gid}`,
    `memory rssMb=${p.rssMb} heapMb=${p.heapMb}`,
    `resourceLimits=${p.resourceLimitsSummary}`,
    `tsxArgvLikely=${p.tsxCandidate}`,
    `DATABASE_URL=${p.databaseUrlFingerprint}`,
    `.env path=${p.envFileHints}`,
    `resolvedEnvFiles=${p.loadedEnvFilesSummary}`,
    `argv=${JSON.stringify(p.argvSnapshot)}`,
    `AIRDROP_QUEUE_V2_env=${isAirdropQueueV2EnvEnabled()}`,
    `PM2=${JSON.stringify(p.pm2Meta)}`,
  ];
  for (const line of lines) {
    console.info(`[startup-diag] ${line}`);
    appendStartupDebugLine(projectRoot, line);
  }
  return p;
}

export function poolDiagnostics(pool: Pool): { totalCount?: number; idleCount?: number; waitingCount?: number } {
  try {
    return {
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
    };
  } catch {
    return {};
  }
}

export async function sessionIsolation(
  conn: { query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }> },
): Promise<string | undefined> {
  try {
    const { rows } = await conn.query(
      "SELECT current_setting('transaction_isolation') AS iso, current_setting('transaction_read_only') AS ro",
    );
    const r = rows[0] as { iso?: string; ro?: string } | undefined;
    if (!r) return undefined;
    return `${r.iso ?? "?"} read_only=${r.ro ?? "?"}`;
  } catch {
    return undefined;
  }
}
