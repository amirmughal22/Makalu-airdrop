"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { lithoUiNetwork } from "@/lib/chain";

const STORAGE_KEY = "makalu-theme";

export function SiteShell({ children }: { children: ReactNode }) {
  const [dark, setDark] = useState(true);
  const net = useMemo(() => lithoUiNetwork(), []);

  useEffect(() => {
    const prefersDark = document.documentElement.classList.contains("dark");
    queueMicrotask(() => setDark(prefersDark));
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (dark) {
      root.classList.add("dark");
      try {
        localStorage.setItem(STORAGE_KEY, "dark");
      } catch {
        /* ignore */
      }
    } else {
      root.classList.remove("dark");
      try {
        localStorage.setItem(STORAGE_KEY, "light");
      } catch {
        /* ignore */
      }
    }
  }, [dark]);

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 dark:bg-[#000000]">
      <main className="flex-1">{children}</main>
      <footer className="border-t border-slate-200 bg-white py-5 dark:border-[#222222] dark:bg-[#111111]">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6">
          <p className="text-sm text-slate-600 dark:text-slate-400">
            <span className="font-medium text-slate-800 dark:text-slate-200">Airdrop Suite</span>
            <span className="mx-2 text-slate-300 dark:text-slate-600">·</span>
            {net.name} ({net.chainId})
          </p>
          <button
            type="button"
            onClick={() => setDark((d) => !d)}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-medium text-slate-800 transition-colors hover:bg-slate-100 dark:border-[#333333] dark:bg-[#111111] dark:text-slate-100 dark:hover:bg-[#1a1a1a]"
            aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
          >
            {dark ? (
              <>
                <Sun className="h-4 w-4 shrink-0" aria-hidden />
                Light mode
              </>
            ) : (
              <>
                <Moon className="h-4 w-4 shrink-0" aria-hidden />
                Dark mode
              </>
            )}
          </button>
        </div>
      </footer>
    </div>
  );
}
