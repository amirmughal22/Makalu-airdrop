/**
 * Bundle standalone queue worker to CommonJS for production (`node` without `tsx`).
 */
import { build } from "esbuild";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const outDir = path.join(root, "dist", "worker");
const outfile = path.join(outDir, "airdrop-queue-worker.cjs");

mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(root, "scripts", "airdrop-queue-worker.ts")],
  bundle: true,
  platform: "node",
  target: ["node20"],
  format: "cjs",
  outfile,
  sourcemap: true,
  legalComments: "none",
  external: ["mysql2"],
  alias: {
    "@": path.join(root, "src"),
  },
  logLevel: "info",
});

console.info("[build-worker] wrote", outfile);
