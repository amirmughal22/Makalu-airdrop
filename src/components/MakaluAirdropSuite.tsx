"use client";

import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { ListPagination } from "@/components/ui/list-pagination";
import { DISTRIBUTOR_WALLETS_PAGE_SIZE, HISTORY_JOBS_PAGE_SIZE, LIST_PAGE_SIZE } from "@/lib/list-page-size";
import {
  Wallet,
  Plus,
  Play,
  Copy,
  Trash2,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Upload,
  Coins,
  FileText,
  PauseCircle,
  Download,
  ChevronRight,
  Server,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { numberToHex, parseEther, parseUnits } from "viem";
import { cn } from "@/lib/utils";
import { formatAmountAtDisplayPrecision } from "@/lib/split-amounts";
import {
  addressesInExecutionRange,
  executionAddressListsEqual,
  rangeEndpointsFromAddresses,
} from "@/lib/execution-wallet-range";
import { FUND_DISTRIBUTE_MAX_RECIPIENTS } from "@/lib/fund-distribute";
import { readResponseJson } from "@/lib/read-response-json";
import { NetworkConfigGrid } from "@/components/NetworkConfigGrid";
import { FloatingErrorNotice } from "@/components/FloatingErrorNotice";
import { chainDisplayLabel, explorerUrlForChainId, lithoUiNetwork, rpcEndpointLabel } from "@/lib/chain";

const SESSION_STORAGE_KEY = "litho-airdrop-session";
const EXECUTION_WALLETS_STORAGE_KEY = "litho-airdrop-execution-wallets";
/** Batched generation: max total wallets per "Generate" run, max per request on the server. */
const WALLET_GEN_MAX_TOTAL = 100_000;
const WALLET_GEN_BATCH = 5_000;

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

function formatError(error: unknown) {
  if (error && typeof error === "object") {
    const o = error as Record<string, unknown>;
    return String(o.message ?? o.shortMessage ?? o.reason ?? "Unknown error");
  }
  return "Unknown error";
}

/** Reads body once; on error throws with API `error` message when present. */
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
        ? String((parsed as { error: string }).error).trim()
        : "";
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

type Recipient = {
  id: string;
  address: string;
  amount: string;
  source?: "backend-generated" | "imported";
};

type BatchResult = {
  recipient: string;
  amount: string;
  txHash?: string;
  status: "queued" | "submitted" | "success" | "failed" | "pending";
  error?: string;
  signerAddress?: string;
  rpcUrl?: string;
};

type BatchJob = {
  jobId: string;
  signerAddress?: string;
  signerAddresses?: string[];
  status: "draft" | "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
  mode: "native" | "erc20";
  tokenAddress?: string;
  chainId?: number;
  scheduledAt?: string;
  queuedAt?: string;
  createdAt: string;
  targetRunCount?: number;
  currentRun?: number;
  /** Normalized jobs: server keeps re-queuing after each cycle when true. */
  loopForever?: boolean;
  results: BatchResult[];
  /** Present when loaded with `?summary=1` — avoids shipping huge `results` on every poll. */
  resultSummary?: {
    total: number;
    success: number;
    failed: number;
    pending: number;
    queued: number;
    submitted: number;
  };
};

type HistoryJobLite = {
  jobId: string;
  status: string;
  mode: string;
  createdAt: string;
  /** Chain locked when the job was created (explorer + context). */
  chainId?: number;
  queuePosition?: number;
  signerAddress?: string;
  signerAddresses?: string[];
  targetRunCount?: number;
  currentRun?: number;
  loopForever?: boolean;
  /** Empty when the list is loaded with `summary=1`. */
  results: BatchResult[];
  resultSummary?: {
    total: number;
    success: number;
    failed: number;
    pending: number;
    queued: number;
    submitted: number;
  };
};

type DistributorWalletMeta = {
  address: string;
  label: string;
  createdAt: string;
  source: "primary" | "added" | "hd-generated";
  /** Native token balance on the chain requested when listing (from RPC). */
  balanceNative?: string;
  balanceWei?: string;
};

type HdKeyExportRow = {
  address: string;
  label: string;
  hdDerivationIndex: number;
  derivationPath: string;
  privateKey: string;
};

/** Which dashboard page is rendered (`view="dashboard"` only). */
export type DashboardSection =
  | "session-wallet-connect"
  | "wallet-generation"
  | "fund-distribution"
  | "jobs-history"
  | "queue-worker";

type MakaluAirdropSuiteProps = {
  view?: "execution" | "dashboard";
  /** Route-driven dashboard panel; defaults to session when omitted. */
  dashboardSection?: DashboardSection;
  /** Server-provided: PostgreSQL normalized jobs (`jobs` / `job_wallets`) enabled. */
  normalizedJobsEnabled?: boolean;
};

export default function MakaluAirdropSuite({
  view = "execution",
  dashboardSection,
  normalizedJobsEnabled = false,
}: MakaluAirdropSuiteProps) {
  const dashboardMode = view === "dashboard";
  const dashSection: DashboardSection | null = dashboardMode
    ? dashboardSection ?? "session-wallet-connect"
    : null;
  const sessionHydratedRef = useRef(false);
  const [account, setAccount] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [sessionVerified, setSessionVerified] = useState(false);
  const [sessionAddress, setSessionAddress] = useState("");
  const [mode, setMode] = useState<"native" | "erc20">("native");
  const [tokenAddress, setTokenAddress] = useState("");
  const [walletCount, setWalletCount] = useState("10");
  const [totalAmount, setTotalAmount] = useState("2500");
  const [seed, setSeed] = useState(String(Math.floor(Date.now() / 1000)));
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [csvText, setCsvText] = useState("");
  const [batchJob, setBatchJob] = useState<BatchJob | null>(null);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  /** Progress for multi-request wallet generation (50k–100k). */
  const [walletGenProgress, setWalletGenProgress] = useState<{ done: number; total: number } | null>(null);
  const [nonceQueueEnabled] = useState(true);
  const [hsmModeEnabled] = useState(true);
  const [distributorWallets, setDistributorWallets] = useState<DistributorWalletMeta[]>([]);
  const [selectedDistributorAddresses, setSelectedDistributorAddresses] = useState<string[]>([]);
  const [newDistributorPrivateKey, setNewDistributorPrivateKey] = useState("");
  const [newDistributorLabel, setNewDistributorLabel] = useState("");
  const [hdSeedConfigured, setHdSeedConfigured] = useState(false);
  const [hdGenCount, setHdGenCount] = useState("5");
  /** Latest HD batch only — includes private keys for JSON download; cleared on logout. */
  const [lastHdKeyExport, setLastHdKeyExport] = useState<HdKeyExportRow[] | null>(null);
  const [fundMode, setFundMode] = useState<"erc20" | "native">("erc20");
  const [fundFromAddress, setFundFromAddress] = useState("");
  /** Inclusive recipient range in fund-recipient list order (excludes pay-from wallet). */
  const [fundRecipientRangeFrom, setFundRecipientRangeFrom] = useState("");
  const [fundRecipientRangeTo, setFundRecipientRangeTo] = useState("");
  const [fundTokenAddress, setFundTokenAddress] = useState("");
  const [fundAmountPerWallet, setFundAmountPerWallet] = useState("");
  const [fundTargetAddresses, setFundTargetAddresses] = useState<string[]>([]);
  const [fundLastResults, setFundLastResults] = useState<Array<{ to: string; txHash?: string; error?: string }> | null>(
    null,
  );
  const [balancesRefreshing, setBalancesRefreshing] = useState(false);
  const [walletImportNotice, setWalletImportNotice] = useState("");
  /** Bulk-register from env `AIRDROP_HD_MNEMONIC` indices (same derivation as Generate). */
  const [envRegisterStartIndex, setEnvRegisterStartIndex] = useState("0");
  const [envRegisterCount, setEnvRegisterCount] = useState("100");
  const hdImportJsonFileRef = useRef<HTMLInputElement>(null);
  const [scheduleAtLocal, setScheduleAtLocal] = useState("");
  const [activeJobs, setActiveJobs] = useState<BatchJob[]>([]);
  const [historyJobs, setHistoryJobs] = useState<HistoryJobLite[]>([]);
  const [historyJobsTotal, setHistoryJobsTotal] = useState(0);
  const [historyJobsPage, setHistoryJobsPage] = useState(1);
  const [historyJobsLoading, setHistoryJobsLoading] = useState(false);
  const [queueRuntimeInfo, setQueueRuntimeInfo] = useState<{
    processingEnabled: boolean;
    normalizedQueueV2: boolean;
    embeddedWorker: boolean;
    maxParallelTxs: number;
    maxConcurrentJobs: number;
    embeddedWorkerCount: number;
    embeddedWorkerActiveLoops: number;
    queueV2Effective: boolean;
    queueV2Env: boolean;
    embeddedWorkerEffective: boolean;
    embeddedWorkerLoopRunning: boolean;
    embeddedEnvOptOut: boolean;
    databaseConfigured: boolean;
    globalPausedEnv: boolean;
    canToggle: boolean;
  } | null>(null);
  const [queueRuntimeLoading, setQueueRuntimeLoading] = useState(false);
  const [historyStatusFilter, setHistoryStatusFilter] = useState<"all" | "running" | "paused" | "stopped" | "completed">("all");
  const historyJobsPageRef = useRef(1);
  const makaluAirdropSuiteAliveRef = useRef(true);
  /** Inclusive range in distributor wallet list order → drives `selectedDistributorAddresses`. */
  const [executionWalletFrom, setExecutionWalletFrom] = useState("");
  const [executionWalletTo, setExecutionWalletTo] = useState("");
  const selectedDistributorAddressesRef = useRef<string[]>([]);
  const [dashWalletListPage, setDashWalletListPage] = useState(1);
  /** Dashboard distributor table: multi-select (lowercase address) for balance refresh + bulk delete. */
  const [dashWalletTableSelected, setDashWalletTableSelected] = useState<Set<string>>(() => new Set());
  const [recipientsPage, setRecipientsPage] = useState(1);
  const [batchResultsPage, setBatchResultsPage] = useState(1);
  /** When true: HD addresses from seed. Amount rules depend on split mode (see UI). */
  const [deterministicGeneration, setDeterministicGeneration] = useState(false);
  /** Fixed total split vs independent random amount per wallet in [min, max]. */
  const [splitMode, setSplitMode] = useState<"equalTotal" | "randomRange">("equalTotal");
  const [minPerWallet, setMinPerWallet] = useState("1");
  const [maxPerWallet, setMaxPerWallet] = useState("10");
  /** When set, the job automatically starts another cycle after each completion (until paused/cancelled). */
  const [jobLoopForever, setJobLoopForever] = useState(false);
  /** Normalized jobs: use CSV/recipient list vs PostgreSQL saved wallet batch range. */
  const [jobWalletSource, setJobWalletSource] = useState<"recipients" | "generated_batch">("recipients");
  const [savedBatches, setSavedBatches] = useState<
    { id: string; name: string; totalWallets: number; insertedWallets: number; status: string }[]
  >([]);
  const [selectedBatchId, setSelectedBatchId] = useState("");
  const [batchRangeFrom, setBatchRangeFrom] = useState("1");
  const [batchRangeTo, setBatchRangeTo] = useState("");
  const [batchUniformAmount, setBatchUniformAmount] = useState("1");
  const [jobNameInput, setJobNameInput] = useState("");

  const net = useMemo(() => lithoUiNetwork(), []);

  const dashWalletListTotalPages = Math.max(1, Math.ceil(distributorWallets.length / DISTRIBUTOR_WALLETS_PAGE_SIZE));
  const pagedDashWallets = useMemo(() => {
    const start = (dashWalletListPage - 1) * DISTRIBUTOR_WALLETS_PAGE_SIZE;
    return distributorWallets.slice(start, start + DISTRIBUTOR_WALLETS_PAGE_SIZE);
  }, [distributorWallets, dashWalletListPage]);

  /** Dashboard table: fixed page size rows; pad last page with empty slots. */
  const pagedDashWalletsPadded = useMemo((): (DistributorWalletMeta | null)[] => {
    if (distributorWallets.length === 0) return [];
    const rows: (DistributorWalletMeta | null)[] = [...pagedDashWallets];
    while (rows.length < DISTRIBUTOR_WALLETS_PAGE_SIZE) {
      rows.push(null);
    }
    return rows;
  }, [distributorWallets.length, pagedDashWallets]);

  const dashPageAddressKeys = useMemo(
    () => pagedDashWallets.map((w) => w.address.toLowerCase()),
    [pagedDashWallets],
  );
  const dashPageAllSelected =
    dashPageAddressKeys.length > 0 && dashPageAddressKeys.every((k) => dashWalletTableSelected.has(k));
  const dashPageSomeSelected =
    dashPageAddressKeys.some((k) => dashWalletTableSelected.has(k)) && !dashPageAllSelected;

  const fundRecipientWallets = useMemo(
    () => distributorWallets.filter((w) => w.address.toLowerCase() !== fundFromAddress.toLowerCase()),
    [distributorWallets, fundFromAddress],
  );

  const fundRecipientRangeFullCount = useMemo(() => {
    if (!fundRecipientWallets.length) return 0;
    const a = fundRecipientRangeFrom.trim();
    const b = fundRecipientRangeTo.trim();
    if (!a || !b) return 0;
    return addressesInExecutionRange(fundRecipientWallets, a, b).length;
  }, [fundRecipientWallets, fundRecipientRangeFrom, fundRecipientRangeTo]);

  useEffect(() => {
    setDashWalletListPage((p) => Math.min(Math.max(1, p), dashWalletListTotalPages));
  }, [distributorWallets.length, dashWalletListTotalPages]);

  useEffect(() => {
    const allowed = new Set(distributorWallets.map((w) => w.address.toLowerCase()));
    setDashWalletTableSelected((prev) => {
      const next = new Set<string>();
      for (const a of prev) {
        if (allowed.has(a)) next.add(a);
      }
      if (next.size === prev.size) {
        for (const a of prev) {
          if (!next.has(a)) return next;
        }
        return prev;
      }
      return next;
    });
  }, [distributorWallets]);

  useEffect(() => {
    if (!fundRecipientWallets.length) {
      setFundRecipientRangeFrom("");
      setFundRecipientRangeTo("");
      return;
    }
    setFundRecipientRangeFrom((prev) => {
      if (prev && fundRecipientWallets.some((w) => w.address.toLowerCase() === prev.toLowerCase())) return prev;
      return fundRecipientWallets[0]!.address;
    });
    setFundRecipientRangeTo((prev) => {
      if (prev && fundRecipientWallets.some((w) => w.address.toLowerCase() === prev.toLowerCase())) return prev;
      return fundRecipientWallets[fundRecipientWallets.length - 1]!.address;
    });
  }, [fundRecipientWallets]);

  useEffect(() => {
    const wallets = fundRecipientWallets;
    if (!wallets.length) {
      setFundTargetAddresses([]);
      return;
    }
    const rf = fundRecipientRangeFrom.trim();
    const rt = fundRecipientRangeTo.trim();
    if (!rf || !rt) return;

    let iFrom = wallets.findIndex((w) => w.address.toLowerCase() === rf.toLowerCase());
    let iTo = wallets.findIndex((w) => w.address.toLowerCase() === rt.toLowerCase());
    if (iFrom < 0) iFrom = 0;
    if (iTo < 0) iTo = 0;
    if (iFrom > iTo) [iFrom, iTo] = [iTo, iFrom];
    const canonFrom = wallets[iFrom]!.address;
    const canonTo = wallets[iTo]!.address;
    if (canonFrom !== fundRecipientRangeFrom || canonTo !== fundRecipientRangeTo) {
      setFundRecipientRangeFrom(canonFrom);
      setFundRecipientRangeTo(canonTo);
      return;
    }
    const next = addressesInExecutionRange(wallets, canonFrom, canonTo);
    const capped = next.slice(0, FUND_DISTRIBUTE_MAX_RECIPIENTS);
    setFundTargetAddresses((prev) => (executionAddressListsEqual(prev, capped) ? prev : capped));
  }, [fundRecipientWallets, fundRecipientRangeFrom, fundRecipientRangeTo]);

  useEffect(() => {
    historyJobsPageRef.current = historyJobsPage;
  }, [historyJobsPage]);

  useEffect(() => {
    makaluAirdropSuiteAliveRef.current = true;
    return () => {
      makaluAirdropSuiteAliveRef.current = false;
    };
  }, []);

  const clearSessionState = useCallback(() => {
    setSessionVerified(false);
    setSessionToken("");
    setSessionAddress("");
    setDistributorWallets([]);
    setSelectedDistributorAddresses([]);
    setActiveJobs([]);
    setHistoryJobs([]);
    setHistoryJobsTotal(0);
    setHistoryJobsPage(1);
    historyJobsPageRef.current = 1;
    setExecutionWalletFrom("");
    setExecutionWalletTo("");
    setDashWalletListPage(1);
    setFundRecipientRangeFrom("");
    setFundRecipientRangeTo("");
    setHdSeedConfigured(false);
    setLastHdKeyExport(null);
    setFundLastResults(null);
    setFundTargetAddresses([]);
    setFundFromAddress("");
    setBalancesRefreshing(false);
    setWalletImportNotice("");
    setEnvRegisterStartIndex("0");
    setEnvRegisterCount("100");
    try {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const authHeaders = useCallback((tokenOverride?: string): HeadersInit => {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    const token = tokenOverride ?? sessionToken;
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }, [sessionToken]);

  useEffect(() => {
    if (!sessionVerified || !normalizedJobsEnabled || jobWalletSource !== "generated_batch") return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/airdrop/wallet-batches?page=1", { headers: authHeaders() });
        if (!res.ok) return;
        const data = await readResponseJson<{
          batches?: Array<{
            id: string;
            name: string;
            totalWallets: number;
            insertedWallets: number;
            status: string;
          }>;
        }>(res);
        const list = (data.batches ?? []).filter((b) => b.status === "completed");
        if (!cancelled) setSavedBatches(list);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionVerified, jobWalletSource, authHeaders, normalizedJobsEnabled]);

  const loadDistributorWallets = useCallback(
    async (
      tokenOverride?: string,
      options?: string | { preferredAddress?: string; ownerForStorage?: string },
    ) => {
      const o =
        typeof options === "string"
          ? { preferredAddress: options, ownerForStorage: options }
          : options ?? {};
      const res = await fetch("/api/distributor-wallets", { headers: authHeaders(tokenOverride) });
      if (!res.ok) throw new Error("Failed to load distributor wallets");
      const data = (await res.json()) as { wallets: DistributorWalletMeta[] };
      const wallets = data.wallets ?? [];
      setDistributorWallets(wallets);
      if (!wallets.length) {
        setExecutionWalletFrom("");
        setExecutionWalletTo("");
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
      setExecutionWalletFrom(newFrom);
      setExecutionWalletTo(newTo);
    },
    [authHeaders, sessionAddress]
  );

  const refreshDistributorBalances = useCallback(async () => {
    if (!sessionVerified) return;
    const selected = [...dashWalletTableSelected];
    if (selected.length === 0) {
      setError("Select one or more wallets in the table, then refresh balances.");
      return;
    }
    try {
      setBalancesRefreshing(true);
      setError("");
      const chainId = net.chainId;
      const qs = new URLSearchParams();
      qs.set("chainId", String(chainId));
      qs.set("addresses", selected.join(","));
      const res = await fetch(`/api/distributor-wallets/balances?${qs}`, { headers: authHeaders() });
      const data = await parseApiJson<{
        balances: Array<{ address: string; balanceNative: string; balanceWei: string }>;
      }>(res, "Failed to load balances");
      const byAddr = new Map(data.balances.map((b) => [b.address.toLowerCase(), b]));
      setDistributorWallets((prev) =>
        prev.map((w) => {
          const b = byAddr.get(w.address.toLowerCase());
          if (!b) return w;
          return { ...w, balanceNative: b.balanceNative, balanceWei: b.balanceWei };
        }),
      );
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBalancesRefreshing(false);
    }
  }, [sessionVerified, net.chainId, authHeaders, dashWalletTableSelected]);

  const loadActiveJobs = useCallback(
    async (tokenOverride?: string, summary = true) => {
      const token = tokenOverride ?? sessionToken;
      if (!token) {
        setActiveJobs([]);
        return;
      }
      const q = summary ? "&summary=1" : "";
      const res = await fetch(`/api/airdrop/active?limit=30${q}`, {
        headers: authHeaders(token),
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as { jobs: BatchJob[] };
      setActiveJobs(data.jobs ?? []);
    },
    [authHeaders, sessionToken],
  );

  const loadHistoryJobs = useCallback(
    async (tokenOverride?: string, page?: number) => {
      const token = tokenOverride ?? sessionToken;
      if (!token) {
        setHistoryJobs([]);
        setHistoryJobsTotal(0);
        setHistoryJobsPage(1);
        historyJobsPageRef.current = 1;
        return;
      }
      const safePage = Math.max(1, page ?? historyJobsPageRef.current);
      setHistoryJobsLoading(true);
      try {
        const res = await fetch(
          `/api/airdrop/history?page=${safePage}&limit=${HISTORY_JOBS_PAGE_SIZE}&statusFilter=${encodeURIComponent(historyStatusFilter)}&summary=1&_=${Date.now()}`,
          {
            headers: authHeaders(token),
            cache: "no-store",
          },
        );
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          setError(j.error || `Could not refresh job list (${res.status}).`);
          return;
        }
        const data = (await res.json()) as {
          jobs?: HistoryJobLite[];
          total?: number;
          page?: number;
          totalPages?: number;
        };
        const total = (typeof data.total === "number" ? data.total : data.jobs?.length) ?? 0;
        let jobs = data.jobs ?? [];
        let resolvedPage = typeof data.page === "number" ? data.page : safePage;
        if (jobs.length === 0 && total > 0 && resolvedPage > 1) {
          await loadHistoryJobs(tokenOverride, 1);
          return;
        }
        setHistoryJobs(jobs);
        setHistoryJobsTotal(total);
        setHistoryJobsPage(resolvedPage);
        historyJobsPageRef.current = resolvedPage;
      } finally {
        setHistoryJobsLoading(false);
      }
    },
    [authHeaders, sessionToken, historyStatusFilter],
  );

  const patchQueueRuntime = useCallback(
    async (partial: {
      processingEnabled?: boolean;
      normalizedQueueV2?: boolean;
      embeddedWorker?: boolean;
      maxParallelTxs?: number;
      maxConcurrentJobs?: number;
      embeddedWorkerCount?: number;
    }) => {
      if (!sessionVerified) return;
      setQueueRuntimeLoading(true);
      setError("");
      try {
        const res = await fetch("/api/airdrop/queue-runtime", {
          method: "PATCH",
          headers: authHeaders(),
          body: JSON.stringify(partial),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          setError(typeof data.error === "string" ? data.error : "Could not update queue runtime");
          return;
        }
        const snap = await fetch("/api/airdrop/queue-runtime", { headers: authHeaders() });
        if (snap.ok) {
          setQueueRuntimeInfo((await snap.json()) as NonNullable<typeof queueRuntimeInfo>);
        }
      } catch (e) {
        setError(formatError(e));
      } finally {
        setQueueRuntimeLoading(false);
      }
    },
    [sessionVerified, authHeaders],
  );

  useEffect(() => {
    if (!dashboardMode || !sessionVerified || dashSection !== "queue-worker") return;
    let cancelled = false;
    void (async () => {
      setQueueRuntimeLoading(true);
      try {
        const res = await fetch("/api/airdrop/queue-runtime", { headers: authHeaders() });
        const data = (await res.json()) as NonNullable<typeof queueRuntimeInfo>;
        if (!cancelled && res.ok) setQueueRuntimeInfo(data);
      } catch {
        if (!cancelled) setQueueRuntimeInfo(null);
      } finally {
        if (!cancelled) setQueueRuntimeLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dashboardMode, sessionVerified, dashSection, authHeaders]);

  useEffect(() => {
    if (sessionHydratedRef.current) return;
    sessionHydratedRef.current = true;
    const restore = async () => {
      const saved = loadStoredSession();
      if (!saved) return;
      setSessionToken(saved.token);
      setSessionVerified(true);
      setSessionAddress(saved.address);
      await loadDistributorWallets(saved.token, saved.address);
      if (!dashboardMode) await loadActiveJobs(saved.token);
      if (dashboardMode) await loadHistoryJobs(saved.token, 1);
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
  }, [dashboardMode, loadActiveJobs, loadDistributorWallets, loadHistoryJobs]);

  useEffect(() => {
    try {
      if (sessionVerified && sessionToken && sessionAddress) {
        localStorage.setItem(
          SESSION_STORAGE_KEY,
          JSON.stringify({
            token: sessionToken,
            address: sessionAddress.toLowerCase(),
          })
        );
      } else {
        localStorage.removeItem(SESSION_STORAGE_KEY);
      }
    } catch {
      /* ignore */
    }
  }, [sessionVerified, sessionToken, sessionAddress]);

  useEffect(() => {
    if (!sessionVerified || !dashboardMode) return;
    void (async () => {
      const res = await fetch("/api/distributor-wallets/seed-config", { headers: authHeaders() });
      if (!res.ok) return;
      const d = (await res.json()) as { hdSeedConfigured?: boolean };
      setHdSeedConfigured(Boolean(d.hdSeedConfigured));
    })();
  }, [sessionVerified, dashboardMode, authHeaders]);

  useEffect(() => {
    if (!distributorWallets.length) return;
    setFundFromAddress((prev) => {
      if (prev && distributorWallets.some((w) => w.address.toLowerCase() === prev.toLowerCase())) return prev;
      return distributorWallets[0]!.address;
    });
  }, [distributorWallets]);

  useEffect(() => {
    const from = fundFromAddress.toLowerCase();
    if (!from) return;
    setFundTargetAddresses((prev) => prev.filter((a) => a.toLowerCase() !== from));
  }, [fundFromAddress]);

  useEffect(() => {
    selectedDistributorAddressesRef.current = selectedDistributorAddresses;
  }, [selectedDistributorAddresses]);

  useEffect(() => {
    const wallets = distributorWallets;
    if (!wallets.length) {
      setSelectedDistributorAddresses([]);
      return;
    }
    let iFrom = wallets.findIndex((w) => w.address.toLowerCase() === executionWalletFrom.trim().toLowerCase());
    let iTo = wallets.findIndex((w) => w.address.toLowerCase() === executionWalletTo.trim().toLowerCase());
    if (iFrom < 0) iFrom = 0;
    if (iTo < 0) iTo = 0;
    if (iFrom > iTo) [iFrom, iTo] = [iTo, iFrom];
    const canonFrom = wallets[iFrom]!.address;
    const canonTo = wallets[iTo]!.address;
    const fromOk = canonFrom.toLowerCase() === executionWalletFrom.trim().toLowerCase();
    const toOk = canonTo.toLowerCase() === executionWalletTo.trim().toLowerCase();
    if (!fromOk || !toOk) {
      setExecutionWalletFrom(canonFrom);
      setExecutionWalletTo(canonTo);
      return;
    }
    const next = addressesInExecutionRange(wallets, canonFrom, canonTo);
    setSelectedDistributorAddresses((prev) =>
      executionAddressListsEqual(prev, next) ? prev : next,
    );
  }, [distributorWallets, executionWalletFrom, executionWalletTo]);

  useEffect(() => {
    if (!sessionVerified || !sessionAddress || selectedDistributorAddresses.length === 0) return;
    try {
      localStorage.setItem(
        `${EXECUTION_WALLETS_STORAGE_KEY}:${sessionAddress.toLowerCase()}`,
        JSON.stringify(selectedDistributorAddresses)
      );
    } catch {
      /* ignore */
    }
  }, [sessionVerified, sessionAddress, selectedDistributorAddresses]);

  useEffect(() => {
    const eth = window.ethereum;
    if (!eth) return;

    const onAccountsChanged = (accounts: unknown) => {
      const list = Array.isArray(accounts) ? accounts : [];
      const next = (list[0] as string) || "";
      setAccount(next);
      if (sessionAddress && next.toLowerCase() !== sessionAddress.toLowerCase()) {
        clearSessionState();
      }
    };

    const onChainChanged = () => window.location.reload();

    eth.on("accountsChanged", onAccountsChanged);
    eth.on("chainChanged", onChainChanged);

    return () => {
      eth.removeListener?.("accountsChanged", onAccountsChanged);
      eth.removeListener?.("chainChanged", onChainChanged);
    };
  }, [sessionAddress, clearSessionState]);

  const refreshJob = useCallback(
    async (jobId?: string, options?: { summary?: boolean }) => {
      const id = jobId || batchJob?.jobId;
      if (!id) return;
      const summary = options?.summary === true;
      const res = await fetch(
        `/api/airdrop/jobs/${id}?${summary ? "summary=1&" : ""}_=${Date.now()}`,
        { headers: authHeaders(), cache: "no-store" },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error || `Could not refresh job (${res.status}).`);
        return;
      }
      const data = (await res.json()) as { job: BatchJob };
      const j = data.job;
      setBatchJob(j);
    },
    [batchJob?.jobId, authHeaders],
  );

  /** Fast summary polls while a job runs (`resultSummary` + optional `stats`; avoid loading full `results`). */
  useEffect(() => {
    if (!batchJob?.jobId) return;
    const active = batchJob.status === "running" || batchJob.status === "paused" || batchJob.status === "queued";
    if (!active) return;
    const id = batchJob.jobId;
    const t = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void refreshJob(id, { summary: true });
    }, 3000);
    return () => clearInterval(t);
  }, [batchJob?.jobId, batchJob?.status, refreshJob]);

  const executionJobBusy =
    Boolean(batchJob?.jobId) &&
    (batchJob?.status === "running" ||
      batchJob?.status === "queued" ||
      batchJob?.status === "paused");
  /** While the detail panel polls `?summary=1` every 3s, slow the active-job list refresh to avoid redundant DB/API load. */
  const activeJobsListPollMs = executionJobBusy ? 12_000 : 5000;

  useEffect(() => {
    if (!sessionVerified) return;
    if (dashboardMode) return;
    void loadActiveJobs(undefined, true);
    const t = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void loadActiveJobs(undefined, true);
    }, activeJobsListPollMs);
    return () => clearInterval(t);
  }, [sessionVerified, loadActiveJobs, dashboardMode, activeJobsListPollMs]);

  useEffect(() => {
    if (!dashboardMode || !sessionVerified || dashSection !== "jobs-history") return;
    void loadHistoryJobs(undefined, historyJobsPageRef.current);
  }, [dashboardMode, sessionVerified, dashSection, loadHistoryJobs]);

  useEffect(() => {
    if (!dashboardMode || !sessionVerified || dashSection !== "jobs-history") return;
    historyJobsPageRef.current = 1;
    setHistoryJobsPage(1);
    void loadHistoryJobs(undefined, 1);
  }, [dashboardMode, sessionVerified, dashSection, historyStatusFilter, loadHistoryJobs]);

  const totalRecipients = recipients.length;
  const successCount =
    batchJob?.resultSummary?.success ?? batchJob?.results.filter((r) => r.status === "success").length ?? 0;
  const failedCount =
    batchJob?.resultSummary?.failed ?? batchJob?.results.filter((r) => r.status === "failed").length ?? 0;
  const batchJobCanRerun = Boolean(
    batchJob && (batchJob.status === "completed" || batchJob.status === "failed"),
  );

  const recipientsTotalPages = Math.max(1, Math.ceil(recipients.length / LIST_PAGE_SIZE));
  const pagedRecipients = useMemo(() => {
    const start = (recipientsPage - 1) * LIST_PAGE_SIZE;
    return recipients.slice(start, start + LIST_PAGE_SIZE);
  }, [recipients, recipientsPage]);

  const batchResults = useMemo(() => batchJob?.results ?? [], [batchJob?.results]);
  const batchExplorerBase = explorerUrlForChainId(batchJob?.chainId ?? net.chainId);
  const batchResultsTotalPages = Math.max(1, Math.ceil(batchResults.length / LIST_PAGE_SIZE));
  const pagedBatchResults = useMemo(() => {
    const start = (batchResultsPage - 1) * LIST_PAGE_SIZE;
    return batchResults.slice(start, start + LIST_PAGE_SIZE);
  }, [batchResults, batchResultsPage]);

  useEffect(() => {
    if (recipientsPage > recipientsTotalPages) setRecipientsPage(recipientsTotalPages);
  }, [recipients.length, recipientsPage, recipientsTotalPages]);

  useEffect(() => {
    if (batchResultsPage > batchResultsTotalPages) setBatchResultsPage(batchResultsTotalPages);
  }, [batchResults.length, batchResultsPage, batchResultsTotalPages]);

  useEffect(() => {
    setBatchResultsPage(1);
  }, [batchJob?.jobId]);

  useEffect(() => {
    if (!batchJob?.scheduledAt) {
      setScheduleAtLocal("");
      return;
    }
    const d = new Date(batchJob.scheduledAt);
    if (!Number.isFinite(d.getTime())) {
      setScheduleAtLocal("");
      return;
    }
    setScheduleAtLocal(d.toISOString().slice(0, 16));
  }, [batchJob?.jobId, batchJob?.scheduledAt]);

  const csvExport = useMemo(() => {
    return [
      "address,amount,source",
      ...recipients.map((r) => `${r.address},${r.amount},${r.source || "unknown"}`),
    ].join("\n");
  }, [recipients]);

  const randomRangeAmountsTotalDisplay = useMemo(() => {
    if (splitMode !== "randomRange" || recipients.length === 0) return null;
    const decimals = 18;
    try {
      let sum = 0n;
      for (const r of recipients) {
        sum += mode === "native" ? parseEther(r.amount) : parseUnits(r.amount, decimals);
      }
      return formatAmountAtDisplayPrecision(sum, decimals);
    } catch {
      return null;
    }
  }, [splitMode, recipients, mode]);

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
        let detail = "Wallet verification failed";
        try {
          const errBody = (await verifyRes.json()) as { error?: string };
          if (errBody.error) detail = `${detail}: ${errBody.error}`;
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
      await loadDistributorWallets(token, verifiedAddress);
      if (!dashboardMode) await loadActiveJobs(token);
      if (dashboardMode) await loadHistoryJobs(token, 1);
    } catch (e) {
      clearSessionState();
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  async function generateWalletsOnBackend() {
    try {
      setBusy(true);
      setError("");
      setWalletGenProgress(null);
      if (!sessionVerified) throw new Error("Verify wallet session before generating recipients");
      if (!selectedDistributorAddresses.length) throw new Error("Select at least one distributor wallet");

      const totalWanted = Math.floor(Number(walletCount));
      if (!Number.isFinite(totalWanted) || totalWanted < 1) {
        throw new Error("Wallet count must be a positive integer");
      }
      if (totalWanted > WALLET_GEN_MAX_TOTAL) {
        throw new Error(`Wallet count cannot exceed ${WALLET_GEN_MAX_TOTAL.toLocaleString()}`);
      }
      if (splitMode === "equalTotal" && !deterministicGeneration && totalWanted > WALLET_GEN_BATCH) {
        throw new Error(
          "For more than 5,000 wallets with a fixed total, turn on “Deterministic addresses (HD from seed)” so the total splits evenly across all batches, or use at most 5,000 wallets with the random per-wallet split.",
        );
      }

      const buildPayload = (count: number, offset: number, totalCount: number) => {
        const payload: Record<string, unknown> = {
          count,
          offset,
          totalCount,
          seed,
          mode,
          deterministic: deterministicGeneration,
          splitMode,
          distributorAddresses: selectedDistributorAddresses,
        };
        if (splitMode === "equalTotal") {
          payload.totalAmount = totalAmount;
        } else {
          payload.minAmount = minPerWallet.trim();
          payload.maxAmount = maxPerWallet.trim();
        }
        return payload;
      };

      const accumulated: Recipient[] = [];
      for (let offset = 0; offset < totalWanted; offset += WALLET_GEN_BATCH) {
        const n = Math.min(WALLET_GEN_BATCH, totalWanted - offset);
        setWalletGenProgress({ done: offset, total: totalWanted });
        const res = await fetch("/api/wallets/generate", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify(buildPayload(n, offset, totalWanted)),
        });
        const data = await parseApiJson<{ recipients?: Recipient[] }>(res, "Backend wallet generation failed");
        accumulated.push(...(data.recipients || []));
        setWalletGenProgress({ done: offset + n, total: totalWanted });
        await new Promise((r) => setTimeout(r, 0));
      }
      setRecipients(accumulated);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
      setTimeout(() => setWalletGenProgress(null), 2000);
    }
  }

  function importCsvRows() {
    try {
      setError("");
      const rows = csvText
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !line.toLowerCase().startsWith("address,"))
        .map((line, index) => {
          const [address, amount] = line.split(",").map((v) => v.trim());
          if (!address || !amount) throw new Error(`Line ${index + 1} must be address,amount`);
          return {
            id: String(index + 1),
            address,
            amount,
            source: "imported" as const,
          };
        });
      setRecipients(rows);
    } catch (e) {
      setError(formatError(e));
    }
  }

  async function createBatchJob() {
    try {
      setBusy(true);
      setError("");
      if (!sessionVerified) throw new Error("Verified wallet session required");
      if (!selectedDistributorAddresses.length) throw new Error("Select at least one distributor wallet");
      const normalized = normalizedJobsEnabled;
      if (normalized && jobWalletSource === "generated_batch") {
        if (!selectedBatchId) throw new Error("Select a saved wallet batch");
        const toN = parseInt(batchRangeTo.trim(), 10);
        const fromN = parseInt(batchRangeFrom.trim(), 10) || 1;
        if (!Number.isFinite(toN) || !Number.isFinite(fromN)) throw new Error("Invalid index range");
        if (fromN < 1 || toN < fromN) throw new Error("fromWalletIndex must be ≥ 1 and toWalletIndex ≥ from");
        const u = Number(batchUniformAmount.trim());
        if (!Number.isFinite(u) || u < 0) throw new Error("Uniform amount must be a non-negative number");
      } else {
        if (!recipients.length) throw new Error("Add recipients first");
      }
      if (mode === "erc20" && !tokenAddress.trim()) throw new Error("Token contract required for ERC-20 mode");

      const res = await fetch("/api/airdrop/jobs", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          mode,
          tokenAddress: tokenAddress.trim() || undefined,
          recipients: normalized && jobWalletSource === "generated_batch" ? [] : recipients,
          walletSource: normalized && jobWalletSource === "generated_batch" ? "generated_batch" : undefined,
          generatedBatchId: normalized && jobWalletSource === "generated_batch" ? selectedBatchId : undefined,
          fromWalletIndex: normalized && jobWalletSource === "generated_batch" ? parseInt(batchRangeFrom, 10) || 1 : undefined,
          toWalletIndex: normalized && jobWalletSource === "generated_batch" ? parseInt(batchRangeTo.trim(), 10) : undefined,
          uniformAmount: normalized && jobWalletSource === "generated_batch" ? batchUniformAmount.trim() : undefined,
          jobName: jobNameInput.trim() || undefined,
          loopForever: jobLoopForever,
          network: {
            name: net.name,
            chainId: net.chainId,
            rpcUrl: net.rpcUrl,
            explorerUrl: net.explorerUrl,
          },
          distributorAddresses: selectedDistributorAddresses,
        }),
      });

      const data = await parseApiJson<{ job: BatchJob }>(res, "Failed to create batch job");
      setBatchJob(data.job);
      setStatus("job-created");
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  async function startBatchJob() {
    try {
      setBusy(true);
      setError("");
      if (!batchJob?.jobId) throw new Error("Create a job first");

      const res = await fetch(`/api/airdrop/jobs/${batchJob.jobId}/start`, {
        method: "POST",
        headers: authHeaders(),
      });
      const data = await parseApiJson<{ job: BatchJob }>(res, "Failed to queue batch job");
      if (data.job) setBatchJob(data.job);
      await refreshJob(batchJob.jobId);
      setStatus("queued");
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  async function pauseBatchJob() {
    try {
      setBusy(true);
      setError("");
      if (!batchJob?.jobId) throw new Error("No active batch job");
      const res = await fetch(`/api/airdrop/jobs/${batchJob.jobId}/pause`, {
        method: "POST",
        headers: authHeaders(),
      });
      await parseApiJson<Record<string, unknown>>(res, "Failed to pause job");
      await refreshJob(batchJob.jobId);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  async function resumeBatchJob() {
    try {
      setBusy(true);
      setError("");
      if (!batchJob?.jobId) throw new Error("No active batch job");
      const res = await fetch(`/api/airdrop/jobs/${batchJob.jobId}/resume`, {
        method: "POST",
        headers: authHeaders(),
      });
      await parseApiJson<Record<string, unknown>>(res, "Failed to resume job");
      await refreshJob(batchJob.jobId);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  async function queueBatchJob() {
    try {
      setBusy(true);
      setError("");
      if (!batchJob?.jobId) throw new Error("Create a job first");
      const scheduledAtIso = scheduleAtLocal ? new Date(scheduleAtLocal).toISOString() : null;
      const res = await fetch(`/api/airdrop/jobs/${batchJob.jobId}/queue`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ scheduledAt: scheduledAtIso }),
      });
      const data = await parseApiJson<{ job: BatchJob }>(res, "Failed to queue job");
      if (data.job) setBatchJob(data.job);
      setStatus(scheduledAtIso ? "scheduled" : "queued");
      await refreshJob(batchJob.jobId);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  async function retryFailedInBatchJob() {
    try {
      setBusy(true);
      setError("");
      if (!batchJob?.jobId) throw new Error("No active batch job");
      const hasFailed =
        (batchJob.resultSummary?.failed ?? 0) > 0 || (batchJob.results ?? []).some((r) => r.status === "failed");
      if (!hasFailed) throw new Error("No failed recipients to retry");
      const res = await fetch(`/api/airdrop/jobs/${batchJob.jobId}/queue`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ scheduledAt: null }),
      });
      const data = await parseApiJson<{ job: BatchJob }>(res, "Failed to retry failed recipients");
      if (data.job) setBatchJob(data.job);
      setStatus("retrying-failed");
      await refreshJob(batchJob.jobId);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  async function cancelBatchJob() {
    try {
      setBusy(true);
      setError("");
      if (!batchJob?.jobId) throw new Error("No active batch job");
      const res = await fetch(`/api/airdrop/jobs/${batchJob.jobId}/cancel`, {
        method: "POST",
        headers: authHeaders(),
      });
      const data = await parseApiJson<{ job: BatchJob }>(res, "Failed to cancel job");
      if (data.job) setBatchJob(data.job);
      setStatus("cancelled");
      await refreshJob(batchJob.jobId, { summary: false });
      if (dashboardMode) await loadHistoryJobs(undefined, historyJobsPageRef.current);
      await loadActiveJobs(undefined, true);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  async function updateQueuedSchedule() {
    try {
      setBusy(true);
      setError("");
      if (!batchJob?.jobId) throw new Error("No active batch job");
      const scheduledAtIso = scheduleAtLocal ? new Date(scheduleAtLocal).toISOString() : null;
      const res = await fetch(`/api/airdrop/jobs/${batchJob.jobId}`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ scheduledAt: scheduledAtIso }),
      });
      const data = await parseApiJson<{ job: BatchJob }>(res, "Failed to update schedule");
      if (data.job) setBatchJob(data.job);
      setStatus("schedule-updated");
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  function copyCsv() {
    void navigator.clipboard.writeText(csvExport);
  }

  function removeRecipient(id: string) {
    setRecipients((current) => current.filter((r) => r.id !== id));
  }

  async function addDistributorWalletFromPrivateKey() {
    try {
      setBusy(true);
      setError("");
      if (!sessionVerified) throw new Error("Verify wallet session first");
      const pk = newDistributorPrivateKey.trim();
      const label = newDistributorLabel.trim();
      if (!pk) throw new Error("Private key is required");
      if (!label) throw new Error("Wallet label is required");
      const res = await fetch("/api/distributor-wallets", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ privateKey: pk, label }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || "Failed to add wallet");
      setNewDistributorPrivateKey("");
      setNewDistributorLabel("");
      await loadDistributorWallets(undefined, { ownerForStorage: sessionAddress });
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  async function removeDistributorWallet(address: string) {
    try {
      setBusy(true);
      setError("");
      const res = await fetch("/api/distributor-wallets", {
        method: "DELETE",
        headers: authHeaders(),
        body: JSON.stringify({ address }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || "Failed to delete wallet");
      await loadDistributorWallets(undefined, { ownerForStorage: sessionAddress });
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  function toggleDashWalletRowSelected(address: string) {
    const k = address.toLowerCase();
    setDashWalletTableSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  function toggleDashWalletPageSelected() {
    const pageKeys = pagedDashWallets.map((w) => w.address.toLowerCase());
    if (pageKeys.length === 0) return;
    const allOn = pageKeys.every((k) => dashWalletTableSelected.has(k));
    setDashWalletTableSelected((prev) => {
      const next = new Set(prev);
      if (allOn) {
        for (const k of pageKeys) next.delete(k);
      } else {
        for (const k of pageKeys) next.add(k);
      }
      return next;
    });
  }

  function clearDashWalletTableSelection() {
    setDashWalletTableSelected(new Set());
  }

  async function removeSelectedDashWallets() {
    const deletable = [...dashWalletTableSelected]
      .map((k) => distributorWallets.find((w) => w.address.toLowerCase() === k))
      .filter((w): w is DistributorWalletMeta => Boolean(w && w.source !== "primary"));
    if (deletable.length === 0) {
      setError("Select one or more non-authorized wallets to delete.");
      return;
    }
    if (
      !confirm(
        `Delete ${deletable.length} wallet${deletable.length === 1 ? "" : "s"} from this distributor list? This cannot be undone.`,
      )
    ) {
      return;
    }
    try {
      setBusy(true);
      setError("");
      for (const w of deletable) {
        const res = await fetch("/api/distributor-wallets", {
          method: "DELETE",
          headers: authHeaders(),
          body: JSON.stringify({ address: w.address }),
        });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) throw new Error(data.error || `Failed to delete ${shortAddr(w.address)}`);
      }
      setDashWalletTableSelected((prev) => {
        const next = new Set(prev);
        for (const w of deletable) next.delete(w.address.toLowerCase());
        return next;
      });
      await loadDistributorWallets(undefined, { ownerForStorage: sessionAddress });
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  function selectAllExecutionWallets() {
    if (!distributorWallets.length) return;
    setExecutionWalletFrom(distributorWallets[0]!.address);
    setExecutionWalletTo(distributorWallets[distributorWallets.length - 1]!.address);
  }

  function selectFundRecipientFullRange() {
    if (!fundRecipientWallets.length) return;
    setFundRecipientRangeFrom(fundRecipientWallets[0]!.address);
    setFundRecipientRangeTo(fundRecipientWallets[fundRecipientWallets.length - 1]!.address);
  }

  function downloadHdKeyExportJson() {
    if (!lastHdKeyExport?.length) return;
    const payload = {
      exportedAt: new Date().toISOString(),
      warning: "This file contains private keys. Do not share, email, or commit to version control.",
      walletCount: lastHdKeyExport.length,
      wallets: lastHdKeyExport,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const a = document.createElement("a");
    a.href = url;
    a.download = `hd-wallets-${stamp}.json`;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function downloadFullWalletBackupJson() {
    try {
      setBusy(true);
      setError("");
      if (!sessionVerified) throw new Error("Verify wallet session first");
      const res = await fetch("/api/distributor-wallets/export", { headers: authHeaders() });
      const data = await parseApiJson<{
        exportedAt: string;
        warning?: string;
        walletCount: number;
        wallets: unknown[];
      }>(res, "Wallet export failed");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const a = document.createElement("a");
      a.href = url;
      a.download = `distributor-wallets-backup-${stamp}.json`;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  async function importWalletsFromJsonFile(ev: ChangeEvent<HTMLInputElement>) {
    const input = ev.target;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      setBusy(true);
      setError("");
      setWalletImportNotice("");
      if (!sessionVerified) throw new Error("Verify session first");
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        throw new Error("File is not valid JSON");
      }
      const res = await fetch("/api/distributor-wallets/import-json", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(parsed),
      });
      const data = await parseApiJson<{ added: number; skipped: number }>(res, "Import failed");
      setWalletImportNotice(
        `Import finished: ${data.added} added${data.skipped ? `, ${data.skipped} skipped (duplicates or errors)` : ""}.`,
      );
      await loadDistributorWallets(undefined, { ownerForStorage: sessionAddress });
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  async function registerEnvSeedRangeOnServer() {
    try {
      setBusy(true);
      setError("");
      setWalletImportNotice("");
      setLastHdKeyExport(null);
      if (!sessionVerified) throw new Error("Verify session first");
      const si = parseInt(envRegisterStartIndex.trim(), 10);
      const cnt = parseInt(envRegisterCount.trim(), 10);
      if (!Number.isFinite(si) || si < 0) throw new Error("Start index must be 0 or greater");
      if (!Number.isFinite(cnt) || cnt < 1 || cnt > 500) throw new Error("Count must be between 1 and 500");
      const res = await fetch("/api/distributor-wallets/register-env-range", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ startIndex: si, count: cnt }),
      });
      const data = await parseApiJson<{
        wallets: DistributorWalletMeta[];
        hdExport?: HdKeyExportRow[];
        skipped: number;
      }>(res, "Env seed import failed");
      if (data.hdExport?.length) setLastHdKeyExport(data.hdExport);
      const added = data.wallets?.length ?? 0;
      const skipped = data.skipped ?? 0;
      if (added > 0 && skipped > 0) {
        setWalletImportNotice(`Registered ${added} wallet(s) from env seed. ${skipped} skipped (already listed).`);
      } else if (added > 0) {
        setWalletImportNotice(`Registered ${added} wallet(s) from env seed.`);
      } else if (skipped > 0) {
        setWalletImportNotice(`No new wallets — ${skipped} indices already registered or match primary.`);
      } else {
        setWalletImportNotice("Done.");
      }
      await loadDistributorWallets(undefined, { ownerForStorage: sessionAddress });
      const seedRes = await fetch("/api/distributor-wallets/seed-config", { headers: authHeaders() });
      if (seedRes.ok) {
        const sd = (await seedRes.json()) as { hdSeedConfigured?: boolean };
        setHdSeedConfigured(Boolean(sd.hdSeedConfigured));
      }
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  async function generateHdWalletsFromSeed() {
    try {
      setBusy(true);
      setError("");
      setWalletImportNotice("");
      setLastHdKeyExport(null);
      if (!sessionVerified) throw new Error("Verify session first");
      const n = parseInt(hdGenCount.trim(), 10);
      if (!Number.isFinite(n) || n < 1 || n > 100) throw new Error("Count must be between 1 and 100");
      const res = await fetch("/api/distributor-wallets/generate-from-seed", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ count: n }),
      });
      const data = await parseApiJson<{ wallets: DistributorWalletMeta[]; hdExport?: HdKeyExportRow[] }>(
        res,
        "HD wallet generation failed",
      );
      if (data.hdExport?.length) setLastHdKeyExport(data.hdExport);
      await loadDistributorWallets(undefined, { ownerForStorage: sessionAddress });
      const seedRes = await fetch("/api/distributor-wallets/seed-config", { headers: authHeaders() });
      if (seedRes.ok) {
        const sd = (await seedRes.json()) as { hdSeedConfigured?: boolean };
        setHdSeedConfigured(Boolean(sd.hdSeedConfigured));
      }
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  async function distributeToDistributorWallets() {
    try {
      setBusy(true);
      setError("");
      setFundLastResults(null);
      if (!sessionVerified) throw new Error("Verify session first");
      if (!fundFromAddress) throw new Error("Select a sender wallet");
      if (!fundTargetAddresses.length) throw new Error("Select at least one recipient");
      if (fundTargetAddresses.length > FUND_DISTRIBUTE_MAX_RECIPIENTS) {
        throw new Error(`Select at most ${FUND_DISTRIBUTE_MAX_RECIPIENTS} recipients per send (use multiple batches if needed).`);
      }
      if (fundMode === "erc20" && !fundTokenAddress.trim()) throw new Error("Token contract is required for ERC-20");
      const amt = Number(fundAmountPerWallet.trim());
      if (!fundAmountPerWallet.trim() || !Number.isFinite(amt) || amt <= 0) throw new Error("Enter a valid amount per wallet");

      const body: Record<string, unknown> = {
        chainId: net.chainId,
        mode: fundMode,
        fromAddress: fundFromAddress,
        amountPerWallet: fundAmountPerWallet.trim(),
        toAddresses: fundTargetAddresses,
      };
      if (fundMode === "erc20") body.tokenAddress = fundTokenAddress.trim();

      const res = await fetch("/api/distributor-wallets/distribute", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      const data = await parseApiJson<{
        results: Array<{ to: string; txHash?: string; error?: string }>;
        allOk: boolean;
      }>(res, "Distribute failed");
      setFundLastResults(data.results);
      if (!data.allOk) setError("Some transfers failed — see the list below.");
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  function logout() {
    clearSessionState();
    setStatus("logged-out");
    setError("");
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
                  {dashboardMode ? `${net.name} Dashboard` : `${net.name} Airdrop Suite`}
                </span>
                <div className="flex items-center gap-2">
                  <Link href="/" className="inline-flex items-center rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium hover:bg-slate-50 dark:border-[#333333] dark:hover:bg-[#1a1a1a]">
                    Home
                  </Link>
                  <Link
                    href="/dashboard/session"
                    className="inline-flex items-center rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium hover:bg-slate-50 dark:border-[#333333] dark:hover:bg-[#1a1a1a]"
                  >
                    Dashboard
                  </Link>
                  <Link
                    href="/mix-drop"
                    className="inline-flex items-center rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium hover:bg-slate-50 dark:border-[#333333] dark:hover:bg-[#1a1a1a]"
                  >
                    Mix Drop
                  </Link>
                  {sessionVerified ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="shrink-0 rounded-xl text-sm font-medium"
                      onClick={logout}
                    >
                      Logout
                    </Button>
                  ) : null}
                </div>
              </CardTitle>
              <p className="text-sm font-medium tracking-tight text-slate-600 dark:text-slate-400">
                Ship verified, batched airdrops on {net.name}—native or ERC-20.
              </p>
            </CardHeader>
            <CardContent>
              <NetworkConfigGrid nonceQueueEnabled={nonceQueueEnabled} hsmModeEnabled={hsmModeEnabled} />
            </CardContent>
          </Card>
        </div>

        {dashboardMode && dashSection ? (
          <nav
            className="grid w-full grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5"
            aria-label="Dashboard sections"
          >
            {(
              [
                { href: "/dashboard/session", section: "session-wallet-connect" as const, label: "Session / Wallet" },
                { href: "/dashboard/wallet-generation", section: "wallet-generation" as const, label: "Wallet generation" },
                { href: "/dashboard/fund-distribution", section: "fund-distribution" as const, label: "Fund distribution" },
                { href: "/dashboard/jobs", section: "jobs-history" as const, label: "Jobs" },
                { href: "/dashboard/queue-worker", section: "queue-worker" as const, label: "Queue worker" },
              ] as const
            ).map(({ href, section, label }) => (
              <Link
                key={href}
                href={href}
                className={cn(
                  "rounded-2xl border px-3 py-2 text-center text-xs font-medium md:text-sm",
                  dashSection === section
                    ? "border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900"
                    : "border-slate-200 bg-white hover:bg-slate-50 dark:border-[#333333] dark:bg-[#111111] dark:hover:bg-[#1a1a1a]",
                )}
              >
                {label}
              </Link>
            ))}
            <Link
              href="/dashboard/wallet-batches"
              className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-center text-xs font-medium hover:bg-slate-50 dark:border-[#333333] dark:bg-[#111111] dark:hover:bg-[#1a1a1a] md:text-sm"
            >
              Wallet batches
            </Link>
          </nav>
        ) : null}

        <div className={dashboardMode ? "space-y-6" : "grid gap-6 lg:grid-cols-3"}>
          <div className={dashboardMode ? "space-y-6" : "space-y-6 lg:col-span-2"}>
            {!dashboardMode || dashSection === "session-wallet-connect" ? (
            <Card className="rounded-2xl shadow-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-xl">
                  <Wallet className="h-5 w-5" />
                  Wallet Auth + Session Verification
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
                      {account ? "Disconnect Wallet" : "Connect Wallet"}
                    </Button>
                    <Button onClick={verifyWalletSession} disabled={busy || !account} variant="outline" className="rounded-2xl">
                      Verify Session
                    </Button>
                    <div className="flex items-center rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm dark:border-[#333333] dark:bg-[#111111]">
                      {account ? shortAddr(account) : "Not connected"}
                    </div>
                    <Badge variant={sessionVerified ? "default" : "secondary"} className="rounded-xl px-3 py-2">
                      {sessionVerified ? "Verified" : "Unverified"}
                    </Badge>
                  </div>
                </div>
                {!dashboardMode ? (
                <div className="space-y-2 md:col-span-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Label>Execution wallets (range)</Label>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        className="h-8 rounded-xl px-3 text-xs"
                        disabled={!sessionVerified || busy || distributorWallets.length === 0}
                        onClick={selectAllExecutionWallets}
                      >
                        Select all
                      </Button>
                    </div>
                  </div>
                  {distributorWallets.length === 0 ? (
                    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:border-[#333333] dark:bg-[#111111] dark:text-slate-400">
                      No wallet available — verify session or add a wallet on the dashboard.
                    </div>
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="makalu-exec-wallet-from">From wallet</Label>
                        <select
                          id="makalu-exec-wallet-from"
                          className="flex h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-200 disabled:cursor-not-allowed disabled:opacity-60 dark:border-[#333333] dark:bg-[#111111] dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-900/40"
                          disabled={!sessionVerified || busy}
                          value={executionWalletFrom}
                          onChange={(e) => setExecutionWalletFrom(e.target.value)}
                        >
                          {distributorWallets.map((w) => (
                            <option key={w.address} value={w.address}>
                              {(w.label || shortAddr(w.address)) + " · " + shortAddr(w.address)}
                              {w.source === "primary" ? " (authorized)" : w.source === "hd-generated" ? " (HD seed)" : ""}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="makalu-exec-wallet-to">To wallet</Label>
                        <select
                          id="makalu-exec-wallet-to"
                          className="flex h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-200 disabled:cursor-not-allowed disabled:opacity-60 dark:border-[#333333] dark:bg-[#111111] dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-900/40"
                          disabled={!sessionVerified || busy}
                          value={executionWalletTo}
                          onChange={(e) => setExecutionWalletTo(e.target.value)}
                        >
                          {distributorWallets.map((w) => (
                            <option key={w.address} value={w.address}>
                              {(w.label || shortAddr(w.address)) + " · " + shortAddr(w.address)}
                              {w.source === "primary" ? " (authorized)" : w.source === "hd-generated" ? " (HD seed)" : ""}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  )}
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    All wallets from “From” through “To” in your list order are used. Each wave sends one transaction
                    per wallet in parallel (recipients split across those wallets). Generation and batch jobs use that
                    range.
                  </p>
                </div>
                ) : null}
                {dashboardMode ? (
                  <div className="space-y-2 md:col-span-2">
                    <Label>Add new wallet (private key)</Label>
                    <div className="flex flex-wrap gap-2">
                      <Input
                        value={newDistributorLabel}
                        onChange={(e) => setNewDistributorLabel(e.target.value)}
                        placeholder="Wallet label (e.g. Treasury 1)"
                        className="min-w-[220px]"
                      />
                      <Input
                        type="password"
                        value={newDistributorPrivateKey}
                        onChange={(e) => setNewDistributorPrivateKey(e.target.value)}
                        placeholder="0x... private key"
                        autoComplete="off"
                        className="min-w-[260px] flex-1"
                      />
                      <Button type="button" onClick={addDistributorWalletFromPrivateKey} disabled={!sessionVerified || busy}>
                        Add Wallet
                      </Button>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Native {net.nativeCurrency.symbol} balances use the header network ({net.name}). Select wallets in the
                        table, then{" "}
                        <strong>Refresh balances</strong> (only selected rows are queried — reduces RPC load and
                        timeouts). Use <strong>Export backup</strong> to download every distributor wallet with private
                        keys (same JSON shape as import below) if your backup file is lost.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          className="shrink-0 rounded-2xl"
                          disabled={!sessionVerified || busy || distributorWallets.length === 0}
                          onClick={() => void downloadFullWalletBackupJson()}
                        >
                          <Download className="mr-2 h-4 w-4" />
                          Export backup (JSON)
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className="shrink-0 rounded-2xl"
                          disabled={
                            !sessionVerified ||
                            busy ||
                            balancesRefreshing ||
                            distributorWallets.length === 0 ||
                            dashWalletTableSelected.size === 0
                          }
                          onClick={() => void refreshDistributorBalances()}
                        >
                          <RefreshCw className={cn("mr-2 h-4 w-4", balancesRefreshing && "animate-spin")} />
                          Refresh balances
                        </Button>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        className="h-8 rounded-xl px-3 text-xs"
                        disabled={!sessionVerified || busy || pagedDashWallets.length === 0}
                        onClick={toggleDashWalletPageSelected}
                      >
                        {dashPageAllSelected ? "Deselect page" : "Select page"}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-8 rounded-xl px-3 text-xs"
                        disabled={!sessionVerified || busy || dashWalletTableSelected.size === 0}
                        onClick={clearDashWalletTableSelection}
                      >
                        Clear selection
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-8 rounded-xl border-red-200 px-3 text-xs text-red-700 hover:bg-red-50 dark:border-red-900/50 dark:text-red-400 dark:hover:bg-red-950/40"
                        disabled={
                          !sessionVerified ||
                          busy ||
                          ![...dashWalletTableSelected].some((k) => {
                            const w = distributorWallets.find((x) => x.address.toLowerCase() === k);
                            return w && w.source !== "primary";
                          })
                        }
                        onClick={() => void removeSelectedDashWallets()}
                      >
                        <Trash2 className="mr-1 inline h-3.5 w-3.5" />
                        Delete selected
                      </Button>
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        {dashWalletTableSelected.size} selected
                      </span>
                    </div>
                    <div className="mt-2 overflow-x-auto rounded-2xl border border-slate-200 dark:border-[#222222]">
                      <table className="w-full min-w-[820px] text-left text-sm">
                        <thead className="bg-slate-50 dark:bg-[#111111]">
                          <tr>
                            <th className="w-10 px-2 py-3">
                              <input
                                type="checkbox"
                                className="h-4 w-4 rounded border-slate-300 accent-blue-600 dark:border-slate-600"
                                checked={dashPageAllSelected}
                                ref={(el) => {
                                  if (el) el.indeterminate = dashPageSomeSelected;
                                }}
                                onChange={toggleDashWalletPageSelected}
                                disabled={!sessionVerified || busy || pagedDashWallets.length === 0}
                                aria-label="Select all wallets on this page"
                              />
                            </th>
                            <th className="px-4 py-3 font-medium">Label</th>
                            <th className="px-4 py-3 font-medium">Address</th>
                            <th className="px-4 py-3 text-right font-medium">
                              {net.nativeCurrency.symbol} ({net.name})
                            </th>
                            <th className="px-4 py-3 font-medium">Source</th>
                            <th className="px-4 py-3 font-medium">Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pagedDashWalletsPadded.map((w, rowIdx) =>
                            w ? (
                              <tr key={w.address} className="border-t border-slate-200 dark:border-[#222222]">
                                <td className="px-2 py-3 align-middle">
                                  <input
                                    type="checkbox"
                                    className="h-4 w-4 rounded border-slate-300 accent-blue-600 dark:border-slate-600"
                                    checked={dashWalletTableSelected.has(w.address.toLowerCase())}
                                    onChange={() => toggleDashWalletRowSelected(w.address)}
                                    disabled={!sessionVerified || busy}
                                    aria-label={`Select ${w.label || shortAddr(w.address)}`}
                                  />
                                </td>
                                <td className="px-4 py-3">{w.label || "—"}</td>
                                <td className="px-4 py-3 font-mono text-xs">{w.address}</td>
                                <td className="px-4 py-3 text-right font-mono text-sm tabular-nums text-slate-800 dark:text-slate-200">
                                  {w.balanceNative ?? "—"}
                                </td>
                                <td className="px-4 py-3">
                                  {w.source === "primary"
                                    ? "Authorized"
                                    : w.source === "hd-generated"
                                      ? "HD seed"
                                      : "Added"}
                                </td>
                                <td className="px-4 py-3">
                                  {w.source === "primary" ? (
                                    <span className="text-xs text-slate-500 dark:text-slate-400">Protected</span>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => void removeDistributorWallet(w.address)}
                                      disabled={busy}
                                      className="p-0 text-left text-sm font-normal text-blue-600 underline-offset-2 hover:underline dark:text-blue-400 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:no-underline"
                                    >
                                      Delete
                                    </button>
                                  )}
                                </td>
                              </tr>
                            ) : (
                              <tr
                                key={`dash-pad-${dashWalletListPage}-${rowIdx}`}
                                className="border-t border-slate-200 dark:border-[#222222]"
                                aria-hidden
                              >
                                <td className="px-2 py-3">&nbsp;</td>
                                <td className="px-4 py-3">&nbsp;</td>
                                <td className="px-4 py-3">&nbsp;</td>
                                <td className="px-4 py-3">&nbsp;</td>
                                <td className="px-4 py-3">&nbsp;</td>
                                <td className="px-4 py-3">&nbsp;</td>
                              </tr>
                            ),
                          )}
                        </tbody>
                      </table>
                    </div>
                    {distributorWallets.length > DISTRIBUTOR_WALLETS_PAGE_SIZE ? (
                      <ListPagination
                        page={dashWalletListPage}
                        totalPages={dashWalletListTotalPages}
                        totalItems={distributorWallets.length}
                        pageSize={DISTRIBUTOR_WALLETS_PAGE_SIZE}
                        onPageChange={setDashWalletListPage}
                        className="border-0 pt-2"
                      />
                    ) : null}
                  </div>
                ) : null}
              </CardContent>
            </Card>
            ) : null}

            {dashboardMode && dashSection === "wallet-generation" ? (
              <Card className="rounded-2xl shadow-sm">
                <CardHeader>
                  <CardTitle className="text-xl">HD wallets from server seed</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4 text-sm">
                  {!sessionVerified ? (
                    <p className="text-slate-500 dark:text-slate-400">Verify session to use this section.</p>
                  ) : !hdSeedConfigured ? (
                    <Alert className="rounded-2xl border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/30">
                      <AlertCircle className="h-4 w-4" />
                      <AlertTitle className="text-amber-900 dark:text-amber-200">Mnemonic not configured</AlertTitle>
                      <AlertDescription className="text-amber-900/90 dark:text-amber-100/80">
                        Add{" "}
                        <code className="rounded bg-white/60 px-1 font-mono text-xs dark:bg-black/30">AIRDROP_HD_MNEMONIC</code>{" "}
                        to server <code className="font-mono text-xs">.env</code>, restart the app, then reload this page.
                      </AlertDescription>
                    </Alert>
                  ) : (
                    <div className="space-y-6">
                      <div className="flex flex-wrap items-end gap-3">
                        <div className="space-y-1">
                          <Label htmlFor="hd-gen-count">How many new wallets</Label>
                          <Input
                            id="hd-gen-count"
                            inputMode="numeric"
                            className="w-32"
                            value={hdGenCount}
                            onChange={(e) => setHdGenCount(e.target.value)}
                          />
                        </div>
                        <Button type="button" onClick={() => void generateHdWalletsFromSeed()} disabled={busy}>
                          Generate and register
                        </Button>
                      </div>
                      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-[#333333] dark:bg-[#141414]">
                        <div className="mb-3 space-y-1">
                          <Label className="text-base">Import from env seed</Label>
                          <p className="text-xs text-slate-600 dark:text-slate-400">
                            Uses <code className="rounded bg-white/70 px-1 font-mono dark:bg-black/40">AIRDROP_HD_MNEMONIC</code>{" "}
                            on the server (same derivation as Generate). Enter a range of indices{" "}
                            <code className="font-mono">basePath/index</code>; wallets already in your list are skipped.
                            Start at <code className="font-mono">0</code> and set a high count (max 500 per click) to
                            restore everything you previously derived from this seed.
                          </p>
                        </div>
                        <div className="flex flex-wrap items-end gap-3">
                          <div className="space-y-1">
                            <Label htmlFor="env-reg-start">Start index</Label>
                            <Input
                              id="env-reg-start"
                              inputMode="numeric"
                              className="w-28"
                              value={envRegisterStartIndex}
                              onChange={(e) => setEnvRegisterStartIndex(e.target.value)}
                            />
                          </div>
                          <div className="space-y-1">
                            <Label htmlFor="env-reg-count">How many indices</Label>
                            <Input
                              id="env-reg-count"
                              inputMode="numeric"
                              className="w-36"
                              value={envRegisterCount}
                              onChange={(e) => setEnvRegisterCount(e.target.value)}
                            />
                          </div>
                          <Button
                            type="button"
                            variant="secondary"
                            className="rounded-2xl"
                            disabled={busy}
                            onClick={() => void registerEnvSeedRangeOnServer()}
                          >
                            Import range into site
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}
                  {lastHdKeyExport && lastHdKeyExport.length > 0 ? (
                    <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-[#333333] dark:bg-[#141414]">
                      <Alert className="rounded-xl border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/30">
                        <AlertCircle className="h-4 w-4" />
                        <AlertTitle className="text-amber-900 dark:text-amber-200">Latest batch — save keys now</AlertTitle>
                        <AlertDescription className="text-amber-900/90 dark:text-amber-100/80">
                          JSON includes private keys for {lastHdKeyExport.length} wallet(s) from the last successful
                          generate. Store offline; this panel does not keep a history of past downloads.
                        </AlertDescription>
                      </Alert>
                      <Button type="button" variant="outline" className="rounded-2xl" onClick={downloadHdKeyExportJson}>
                        <Download className="mr-2 h-4 w-4" />
                        Download keys (JSON)
                      </Button>
                    </div>
                  ) : null}
                  {sessionVerified ? (
                    <div className="space-y-4">
                      <div className="space-y-2 rounded-2xl border border-slate-200 bg-white p-4 dark:border-[#333333] dark:bg-[#111111]">
                        <Label>Import wallets from JSON backup</Label>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          Use the same file from <strong>Download keys (JSON)</strong>, or any JSON with a top-level{" "}
                          <code className="rounded bg-slate-100 px-1 font-mono dark:bg-[#1a1a1a]">wallets</code> array of
                          objects containing <code className="font-mono">privateKey</code> (and optional{" "}
                          <code className="font-mono">label</code>). Duplicates are skipped. Max 200 per file.
                        </p>
                        <input
                          ref={hdImportJsonFileRef}
                          type="file"
                          accept="application/json,.json"
                          className="hidden"
                          onChange={(e) => void importWalletsFromJsonFile(e)}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          className="rounded-2xl"
                          disabled={busy}
                          onClick={() => hdImportJsonFileRef.current?.click()}
                        >
                          <Upload className="mr-2 h-4 w-4" />
                          Choose JSON file…
                        </Button>
                      </div>
                      {walletImportNotice ? (
                        <Alert className="rounded-xl border-emerald-200 bg-emerald-50 dark:border-emerald-900/40 dark:bg-emerald-950/30">
                          <CheckCircle2 className="h-4 w-4 text-emerald-700 dark:text-emerald-400" />
                          <AlertTitle className="text-emerald-900 dark:text-emerald-200">Import</AlertTitle>
                          <AlertDescription className="text-emerald-900/90 dark:text-emerald-100/90">
                            {walletImportNotice}
                          </AlertDescription>
                        </Alert>
                      ) : null}
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            ) : null}

            {dashboardMode && dashSection === "fund-distribution" ? (
              <Card className="rounded-2xl shadow-sm">
                <CardHeader>
                  <CardTitle className="text-xl">Fund distributor wallets</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4 text-sm">
                  <p className="text-slate-600 dark:text-slate-400">
                    Send the same amount from one payer wallet to an inclusive range of recipient wallets (same pattern as
                    batch job execution wallets). Sequential transactions on {net.name} (chain ID {net.chainId}). Up to{" "}
                    {FUND_DISTRIBUTE_MAX_RECIPIENTS} recipients per send (wide ranges are truncated to this limit).
                  </p>
                  {!sessionVerified ? (
                    <p className="text-slate-500 dark:text-slate-400">Verify session to use this section.</p>
                  ) : (
                    <>
                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-1">
                          <Label>Asset</Label>
                          <select
                            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm dark:border-[#333333] dark:bg-[#111111]"
                            value={fundMode}
                            disabled={busy}
                            onChange={(e) => setFundMode(e.target.value === "native" ? "native" : "erc20")}
                          >
                            <option value="erc20">ERC-20 token</option>
                            <option value="native">Native ({net.nativeCurrency.symbol})</option>
                          </select>
                        </div>
                        <div className="space-y-1">
                          <Label>Pay from wallet</Label>
                          <select
                            className="flex h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-200 disabled:cursor-not-allowed disabled:opacity-60 dark:border-[#333333] dark:bg-[#111111] dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-900/40"
                            value={fundFromAddress}
                            disabled={busy || distributorWallets.length === 0}
                            onChange={(e) => setFundFromAddress(e.target.value)}
                          >
                            {distributorWallets.map((w) => (
                              <option key={w.address} value={w.address}>
                                {(w.label || shortAddr(w.address)) + " · " + shortAddr(w.address)}
                                {w.source === "primary" ? " (authorized)" : w.source === "hd-generated" ? " (HD seed)" : ""}
                              </option>
                            ))}
                          </select>
                        </div>
                        {fundMode === "erc20" ? (
                          <div className="space-y-1 md:col-span-2">
                            <Label htmlFor="fund-token">Token contract</Label>
                            <Input
                              id="fund-token"
                              className="font-mono text-xs"
                              placeholder="0x…"
                              value={fundTokenAddress}
                              onChange={(e) => setFundTokenAddress(e.target.value)}
                              disabled={busy}
                            />
                          </div>
                        ) : null}
                        <div className="space-y-1 md:col-span-2">
                          <Label htmlFor="fund-amt">
                            Amount per recipient ({fundMode === "native" ? net.nativeCurrency.symbol : "token units"})
                          </Label>
                          <Input
                            id="fund-amt"
                            value={fundAmountPerWallet}
                            onChange={(e) => setFundAmountPerWallet(e.target.value)}
                            placeholder={fundMode === "native" ? "0.1" : "100"}
                            disabled={busy}
                          />
                        </div>
                      </div>
                      <div className="space-y-2 md:col-span-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <Label>Recipient wallets (range)</Label>
                          <Button
                            type="button"
                            variant="outline"
                            className="h-8 rounded-xl px-3 text-xs"
                            disabled={busy || fundRecipientWallets.length === 0}
                            onClick={selectFundRecipientFullRange}
                          >
                            Select all
                          </Button>
                        </div>
                        {fundRecipientWallets.length === 0 ? (
                          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:border-[#333333] dark:bg-[#111111] dark:text-slate-400">
                            No recipient wallets — choose a different pay-from wallet or add more distributor wallets.
                          </div>
                        ) : (
                          <div className="grid gap-3 sm:grid-cols-2">
                            <div className="space-y-2">
                              <Label htmlFor="fund-recipient-from">From wallet</Label>
                              <select
                                id="fund-recipient-from"
                                className="flex h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-200 disabled:cursor-not-allowed disabled:opacity-60 dark:border-[#333333] dark:bg-[#111111] dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-900/40"
                                disabled={!sessionVerified || busy}
                                value={fundRecipientRangeFrom}
                                onChange={(e) => setFundRecipientRangeFrom(e.target.value)}
                              >
                                {fundRecipientWallets.map((w) => (
                                  <option key={w.address} value={w.address}>
                                    {(w.label || shortAddr(w.address)) + " · " + shortAddr(w.address)}
                                    {w.source === "primary" ? " (authorized)" : w.source === "hd-generated" ? " (HD seed)" : ""}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="space-y-2">
                              <Label htmlFor="fund-recipient-to">To wallet</Label>
                              <select
                                id="fund-recipient-to"
                                className="flex h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-200 disabled:cursor-not-allowed disabled:opacity-60 dark:border-[#333333] dark:bg-[#111111] dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-900/40"
                                disabled={!sessionVerified || busy}
                                value={fundRecipientRangeTo}
                                onChange={(e) => setFundRecipientRangeTo(e.target.value)}
                              >
                                {fundRecipientWallets.map((w) => (
                                  <option key={w.address} value={w.address}>
                                    {(w.label || shortAddr(w.address)) + " · " + shortAddr(w.address)}
                                    {w.source === "primary" ? " (authorized)" : w.source === "hd-generated" ? " (HD seed)" : ""}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>
                        )}
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          All wallets from “From” through “To” in your distributor list order (pay-from excluded) receive
                          the amount.{" "}
                          {fundTargetAddresses.length > 0 ? (
                            <span className="font-medium text-slate-700 dark:text-slate-300">
                              Recipients in this send: {fundTargetAddresses.length}
                              {fundRecipientRangeFullCount > FUND_DISTRIBUTE_MAX_RECIPIENTS
                                ? ` (range has ${fundRecipientRangeFullCount}; only the first ${FUND_DISTRIBUTE_MAX_RECIPIENTS} are used)`
                                : ""}
                              .
                            </span>
                          ) : null}
                        </p>
                      </div>
                      <Button type="button" onClick={() => void distributeToDistributorWallets()} disabled={busy}>
                        Send to recipient range
                      </Button>
                      {fundLastResults && fundLastResults.length > 0 ? (
                        <ul className="space-y-2 rounded-lg border border-slate-200 p-3 text-xs dark:border-[#333333]">
                          {fundLastResults.map((r) => (
                            <li key={r.to} className="flex flex-wrap items-center gap-2">
                              <span className="font-mono">{shortAddr(r.to)}</span>
                              {r.txHash ? (
                                <a
                                  className="text-blue-600 underline dark:text-blue-400"
                                  href={`${explorerUrlForChainId(net.chainId)}/tx/${r.txHash}`}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {r.txHash.slice(0, 10)}…
                                </a>
                              ) : (
                                <span className="text-red-600 dark:text-red-400">{r.error || "Failed"}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </>
                  )}
                </CardContent>
              </Card>
            ) : null}

            {dashboardMode && dashSection === "queue-worker" ? (
              <Card className="rounded-2xl shadow-sm">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-xl">
                    <Server className="h-5 w-5" aria-hidden />
                    Normalized queue (job_wallets)
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4 text-sm">
                  {!sessionVerified ? (
                    <div className="rounded-2xl border border-dashed border-slate-300 p-6 text-center text-slate-500 dark:border-[#333333] dark:text-slate-400">
                      Verify wallet session to manage queue processing.
                    </div>
                  ) : queueRuntimeLoading && !queueRuntimeInfo ? (
                    <p className="text-slate-500 dark:text-slate-400">Loading queue status…</p>
                  ) : queueRuntimeInfo ? (
                    <>
                      <p className="text-xs text-slate-600 dark:text-slate-400">
                        Runtime flags are stored in MySQL (<code className="rounded bg-slate-100 px-1 dark:bg-black">queue_runtime_settings</code>
                        ). Env must still allow features (e.g. <code className="rounded bg-slate-100 px-1 dark:bg-black">AIRDROP_QUEUE_V2=true</code>
                        ).
                      </p>
                      <div className="grid gap-3">
                        {(
                          [
                            {
                              key: "proc",
                              title: "Claim / process wallets",
                              desc: "Pause all sends — workers skip claiming.",
                              on: queueRuntimeInfo.processingEnabled,
                              flip: () => void patchQueueRuntime({ processingEnabled: !queueRuntimeInfo.processingEnabled }),
                            },
                            {
                              key: "v2",
                              title: "Normalized queue V2",
                              desc: "Dashboard flag + AIRDROP_QUEUE_V2 in .env both required for an active queue.",
                              on: queueRuntimeInfo.normalizedQueueV2,
                              flip: () => void patchQueueRuntime({ normalizedQueueV2: !queueRuntimeInfo.normalizedQueueV2 }),
                            },
                            {
                              key: "emb",
                              title: "Embedded worker (this Node process)",
                              desc: "Run job_wallets sender inside dev/start. Off = rely on npm run worker:queue only.",
                              on: queueRuntimeInfo.embeddedWorker,
                              flip: () => void patchQueueRuntime({ embeddedWorker: !queueRuntimeInfo.embeddedWorker }),
                            },
                          ] as const
                        ).map((row) => (
                          <div
                            key={row.key}
                            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50/80 px-4 py-3 dark:border-[#333333] dark:bg-[#151515]"
                          >
                            <div>
                              <p className="font-medium text-slate-900 dark:text-slate-100">{row.title}</p>
                              <p className="text-xs text-slate-600 dark:text-slate-400">{row.desc}</p>
                              {row.key === "emb" ? (
                                <p className="mt-1 text-xs text-slate-500 dark:text-slate-500">
                                  Effective: {queueRuntimeInfo.embeddedWorkerEffective ? "yes" : "no"} · Loop running:{" "}
                                  {queueRuntimeInfo.embeddedWorkerLoopRunning ? "yes" : "no"} · Active{" "}
                                  {queueRuntimeInfo.embeddedWorkerActiveLoops ?? 0} /{" "}
                                  {queueRuntimeInfo.embeddedWorkerCount ?? 1}
                                  {queueRuntimeInfo.embeddedEnvOptOut ? (
                                    <>
                                      {" "}
                                      · Env <code className="rounded bg-white px-1 dark:bg-black">AIRDROP_EMBEDDED_QUEUE_WORKER=false</code> blocks
                                      embedded
                                    </>
                                  ) : null}
                                </p>
                              ) : null}
                            </div>
                            <Button
                              type="button"
                              variant={row.on ? "default" : "outline"}
                              className="rounded-xl shrink-0"
                              disabled={queueRuntimeLoading || !queueRuntimeInfo.canToggle}
                              onClick={row.flip}
                            >
                              {row.on ? "On" : "Off"}
                            </Button>
                          </div>
                        ))}
                      </div>
                      <div className="space-y-4 rounded-xl border border-slate-200 bg-white/60 p-4 dark:border-[#333333] dark:bg-[#101010]">
                        <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                          Embedded queue workers (this process)
                        </p>
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-slate-800 dark:text-slate-200">Concurrent worker loops</span>
                            <span className="font-mono text-sm tabular-nums text-slate-600 dark:text-slate-400">
                              {queueRuntimeInfo.embeddedWorkerCount ?? 1}
                            </span>
                          </div>
                          <input
                            key={`ewc-${queueRuntimeInfo.embeddedWorkerCount ?? 1}`}
                            type="range"
                            min={1}
                            max={10}
                            step={1}
                            defaultValue={queueRuntimeInfo.embeddedWorkerCount ?? 1}
                            disabled={queueRuntimeLoading || !queueRuntimeInfo.canToggle}
                            className="h-2 w-full cursor-pointer accent-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                            aria-label="Number of embedded queue worker loops"
                            onPointerUp={(e) => {
                              const v = Number((e.currentTarget as HTMLInputElement).value);
                              const cur = queueRuntimeInfo.embeddedWorkerCount ?? 1;
                              if (Number.isFinite(v) && v !== cur) {
                                void patchQueueRuntime({ embeddedWorkerCount: v });
                              }
                            }}
                          />
                          <p className="text-xs text-slate-500 dark:text-slate-500">
                            Range 1–10. Each loop runs the normalized queue worker in this Node process with a distinct
                            worker ID (MySQL <code className="rounded bg-slate-100 px-1 dark:bg-black">SKIP LOCKED</code>
                            ). For separate machines or PM2 clusters, run{" "}
                            <code className="rounded bg-slate-100 px-1 dark:bg-black">npm run worker:queue</code> per
                            process instead or in addition.
                          </p>
                        </div>
                      </div>
                      <div className="space-y-4 rounded-xl border border-slate-200 bg-white/60 p-4 dark:border-[#333333] dark:bg-[#101010]">
                        <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                          Throughput (stored in DB)
                        </p>
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-slate-800 dark:text-slate-200">Parallel transactions per wave</span>
                            <span className="font-mono text-sm tabular-nums text-slate-600 dark:text-slate-400">
                              {queueRuntimeInfo.maxParallelTxs}
                            </span>
                          </div>
                          <input
                            key={`mp-${queueRuntimeInfo.maxParallelTxs}`}
                            type="range"
                            min={1}
                            max={20}
                            step={1}
                            defaultValue={queueRuntimeInfo.maxParallelTxs}
                            disabled={queueRuntimeLoading || !queueRuntimeInfo.canToggle}
                            className="h-2 w-full cursor-pointer accent-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                            aria-label="Parallel transactions per wave"
                            onPointerUp={(e) => {
                              const v = Number((e.currentTarget as HTMLInputElement).value);
                              if (Number.isFinite(v) && v !== queueRuntimeInfo.maxParallelTxs) {
                                void patchQueueRuntime({ maxParallelTxs: v });
                              }
                            }}
                          />
                          <p className="text-xs text-slate-500 dark:text-slate-500">
                            Range 1–20. Caps simultaneous sends per batch wave (also override via{" "}
                            <code className="rounded bg-slate-100 px-1 dark:bg-black">AIRDROP_MAX_PARALLEL_TXS</code> when
                            DB unavailable).
                          </p>
                        </div>
                        <div className="space-y-2 border-t border-slate-200 pt-4 dark:border-[#333333]">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-slate-800 dark:text-slate-200">Max concurrent jobs (this process)</span>
                            <span className="font-mono text-sm tabular-nums text-slate-600 dark:text-slate-400">
                              {queueRuntimeInfo.maxConcurrentJobs}
                            </span>
                          </div>
                          <input
                            key={`mj-${queueRuntimeInfo.maxConcurrentJobs}`}
                            type="range"
                            min={1}
                            max={32}
                            step={1}
                            defaultValue={queueRuntimeInfo.maxConcurrentJobs}
                            disabled={queueRuntimeLoading || !queueRuntimeInfo.canToggle}
                            className="h-2 w-full cursor-pointer accent-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                            aria-label="Max concurrent airdrop jobs"
                            onPointerUp={(e) => {
                              const v = Number((e.currentTarget as HTMLInputElement).value);
                              if (Number.isFinite(v) && v !== queueRuntimeInfo.maxConcurrentJobs) {
                                void patchQueueRuntime({ maxConcurrentJobs: v });
                              }
                            }}
                          />
                          <p className="text-xs text-slate-500 dark:text-slate-500">
                            Range 1–32. How many airdrop jobs may run at once in this Node process. Env fallback:{" "}
                            <code className="rounded bg-slate-100 px-1 dark:bg-black">AIRDROP_MAX_CONCURRENT_JOBS</code>.
                          </p>
                        </div>
                      </div>
                      {!queueRuntimeInfo.canToggle ? (
                        <p className="text-xs text-amber-700 dark:text-amber-400">
                          Your wallet is not in <code className="rounded bg-amber-100 px-1 dark:bg-amber-950">AIRDROP_QUEUE_CONTROL_ADDRESSES</code>{" "}
                          — cannot change settings (server env).
                        </p>
                      ) : null}
                      <ul className="space-y-1.5 rounded-xl border border-slate-200 p-3 text-xs text-slate-700 dark:border-[#333333] dark:text-slate-300">
                        <li>
                          <span className="font-medium">DATABASE_URL:</span>{" "}
                          {queueRuntimeInfo.databaseConfigured ? "set" : "missing — configure MySQL"}
                        </li>
                        <li>
                          <span className="font-medium">AIRDROP_QUEUE_V2 (env):</span>{" "}
                          {queueRuntimeInfo.queueV2Env ? "on" : "off — add to .env for dashboard toggles to apply"}
                        </li>
                        <li>
                          <span className="font-medium">Normalized queue effective:</span>{" "}
                          {queueRuntimeInfo.queueV2Effective ? (
                            <span className="text-green-700 dark:text-green-400">yes</span>
                          ) : (
                            <span className="text-amber-700 dark:text-amber-400">no</span>
                          )}
                        </li>
                        <li>
                          <span className="font-medium">AIRDROP_QUEUE_GLOBAL_PAUSED:</span>{" "}
                          {queueRuntimeInfo.globalPausedEnv ? (
                            <span className="text-red-600 dark:text-red-400">true — workers claim nothing</span>
                          ) : (
                            "false"
                          )}
                        </li>
                      </ul>
                    </>
                  ) : (
                    <p className="text-slate-500 dark:text-slate-400">Could not load queue runtime.</p>
                  )}
                </CardContent>
              </Card>
            ) : null}

            {dashboardMode && dashSection === "jobs-history" ? (
              <Card className="rounded-2xl shadow-sm">
                <CardHeader>
                  <CardTitle className="text-xl">Jobs History Data</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  {!sessionVerified ? (
                    <div className="rounded-2xl border border-dashed border-slate-300 p-6 text-center text-slate-500 dark:border-[#333333] dark:text-slate-400">
                      Verify wallet session to load history.
                    </div>
                  ) : (
                    <>
                      <div className="flex flex-wrap gap-2">
                        {[
                          { id: "running", label: "Running" },
                          { id: "paused", label: "Paused" },
                          { id: "stopped", label: "Stopped" },
                          { id: "completed", label: "Completed" },
                        ].map((f) => (
                          <Button
                            key={f.id}
                            type="button"
                            variant={historyStatusFilter === f.id ? "default" : "outline"}
                            className="h-8 rounded-xl px-3 text-xs"
                            onClick={() => setHistoryStatusFilter(f.id as typeof historyStatusFilter)}
                          >
                            {f.label}
                          </Button>
                        ))}
                        <Button
                          type="button"
                          variant={historyStatusFilter === "all" ? "default" : "outline"}
                          className="h-8 rounded-xl px-3 text-xs"
                          onClick={() => setHistoryStatusFilter("all")}
                        >
                          All
                        </Button>
                      </div>
                      {historyJobsTotal === 0 ? (
                        <div className="rounded-2xl border border-dashed border-slate-300 p-6 text-center text-slate-500 dark:border-[#333333] dark:text-slate-400">
                          {historyStatusFilter === "all" ? "No history jobs found." : "No jobs in selected filter."}
                        </div>
                      ) : historyJobs.length === 0 ? (
                        <div className="rounded-2xl border border-dashed border-slate-300 p-6 text-center text-slate-500 dark:border-[#333333] dark:text-slate-400">
                          No jobs in selected filter.
                        </div>
                      ) : (
                        <>
                        {historyJobs.map((j) => {
                          const jobSt = String(j.status).toLowerCase();
                          const ok = j.resultSummary?.success ?? j.results.filter((r) => r.status === "success").length;
                          const fail = j.resultSummary?.failed ?? j.results.filter((r) => r.status === "failed").length;
                          const nRecipients = j.resultSummary?.total ?? j.results.length;
                          const showListRefresh = jobSt === "running" || jobSt === "queued";

                          return (
                            <div
                              key={j.jobId}
                              className="relative rounded-2xl border border-slate-200 bg-white dark:border-[#222222] dark:bg-[#111111]"
                            >
                              {showListRefresh ? (
                                <Button
                                  type="button"
                                  variant="outline"
                                  className="absolute right-3 top-3 z-10 h-9 rounded-xl px-3"
                                  disabled={busy || historyJobsLoading}
                                  title="Refresh counts and status from server"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    void loadHistoryJobs(undefined, historyJobsPageRef.current);
                                  }}
                                >
                                  <RefreshCw
                                    className={cn("h-4 w-4", historyJobsLoading && "animate-spin")}
                                    aria-hidden
                                  />
                                  <span className="sr-only">Refresh</span>
                                </Button>
                              ) : null}
                              <Link
                                href={`/dashboard/jobs/${j.jobId}`}
                                className="flex items-start gap-3 rounded-2xl p-4 pr-14 text-left transition-colors hover:bg-slate-100/80 dark:hover:bg-[#1a1a1a]"
                              >
                                <ChevronRight className="mt-0.5 h-5 w-5 shrink-0 text-slate-500" aria-hidden />
                                <div className="min-w-0 flex-1">
                                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-3 lg:items-start lg:gap-6">
                                    <div className="min-w-0">
                                      <div className="text-xs text-slate-500 dark:text-slate-400">Status</div>
                                      <div className="font-semibold uppercase">{j.status}</div>
                                    </div>
                                    <div className="min-w-0">
                                      <div className="text-xs text-slate-500 dark:text-slate-400">Job ID</div>
                                      <div className="break-all font-mono text-sm font-medium">{j.jobId}</div>
                                    </div>
                                    <div className="min-w-0">
                                      <div className="text-xs text-slate-500 dark:text-slate-400">Mode</div>
                                      <div className="font-medium uppercase">{j.mode}</div>
                                    </div>
                                  </div>
                                  <div className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                                    {new Date(j.createdAt).toLocaleString()} · {chainDisplayLabel(j.chainId)} · {nRecipients}{" "}
                                    recipients · {ok} success · {fail} failed ·{" "}
                                    {j.loopForever ? "continuous loop" : `single pass (${j.currentRun ?? 1}/${j.targetRunCount ?? 1})`}
                                    {jobSt === "queued" && typeof j.queuePosition === "number" ? ` · queue #${j.queuePosition}` : ""}
                                  </div>
                                </div>
                              </Link>
                            </div>
                          );
                        })}
                      <ListPagination
                        page={historyJobsPage}
                        totalPages={Math.max(1, Math.ceil(historyJobsTotal / HISTORY_JOBS_PAGE_SIZE))}
                        totalItems={historyJobsTotal}
                        pageSize={HISTORY_JOBS_PAGE_SIZE}
                        onPageChange={(p) => void loadHistoryJobs(undefined, p)}
                      />
                      </>
                    )}
                    </>
                  )} 
                </CardContent>
              </Card>
            ) : null}

            {!dashboardMode ? (
              <Card className="rounded-2xl shadow-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-xl">
                  <Coins className="h-5 w-5" />
                  Airdrop Configuration
                </CardTitle>
              </CardHeader>
              <CardContent>
                {normalizedJobsEnabled ? (
                  <div className="mb-6 space-y-3 rounded-2xl border border-slate-200 bg-slate-50/80 p-4 dark:border-[#333333] dark:bg-[#141414]/80">
                    <Label className="text-base">Recipient source</Label>
                    <div className="flex flex-col gap-2 text-sm sm:flex-row sm:flex-wrap sm:gap-6">
                      <label className="flex cursor-pointer items-center gap-2">
                        <input
                          type="radio"
                          name="jobWalletSource"
                          checked={jobWalletSource === "recipients"}
                          onChange={() => setJobWalletSource("recipients")}
                        />
                        <span>Build list here (CSV / generate)</span>
                      </label>
                      <label className="flex cursor-pointer items-center gap-2">
                        <input
                          type="radio"
                          name="jobWalletSource"
                          checked={jobWalletSource === "generated_batch"}
                          onChange={() => setJobWalletSource("generated_batch")}
                        />
                        <span>Saved PostgreSQL wallet batch</span>
                      </label>
                    </div>
                    {jobWalletSource === "generated_batch" ? (
                      <div className="grid gap-3 border-t border-slate-200 pt-3 dark:border-[#333333] md:grid-cols-2 lg:grid-cols-4">
                        <div className="space-y-1 md:col-span-2">
                          <Label>Batch (completed)</Label>
                          <select
                            className="flex h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm dark:border-[#333333] dark:bg-[#111111]"
                            value={selectedBatchId}
                            onChange={(e) => setSelectedBatchId(e.target.value)}
                          >
                            <option value="">— Select batch —</option>
                            {savedBatches.map((b) => (
                              <option key={b.id} value={b.id}>
                                {b.name} ({b.insertedWallets.toLocaleString()} wallets)
                              </option>
                            ))}
                          </select>
                          <p className="text-xs text-slate-500 dark:text-slate-400">
                            <Link href="/dashboard/wallet-batches" className="underline">
                              Open Wallet batches
                            </Link>{" "}
                            to generate storage and run <code className="rounded bg-slate-200 px-1 dark:bg-black">npm run wallets:generate</code>.
                          </p>
                        </div>
                        <div className="space-y-1">
                          <Label>From index (≥ 1)</Label>
                          <Input inputMode="numeric" value={batchRangeFrom} onChange={(e) => setBatchRangeFrom(e.target.value)} />
                        </div>
                        <div className="space-y-1">
                          <Label>To index (inclusive)</Label>
                          <Input
                            inputMode="numeric"
                            value={batchRangeTo}
                            onChange={(e) => setBatchRangeTo(e.target.value)}
                            placeholder="e.g. 100000"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label>Amount per recipient</Label>
                          <Input value={batchUniformAmount} onChange={(e) => setBatchUniformAmount(e.target.value)} />
                        </div>
                        <div className="space-y-1 md:col-span-2">
                          <Label>Job name (optional)</Label>
                          <Input value={jobNameInput} onChange={(e) => setJobNameInput(e.target.value)} placeholder="e.g. Litho airdrop wave 1" />
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <Tabs value={mode} onValueChange={(v) => setMode(v as "native" | "erc20")}>
                  <TabsList className="mb-4 grid w-full grid-cols-2 rounded-2xl">
                    <TabsTrigger value="native">Native Token</TabsTrigger>
                    <TabsTrigger value="erc20">LEP100/ERC-20 Token</TabsTrigger>
                  </TabsList>

                  <TabsContent value="native" className="space-y-4">
                    <Tabs value={splitMode} onValueChange={(v) => setSplitMode(v as "equalTotal" | "randomRange")}>
                      <TabsList className="mb-4 grid w-full grid-cols-2 rounded-2xl">
                        <TabsTrigger value="equalTotal">Fixed total (split)</TabsTrigger>
                        <TabsTrigger value="randomRange">Random per wallet (min–max)</TabsTrigger>
                      </TabsList>

                      <TabsContent value="equalTotal" className="space-y-4">
                        <div className="grid gap-4 md:grid-cols-3">
                          <div className="space-y-2">
                            <Label>Wallet count</Label>
                            <Input value={walletCount} onChange={(e) => setWalletCount(e.target.value)} />
                          </div>
                          <div className="space-y-2">
                            <Label>Total native amount</Label>
                            <Input value={totalAmount} onChange={(e) => setTotalAmount(e.target.value)} />
                          </div>
                          {deterministicGeneration ? (
                            <div className="space-y-2">
                              <Label>Derivation seed</Label>
                              <div className="flex gap-2">
                                <Input value={seed} onChange={(e) => setSeed(e.target.value)} />
                                <Button type="button" variant="outline" onClick={() => setSeed(String(Math.floor(Date.now() / 1000)))}>
                                  <RefreshCw className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </TabsContent>

                      <TabsContent value="randomRange" className="space-y-4">
                        <div className="grid gap-4 md:grid-cols-3">
                          <div className="space-y-2">
                            <Label>Wallet count</Label>
                            <Input value={walletCount} onChange={(e) => setWalletCount(e.target.value)} />
                          </div>
                          <div className="space-y-2">
                            <Label>Min per wallet (native)</Label>
                            <Input value={minPerWallet} onChange={(e) => setMinPerWallet(e.target.value)} placeholder="e.g. 1.25" />
                          </div>
                          <div className="space-y-2">
                            <Label>Max per wallet (native)</Label>
                            <Input value={maxPerWallet} onChange={(e) => setMaxPerWallet(e.target.value)} placeholder="e.g. 7.5" />
                          </div>
                        </div>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          Each wallet gets a random amount between min and max (independent draws). Overall total is not fixed.
                        </p>
                        {deterministicGeneration ? (
                          <div className="grid gap-4 md:grid-cols-3">
                            <div className="space-y-2 md:col-span-2">
                              <Label>Derivation seed (addresses only)</Label>
                              <div className="flex gap-2">
                                <Input value={seed} onChange={(e) => setSeed(e.target.value)} />
                                <Button type="button" variant="outline" onClick={() => setSeed(String(Math.floor(Date.now() / 1000)))}>
                                  <RefreshCw className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>
                          </div>
                        ) : null}
                      </TabsContent>
                    </Tabs>
                  </TabsContent>

                  <TabsContent value="erc20" className="space-y-4">
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2 md:col-span-2">
                        <Label>Token contract address</Label>
                        <Input value={tokenAddress} onChange={(e) => setTokenAddress(e.target.value)} placeholder="0x..." />
                      </div>
                    </div>

                    <Tabs value={splitMode} onValueChange={(v) => setSplitMode(v as "equalTotal" | "randomRange")}>
                      <TabsList className="mb-4 grid w-full grid-cols-2 rounded-2xl">
                        <TabsTrigger value="equalTotal">Fixed total (split)</TabsTrigger>
                        <TabsTrigger value="randomRange">Random per wallet (min–max)</TabsTrigger>
                      </TabsList>

                      <TabsContent value="equalTotal" className="space-y-4">
                        <div className="grid gap-4 md:grid-cols-3">
                          <div className="space-y-2">
                            <Label>Wallet count</Label>
                            <Input value={walletCount} onChange={(e) => setWalletCount(e.target.value)} />
                          </div>
                          <div className="space-y-2 md:col-span-2">
                            <Label>Total token amount</Label>
                            <Input value={totalAmount} onChange={(e) => setTotalAmount(e.target.value)} />
                          </div>
                          {deterministicGeneration ? (
                            <div className="space-y-2 md:col-span-3">
                              <Label>Derivation seed</Label>
                              <div className="flex max-w-md gap-2">
                                <Input value={seed} onChange={(e) => setSeed(e.target.value)} />
                                <Button type="button" variant="outline" onClick={() => setSeed(String(Math.floor(Date.now() / 1000)))}>
                                  <RefreshCw className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </TabsContent>

                      <TabsContent value="randomRange" className="space-y-4">
                        <div className="grid gap-4 md:grid-cols-3">
                          <div className="space-y-2">
                            <Label>Wallet count</Label>
                            <Input value={walletCount} onChange={(e) => setWalletCount(e.target.value)} />
                          </div>
                          <div className="space-y-2">
                            <Label>Min per wallet (tokens)</Label>
                            <Input value={minPerWallet} onChange={(e) => setMinPerWallet(e.target.value)} />
                          </div>
                          <div className="space-y-2">
                            <Label>Max per wallet (tokens)</Label>
                            <Input value={maxPerWallet} onChange={(e) => setMaxPerWallet(e.target.value)} />
                          </div>
                        </div>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          Each wallet gets a random token amount between min and max. Overall total is not fixed.
                        </p>
                        {deterministicGeneration ? (
                          <div className="grid gap-4 md:grid-cols-3">
                            <div className="space-y-2 md:col-span-2">
                              <Label>Derivation seed (addresses only)</Label>
                              <div className="flex gap-2">
                                <Input value={seed} onChange={(e) => setSeed(e.target.value)} />
                                <Button type="button" variant="outline" onClick={() => setSeed(String(Math.floor(Date.now() / 1000)))}>
                                  <RefreshCw className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>
                          </div>
                        ) : null}
                      </TabsContent>
                    </Tabs>
                  </TabsContent>
                </Tabs>

                <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50/80 p-4 text-sm dark:border-[#222222] dark:bg-[#111111]/80">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={deterministicGeneration}
                    onChange={(e) => setDeterministicGeneration(e.target.checked)}
                  />
                  <span>
                    <span className="font-medium text-slate-900 dark:text-slate-100">Deterministic addresses (HD from seed)</span>
                    <span className="block text-xs text-slate-500 dark:text-slate-400">
                      Unchecked = random recipient EOAs (keys not stored on server). Fixed-total tab: deterministic also uses equal split of total; random min–max tab uses random amounts in range. Check this if you need reproducible addresses from the seed.
                    </span>
                  </span>
                </label>

                {splitMode === "randomRange" && randomRangeAmountsTotalDisplay !== null && (
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm dark:border-[#333333] dark:bg-[#111111]">
                    <span className="text-slate-600 dark:text-slate-400">
                      {mode === "native" ? "Total Litho Value:" : "Total token amount:"}
                    </span>
                    <span className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">{randomRangeAmountsTotalDisplay}</span>
                  </div>
                )}

                <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">
                  Up to {WALLET_GEN_MAX_TOTAL.toLocaleString()} recipients per run. The app fetches up to {WALLET_GEN_BATCH.toLocaleString()} at a
                  time. Fixed total above 5,000: use deterministic (HD) so the full amount is split across all wallets.
                </p>
                {walletGenProgress && (
                  <p className="mt-1 text-xs font-medium text-slate-700 dark:text-slate-300">
                    Generating… {walletGenProgress.done.toLocaleString()} / {walletGenProgress.total.toLocaleString()} recipients
                  </p>
                )}

                <div className="mt-4 flex max-w-md flex-col gap-2">
                  <label className="flex cursor-pointer items-start gap-3 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 rounded border-slate-400 accent-slate-900 dark:accent-slate-100"
                      checked={jobLoopForever}
                      onChange={(e) => setJobLoopForever(e.target.checked)}
                    />
                    <span>
                      <span className="font-medium text-slate-900 dark:text-slate-100">Loop</span>
                      <span className="mt-0.5 block text-xs font-normal text-slate-500 dark:text-slate-400">
                        When checked, after each full run through all recipients finishes, the job is queued again automatically until you pause or cancel it.
                      </span>
                    </span>
                  </label>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    onClick={() => void generateWalletsOnBackend()}
                    disabled={
                      busy ||
                      !sessionVerified ||
                      selectedDistributorAddresses.length === 0 ||
                      (normalizedJobsEnabled && jobWalletSource === "generated_batch")
                    }
                    className="rounded-2xl"
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Generate on Backend
                  </Button>
                  <Button
                    onClick={() => void createBatchJob()}
                    variant="outline"
                    disabled={
                      busy ||
                      !sessionVerified ||
                      selectedDistributorAddresses.length === 0 ||
                      (normalizedJobsEnabled && jobWalletSource === "generated_batch"
                        ? !selectedBatchId || !batchRangeTo.trim()
                        : !recipients.length)
                    }
                    className="rounded-2xl"
                  >
                    <FileText className="mr-2 h-4 w-4" />
                    Create Batch Job
                  </Button>
                  <Button onClick={() => void startBatchJob()} disabled={busy || !batchJob} className="rounded-2xl">
                    <Play className="mr-2 h-4 w-4" />
                    Queue Job
                  </Button>
                  {dashboardMode ? (
                    <>
                      <Button onClick={queueBatchJob} disabled={busy || !batchJob} variant="outline" className="rounded-2xl">
                        Schedule / Queue
                      </Button>
                      <Button onClick={pauseBatchJob} disabled={busy || !batchJob} variant="outline" className="rounded-2xl">
                        <PauseCircle className="mr-2 h-4 w-4" />
                        Pause
                      </Button>
                      <Button onClick={resumeBatchJob} disabled={busy || !batchJob} variant="outline" className="rounded-2xl">
                        Resume
                      </Button>
                      <Button onClick={cancelBatchJob} disabled={busy || !batchJob} variant="outline" className="rounded-2xl">
                        Cancel
                      </Button>
                    </>
                  ) : null}
                </div>
                {dashboardMode && batchJob ? (
                  <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 dark:border-[#222222] dark:bg-[#111111]">
                    <Label htmlFor="scheduleAt">Schedule time (optional)</Label>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Input
                        id="scheduleAt"
                        type="datetime-local"
                        value={scheduleAtLocal}
                        onChange={(e) => setScheduleAtLocal(e.target.value)}
                        className="max-w-sm"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={updateQueuedSchedule}
                        disabled={busy || (batchJob.status !== "queued" && batchJob.status !== "draft")}
                      >
                        Edit Queue Schedule
                      </Button>
                    </div>
                    <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                      Jobs run one-by-one in queue order. If a schedule is set, the job starts after it becomes due.
                    </p>
                  </div>
                ) : null}
              </CardContent>
            </Card>
            ) : null}

            {!dashboardMode ? (
              <Card className="rounded-2xl shadow-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-xl">
                  <Upload className="h-5 w-5" />
                  CSV Import / Export + Recipients
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-[#222222] dark:bg-[#111111]">
                    <div className="mb-2 text-sm font-medium">Import CSV</div>
                    <div className="mb-2 text-xs text-slate-500 dark:text-slate-400">Format: address,amount</div>
                    <Textarea
                      className="!h-[450px] !min-h-[450px] !max-h-[450px] resize-none overflow-y-auto font-mono text-xs"
                      value={csvText}
                      onChange={(e) => setCsvText(e.target.value)}
                      placeholder={"address,amount\n0xabc...,12.5\n0xdef...,3.2"}
                    />
                    <Button type="button" onClick={importCsvRows} variant="outline" className="mt-3 rounded-2xl">
                      Import Recipients
                    </Button>
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-600 dark:border-[#222222] dark:bg-[#111111] dark:text-slate-300">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="font-medium text-slate-900 dark:text-slate-100">CSV export preview</div>
                      <Button onClick={copyCsv} variant="outline" className="rounded-2xl">
                        <Copy className="mr-2 h-4 w-4" />
                        Copy CSV
                      </Button>
                    </div>
                    <pre className="mt-3 h-[450px] overflow-auto whitespace-pre-wrap rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs dark:border-[#333333] dark:bg-[#000000]">
                      {csvExport}
                    </pre>
                  </div>
                </div>

                <div className="space-y-3">
                  {recipients.length === 0 && (
                    <div className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-[#333333] dark:text-slate-400">
                      No recipients loaded.
                    </div>
                  )}

                  {pagedRecipients.map((r) => (
                    <div
                      key={r.id}
                      className="grid items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 dark:border-[#222222] dark:bg-[#111111] md:grid-cols-[1fr_auto_auto]"
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium">{r.address}</div>
                        <div className="truncate text-xs text-slate-500 dark:text-slate-400">Source: {r.source}</div>
                      </div>
                      <Badge variant="secondary" className="rounded-xl px-3 py-2">
                        {r.amount}
                      </Badge>
                      <Button type="button" variant="ghost" size="icon" onClick={() => removeRecipient(r.id)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                  {recipients.length > 0 ? (
                    <ListPagination
                      page={recipientsPage}
                      totalPages={recipientsTotalPages}
                      totalItems={recipients.length}
                      pageSize={LIST_PAGE_SIZE}
                      onPageChange={setRecipientsPage}
                    />
                  ) : null}
                </div>
              </CardContent>
            </Card>
            ) : null}
          </div>

          {!dashboardMode ? (
          <div className="space-y-6">
            {!dashboardMode ? (
            <Card className="rounded-2xl shadow-sm">
              <CardHeader>
                <CardTitle className="text-xl">Batch Job Status</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-[#222222] dark:bg-[#111111]">
                    <div className="text-slate-500 dark:text-slate-400">Recipients</div>
                    <div className="text-2xl font-semibold">{totalRecipients}</div>
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-[#222222] dark:bg-[#111111]">
                    <div className="text-slate-500 dark:text-slate-400">Mode</div>
                    <div className="text-2xl font-semibold uppercase">{mode}</div>
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-[#222222] dark:bg-[#111111]">
                    <div className="text-slate-500 dark:text-slate-400">Success</div>
                    <div className="text-2xl font-semibold">{successCount}</div>
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-[#222222] dark:bg-[#111111]">
                    <div className="text-slate-500 dark:text-slate-400">Failed</div>
                    <div className="text-2xl font-semibold">{failedCount}</div>
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white p-4 text-slate-600 dark:border-[#222222] dark:bg-[#111111] dark:text-slate-300">
                  <div className="font-medium text-slate-900 dark:text-slate-100">Current job</div>
                  <div className="mt-2">Status: {batchJob?.status || "none"}</div>
                  <div>
                    Run mode:{" "}
                    {batchJob?.loopForever ? (
                      <span className="font-medium text-sky-700 dark:text-sky-300">Continuous loop</span>
                    ) : (
                      <span>Single pass</span>
                    )}
                  </div>
                  <div>Job ID: {batchJob?.jobId || "—"}</div>
                  <div>
                    Execution wallets:{" "}
                    {batchJob?.signerAddresses?.length
                      ? `${batchJob.signerAddresses.length} (${batchJob.signerAddresses.map(shortAddr).join(", ")})`
                      : batchJob?.signerAddress
                        ? shortAddr(batchJob.signerAddress)
                        : "—"}
                  </div>
                  <div>Queued: {batchJob?.queuedAt || "—"}</div>
                  <div>Scheduled: {batchJob?.scheduledAt || "Now"}</div>
                  <div>Created: {batchJob?.createdAt || "—"}</div>
                  <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">App status: {status}</div>
                </div>

                <div className="space-y-3">
                  {!batchJob?.results?.length && (
                    <div className="rounded-2xl border border-dashed border-slate-300 p-6 text-center text-slate-500 dark:border-[#333333] dark:text-slate-400">
                      No execution results yet.
                    </div>
                  )}

                  {pagedBatchResults.map((r, idx) => (
                    <div
                      key={`${r.recipient}-${(batchResultsPage - 1) * LIST_PAGE_SIZE + idx}`}
                      className={cn(
                        "rounded-2xl border p-4",
                        r.status === "success"
                          ? "border-emerald-200 bg-emerald-50 dark:border-emerald-900/50 dark:bg-emerald-950/40"
                          : r.status === "failed"
                            ? "border-red-200 bg-red-50 dark:border-red-900/50 dark:bg-red-950/40"
                            : "border-slate-200 bg-white dark:border-[#222222] dark:bg-[#111111]"
                      )}
                    >
                      <div className="mb-2 flex items-center gap-2 font-medium">
                        {r.status === "success" ? (
                          <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                        ) : r.status === "failed" ? (
                          <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
                        ) : (
                          <RefreshCw className="h-4 w-4" />
                        )}
                        {shortAddr(r.recipient)}
                      </div>
                      <div className="text-xs text-slate-600 dark:text-slate-300">Amount: {r.amount}</div>
                      {r.signerAddress ? (
                        <div className="text-xs text-slate-500 dark:text-slate-400">Signer: {shortAddr(r.signerAddress)}</div>
                      ) : null}
                      {r.rpcUrl ? (
                        <div className="text-xs text-slate-500 dark:text-slate-400" title={r.rpcUrl}>
                          RPC: {rpcEndpointLabel(r.rpcUrl)}
                        </div>
                      ) : null}
                      {r.txHash && (
                        <a
                          href={`${batchExplorerBase}/tx/${r.txHash}`}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-2 block truncate text-xs underline"
                        >
                          {r.txHash}
                        </a>
                      )}
                      {r.error && <div className="mt-2 text-xs text-red-700 dark:text-red-300">{r.error}</div>}
                    </div>
                  ))}
                  {batchResults.length > 0 ? (
                    <ListPagination
                      page={batchResultsPage}
                      totalPages={batchResultsTotalPages}
                      totalItems={batchResults.length}
                      pageSize={LIST_PAGE_SIZE}
                      onPageChange={setBatchResultsPage}
                    />
                  ) : null}
                </div>
              </CardContent>
            </Card>
            ) : null}
          </div>
          ) : null}
        </div>
      </div>
      <FloatingErrorNotice message={error} onDismiss={() => setError("")} />
    </div>
  );
}
