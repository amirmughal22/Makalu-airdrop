import { createRequire } from "node:module";
import { NextResponse } from "next/server";
import { isAirdropQueueV2Enabled } from "./config";

const require = createRequire(import.meta.url);
const { ensureDatabaseUrl } = require("../../../database-url.js") as { ensureDatabaseUrl: () => void };

/** Requires AIRDROP_QUEUE_V2 + DATABASE_URL for normalized queue HTTP handlers. */
export function requireNormalizedQueueApi(): NextResponse | null {
  ensureDatabaseUrl();
  if (!isAirdropQueueV2Enabled()) {
    return NextResponse.json(
      {
        error:
          "Normalized queue API is disabled. Set AIRDROP_QUEUE_V2=true in .env and enable «Normalized queue V2» on Dashboard → Queue worker (or DB queue_runtime_settings.normalized_queue_v2).",
      },
      { status: 503 },
    );
  }
  if (!process.env.DATABASE_URL?.trim()) {
    return NextResponse.json(
      { error: "DATABASE_URL is required for the normalized queue API." },
      { status: 503 },
    );
  }
  return null;
}
