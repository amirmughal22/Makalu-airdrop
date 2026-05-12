"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { numberToHex } from "viem";
import { CheckCircle2, FileText, Play, RefreshCw, Wallet } from "lucide-react";
import { NetworkConfigGrid } from "@/components/NetworkConfigGrid";
import { FloatingErrorNotice } from "@/components/FloatingErrorNotice";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { clientRandomAmountsInRangeNative, clientRandomAmountsInRangeToken } from "@/lib/client-random-amounts";
import {
  addressesInExecutionRange,
  executionAddressListsEqual,
  rangeEndpointsFromAddresses,
} from "@/lib/execution-wallet-range";
import { buildMixRotationRecipients, orderedSelectedWallets } from "@/lib/mix-rotation";
import { lithoUiNetwork } from "@/lib/chain";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const SESSION_STORAGE_KEY = "litho-airdrop-session";
const EXECUTION_WALLETS_STORAGE_KEY = "litho-airdrop-execution-wallets";
const MIX_MAX_LOOPS = 200;

type DistributorWalletMeta = {
  address: string;
  label: string;
  createdAt: string;
  source: "primary" | "added" | "hd-generated";
  balanceNative?: string;
  balanceWei?: string;
};

type BatchJob = {
  jobId: string;
  signerAddress?: string;
  signerAddresses?: string[];
  status: string;
  mode: "native" | "erc20";
  tokenAddress?: string;
  chainId?: number;
  results: { recipient: string; amount: string; status: string }[];
  createdAt: string;
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

function loadStoredExecutionWalletAddresses(ownerLower: string): string[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(`${EXECUTION_WALLETS_STORAGE_KEY}:${ownerLower}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const out = parsed
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    return out.length ? out : null;
  } catch {
    return null;
  }
}

function shortAddr(address?: string) {
  if (!address) return "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatError(error: unknown) {
  if (error && typeof error === "object") {
    const o = error as Record<string, unknown>;
    return String(o.message ?? o.shortMessage ?? o.reason ?? "Unknown error");
  }
  return "Unknown error";
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
      typeof (parsed as { error?: unknown }).error === "string" ? String((parsed as { error: string }).error).trim() : "";
    throw new Error(msg || `${fallback} (HTTP ${res.status})`);
  }
  return parsed as T;
}

async function ensureLithoNetwork(ui: ReturnType<typeof lithoUiNetwork>) {
  const eth = window.ethereum;
  if (!eth) throw new Error("No injected wallet found");
  const chainIdHex = numberToHex(ui.chainId);
  const currentChainId = ((await eth.request({ method: "eth_chainId" })) as string).toLowerCase();
  if (currentChainId === chainIdHex.toLowerCase()) return;

  try {
    await eth.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex }],
    });
  } catch (switchError: unknown) {
    const code = switchError && typeof switchError === "object" && "code" in switchError ? (switchError as { code: number }).code : null;
    if (code !== 4902) throw switchError;

    await eth.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: chainIdHex,
          chainName: ui.name,
          rpcUrls: [ui.rpcUrl],
          nativeCurrency: {
            name: ui.nativeCurrency.name,
            symbol: ui.nativeCurrency.symbol,
            decimals: ui.nativeCurrency.decimals,
          },
          blockExplorerUrls: [ui.explorerUrl],
        },
      ],
    });
  }
}

export default function MixDropSuite() {
  const sessionHydratedRef = useRef(false);
  const [account, setAccount] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [sessionVerified, setSessionVerified] = useState(false);
  const [sessionAddress, setSessionAddress] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [distributorWallets, setDistributorWallets] = useState<DistributorWalletMeta[]>([]);
  const [selectedDistributorAddresses, setSelectedDistributorAddresses] = useState<string[]>([]);
  const [mixRotationWalletFrom, setMixRotationWalletFrom] = useState("");
  const [mixRotationWalletTo, setMixRotationWalletTo] = useState("");
  const selectedDistributorAddressesRef = useRef<string[]>([]);
  const [balancesRefreshing, setBalancesRefreshing] = useState(false);
  const [mode, setMode] = useState<"native" | "erc20">("native");
  const [tokenAddress, setTokenAddress] = useState("");
  const [minPerWallet, setMinPerWallet] = useState("1");
  const [maxPerWallet, setMaxPerWallet] = useState("10");
  const [loopCount, setLoopCount] = useState("1");
  const [shuffleRecipients, setShuffleRecipients] = useState(false);
  const [batchJob, setBatchJob] = useState<BatchJob | null>(null);
  const [nonceQueueEnabled] = useState(true);
  const [hsmModeEnabled] = useState(true);
  const [status, setStatus] = useState("idle");

  const net = useMemo(() => lithoUiNetwork(), []);

  const authHeaders = useCallback(
    (tokenOverride?: string): HeadersInit => {
      const h: Record<string, string> = { "Content-Type": "application/json" };
      const token = tokenOverride ?? sessionToken;
      if (token) h.Authorization = `Bearer ${token}`;
      return h;
    },
    [sessionToken]
  );

  const clearSessionState = useCallback(() => {
    setSessionToken("");
    setSessionVerified(false);
    setSessionAddress("");
    setSelectedDistributorAddresses([]);
    setMixRotationWalletFrom("");
    setMixRotationWalletTo("");
    setDistributorWallets([]);
  }, []);

  const loadDistributorWallets = useCallback(
    async (tokenOverride?: string, options?: { preferredAddress?: string; ownerForStorage?: string }) => {
      const o = options ?? {};
      const res = await fetch("/api/distributor-wallets", { headers: authHeaders(tokenOverride) });
      if (!res.ok) throw new Error("Failed to load distributor wallets");
      const data = (await res.json()) as { wallets: DistributorWalletMeta[] };
      const wallets = data.wallets ?? [];
      setDistributorWallets(wallets);
      if (!wallets.length) {
        setMixRotationWalletFrom("");
        setMixRotationWalletTo("");
        setSelectedDistributorAddresses([]);
        return;
      }
      const allowed = new Set(wallets.map((w) => w.address.toLowerCase()));
      const ownerKey = (o.ownerForStorage || sessionAddress || "").trim().toLowerCase();
      const storedLower = ownerKey ? loadStoredExecutionWalletAddresses(ownerKey) : null;
      let fromStored: string[] = [];
      if (storedLower?.length) {
        const seen = new Set<string>();
        for (const low of storedLower) {
          if (!allowed.has(low) || seen.has(low)) continue;
          const w = wallets.find((x) => x.address.toLowerCase() === low);
          if (w) {
            fromStored.push(w.address);
            seen.add(low);
          }
        }
      }

      let newFrom = wallets[0]!.address;
      let newTo = wallets[0]!.address;
      if (fromStored.length > 0) {
        const r = rangeEndpointsFromAddresses(wallets, fromStored);
        if (r) {
          newFrom = r.from;
          newTo = r.to;
        }
      } else {
        const prev = selectedDistributorAddressesRef.current.filter((a) => allowed.has(a.toLowerCase()));
        if (prev.length > 0) {
          const r = rangeEndpointsFromAddresses(wallets, prev);
          if (r) {
            newFrom = r.from;
            newTo = r.to;
          }
        } else {
          const pref = (o.preferredAddress || "").toLowerCase();
          if (pref && allowed.has(pref)) {
            const w = wallets.find((x) => x.address.toLowerCase() === pref)!;
            newFrom = w.address;
            newTo = w.address;
          }
        }
      }
      setMixRotationWalletFrom(newFrom);
      setMixRotationWalletTo(newTo);
    },
    [authHeaders, sessionAddress]
  );

  const refreshDistributorBalances = useCallback(async () => {
    if (!sessionVerified) return;
    try {
      setBalancesRefreshing(true);
      setError("");
      const chainId = net.chainId;
      const res = await fetch(`/api/distributor-wallets/balances?chainId=${chainId}`, { headers: authHeaders() });
      const data = await parseApiJson<{
        balances: Array<{ address: string; balanceNative: string; balanceWei: string }>;
      }>(res, "Failed to load balances");
      const byAddr = new Map(data.balances.map((b) => [b.address.toLowerCase(), b]));
      setDistributorWallets((prev) =>
        prev.map((w) => {
          const b = byAddr.get(w.address.toLowerCase());
          if (!b) return { ...w, balanceNative: undefined, balanceWei: undefined };
          return { ...w, balanceNative: b.balanceNative, balanceWei: b.balanceWei };
        })
      );
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBalancesRefreshing(false);
    }
  }, [sessionVerified, net.chainId, authHeaders]);

  useEffect(() => {
    if (sessionHydratedRef.current) return;
    sessionHydratedRef.current = true;
    const restore = async () => {
      const saved = loadStoredSession();
      if (!saved) return;
      setSessionToken(saved.token);
      setSessionVerified(true);
      setSessionAddress(saved.address);
      try {
        await loadDistributorWallets(saved.token, { ownerForStorage: saved.address, preferredAddress: saved.address });
      } catch {
        /* ignore */
      }
    };
    void restore();
    const eth = window.ethereum;
    if (!eth) return;
    void eth
      .request({ method: "eth_accounts" })
      .then((accounts) => {
        const list = Array.isArray(accounts) ? accounts : [];
        const next = (list[0] as string) || "";
        if (next) setAccount(next);
      })
      .catch(() => {});
  }, [loadDistributorWallets]);

  useEffect(() => {
    try {
      if (sessionVerified && sessionToken && sessionAddress) {
        localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ token: sessionToken, address: sessionAddress.toLowerCase() }));
      } else {
        localStorage.removeItem(SESSION_STORAGE_KEY);
      }
    } catch {
      /* ignore */
    }
  }, [sessionVerified, sessionToken, sessionAddress]);

  useEffect(() => {
    if (!sessionVerified || !sessionAddress || selectedDistributorAddresses.length === 0) return;
    try {
      localStorage.setItem(
        `${EXECUTION_WALLETS_STORAGE_KEY}:${sessionAddress.toLowerCase()}`,
        JSON.stringify(selectedDistributorAddresses),
      );
    } catch {
      /* ignore */
    }
  }, [sessionVerified, sessionAddress, selectedDistributorAddresses]);

  useEffect(() => {
    selectedDistributorAddressesRef.current = selectedDistributorAddresses;
  }, [selectedDistributorAddresses]);

  useEffect(() => {
    const wallets = distributorWallets;
    if (!wallets.length) {
      setSelectedDistributorAddresses([]);
      return;
    }
    let iFrom = wallets.findIndex((w) => w.address.toLowerCase() === mixRotationWalletFrom.trim().toLowerCase());
    let iTo = wallets.findIndex((w) => w.address.toLowerCase() === mixRotationWalletTo.trim().toLowerCase());
    if (iFrom < 0) iFrom = 0;
    if (iTo < 0) iTo = 0;
    if (iFrom > iTo) [iFrom, iTo] = [iTo, iFrom];
    const canonFrom = wallets[iFrom]!.address;
    const canonTo = wallets[iTo]!.address;
    const fromOk = canonFrom.toLowerCase() === mixRotationWalletFrom.trim().toLowerCase();
    const toOk = canonTo.toLowerCase() === mixRotationWalletTo.trim().toLowerCase();
    if (!fromOk || !toOk) {
      setMixRotationWalletFrom(canonFrom);
      setMixRotationWalletTo(canonTo);
      return;
    }
    const next = addressesInExecutionRange(wallets, canonFrom, canonTo);
    setSelectedDistributorAddresses((prev) =>
      executionAddressListsEqual(prev, next) ? prev : next,
    );
  }, [distributorWallets, mixRotationWalletFrom, mixRotationWalletTo]);

  function selectAllMixWallets() {
    if (!distributorWallets.length) return;
    setMixRotationWalletFrom(distributorWallets[0]!.address);
    setMixRotationWalletTo(distributorWallets[distributorWallets.length - 1]!.address);
  }

  async function connectWallet() {
    try {
      setError("");
      await ensureLithoNetwork(net);
      const eth = window.ethereum;
      if (!eth) throw new Error("No wallet");
      const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      setAccount(accounts?.[0] || "");
    } catch (e) {
      setError(formatError(e));
    }
  }

  async function disconnectWallet() {
    setError("");
    setAccount("");
    if (!sessionVerified) {
      try {
        const eth = window.ethereum;
        if (!eth?.request) return;
        await eth.request({
          method: "wallet_revokePermissions",
          params: [{ eth_accounts: {} }],
        });
      } catch {
        /* provider may not implement revoke */
      }
    }
  }

  async function verifyWalletSession() {
    try {
      setBusy(true);
      setError("");
      if (!account) throw new Error("Connect your wallet first");
      await ensureLithoNetwork(net);

      const challengeRes = await fetch("/api/auth/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: account, chainId: net.chainId }),
      });
      if (!challengeRes.ok) {
        let detail = "Failed to create challenge";
        try {
          const errBody = (await challengeRes.json()) as { error?: string };
          if (errBody.error) detail = `${detail}: ${errBody.error}`;
        } catch {
          /* ignore */
        }
        throw new Error(detail);
      }
      const challenge = (await challengeRes.json()) as { message: string; nonce: string };

      const eth = window.ethereum;
      if (!eth) throw new Error("No wallet");
      const signature = (await eth.request({
        method: "personal_sign",
        params: [challenge.message, account],
      })) as string;

      const verifyRes = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: account,
          chainId: net.chainId,
          message: challenge.message,
          nonce: challenge.nonce,
          signature,
        }),
      });
      if (!verifyRes.ok) {
        let detail = "Session verification failed";
        try {
          const j = (await verifyRes.json()) as { error?: string };
          if (j.error) detail = j.error;
        } catch {
          /* ignore */
        }
        throw new Error(detail);
      }
      const data = (await verifyRes.json()) as { address?: string; token?: string };
      const token = data.token ?? "";
      const verifiedAddress = (data.address || account).toLowerCase();
      setSessionToken(token);
      setSessionVerified(true);
      setSessionAddress(verifiedAddress);
      await loadDistributorWallets(token, { ownerForStorage: verifiedAddress, preferredAddress: verifiedAddress });
    } catch (e) {
      clearSessionState();
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  function logout() {
    clearSessionState();
  }

  async function createMixJob() {
    try {
      setBusy(true);
      setError("");
      if (!sessionVerified) throw new Error("Verify your wallet session first");
      if (!account) throw new Error("Connect wallet");
      const selected = new Set(selectedDistributorAddresses.map((a) => a.toLowerCase()));
      const ordered = orderedSelectedWallets(distributorWallets, selected);
      if (ordered.length < 2) throw new Error("Select at least two distribution wallets for a rotation");
      const loops = Math.floor(Number(loopCount.trim()));
      if (!Number.isFinite(loops) || loops < 1 || loops > MIX_MAX_LOOPS) {
        throw new Error(`Loop count must be between 1 and ${MIX_MAX_LOOPS}`);
      }
      const minA = minPerWallet.trim();
      const maxA = maxPerWallet.trim();
      if (!minA || !maxA) throw new Error("Enter min and max amounts");

      const total = ordered.length * loops;
      const amounts =
        mode === "native"
          ? clientRandomAmountsInRangeNative(minA, maxA, total)
          : clientRandomAmountsInRangeToken(minA, maxA, total, 18);
      if (mode === "erc20" && !tokenAddress.trim()) throw new Error("Token contract is required for ERC-20");

      const recipients = buildMixRotationRecipients(ordered, loops, amounts, { shuffleRecipients });
      if (!recipients.length) throw new Error("Could not build rotation");

      const res = await fetch("/api/airdrop/jobs", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          mode,
          tokenAddress: mode === "erc20" ? tokenAddress.trim() : undefined,
          recipients,
          targetRunCount: 1,
          network: {
            name: net.name,
            chainId: net.chainId,
            rpcUrl: net.rpcUrl,
            explorerUrl: net.explorerUrl,
          },
          distributorAddresses: ordered,
        }),
      });
      const data = await parseApiJson<{ job: BatchJob }>(res, "Failed to create job");
      setBatchJob(data.job);
      setStatus("job-created");
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  async function startMixJob() {
    try {
      setBusy(true);
      setError("");
      if (!batchJob?.jobId) throw new Error("Create a job first");
      const res = await fetch(`/api/airdrop/jobs/${batchJob.jobId}/start`, {
        method: "POST",
        headers: authHeaders(),
      });
      const data = await parseApiJson<{ job: BatchJob }>(res, "Failed to queue");
      if (data.job) setBatchJob(data.job);
      setStatus("queued");
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-full bg-slate-50 p-6 dark:bg-[#000000]">
      <div className="mx-auto max-w-7xl space-y-6">
        <div>
          <Card className="rounded-2xl shadow-sm">
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center justify-between gap-3 text-2xl">
                <span className="flex items-center gap-3">
                  <Image
                    src="/litho-logo.png"
                    alt={`${net.name} logo`}
                    width={24}
                    height={24}
                    className="h-6 w-6 rounded-sm"
                    priority
                  />
                  Mix Drop
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href="/"
                    className="inline-flex items-center rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium hover:bg-slate-50 dark:border-[#333333] dark:hover:bg-[#1a1a1a]"
                  >
                    Home
                  </Link>
                  <Link
                    href="/dashboard/session"
                    className="inline-flex items-center rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium hover:bg-slate-50 dark:border-[#333333] dark:hover:bg-[#1a1a1a]"
                  >
                    Dashboard
                  </Link>
                  <span className="inline-flex items-center rounded-xl border-2 border-slate-900 bg-slate-50 px-3 py-2 text-sm font-medium dark:border-slate-200 dark:bg-[#1a1a1a]">
                    Mix Drop
                  </span>
                  {sessionVerified ? (
                    <Button type="button" variant="outline" className="shrink-0 rounded-xl text-sm font-medium" onClick={logout}>
                      Logout
                    </Button>
                  ) : null}
                </div>
              </CardTitle>
              <p className="text-sm font-medium tracking-tight text-slate-600 dark:text-slate-400">
                Rotate native or LEP100/ERC-20 between your distribution wallets only — no new recipient generation.
              </p>
            </CardHeader>
            <CardContent>
              <NetworkConfigGrid nonceQueueEnabled={nonceQueueEnabled} hsmModeEnabled={hsmModeEnabled} />
            </CardContent>
          </Card>
        </div>

        <Card className="rounded-2xl shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl">
              <Wallet className="h-5 w-5" />
              Wallet session
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 md:col-span-2">
              <Label>Distributor wallet</Label>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  onClick={account ? disconnectWallet : connectWallet}
                  disabled={busy}
                  variant={account ? "outline" : "default"}
                  className="rounded-2xl"
                >
                  {account ? "Disconnect wallet" : "Connect wallet"}
                </Button>
                <Button onClick={verifyWalletSession} disabled={busy || !account} variant="outline" className="rounded-2xl">
                  Verify session
                </Button>
                <div className="flex items-center rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm dark:border-[#333333] dark:bg-[#111111]">
                  {account ? shortAddr(account) : "Not connected"}
                </div>
                <Badge variant={sessionVerified ? "default" : "secondary"} className="rounded-xl px-3 py-2">
                  {sessionVerified ? "Verified" : "Unverified"}
                </Badge>
              </div>
            </div>
            <div className="space-y-2 md:col-span-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label>Distribution wallets (range = rotation order)</Label>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-8 rounded-xl px-3 text-xs"
                    disabled={!sessionVerified || busy || distributorWallets.length === 0}
                    onClick={selectAllMixWallets}
                  >
                    Select all
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-8 rounded-xl px-3 text-xs"
                    disabled={!sessionVerified || busy || distributorWallets.length === 0}
                    onClick={() => void refreshDistributorBalances()}
                  >
                    <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", balancesRefreshing && "animate-spin")} />
                    Balances
                  </Button>
                </div>
              </div>
              {distributorWallets.length === 0 ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:border-[#333333] dark:bg-[#111111] dark:text-slate-400">
                  Add distribution wallets on the home page or dashboard first, then return here.
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="mix-from-wallet">From wallet</Label>
                    <select
                      id="mix-from-wallet"
                      className="flex h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-200 disabled:cursor-not-allowed disabled:opacity-60 dark:border-[#333333] dark:bg-[#111111] dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-900/40"
                      disabled={!sessionVerified || busy}
                      value={mixRotationWalletFrom}
                      onChange={(e) => setMixRotationWalletFrom(e.target.value)}
                    >
                      {distributorWallets.map((w) => (
                        <option key={w.address} value={w.address}>
                          {(w.label || shortAddr(w.address)) + " · " + shortAddr(w.address)}
                          {w.balanceNative ? ` · ${w.balanceNative} ${net.nativeCurrency.symbol}` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="mix-to-wallet">To wallet</Label>
                    <select
                      id="mix-to-wallet"
                      className="flex h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-200 disabled:cursor-not-allowed disabled:opacity-60 dark:border-[#333333] dark:bg-[#111111] dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-900/40"
                      disabled={!sessionVerified || busy}
                      value={mixRotationWalletTo}
                      onChange={(e) => setMixRotationWalletTo(e.target.value)}
                    >
                      {distributorWallets.map((w) => (
                        <option key={`${w.address}-to`} value={w.address}>
                          {(w.label || shortAddr(w.address)) + " · " + shortAddr(w.address)}
                          {w.balanceNative ? ` · ${w.balanceNative} ${net.nativeCurrency.symbol}` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Wallets from “From” through “To” in list order participate in the ring rotation. Enable recipient shuffle
                below to randomize recipients each loop. One loop = one full round.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-2xl shadow-sm">
          <CardHeader>
            <CardTitle className="text-xl">Airdrop configuration</CardTitle>
            <p className="text-sm text-slate-500 dark:text-slate-400">Random per transfer. No fixed-total split.</p>
          </CardHeader>
          <CardContent className="space-y-4">
            <Tabs value={mode} onValueChange={(v) => setMode(v as "native" | "erc20")}>
              <TabsList className="mb-2 grid w-full max-w-md grid-cols-2 rounded-2xl">
                <TabsTrigger value="native">Native token</TabsTrigger>
                <TabsTrigger value="erc20">LEP100 / ERC-20</TabsTrigger>
              </TabsList>
              <TabsContent value="native" className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
                  <div className="space-y-2">
                    <Label>Min per transfer (native)</Label>
                    <Input value={minPerWallet} onChange={(e) => setMinPerWallet(e.target.value)} placeholder="e.g. 0.1" />
                  </div>
                  <div className="space-y-2">
                    <Label>Max per transfer (native)</Label>
                    <Input value={maxPerWallet} onChange={(e) => setMaxPerWallet(e.target.value)} placeholder="e.g. 2.0" />
                  </div>
                  <div className="space-y-2 sm:col-span-2">
                    <Label>Loops (full ring count)</Label>
                    <Input
                      type="number"
                      min={1}
                      max={MIX_MAX_LOOPS}
                      inputMode="numeric"
                      value={loopCount}
                      onChange={(e) => setLoopCount(e.target.value)}
                    />
                    <p className="text-xs text-slate-500">How many full rotations to include in this job (max {MIX_MAX_LOOPS}).</p>
                  </div>
                </div>
              </TabsContent>
              <TabsContent value="erc20" className="space-y-4">
                <div className="space-y-2 max-w-2xl">
                  <Label>Token contract</Label>
                  <Input value={tokenAddress} onChange={(e) => setTokenAddress(e.target.value)} placeholder="0x..." />
                </div>
                <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
                  <div className="space-y-2">
                    <Label>Min per transfer (tokens)</Label>
                    <Input value={minPerWallet} onChange={(e) => setMinPerWallet(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label>Max per transfer (tokens)</Label>
                    <Input value={maxPerWallet} onChange={(e) => setMaxPerWallet(e.target.value)} />
                  </div>
                  <div className="space-y-2 sm:col-span-2">
                    <Label>Loops (full ring count)</Label>
                    <Input
                      type="number"
                      min={1}
                      max={MIX_MAX_LOOPS}
                      inputMode="numeric"
                      value={loopCount}
                      onChange={(e) => setLoopCount(e.target.value)}
                    />
                  </div>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">LEP100 and similar tokens use 18 decimals in this app.</p>
              </TabsContent>
            </Tabs>
            <label className="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 dark:border-slate-600 dark:bg-[#111111]"
                checked={shuffleRecipients}
                onChange={(e) => setShuffleRecipients(e.target.checked)}
              />
              Shuffle recipient per loop
            </label>
            <div className="flex flex-wrap gap-2 pt-2">
              <Button
                type="button"
                onClick={() => void createMixJob()}
                disabled={busy || !sessionVerified || selectedDistributorAddresses.length < 2}
                variant="outline"
                className="rounded-2xl"
              >
                <FileText className="mr-2 h-4 w-4" />
                Create mix job
              </Button>
              <Button
                type="button"
                onClick={() => void startMixJob()}
                disabled={busy || !batchJob}
                className="rounded-2xl"
              >
                <Play className="mr-2 h-4 w-4" />
                Queue now
              </Button>
            </div>
            {batchJob ? (
              <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm dark:border-[#222222] dark:bg-[#111111]">
                <div className="flex items-center gap-2 font-medium text-slate-900 dark:text-slate-100">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  Current job: {batchJob.status}
                </div>
                <div className="mt-1 break-all text-xs text-slate-600 dark:text-slate-400">ID: {batchJob.jobId}</div>
                <p className="mt-2 text-xs text-slate-500">Track this job on the home page or dashboard under history.</p>
                <p className="mt-1 text-xs text-slate-500">App: {status}</p>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
      <FloatingErrorNotice message={error} onDismiss={() => setError("")} />
    </div>
  );
}
