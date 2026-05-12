"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Ban, ExternalLink, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ListPagination } from "@/components/ui/list-pagination";
import { LIST_PAGE_SIZE } from "@/lib/list-page-size";
import { chainDisplayLabel, explorerUrlForChainId, MAKALU_CHAIN_ID_DECIMAL, rpcEndpointLabel } from "@/lib/chain";
import { cn } from "@/lib/utils";

const SESSION_STORAGE_KEY = "litho-airdrop-session";

type BatchResult = {
  recipient: string;
  amount: string;
  txHash?: string;
  status: string;
  error?: string;
  signerAddress?: string;
  rpcUrl?: string;
};

type JobStats = {
  totalWallets: number;
  processedWallets: number;
  failedWallets: number;
  pendingWallets: number;
  processingWallets: number;
  progressPercent: number;
  activeWorkers: number;
  createdAt: string;
  updatedAt: string;
};

type WalletApiRow = {
  id: number;
  recipient: string;
  amount: string;
  status: string;
  rawStatus: string;
  txHash?: string;
  error?: string;
  signerAddress?: string;
  rpcUrl?: string;
  retryCount: number;
  updatedAt: string;
};

type BatchJob = {
  jobId: string;
  status: string;
  mode: string;
  createdAt: string;
  chainId?: number;
  queuePosition?: number;
  targetRunCount?: number;
  currentRun?: number;
  loopForever?: boolean;
  results: BatchResult[];
  stats?: JobStats;
};

function loadStoredSession(): { token: string; address: string } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { token?: unknown; address?: unknown };
    if (typeof parsed.token !== "string" || typeof parsed.address !== "string") return null;
    const token = parsed.token.trim();
    const address = parsed.address.trim().toLowerCase();
    if (!token || !address) return null;
    return { token, address };
  } catch {
    return null;
  }
}

