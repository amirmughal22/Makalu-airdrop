import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "outline" | "ghost" | "secondary";
  size?: "default" | "icon";
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:pointer-events-none disabled:opacity-50",
        variant === "default" &&
          "bg-slate-900 text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200",
        variant === "outline" &&
          "border border-slate-200 bg-white text-slate-900 hover:bg-slate-50 dark:border-[#333333] dark:bg-[#111111] dark:text-slate-100 dark:hover:bg-[#1a1a1a]",
        variant === "secondary" && "bg-slate-100 text-slate-900 hover:bg-slate-200 dark:bg-[#1a1a1a] dark:text-slate-100 dark:hover:bg-[#252525]",
        variant === "ghost" &&
          "text-slate-800 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-[#1a1a1a]",
        size === "default" && "h-10 px-4 py-2",
        size === "icon" && "h-10 w-10",
        className
      )}
      {...props}
    />
  )
);
Button.displayName = "Button";
