import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const worker = path.join(root, "dist", "worker", "airdrop-queue-worker.cjs");

if (!existsSync(worker)) {
  console.error("[verify-worker-build] MISSING:", worker);
  process.exit(1);
}
console.info("[verify-worker-build] OK:", worker);
process.exit(0);
