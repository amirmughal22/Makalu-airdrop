/**
 * PASS/FAIL checklist for queue runtime (env, DB, flags, dry-run claim, RPC reachability).
 *   npm run worker:self-test
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

import { assertDatabaseConfigured, bootstrapProductionEnv } from "../src/lib/queue/production-env";
import { refreshQueueRuntimeCache } from "../src/lib/queue/queue-runtime-settings";
import { collectQueueClaimBlockers, isAirdropQueueV2EnvEnabled, queueWorkerId } from "../src/lib/queue/config";
import { claimWalletBatchDryRun } from "../src/lib/queue/job-queue-repo";

type Row = { step: string; pass: boolean; detail: string };

function row(step: string, pass: boolean, detail: string): Row {
  return { step, pass, detail };
}

bootstrapProductionEnv(ROOT);

void (async () => {
  const rows: Row[] = [];
  try {
    assertDatabaseConfigured(ROOT);
    rows.push(row("DATABASE_URL / DB_* resolves", true, "ensureDatabaseUrl OK"));
  } catch (e) {
    rows.push(row("DATABASE_URL / DB_* resolves", false, e instanceof Error ? e.message : String(e)));
    printTable(rows);
    process.exit(1);
  }

  rows.push(
    row(
      "AIRDROP_QUEUE_V2 env",
      isAirdropQueueV2EnvEnabled(),
      isAirdropQueueV2EnvEnabled() ? "on" : "off",
    ),
  );

  await refreshQueueRuntimeCache();
  rows.push(
    row(
      "queue_claim_blockers",
      collectQueueClaimBlockers().length === 0,
      collectQueueClaimBlockers().join(" · ") || "(none)",
    ),
  );
  try {
    const pool = await (await import("../src/lib/postgres")).getPostgresPool();
    await pool.query("SELECT 1 AS ok");
    rows.push(row("Postgres ping", true, "SELECT 1"));
  } catch (e) {
    rows.push(row("Postgres ping", false, e instanceof Error ? e.message : String(e)));
  }

  let dryIds: number[] = [];
  try {
    dryIds = await claimWalletBatchDryRun(`${queueWorkerId()}-selftest`);
    rows.push(row("Dry-run claim (rollback)", true, `claimed ${dryIds.length} id(s)`));
  } catch (e) {
    rows.push(row("Dry-run claim (rollback)", false, e instanceof Error ? e.message : String(e)));
  }

  const rpc = process.env.NEXT_PUBLIC_RPC_URL?.trim() || process.env.NEXT_PUBLIC_RPC_URLS?.split(",")[0]?.trim();
  if (rpc) {
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_chainId",
          params: [],
        }),
      });
      const j = (await res.json()) as { result?: string };
      rows.push(row("RPC eth_chainId", res.ok && Boolean(j.result), String(j.result ?? res.status)));
    } catch (e) {
      rows.push(row("RPC eth_chainId", false, e instanceof Error ? e.message : String(e)));
    }
  } else {
    rows.push(row("RPC eth_chainId", false, "NEXT_PUBLIC_RPC_URL unset"));
  }

  printTable(rows);
  const failed = rows.some((r) => !r.pass);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

function printTable(rows: Row[]): void {
  console.info("");
  console.info("SELF-TEST RESULT");
  console.info("-".repeat(72));
  for (const r of rows) {
    const mark = r.pass ? "PASS" : "FAIL";
    console.info(`${mark.padEnd(6)} ${r.step.padEnd(28)} ${r.detail}`);
  }
  console.info("-".repeat(72));
}
