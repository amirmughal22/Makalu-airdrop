"use client";

import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Alert } from "@/components/ui/alert";

const AUTO_DISMISS_MS = 5000;
const EXIT_MS = 300;

type FloatingErrorNoticeProps = {
  message: string;
  onDismiss?: () => void;
};

export function FloatingErrorNotice({ message, onDismiss }: FloatingErrorNoticeProps) {
  const onDismissRef = useRef(onDismiss);

  const [displayText, setDisplayText] = useState(() => (message || "").trim());
  const [inDom, setInDom] = useState(() => !!(message && message.trim()));
  /** true = on-screen (up); false = off below + fade */
  const [isOpen, setIsOpen] = useState(false);

  const hadErrorSinceLastClearRef = useRef(false);
  /** Play slide-up only for a new toast, not when closing. */
  const shouldPlayEnterRef = useRef(false);
  /** `true` after at least one frame where the toast was open; used to detect open → close. */
  const wasOpenRef = useRef(false);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  const clearExitTimer = useCallback(() => {
    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
  }, []);

  const runAfterExit = useCallback(() => {
    wasOpenRef.current = false;
    shouldPlayEnterRef.current = false;
    hadErrorSinceLastClearRef.current = false;
    setInDom(false);
    setDisplayText("");
    onDismissRef.current?.();
  }, []);

  // Play enter: two rAFs so the browser paints “down” first, then we transition to “up”
  useEffect(() => {
    if (!inDom) return;
    if (isOpen) return;
    if (!shouldPlayEnterRef.current) return;
    const id0 = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        shouldPlayEnterRef.current = false;
        setIsOpen(true);
      });
    });
    return () => cancelAnimationFrame(id0);
  }, [inDom, isOpen]);

  // Parent message: show, replace text, or start exit
  useEffect(() => {
    const next = (message || "").trim();
    clearExitTimer();

    if (next) {
      startTransition(() => {
        setDisplayText(next);
        if (!hadErrorSinceLastClearRef.current) {
          hadErrorSinceLastClearRef.current = true;
          shouldPlayEnterRef.current = true;
          setInDom(true);
          setIsOpen(false);
          return;
        }
        // New error while visible or while sliding out: re-open, do not re-run enter rAF
        shouldPlayEnterRef.current = false;
        setIsOpen(true);
      });
      return;
    }

    if (hadErrorSinceLastClearRef.current) {
      startTransition(() => {
        setIsOpen(false);
      });
    }
  }, [message, clearExitTimer]);

  // Auto-dismiss → slide out
  useEffect(() => {
    const next = (message || "").trim();
    if (!next || !onDismissRef.current) return;
    const t = window.setTimeout(() => {
      setIsOpen(false);
    }, AUTO_DISMISS_MS);
    return () => window.clearTimeout(t);
  }, [message]);

  // When open: mark wasOpen, clear any exit timer. When close after open: run exit, then unmount
  useEffect(() => {
    if (isOpen) {
      wasOpenRef.current = true;
      clearExitTimer();
      return;
    }
    if (!inDom) return;
    if (!wasOpenRef.current) return;

    clearExitTimer();
    exitTimerRef.current = setTimeout(() => {
      exitTimerRef.current = null;
      runAfterExit();
    }, EXIT_MS);

    return () => clearExitTimer();
  }, [isOpen, inDom, clearExitTimer, runAfterExit]);

  if (!inDom) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex justify-center p-4 pb-6 sm:pb-8"
      aria-live="assertive"
    >
      <div
        className={cn(
          "pointer-events-auto inline-block min-w-0 max-w-[min(100%,600px)] text-left will-change-transform",
          "transform transition-[transform,opacity] duration-300 ease-out motion-reduce:duration-100 motion-reduce:ease-in-out",
          isOpen
            ? "translate-y-0 opacity-100 motion-reduce:translate-y-0"
            : "translate-y-[110%] opacity-0 motion-reduce:translate-y-1 motion-reduce:opacity-0"
        )}
      >
        <Alert className="flex w-full min-w-0 items-center gap-2.5 rounded-2xl border-red-200 bg-red-100 py-2.5 pl-3 pr-2 shadow-lg dark:border-red-800/60 dark:bg-red-950/90 sm:gap-3 sm:pl-3.5 sm:pr-2.5">
          <AlertCircle
            className="h-4 w-4 shrink-0 self-center text-red-600 dark:text-red-400"
            aria-hidden
          />
          <p className="min-w-0 flex-1 self-center text-sm leading-snug text-red-800 dark:text-red-100/90">
            <span className="font-semibold text-red-900 dark:text-red-200">Error:</span>
            {displayText ? <span className="break-words"> {displayText}</span> : null}
          </p>
          {onDismiss ? (
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="shrink-0 self-center rounded-lg p-1.5 text-red-800/80 transition-colors hover:bg-red-200/60 hover:text-red-900 dark:text-red-200/90 dark:hover:bg-red-900/50 dark:hover:text-red-100"
              aria-label="Dismiss error"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </Alert>
      </div>
    </div>
  );
}
