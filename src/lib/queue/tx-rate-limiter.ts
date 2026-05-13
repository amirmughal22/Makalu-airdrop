import { sleep } from "../rpc-retry";
import { getPostgresPool, pgQuery } from "../postgres";
import { safeRedisDecr, safeRedisIncrUnderLimit } from "../redis";
import {
  globalTxsPerMinuteLimit,
  signerTxsPerMinuteLimit,
  txRateLimitingEnabled,
} from "./throughput-limits";

const BUCKET_TTL_SEC = 120;
const LUA_RETRY_MS = 40;
const PG_RETRY_MS = 80;
const PG_MAX_WAIT_MS = 90_000;

function minuteBucket(): string {
  return String(Math.floor(Date.now() / 60_000));
}

function redisSignerKey(signerLower: string): string {
  return `airdrop:txrl:s:${signerLower}:${minuteBucket()}`;
}

function redisGlobalKey(): string {
  return `airdrop:txrl:g:${minuteBucket()}`;
}

async function pgCountCompletedSince(
  signerLower: string | null,
  sinceMs: number,
): Promise<number> {
  const pool = await getPostgresPool();
  const since = new Date(Date.now() - sinceMs).toISOString();
  if (signerLower) {
    const rows = await pgQuery<{ c: string }>(
      pool,
      `SELECT COUNT(*)::text AS c FROM job_wallets
       WHERE status = 'completed' AND updated_at > ?::timestamptz
         AND lower(trim(signer_address)) = ?`,
      [since, signerLower],
    );
    return Math.max(0, Math.floor(Number(rows[0]?.c ?? 0) || 0));
  }
  const rows = await pgQuery<{ c: string }>(
    pool,
    `SELECT COUNT(*)::text AS c FROM job_wallets
     WHERE status = 'completed' AND updated_at > ?::timestamptz`,
    [since],
  );
  return Math.max(0, Math.floor(Number(rows[0]?.c ?? 0) || 0));
}

/**
 * Blocks until a send slot is allowed under per-signer and global minute caps.
 * Uses Redis when available (accurate across processes); otherwise PostgreSQL completed counts (soft).
 */
export async function acquireTxSendBudget(signerAddressLower: string): Promise<void> {
  if (!txRateLimitingEnabled()) return;
  const signer = signerAddressLower.trim().toLowerCase();
  const sLim = signerTxsPerMinuteLimit();
  const gLim = globalTxsPerMinuteLimit();
  const started = Date.now();

  while (Date.now() - started < PG_MAX_WAIT_MS) {
    const gKey = redisGlobalKey();
    const sKey = redisSignerKey(signer);

    const gTry = await safeRedisIncrUnderLimit(gKey, gLim, BUCKET_TTL_SEC);
    if (gTry === true) {
      const sTry = await safeRedisIncrUnderLimit(sKey, sLim, BUCKET_TTL_SEC);
      if (sTry === true) return;
      await safeRedisDecr(gKey);
      if (sTry === false) {
        await sleep(LUA_RETRY_MS);
        continue;
      }
    } else if (gTry === false) {
      await sleep(LUA_RETRY_MS);
      continue;
    }

    const gc = await pgCountCompletedSince(null, 60_000);
    if (gc >= gLim) {
      await sleep(PG_RETRY_MS);
      continue;
    }
    const sc = await pgCountCompletedSince(signer, 60_000);
    if (sc >= sLim) {
      await sleep(PG_RETRY_MS);
      continue;
    }
    return;
  }

  console.warn("[tx-rate] acquireTxSendBudget timed out — sending anyway (check Redis/DB load)");
}
