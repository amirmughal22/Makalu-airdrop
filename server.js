/**
 * Plesk / custom Node entry: run `npm run build` first, then `node server.js` (or set startup file to server.js).
 * Uses PORT and HOST from the environment when set.
 *
 * Load `.env` here before `database-url.js`: Next.js only merges env when the Next server boots, but
 * `ensureDatabaseUrl()` runs first — without this, DB_* / DATABASE_URL from `.env` are missing and
 * embedded queue workers never start in production.
 */
const path = require("path");
const { loadEnvConfig } = require("@next/env");
const projectDir = path.resolve(__dirname);
loadEnvConfig(projectDir);

const { ensureDatabaseUrl } = require("./database-url.js");
ensureDatabaseUrl();

const { createServer } = require("http");
const { parse } = require("url");
const { pathToFileURL } = require("url");
const next = require("next");

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOST || "0.0.0.0";
const port = parseInt(process.env.PORT || "3000", 10);

const app = next({
  dev,
  hostname,
  port,
  dir: __dirname,
});

const handle = app.getRequestHandler();

app
  .prepare()
  .then(async () => {
    /**
     * Programmatic `next()` skips `server.prepare()` when NODE_ENV=production, so
     * `src/instrumentation.ts` is never executed — embedded queue workers do not start.
     * `next start` does not have this gap. Mirror Next's hook so workers match `npm run dev`.
     */
    if (!dev) {
      try {
        const ig = require.resolve(
          "next/dist/server/lib/router-utils/instrumentation-globals.external.js",
        );
        const { ensureInstrumentationRegistered } = await import(pathToFileURL(ig).href);
        await ensureInstrumentationRegistered(__dirname, ".next");
        console.info("[server.js] Next.js instrumentation hook finished — check for [instrumentation] queue worker lines above.");
      } catch (e) {
        console.error("[server.js] Failed to run instrumentation hook (queue workers may stay off):", e);
      }
    }

    createServer(async (req, res) => {
      try {
        const parsedUrl = parse(req.url, true);
        await handle(req, res, parsedUrl);
      } catch (err) {
        console.error("Request error", err);
        res.statusCode = 500;
        res.end("Internal Server Error");
      }
    }).listen(port, hostname, (err) => {
      if (err) throw err;
      console.log(`> Makalu Airdrop ready on http://${hostname}:${port} (${dev ? "dev" : "production"})`);
    });
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
