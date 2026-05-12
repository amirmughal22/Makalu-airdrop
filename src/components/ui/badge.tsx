import { type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Badge({
  className,
  variant = "default",
  ...props
}: HTMLAttributes<HTMLDivElement> & { variant?: "default" | "secondary" }) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-slate-400",
        variant === "default" &&
          "border-transparent bg-slate-900 text-slate-50 hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200",
        variant === "secondary" &&
          "border-transparent bg-slate-100 text-slate-900 hover:bg-slate-200 dark:bg-[#1a1a1a] dark:text-slate-100 dark:hover:bg-[#252525]",
        className
      )}
      {...props}
    />
  );
}