function shortAddr(address?: string) {
  if (!address) return "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

async function parseApiJson<T>(res: Response, fallback: string): Promise<T> {
  const raw = await res.text();
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    if (!res.ok) throw new Error(raw.trim().slice(0, 400) || `${fallback} (HTTP ${res.status})`);
    throw new Error("Invalid JSON from server");
  }
  if (!res.ok) {
    const msg =
      typeof (parsed as { error?: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : fallback;
    throw new Error(msg);
  }
  return parsed as T;
}

export default function DashboardJobDetail() {
  const params = useParams();
  const router = useRouter();
  const jobId = typeof params.jobId === "string" ? params.jobId : "";

  const [sessionToken, setSessionToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [jobRefreshing, setJobRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [job, setJob] = useState<BatchJob | null>(null);
  const [legacyResultsMode, setLegacyResultsMode] = useState(false);
  const [walletRows, setWalletRows] = useState<WalletApiRow[]>([]);
  const [walletPage, setWalletPage] = useState(1);
  const [walletTotalPages, setWalletTotalPages] = useState(1);
  const [walletTotalMatching, setWalletTotalMatching] = useState(0);
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletStatusFilter, setWalletStatusFilter] = useState<string>("");
  const [walletSearch, setWalletSearch] = useState("");
  const [walletSearchDebounced, setWalletSearchDebounced] = useState("");
  const [resultPage, setResultPage] = useState(1);
  const [rerunLoop, setRerunLoop] = useState(false);
  const rerunLoopRef = useRef(false);
  rerunLoopRef.current = rerunLoop;
  const aliveRef = useRef(true);
  const legacyResultsRef = useRef(false);
  /** Why the DB queue may not claim rows (from API). */
  const [queueClaimBlockers, setQueueClaimBlockers] = useState<string[]>([]);
  const [embeddedWorkerBlockers, setEmbeddedWorkerBlockers] = useState<string[]>([]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setWalletSearchDebounced(walletSearch.trim()), 350);
    return () => clearTimeout(t);
  }, [walletSearch]);

  useEffect(() => {
    const s = loadStoredSession();
    if (!s) {
      router.replace("/dashboard");
      return;
    }
    setSessionToken(s.token);
  }, [router]);

  const authHeaders = useCallback(
    (tokenOverride?: string): HeadersInit => {
      const h: Record<string, string> = { "Content-Type": "application/json" };
      const token = tokenOverride ?? sessionToken;
      if (token) h.Authorization = `Bearer ${token}`;
      return h;
    },
    [sessionToken],
  );

  const loadJob = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!jobId || !sessionToken) return;
      setError("");
      const silent = options?.silent === true;
      if (!silent) setJobRefreshing(true);
      try {
        const res = await fetch(`/api/airdrop/jobs/${jobId}?_=${Date.now()}`, {
          headers: authHeaders(),
          cache: "no-store",
        });
        const data = await parseApiJson<{
          job: BatchJob;
          stats?: JobStats;
          queueClaimBlockers?: string[];
          embeddedWorkerBlockers?: string[];
        }>(res, "Failed to load job");
        const next = data.stats ? { ...data.job, stats: data.stats } : data.job;
        const legacy = (next.results?.length ?? 0) > 0;
        legacyResultsRef.current = legacy;
        setLegacyResultsMode(legacy);
        setJob(next);
        setQueueClaimBlockers(Array.isArray(data.queueClaimBlockers) ? data.queueClaimBlockers : []);
        setEmbeddedWorkerBlockers(Array.isArray(data.embeddedWorkerBlockers) ? data.embeddedWorkerBlockers : []);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load job");
        setJob(null);
        setQueueClaimBlockers([]);
        setEmbeddedWorkerBlockers([]);
      } finally {
        if (!silent) setJobRefreshing(false);
      }
    },
    [jobId, sessionToken, authHeaders],
  );

  const loadWallets = useCallback(async () => {
    if (!jobId || !sessionToken) return;
    if (legacyResultsRef.current) return;
    setWalletLoading(true);
    try {
      const qs = new URLSearchParams({
        limit: String(LIST_PAGE_SIZE),
        page: String(walletPage),
      });
      if (walletStatusFilter) qs.set("status", walletStatusFilter);
      if (walletSearchDebounced) qs.set("search", walletSearchDebounced);
      const res = await fetch(`/api/airdrop/jobs/${jobId}/wallets?${qs.toString()}`, {
        headers: authHeaders(),
        cache: "no-store",
      });
      if (res.status === 501) {
        legacyResultsRef.current = true;
        setLegacyResultsMode(true);
        setWalletRows([]);
        return;
      }
      const data = await parseApiJson<{
        items: WalletApiRow[];
        totalPages: number;
        totalMatching: number;
      }>(res, "Failed to load wallets");
      setWalletRows(data.items);
      setWalletTotalPages(Math.max(1, data.totalPages));
      setWalletTotalMatching(data.totalMatching);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load wallets");
      setWalletRows([]);
    } finally {
      setWalletLoading(false);
    }
  }, [
    jobId,
    sessionToken,
    authHeaders,
    walletPage,
    walletStatusFilter,
    walletSearchDebounced,
  ]);

  useEffect(() => {
    void loadWallets();
  }, [loadWallets]);

  useEffect(() => {
    setWalletPage(1);
  }, [walletStatusFilter, walletSearchDebounced]);

  const rerunEntireJob = useCallback(async () => {
    const terminal = new Set(["completed", "failed", "cancelled"]);
    setBusy(true);
    setError("");
    try {
      const postRerun = async () => {
        await parseApiJson(
          await fetch(`/api/airdrop/jobs/${jobId}/rerun`, { method: "POST", headers: authHeaders() }),
          "Failed to rerun job",
        );
        await loadJob({ silent: true });
        await loadWallets();
      };

      await postRerun();

      while (rerunLoopRef.current && aliveRef.current) {
        let reachedTerminalForLoop = false;
        for (;;) {
          if (!rerunLoopRef.current || !aliveRef.current) break;
          const gr = await fetch(`/api/airdrop/jobs/${jobId}`, { headers: authHeaders() });
          if (gr.ok) {
            const body = (await gr.json()) as { job?: BatchJob };
            const j = body.job;
            if (j) {
              const st = String(j.status).toLowerCase();
              if (terminal.has(st)) {
                reachedTerminalForLoop = true;
                break;
              }
              if (st === "paused") break;
            }
          }
          await new Promise((r) => setTimeout(r, 2000));
        }
        if (!rerunLoopRef.current || !aliveRef.current) break;
        if (!reachedTerminalForLoop) break;
        await postRerun();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Rerun failed");
    } finally {
      setBusy(false);
    }
  }, [jobId, authHeaders, loadJob, loadWallets]);

  async function retryFailedRecipients() {
    if (!jobId || !sessionToken) return;
    setBusy(true);
    setError("");
    try {
      await parseApiJson(
        await fetch(`/api/airdrop/jobs/${jobId}/queue`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ scheduledAt: null }),
        }),
        "Failed to retry failed recipients",
      );
      await loadJob({ silent: true });
      await loadWallets();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Retry failed");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void loadJob({ silent: true });
  }, [loadJob]);

  const active = job && ["running", "queued", "paused"].includes(String(job.status).toLowerCase());
  useEffect(() => {
    if (!active || !sessionToken) return;
    const t = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void loadJob({ silent: true });
      if (!legacyResultsRef.current) void loadWallets();
    }, 5000);
    return () => clearInterval(t);
  }, [active, sessionToken, loadJob, loadWallets]);

  const jobChainId = job?.chainId ?? MAKALU_CHAIN_ID_DECIMAL;
  const jobExplorerBase = explorerUrlForChainId(jobChainId).replace(/\/$/, "");

  const totalPages = Math.max(1, Math.ceil((job?.results.length ?? 0) / LIST_PAGE_SIZE));
  const pagedResults = useMemo(() => {
    if (!job?.results.length) return [];
    const from = (resultPage - 1) * LIST_PAGE_SIZE;
    return job.results.slice(from, from + LIST_PAGE_SIZE);
  }, [job?.results, resultPage]);

  useEffect(() => {
    setResultPage((p) => Math.min(Math.max(1, p), totalPages));
  }, [job?.results.length, totalPages]);

  const displayRows = legacyResultsMode ? pagedResults : walletRows;
  const tablePagination = legacyResultsMode
    ? {
        page: resultPage,
        totalPages,
        totalItems: job?.results.length ?? 0,
        onPageChange: setResultPage,
      }
    : {
        page: walletPage,
        totalPages: walletTotalPages,
        totalItems: walletTotalMatching,
        onPageChange: setWalletPage,
      };

  const stats = job?.stats;

  async function post(path: string, label: string) {
    if (!jobId || !sessionToken) return;
    setBusy(true);
    setError("");
    try {
      await parseApiJson(await fetch(path, { method: "POST", headers: authHeaders() }), label);
      await loadJob({ silent: true });
      await loadWallets();
    } catch (e) {
      setError(e instanceof Error ? e.message : label);
    } finally {
      setBusy(false);
    }
  }

  const jobSt = job ? String(job.status).toLowerCase() : "";
  const isCancelled = jobSt === "cancelled";
  const canRerunFromTerminal = ["completed", "failed"].includes(jobSt);
  const canToggleRerunLoop =
    canRerunFromTerminal || (["running", "queued", "paused"].includes(jobSt) && rerunLoop);
  const failedRecipientCount =
    stats?.failedWallets ?? job?.results.filter((r) => r.status === "failed").length ?? 0;
  const showCancelInHistory = jobSt === "queued" || jobSt === "running";
  const showStop = jobSt === "running" || jobSt === "queued";
  const showResume = jobSt === "paused";

  if (!sessionToken) {
    return (
      <div className="min-h-full bg-slate-50 p-6 dark:bg-[#000000]">
        <p className="text-sm text-slate-600 dark:text-slate-400">Redirecting…</p>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-slate-50 p-6 dark:bg-[#000000]">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link
            href="/dashboard/jobs"
            className="inline-flex items-center rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium hover:bg-slate-50 dark:border-[#333333] dark:hover:bg-[#1a1a1a]"
          >
            ← Jobs list
          </Link>
          <Button
            type="button"
            variant="outline"
            className="h-9 rounded-xl px-3"
            disabled={busy || !job || jobRefreshing}
            onClick={() => void loadJob({ silent: false })}
          >
            <RefreshCw className={cn("mr-2 h-4 w-4", jobRefreshing && "animate-spin")} />
            {jobRefreshing ? "Refreshing…" : "Refresh"}
          </Button>
        </div>

        {error ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
            {error}
          </div>
        ) : null}

        {queueClaimBlockers.length > 0 ? (
          <div className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-100">
            <p className="font-semibold">Queue will not process wallets until this is fixed</p>
            <ul className="mt-2 list-inside list-disc space-y-1">
              {queueClaimBlockers.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {queueClaimBlockers.length === 0 && embeddedWorkerBlockers.length > 0 ? (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-800 dark:border-[#333333] dark:bg-[#141414] dark:text-slate-200">
            <p className="font-medium">In-app embedded queue worker is off</p>
            <ul className="mt-2 list-inside list-disc space-y-1 text-slate-600 dark:text-slate-400">
              {embeddedWorkerBlockers.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
              Jobs still process if you run a separate worker on the server:{" "}
              <code className="rounded bg-slate-200 px-1 dark:bg-[#222]">npm run worker:queue</code> with the same{" "}
              <code className="rounded bg-slate-200 px-1 dark:bg-[#222]">.env</code>.
            </p>
          </div>
        ) : null}

        {job ? (
          <Card className="rounded-2xl shadow-sm">
            <CardHeader>
              <CardTitle className="flex flex-wrap items-start justify-between gap-3 text-xl">
                <span className="break-all font-mono text-base font-semibold">{job.jobId}</span>
                <span className="shrink-0 rounded-lg bg-slate-100 px-3 py-1 text-sm font-semibold uppercase dark:bg-[#222222]">
                  {job.status}
                </span>
              </CardTitle>
              <p className="text-sm text-slate-600 dark:text-slate-400">
                {new Date(job.createdAt).toLocaleString()} · {chainDisplayLabel(job.chainId)} ·{" "}
                <span className="uppercase">{job.mode}</span>
                {jobSt === "queued" && typeof job.queuePosition === "number" ? ` · queue #${job.queuePosition}` : ""}
                {" · "}
                {job.loopForever ? "continuous loop" : `pass ${job.currentRun ?? 1}/${job.targetRunCount ?? 1}`}
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                {jobSt === "draft" ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void post(`/api/airdrop/jobs/${jobId}/start`, "Failed to queue job")}
                  >
                    Run now
                  </Button>
                ) : null}
                {showStop ? (
                  <Button type="button" variant="default" disabled={busy} onClick={() => void post(`/api/airdrop/jobs/${jobId}/pause`, "Failed to pause")}>
                    Stop
                  </Button>
                ) : null}
                {showResume ? (
                  <Button type="button" variant="default" disabled={busy} onClick={() => void post(`/api/airdrop/jobs/${jobId}/resume`, "Failed to resume")}>
                    Resume
                  </Button>
                ) : null}
                {showCancelInHistory ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="border-red-300 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
                    disabled={busy}
                    onClick={() => void post(`/api/airdrop/jobs/${jobId}/cancel`, "Failed to cancel")}
                  >
                    <Ban className="mr-2 h-4 w-4" />
                    Cancel job
                  </Button>
                ) : null}
                {!isCancelled && (jobSt === "running" || jobSt === "queued" || jobSt === "paused") ? (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      setError("");
                      try {
                        const head = await fetch(`/api/airdrop/jobs/${jobId}`, { headers: authHeaders() });
                        const { job: current } = await parseApiJson<{ job: BatchJob }>(head, "Failed to load job");
                        const st = String(current.status).toLowerCase();
                        if (st === "running" || st === "queued") {
                          await parseApiJson(
                            await fetch(`/api/airdrop/jobs/${jobId}/pause`, { method: "POST", headers: authHeaders() }),
                            "Failed to stop job",
                          );
                          for (let i = 0; i < 40; i++) {
                            await new Promise((r) => setTimeout(r, 500));
                            const gr = await fetch(`/api/airdrop/jobs/${jobId}`, { headers: authHeaders() });
                            const { job: j1 } = await parseApiJson<{ job: BatchJob }>(gr, "Failed to load job");
                            const s1 = String(j1.status).toLowerCase();
                            if (s1 === "paused" || s1 === "completed" || s1 === "failed" || s1 === "cancelled") break;
                          }
                        }
                        await parseApiJson(
                          await fetch(`/api/airdrop/jobs/${jobId}/rerun`, { method: "POST", headers: authHeaders() }),
                          "Failed to restart job",
                        );
                        await loadJob({ silent: true });
                      } catch (e) {
                        setError(e instanceof Error ? e.message : "Restart failed");
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Restart
                  </Button>
                ) : null}
                {!isCancelled ? (
                  <Button type="button" variant="default" disabled={busy || !canRerunFromTerminal} onClick={() => void rerunEntireJob()}>
                    Rerun job
                  </Button>
                ) : null}
                {!isCancelled ? (
                  <label
                    className={cn(
                      "flex cursor-pointer items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400",
                      canToggleRerunLoop ? "" : "cursor-not-allowed opacity-50",
                    )}
                    title="When checked, after this job fully finishes (completed / failed), rerun starts again automatically until you uncheck."
                  >
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 rounded border-slate-400 accent-slate-900 dark:accent-slate-100"
                      checked={rerunLoop}
                      onChange={(e) => setRerunLoop(e.target.checked)}
                      disabled={!canToggleRerunLoop || isCancelled}
                    />
                    Loop
                  </label>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || failedRecipientCount === 0}
                  onClick={() => void retryFailedRecipients()}
                >
                  Retry failed only
                </Button>
              </div>

              {stats ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-4 text-sm dark:border-[#222222] dark:bg-[#141414]">
                  <div className="flex flex-wrap gap-x-6 gap-y-2">
                    <span>
                      Progress: <strong>{stats.progressPercent}%</strong>
                    </span>
                    <span>
                      Completed: <strong>{stats.processedWallets}</strong>
                    </span>
                    <span>
                      Failed: <strong>{stats.failedWallets}</strong>
                    </span>
                    <span>
                      Pending: <strong>{stats.pendingWallets}</strong>
                    </span>
                    <span>
                      In flight: <strong>{stats.processingWallets}</strong>
                    </span>
                    <span
                      title="Distinct assigned_worker IDs on rows in “processing”. Often 0 when nothing is claiming or between batches — use “In flight” for live row count."
                      className="cursor-help border-b border-dotted border-slate-400 dark:border-slate-500"
                    >
                      Claiming IDs: <strong>{stats.activeWorkers}</strong>
                    </span>
                  </div>
                  <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-[#333333]">
                    <div
                      className="h-full rounded-full bg-emerald-500 transition-[width] duration-300"
                      style={{ width: `${stats.progressPercent}%` }}
                    />
                  </div>
                </div>
              ) : null}

              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-[140px]">
                  <label className="mb-1 block text-xs text-slate-500 dark:text-slate-400">Status</label>
                  <select
                    className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm dark:border-[#333333] dark:bg-[#111111]"
                    value={walletStatusFilter}
                    onChange={(e) => setWalletStatusFilter(e.target.value)}
                    disabled={legacyResultsMode}
                  >
                    <option value="">All</option>
                    <option value="pending">pending</option>
                    <option value="processing">processing</option>
                    <option value="completed">completed</option>
                    <option value="failed">failed</option>
                  </select>
                </div>
                <div className="min-w-[200px] flex-1">
                  <label className="mb-1 block text-xs text-slate-500 dark:text-slate-400">Search wallet</label>
                  <Input
                    className="h-10 rounded-xl"
                    placeholder="0x…"
                    value={walletSearch}
                    onChange={(e) => setWalletSearch(e.target.value)}
                    disabled={legacyResultsMode}
                  />
                </div>
                {walletLoading ? <span className="pb-2 text-xs text-slate-500">Updating rows…</span> : null}
              </div>

              <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-[#222222]">
                <table className="w-full min-w-[820px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs text-slate-500 dark:border-[#222222] dark:text-slate-400">
                      <th className="p-3 font-medium">Recipient</th>
                      <th className="p-3 font-medium">Signer</th>
                      <th className="p-3 font-medium">Amount</th>
                      <th className="p-3 font-medium">Status</th>
                      <th className="p-3 font-medium">RPC</th>
                      <th className="p-3 font-medium">Transaction</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayRows.map((r, i) => {
                      const rowKey = "id" in r && typeof r.id === "number" ? `w-${r.id}` : `l-${r.recipient}-${i}`;
                      const st = r.status;
                      return (
                        <tr key={rowKey} className="border-b border-slate-100 dark:border-[#222222]/80">
                          <td className="p-3 font-mono text-xs">{shortAddr(r.recipient)}</td>
                          <td className="p-3 font-mono text-xs">{r.signerAddress ? shortAddr(r.signerAddress) : "—"}</td>
                          <td className="p-3">{r.amount}</td>
                          <td className="p-3">
                            <span
                              className={cn(
                                "rounded-md px-2 py-0.5 text-xs font-medium",
                                st === "success" && "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
                                st === "failed" && "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300",
                                st !== "success" &&
                                  st !== "failed" &&
                                  "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
                              )}
                            >
                              {st}
                            </span>
                            {r.error ? <div className="mt-1 max-w-sm text-xs text-red-600 dark:text-red-400">{r.error}</div> : null}
                          </td>
                          <td className="p-3 font-mono text-xs" title={r.rpcUrl}>
                            {rpcEndpointLabel(r.rpcUrl)}
                          </td>
                          <td className="p-3">
                            {r.txHash ? (
                              <a
                                href={`${jobExplorerBase}/tx/${r.txHash}`}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 break-all text-xs font-medium text-sky-600 underline dark:text-sky-400"
                              >
                                {shortAddr(r.txHash)}
                                <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
                              </a>
                            ) : (
                              <span className="text-xs text-slate-400">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {!legacyResultsMode && !walletLoading && displayRows.length === 0 ? (
                <p className="text-center text-sm text-slate-500 dark:text-slate-400">No wallet rows match this filter.</p>
              ) : null}
              {legacyResultsMode && (job.results?.length ?? 0) === 0 ? (
                <p className="text-center text-sm text-slate-500 dark:text-slate-400">No execution results yet.</p>
              ) : null}

              {tablePagination.totalItems > LIST_PAGE_SIZE ? (
                <ListPagination
                  page={tablePagination.page}
                  totalPages={tablePagination.totalPages}
                  totalItems={tablePagination.totalItems}
                  pageSize={LIST_PAGE_SIZE}
                  onPageChange={tablePagination.onPageChange}
                  className="border-t-0 pt-2"
                />
              ) : null}
            </CardContent>
          </Card>
        ) : !error ? (
          <p className="text-sm text-slate-600 dark:text-slate-400">Loading job…</p>
        ) : null}
      </div>
    </div>
  );
}
