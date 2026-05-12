"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, History, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ListPagination } from "@/components/ui/list-pagination";
import { HISTORY_JOBS_PAGE_SIZE, LIST_PAGE_SIZE } from "@/lib/list-page-size";
import { explorerUrlForChainId, MAKALU_CHAIN_ID_DECIMAL, rpcEndpointLabel } from "@/lib/chain";
import { cn } from "@/lib/utils";

type BatchResult = {
  recipient: string;
  amount: string;
  txHash?: string;
  status: string;
  error?: string;
  rpcUrl?: string;
};

type HistoryJob = {
  jobId: string;
  status: string;
  mode: string;
  tokenAddress?: string;
  createdAt: string;
  chainId?: number;
  results: BatchResult[];
};

function shortAddr(address: string) {
  if (!address) return "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

type Props = {
  open: boolean;
  onClose: () => void;
  sessionToken: string;
  sessionVerified: boolean;
};

export function AirdropHistory({ open, onClose, sessionToken, sessionVerified }: Props) {
  const [jobs, setJobs] = useState<HistoryJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [page, setPage] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [resultPageByJob, setResultPageByJob] = useState<Record<string, number>>({});

  const load = useCallback(
    async (pageNum: number) => {
      if (!sessionToken) return;
      setLoading(true);
      setLoadError("");
      try {
        const res = await fetch(
          `/api/airdrop/history?page=${pageNum}&limit=${HISTORY_JOBS_PAGE_SIZE}&_=${Date.now()}`,
          {
            headers: { Authorization: `Bearer ${sessionToken}` },
            cache: "no-store",
          },
        );
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error || `Failed to load (${res.status})`);
        }
        const data = (await res.json()) as {
          jobs?: HistoryJob[];
          total?: number;
          page?: number;
          totalPages?: number;
        };
        setJobs(data.jobs ?? []);
        setTotalItems(data.total ?? 0);
        setTotalPages(Math.max(1, data.totalPages ?? 1));
        setPage(data.page ?? pageNum);
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : "Failed to load history");
        setJobs([]);
      } finally {
        setLoading(false);
      }
    },
    [sessionToken],
  );

  useEffect(() => {
    if (!open || !sessionVerified || !sessionToken) return;
    setPage(1);
    setExpanded({});
    setResultPageByJob({});
    void load(1);
  }, [open, sessionVerified, sessionToken, load]);

  useEffect(() => {
    setResultPageByJob({});
  }, [page]);

  if (!open) return null;

  const goToPage = (p: number) => {
    setPage(p);
    void load(p);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-8 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="airdrop-history-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative mb-8 w-full max-w-4xl rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-[#222222] dark:bg-[#111111]">
        <div className="flex items-center justify-between gap-4 border-b border-slate-200 px-5 py-4 dark:border-[#222222]">
          <h2 id="airdrop-history-title" className="flex items-center gap-2 text-lg font-semibold text-slate-900 dark:text-slate-100">
            <History className="h-5 w-5" />
            Airdrop history
          </h2>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-9 rounded-xl px-3 text-sm"
              onClick={() => void load(page)}
              disabled={loading || !sessionToken}
            >
              <span className={cn(loading && "opacity-60")}>Refresh</span>
            </Button>
            <Button type="button" variant="ghost" size="icon" className="rounded-xl" onClick={onClose} aria-label="Close">
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>

        <div className="max-h-[min(70vh,640px)] overflow-y-auto p-5">
          {!sessionVerified || !sessionToken ? (
            <p className="text-sm text-slate-600 dark:text-slate-400">Verify your wallet session to view history.</p>
          ) : loading ? (
            <p className="text-sm text-slate-600 dark:text-slate-400">Loading…</p>
          ) : loadError ? (
            <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>
          ) : jobs.length === 0 ? (
            <p className="text-sm text-slate-600 dark:text-slate-400">No jobs yet. Create a batch job and start it to see history here.</p>
          ) : (
            <>
              <ul className="space-y-3">
                {jobs.map((job) => {
                  const ok = job.results.filter((r) => r.status === "success").length;
                  const fail = job.results.filter((r) => r.status === "failed").length;
                  const isOpen = expanded[job.jobId] ?? false;
                  const rp = resultPageByJob[job.jobId] ?? 1;
                  const resultTotalPages = Math.max(1, Math.ceil(job.results.length / LIST_PAGE_SIZE));
                  const rFrom = (rp - 1) * LIST_PAGE_SIZE;
                  const pagedResults = job.results.slice(rFrom, rFrom + LIST_PAGE_SIZE);

                  return (
                    <li
                      key={job.jobId}
                      className="rounded-2xl border border-slate-200 bg-slate-50/80 dark:border-[#222222] dark:bg-[#111111]"
                    >
                      <button
                        type="button"
                        className="flex w-full items-start gap-3 rounded-2xl p-4 text-left transition-colors hover:bg-slate-100/80 dark:hover:bg-[#1a1a1a]"
                        onClick={() => setExpanded((e) => ({ ...e, [job.jobId]: !isOpen }))}
                      >
                        {isOpen ? (
                          <ChevronDown className="mt-0.5 h-5 w-5 shrink-0 text-slate-500" aria-hidden />
                        ) : (
                          <ChevronRight className="mt-0.5 h-5 w-5 shrink-0 text-slate-500" aria-hidden />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="secondary" className="rounded-lg uppercase">
                              {job.status}
                            </Badge>
                            <span className="text-sm font-medium text-slate-800 dark:text-slate-200">{job.mode}</span>
                            <span className="text-xs text-slate-500 dark:text-slate-400">
                              {new Date(job.createdAt).toLocaleString()}
                            </span>
                          </div>
                          <div className="mt-1 truncate font-mono text-xs text-slate-600 dark:text-slate-400" title={job.jobId}>
                            {job.jobId}
                          </div>
                          <div className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                            {job.results.length} recipients ·{" "}
                            <span className="text-emerald-600 dark:text-emerald-400">{ok} ok</span>
                            {fail > 0 ? (
                              <>
                                {" "}
                                · <span className="text-red-600 dark:text-red-400">{fail} failed</span>
                              </>
                            ) : null}
                          </div>
                          {job.mode === "erc20" && job.tokenAddress ? (
                            <div className="mt-1 truncate font-mono text-xs text-slate-500" title={job.tokenAddress}>
                              Token: {job.tokenAddress}
                            </div>
                          ) : null}
                        </div>
                      </button>

                      {isOpen && (
                        <div className="border-t border-slate-200 px-4 pb-4 pt-0 dark:border-slate-800">
                          <div className="overflow-x-auto pl-8 pt-3">
                            <table className="w-full min-w-[640px] text-left text-sm">
                              <thead>
                                <tr className="border-b border-slate-200 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
                                  <th className="pb-2 pr-3 font-medium">Wallet</th>
                                  <th className="pb-2 pr-3 font-medium">Amount</th>
                                  <th className="pb-2 pr-3 font-medium">Status</th>
                                  <th className="pb-2 pr-3 font-medium">RPC</th>
                                  <th className="pb-2 font-medium">Transaction</th>
                                </tr>
                              </thead>
                              <tbody>
                                {pagedResults.map((r, i) => (
                                  <tr key={`${r.recipient}-${rFrom + i}`} className="border-b border-slate-100 dark:border-[#222222]/80">
                                    <td className="py-2 pr-3 font-mono text-xs" title={r.recipient}>
                                      {shortAddr(r.recipient)}
                                    </td>
                                    <td className="py-2 pr-3">{r.amount}</td>
                                    <td className="py-2 pr-3">
                                      <span
                                        className={cn(
                                          "rounded-md px-2 py-0.5 text-xs font-medium",
                                          r.status === "success" && "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
                                          r.status === "failed" && "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300",
                                          r.status !== "success" &&
                                            r.status !== "failed" &&
                                            "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
                                        )}
                                      >
                                        {r.status}
                                      </span>
                                      {r.error ? (
                                        <div className="mt-1 max-w-xs text-xs text-red-600 dark:text-red-400">{r.error}</div>
                                      ) : null}
                                    </td>
                                    <td className="py-2 pr-3 font-mono text-xs" title={r.rpcUrl}>
                                      {rpcEndpointLabel(r.rpcUrl)}
                                    </td>
                                    <td className="py-2">
                                      {r.txHash ? (
                                        <a
                                          href={`${explorerUrlForChainId(job.chainId ?? MAKALU_CHAIN_ID_DECIMAL).replace(/\/$/, "")}/tx/${r.txHash}`}
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
                                ))}
                              </tbody>
                            </table>
                          </div>
                          {job.results.length > LIST_PAGE_SIZE ? (
                            <div className="pl-8 pr-2 pt-2">
                              <ListPagination
                                page={rp}
                                totalPages={resultTotalPages}
                                totalItems={job.results.length}
                                pageSize={LIST_PAGE_SIZE}
                                onPageChange={(next) =>
                                  setResultPageByJob((prev) => ({ ...prev, [job.jobId]: next }))
                                }
                                className="border-t-0 pt-2"
                              />
                            </div>
                          ) : null}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
              <ListPagination
                page={page}
                totalPages={totalPages}
                totalItems={totalItems}
                pageSize={HISTORY_JOBS_PAGE_SIZE}
                onPageChange={goToPage}
                disabled={loading}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
