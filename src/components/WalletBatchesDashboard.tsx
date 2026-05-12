"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ListPagination } from "@/components/ui/list-pagination";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertCircle } from "lucide-react";
import { readResponseJson } from "@/lib/read-response-json";

const SESSION_KEY = "litho-airdrop-session";

type BatchRow = {
  id: string;
  name: string;
  totalWallets: number;
  insertedWallets: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
};

type WalletRow = { id: string; walletIndex: number; address: string; createdAt: string };

function loadToken(): string {
  if (typeof window === "undefined") return "";
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return "";
    const p = JSON.parse(raw) as { token?: string };
    return typeof p.token === "string" ? p.token : "";
  } catch {
    return "";
  }
}

export default function WalletBatchesDashboard() {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const pageSize = 30;

  const [newName, setNewName] = useState("");
  const [newCount, setNewCount] = useState("1000");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BatchRow | null>(null);
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [wPage, setWPage] = useState(1);
  const [wTotal, setWTotal] = useState(0);
  const [wSearch, setWSearch] = useState("");
  const wLimit = 50;

  useEffect(() => {
    setToken(loadToken());
  }, []);

  const headers = useCallback((): HeadersInit => {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }, [token]);

  const loadBatches = useCallback(async () => {
    if (!token) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/airdrop/wallet-batches?page=${page}`, { headers: headers() });
      const data = await readResponseJson<{ batches?: BatchRow[]; total?: number; error?: string }>(res);
      if (!res.ok) throw new Error(data.error || `Failed to load batches (${res.status})`);
      setBatches(data.batches ?? []);
      setTotal(Number(data.total ?? 0));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setBusy(false);
    }
  }, [token, page, headers]);

  useEffect(() => {
    void loadBatches();
  }, [loadBatches]);

  const openDetail = async (id: string) => {
    setSelectedId(id);
    setWPage(1);
    setWSearch("");
    setDetail(null);
    setWallets([]);
    if (!token) return;
    try {
      const res = await fetch(`/api/airdrop/wallet-batches/${id}`, { headers: headers() });
      const data = await readResponseJson<{ batch?: BatchRow; error?: string }>(res);
      if (!res.ok) throw new Error(data.error || `Not found (${res.status})`);
      if (data.batch) setDetail(data.batch as unknown as BatchRow);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Detail failed");
    }
  };

  const loadWallets = useCallback(async () => {
    if (!token || !selectedId) return;
    const q = wSearch.trim() ? `&q=${encodeURIComponent(wSearch.trim())}` : "";
    const res = await fetch(
      `/api/airdrop/wallet-batches/${selectedId}/wallets?page=${wPage}&limit=${wLimit}${q}`,
      { headers: headers() },
    );
    const data = await readResponseJson<{ wallets?: WalletRow[]; total?: number; error?: string }>(res);
    if (!res.ok) throw new Error(data.error || `Failed to load wallets (${res.status})`);
    setWallets(data.wallets ?? []);
    setWTotal(Number(data.total ?? 0));
  }, [token, selectedId, wPage, wSearch, headers]);

  useEffect(() => {
    if (!selectedId || !token) return;
    void loadWallets().catch((e) => setError(e instanceof Error ? e.message : "Wallets failed"));
  }, [selectedId, token, wPage, wSearch, loadWallets]);

  async function createBatch() {
    if (!token) {
      setError("Verify session on Session / Wallet first.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const n = parseInt(newCount, 10);
      const res = await fetch("/api/airdrop/wallet-batches", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ name: newName.trim(), totalWallets: n }),
      });
      const data = await readResponseJson<{ error?: string; batchId?: string }>(res);
      if (!res.ok) throw new Error(data.error || `Create failed (${res.status})`);
      setNewName("");
      setNewCount("1000");
      await loadBatches();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  async function resumeBatch(id: string) {
    if (!token) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/airdrop/wallet-batches/${id}/resume`, {
        method: "POST",
        headers: headers(),
        body: "{}",
      });
      const data = await readResponseJson<{ error?: string; message?: string }>(res);
      if (!res.ok) throw new Error(data.error || `Resume failed (${res.status})`);
      await loadBatches();
      if (selectedId === id) await openDetail(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Resume failed");
    } finally {
      setBusy(false);
    }
  }

  function exportCsv() {
    if (!token || !selectedId) return;
    const u = new URL(`/api/airdrop/wallet-batches/${selectedId}/export`, window.location.origin);
    const h = new Headers();
    if (token) h.set("Authorization", `Bearer ${token}`);
    void fetch(u.toString(), { headers: h }).then(async (res) => {
      if (!res.ok) {
        setError("Export failed");
        return;
      }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "wallets-addresses.csv";
      a.click();
      URL.revokeObjectURL(a.href);
    });
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const wTotalPages = Math.max(1, Math.ceil(wTotal / wLimit));

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">Wallet batches</h1>
        <Link href="/dashboard/session" className="text-sm text-blue-600 underline dark:text-blue-400">
          Session / Wallet
        </Link>
      </div>

      {error ? (
        <Alert className="rounded-2xl border-red-300 bg-red-50 dark:border-red-900/50 dark:bg-red-950/40">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Card className="rounded-2xl shadow-sm">
        <CardHeader>
          <CardTitle>Create batch</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label>Name</Label>
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Litho recipients Q1" className="w-64" />
          </div>
          <div className="space-y-1">
            <Label>Number of wallets</Label>
            <Input inputMode="numeric" value={newCount} onChange={(e) => setNewCount(e.target.value)} className="w-36" />
          </div>
          <Button type="button" onClick={() => void createBatch()} disabled={busy || !newName.trim() || !token}>
            Start (pending)
          </Button>
        </CardContent>
      </Card>

      <Card className="rounded-2xl shadow-sm">
        <CardHeader>
          <CardTitle>Batches</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {!token ? (
            <p className="text-sm text-slate-600 dark:text-slate-400">Connect and verify session to manage batches.</p>
          ) : batches.length === 0 ? (
            <p className="text-sm text-slate-600 dark:text-slate-400">No batches yet.</p>
          ) : (
            <ul className="divide-y divide-slate-200 dark:divide-[#333]">
              {batches.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                  <div>
                    <div className="font-medium">{b.name}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {b.status} · {b.insertedWallets.toLocaleString()} / {b.totalWallets.toLocaleString()} ·{" "}
                      {new Date(b.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {b.status === "running" && b.insertedWallets < b.totalWallets ? (
                      <Button
                        type="button"
                        variant="secondary"
                        className="h-8 rounded-xl px-3 text-xs"
                        disabled={busy}
                        onClick={() => void resumeBatch(b.id)}
                      >
                        Resume
                      </Button>
                    ) : null}
                    <Button type="button" variant="outline" className="h-8 rounded-xl px-3 text-xs" onClick={() => void openDetail(b.id)}>
                      View
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <ListPagination page={page} totalPages={totalPages} totalItems={total} pageSize={pageSize} onPageChange={setPage} />
        </CardContent>
      </Card>

      {selectedId && detail ? (
        <Card className="rounded-2xl shadow-sm">
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center justify-between gap-2">
              <span>{detail.name}</span>
              <Button type="button" variant="ghost" className="h-8 rounded-xl px-2 text-xs" onClick={() => setSelectedId(null)}>
                Close
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <span className="text-slate-500">Status</span> <span className="font-medium">{detail.status}</span>
              </div>
              <div>
                <span className="text-slate-500">Progress</span>{" "}
                <span className="font-medium">
                  {detail.insertedWallets} / {detail.totalWallets}
                </span>
              </div>
              <div className="sm:col-span-2">
                <span className="text-slate-500">Range for jobs</span>{" "}
                <span className="font-mono">1 … {detail.totalWallets}</span> (1-based inclusive)
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {detail.status === "running" && detail.insertedWallets < detail.totalWallets ? (
                <Button type="button" variant="secondary" className="rounded-xl" disabled={busy || !token} onClick={() => void resumeBatch(detail.id)}>
                  Resume generation
                </Button>
              ) : null}
              <Button type="button" variant="outline" className="rounded-xl" onClick={() => exportCsv()} disabled={!token}>
                Export CSV (addresses)
              </Button>
            </div>
            <div className="space-y-2">
              <Label>Search address</Label>
              <div className="flex max-w-md gap-2">
                <Input value={wSearch} onChange={(e) => setWSearch(e.target.value)} placeholder="0x…" />
                <Button type="button" variant="secondary" onClick={() => setWPage(1)}>
                  Search
                </Button>
              </div>
              <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-[#333]">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 dark:bg-[#141414]">
                    <tr>
                      <th className="px-2 py-2">#</th>
                      <th className="px-2 py-2">Address</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wallets.map((w) => (
                      <tr key={w.id} className="border-t border-slate-100 dark:border-[#222]">
                        <td className="px-2 py-2 font-mono">{w.walletIndex}</td>
                        <td className="px-2 py-2 font-mono">{w.address}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ListPagination page={wPage} totalPages={wTotalPages} totalItems={wTotal} pageSize={wLimit} onPageChange={setWPage} />
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Alert className="rounded-2xl border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/30">
        <AlertCircle className="h-4 w-4 text-amber-800 dark:text-amber-200" />
        <AlertTitle className="text-amber-900 dark:text-amber-100">Background worker</AlertTitle>
        <AlertDescription className="text-amber-900/90 dark:text-amber-100/90">
          After creating a batch, run <code className="rounded bg-white/70 px-1 font-mono dark:bg-black/40">npm run wallets:generate</code> on
          the server until status becomes <strong>completed</strong>. If the process stops mid-batch, status may stay <strong>running</strong> —
          restarting the command resumes automatically; you can also use <strong>Resume</strong> to set the batch back to <strong>pending</strong>.
          Then create an airdrop job from Dashboard → Airdrop and choose &quot;Saved PostgreSQL wallet batch&quot;.
        </AlertDescription>
      </Alert>
    </div>
  );
}
