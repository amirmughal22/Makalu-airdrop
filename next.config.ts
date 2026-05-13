import type { NextConfig } from "next";

/**
 * Do not set `output: "standalone"` while using root `server.js` (programmatic `next()`):
 * Next prints a warning and that layout is meant for `node .next/standalone/server.js`.
 * This app loads `.env` + DB URL in `server.js` before boot and triggers instrumentation there.
 */
const nextConfig: NextConfig = {};

export default nextConfig;
