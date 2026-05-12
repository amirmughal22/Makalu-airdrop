"use client";

import { lithoUiNetwork } from "@/lib/chain";

type NetworkConfigGridProps = {
  nonceQueueEnabled: boolean;
  hsmModeEnabled: boolean;
};

export function NetworkConfigGrid({ nonceQueueEnabled, hsmModeEnabled }: NetworkConfigGridProps) {
  const net = lithoUiNetwork();
  return (
    <div className="grid gap-4 lg:grid-cols-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-[#222222] dark:bg-[#111111]">
        <div className="text-xs text-slate-500 dark:text-slate-400">Network</div>
        <div className="mt-2 text-sm font-medium">
          {net.name} <span className="text-slate-500 dark:text-slate-400">({net.chainId})</span>
        </div>
      </div>
      <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-[#222222] dark:bg-[#111111]">
        <div className="text-xs text-slate-500 dark:text-slate-400">RPC</div>
        <div className="mt-1 break-all text-sm font-medium">{net.rpcUrl}</div>
      </div>
      <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-[#222222] dark:bg-[#111111]">
        <div className="text-xs text-slate-500 dark:text-slate-400">Explorer</div>
        <a href={net.explorerUrl} target="_blank" rel="noreferrer" className="mt-1 block text-sm font-medium underline">
          {net.explorerUrl}
        </a>
      </div>
      <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-[#222222] dark:bg-[#111111]">
        <div className="text-xs text-slate-500 dark:text-slate-400">Execution Engine</div>
        <div className="mt-1 text-sm font-medium">{hsmModeEnabled ? "HSM-backed signing" : "Software signer"}</div>
        <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {nonceQueueEnabled ? "Queued nonce manager enabled" : "Nonce queue disabled"}
        </div>
      </div>
    </div>
  );
}
