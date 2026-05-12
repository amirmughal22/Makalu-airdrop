import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export type WorkerLogLevel = "info" | "warn" | "error" | "metric";

/** Append structured JSON lines to logs/worker.log (and mirror level≥warn to worker-error.log). */
export class WorkerFileLogger {
  private readonly outPath: string;
  private readonly errPath: string;

  constructor(projectRoot: string, subdir = "logs") {
    const dir = path.join(projectRoot, subdir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.outPath = path.join(dir, "worker.log");
    this.errPath = path.join(dir, "worker-error.log");
  }

  log(level: WorkerLogLevel, message: string, meta?: Record<string, unknown>): void {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg: message,
      pid: process.pid,
      ...meta,
    });
    try {
      appendFileSync(this.outPath, line + "\n", "utf8");
      if (level === "warn" || level === "error") {
        appendFileSync(this.errPath, line + "\n", "utf8");
      }
    } catch {
      /* console-only fallback — avoid crashing worker */
    }
  }
}
