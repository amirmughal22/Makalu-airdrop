import * as fs from "node:fs";
import * as path from "node:path";
import type { StoredJob } from "./job-types";

const DATA_FILE = path.join(process.cwd(), "data", "airdrop-jobs.json");

let hydrated = false;

export function hydrateIfNeeded(map: Map<string, StoredJob>): void {
  if (hydrated) return;
  hydrated = true;
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const arr = JSON.parse(raw) as StoredJob[];
    if (!Array.isArray(arr)) return;
    for (const j of arr) {
      if (j?.jobId && !map.has(j.jobId)) {
        map.set(j.jobId, {
          ...j,
          paused: Boolean(j.paused),
          _runnerActive: false,
        });
      }
    }
  } catch (e) {
    console.error("[airdrop-jobs] hydrate failed", e);
  }
}

export function persistJobsToDisk(map: Map<string, StoredJob>): void {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const arr = [...map.values()].map(({ _runnerActive: _r, ...rest }) => {
      void _r;
      return rest;
    });
    fs.writeFileSync(DATA_FILE, JSON.stringify(arr), "utf8");
  } catch (e) {
    console.error("[airdrop-jobs] persist failed", e);
  }
}
