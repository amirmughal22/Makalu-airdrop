/**
 * In-process RPC endpoint scoring for adaptive ordering (HTTP JSON-RPC — Makalu EVM).
 * Not persisted; resets on process restart. Suitable for multi-endpoint failover latency balancing.
 */

type Sample = { latencyMs: number; ok: boolean };
const recent = new Map<string, Sample[]>();
const MAX_SAMPLES = 80;

export function recordRpcRoundTrip(url: string, latencyMs: number, ok: boolean): void {
  const k = url.trim();
  let arr = recent.get(k);
  if (!arr) {
    arr = [];
    recent.set(k, arr);
  }
  arr.push({ latencyMs: Math.min(latencyMs, 120_000), ok });
  while (arr.length > MAX_SAMPLES) arr.shift();
}

/** Higher is better: favors success rate and lower latency. */
function score(url: string): number {
  const arr = recent.get(url.trim());
  if (!arr?.length) return 0;
  const okN = arr.filter((x) => x.ok).length;
  const okRate = okN / arr.length;
  const latMean = arr.reduce((s, x) => s + x.latencyMs, 0) / arr.length;
  return okRate * 10_000 - Math.min(latMean, 30_000) / 30;
}

/** Re-order URLs so healthier endpoints are tried first (caller may still fall back). */
export function rankRpcUrlsByHealth(urls: string[]): string[] {
  if (urls.length <= 1) return [...urls];
  return [...urls].sort((a, b) => score(b) - score(a));
}

export type RpcEndpointStats = {
  url: string;
  sampleCount: number;
  okRate: number;
  avgLatencyMs: number;
};

/** Snapshot for Prometheus / ops — in-memory since last process restart. */
export function getRpcEndpointStats(): RpcEndpointStats[] {
  const out: RpcEndpointStats[] = [];
  for (const [url, arr] of recent) {
    if (!arr?.length) continue;
    const okN = arr.filter((x) => x.ok).length;
    out.push({
      url,
      sampleCount: arr.length,
      okRate: okN / arr.length,
      avgLatencyMs: arr.reduce((s, x) => s + x.latencyMs, 0) / arr.length,
    });
  }
  return out.sort((a, b) => a.url.localeCompare(b.url));
}

/** Stable short label for Prometheus (hostname from HTTP RPC URL). */
export function rpcHostMetricLabel(url: string): string {
  try {
    const trimmed = url.trim();
    const withProto = trimmed.includes("://") ? trimmed : `http://${trimmed}`;
    const u = new URL(withProto);
    return u.hostname.slice(0, 128).replace(/[^a-zA-Z0-9.-]/g, "_") || "unknown";
  } catch {
    return "unknown";
  }
}
