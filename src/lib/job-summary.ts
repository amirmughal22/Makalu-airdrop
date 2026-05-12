import type { BatchResult } from "./job-types";

export type BatchResultSummary = {
  total: number;
  success: number;
  failed: number;
  pending: number;
  queued: number;
  submitted: number;
  /** Present for normalized jobs — workers currently claiming batches for this job. */
  activeWorkers?: number;
};

/** Share of wallet rows that reached a terminal status (completed + failed). */
export function progressPercentFromSummary(s: BatchResultSummary): number {
  const denom = s.total > 0 ? s.total : 1;
  return Math.min(100, Math.round(((s.success + s.failed) / denom) * 100));
}

export function summarizeBatchResults(results: BatchResult[]): BatchResultSummary {
  let success = 0;
  let failed = 0;
  let pending = 0;
  let queued = 0;
  let submitted = 0;
  for (const r of results) {
    switch (r.status) {
      case "success":
        success += 1;
        break;
      case "failed":
        failed += 1;
        break;
      case "pending":
        pending += 1;
        break;
      case "queued":
        queued += 1;
        break;
      case "submitted":
        submitted += 1;
        break;
      default:
        break;
    }
  }
  return { total: results.length, success, failed, pending, queued, submitted };
}
