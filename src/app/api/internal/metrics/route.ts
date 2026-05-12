import { NextResponse } from "next/server";
import { getPostgresPool, pgQuery } from "@/lib/postgres";
import { getRpcEndpointStats, rpcHostMetricLabel } from "@/lib/rpc-health";
import { getQueueRuntimeCacheMeta } from "@/lib/queue/queue-runtime-settings";
import { getQueueWorkerLivenessSnapshot } from "@/lib/queue/queue-worker-liveness";

/**
 * Prometheus-compatible scrape endpoint (text/plain).
 * Protect with `METRICS_SECRET`: `Authorization: Bearer <secret>` or `?token=`.
 *
 * Note: This deployment uses **EVM (Makalu) + PostgreSQL** queue.
 */
export async function GET(request: Request) {
  const secret = process.env.METRICS_SECRET?.trim();
  if (!secret) {
    return NextResponse.json({ error: "METRICS_SECRET not configured" }, { status: 503 });
  }
  const url = new URL(request.url);
  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const token = url.searchParams.get("token")?.trim() ?? bearer;
  if (token !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const lines: string[] = [];
  const mem = process.memoryUsage();
  lines.push("# HELP makalu_process_heap_used_bytes Node.js V8 heap used (scrape target process).");
  lines.push("# TYPE makalu_process_heap_used_bytes gauge");
  lines.push(`makalu_process_heap_used_bytes ${mem.heapUsed}`);

  try {
    const meta = getQueueRuntimeCacheMeta();
    const live = getQueueWorkerLivenessSnapshot();
    lines.push("# HELP makalu_queue_runtime_refresh_sequence Monotonic counter after each DB read of queue_runtime_settings.");
    lines.push("# TYPE makalu_queue_runtime_refresh_sequence gauge");
    lines.push(`makalu_queue_runtime_refresh_sequence ${meta.refreshSequence}`);
    lines.push("# HELP makalu_queue_runtime_cache_age_ms Age of in-memory runtime cache (ms).");
    lines.push("# TYPE makalu_queue_runtime_cache_age_ms gauge");
    lines.push(`makalu_queue_runtime_cache_age_ms ${Number.isFinite(meta.ageMsSinceRefresh) ? meta.ageMsSinceRefresh : 0}`);
    lines.push("# HELP makalu_queue_runtime_fallback 1 if runtime flags fell back to defaults (DB error or missing row).");
    lines.push("# TYPE makalu_queue_runtime_fallback gauge");
    lines.push(`makalu_queue_runtime_fallback ${meta.loadedFromDbFallback ? 1 : 0}`);
    lines.push("# HELP makalu_queue_worker_idle_ms Time since last successful claim batch in this process (ms).");
    lines.push("# TYPE makalu_queue_worker_idle_ms gauge");
    lines.push(`makalu_queue_worker_idle_ms ${live.queueIdleMs}`);
    lines.push("# HELP makalu_queue_worker_empty_poll_rate Fraction of polls that returned zero rows (this process).");
    lines.push("# TYPE makalu_queue_worker_empty_poll_rate gauge");
    lines.push(`makalu_queue_worker_empty_poll_rate ${live.emptyPollRate}`);
    lines.push("# HELP makalu_queue_worker_avg_claim_latency_ms Rolling mean claim RPC latency (ms).");
    lines.push("# TYPE makalu_queue_worker_avg_claim_latency_ms gauge");
    lines.push(`makalu_queue_worker_avg_claim_latency_ms ${live.avgClaimLatencyMs}`);
    lines.push("# HELP makalu_queue_worker_consecutive_empty_polls Current streak of empty claim batches.");
    lines.push("# TYPE makalu_queue_worker_consecutive_empty_polls gauge");
    lines.push(`makalu_queue_worker_consecutive_empty_polls ${live.consecutiveEmptyPolls}`);
  } catch {
    /* optional metrics */
  }

  const rpcStats = getRpcEndpointStats();
  if (rpcStats.length) {
    lines.push("# HELP makalu_rpc_ok_rate Recent in-process RPC success ratio per HTTP host (resets on restart).");
    lines.push("# TYPE makalu_rpc_ok_rate gauge");
    lines.push("# HELP makalu_rpc_avg_latency_ms Rolling mean RPC round-trip latency (ms).");
    lines.push("# TYPE makalu_rpc_avg_latency_ms gauge");
    lines.push("# HELP makalu_rpc_recent_samples Number of latency samples in the rolling window.");
    lines.push("# TYPE makalu_rpc_recent_samples gauge");
    for (const s of rpcStats) {
      const host = rpcHostMetricLabel(s.url);
      lines.push(`makalu_rpc_ok_rate{host="${host}"} ${s.okRate}`);
      lines.push(`makalu_rpc_avg_latency_ms{host="${host}"} ${s.avgLatencyMs}`);
      lines.push(`makalu_rpc_recent_samples{host="${host}"} ${s.sampleCount}`);
    }
  }

  const pool = await getPostgresPool().catch(() => null);
  if (!pool) {
    lines.push("# makalu_db_up 0");
    lines.push("# TYPE makalu_db_up gauge");
    lines.push("makalu_db_up 0");
    return new NextResponse(lines.join("\n") + "\n", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  lines.push("# HELP makalu_db_up Database pool reachable (1=yes).");
  lines.push("# TYPE makalu_db_up gauge");
  lines.push("makalu_db_up 1");

  try {
    const pendingRows = await pgQuery<{ c: string }>(
      pool,
      `SELECT COUNT(*)::text AS c FROM job_wallets WHERE status = 'pending'
       AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())`,
    );
    const processingRows = await pgQuery<{ c: string }>(
      pool,
      `SELECT COUNT(*)::text AS c FROM job_wallets WHERE status = 'processing'`,
    );
    const pc = Number(pendingRows[0]?.c ?? 0);
    const pr = Number(processingRows[0]?.c ?? 0);
    lines.push("# HELP makalu_queue_job_wallets_pending Claimable pending rows.");
    lines.push("# TYPE makalu_queue_job_wallets_pending gauge");
    lines.push(`makalu_queue_job_wallets_pending ${pc}`);
    lines.push("# HELP makalu_queue_job_wallets_processing Rows marked processing.");
    lines.push("# TYPE makalu_queue_job_wallets_processing gauge");
    lines.push(`makalu_queue_job_wallets_processing ${pr}`);

    const hbRows = await pgQuery<{ c: string }>(
      pool,
      `SELECT COUNT(*)::text AS c FROM queue_worker_heartbeats WHERE last_heartbeat > NOW() - INTERVAL '2 minutes'`,
    );
    const alive = Number(hbRows[0]?.c ?? 0);
    lines.push("# HELP makalu_queue_workers_alive Heartbeats seen in last 2 minutes.");
    lines.push("# TYPE makalu_queue_workers_alive gauge");
    lines.push(`makalu_queue_workers_alive ${alive}`);
  } catch (e) {
    lines.push("# makalu_metrics_query_error 1");
    lines.push(`# error ${e instanceof Error ? e.message.replace(/\n/g, " ") : "unknown"}`);
  }

  return new NextResponse(lines.join("\n") + "\n", {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
