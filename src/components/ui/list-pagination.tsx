"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChevronLeft, ChevronRight } from "lucide-react";

type Props = {
  page: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  disabled?: boolean;
  className?: string;
};

export function ListPagination({
  page,
  totalPages,
  totalItems,
  pageSize,
  onPageChange,
  disabled,
  className,
}: Props) {
  const [pageInput, setPageInput] = useState(String(page));

  useEffect(() => {
    setPageInput(String(page));
  }, [page]);

  if (totalItems === 0) return null;

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, totalItems);

  function commitPageInput() {
    if (disabled) return;
    const parsed = Number.parseInt(pageInput.trim(), 10);
    if (!Number.isFinite(parsed)) {
      setPageInput(String(page));
      return;
    }
    const next = Math.min(totalPages, Math.max(1, parsed));
    setPageInput(String(next));
    if (next !== page) onPageChange(next);
  }

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4 dark:border-[#222222]",
        className,
      )}
    >
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Showing {from}–{to} of {totalItems}
      </p>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-9 w-9 shrink-0 rounded-xl px-0"
          disabled={disabled || page <= 1}
          onClick={() => onPageChange(page - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft
            className="h-4 w-4 shrink-0 stroke-slate-800 dark:stroke-slate-200"
            aria-hidden
          />
        </Button>
        <div className="flex items-center gap-1 text-sm text-slate-700 dark:text-slate-300">
          <span>Page</span>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value)}
            onBlur={commitPageInput}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitPageInput();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setPageInput(String(page));
              }
            }}
            disabled={disabled}
            aria-label="Current page"
            className="h-9 w-20 rounded-xl border border-slate-200 bg-white px-3 text-center text-sm text-slate-800 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-200 disabled:cursor-not-allowed disabled:opacity-60 dark:border-[#333333] dark:bg-[#111111] dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-900/40"
          />
          <span>/ {totalPages}</span>
        </div>
        <Button
          type="button"
          variant="outline"
          className="h-9 w-9 shrink-0 rounded-xl px-0"
          disabled={disabled || page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          aria-label="Next page"
        >
          <ChevronRight
            className="h-4 w-4 shrink-0 stroke-slate-800 dark:stroke-slate-200"
            aria-hidden
          />
        </Button>
      </div>
    </div>
  );
}
