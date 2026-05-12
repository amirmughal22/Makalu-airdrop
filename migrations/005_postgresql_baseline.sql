-- PostgreSQL baseline (reference). The app applies the authoritative schema on boot via
-- `src/lib/postgres.ts` + `src/lib/queue/postgres-queue-schema.ts`.
--
-- Historical MySQL/MariaDB migration files (002–004) document prior evolution; new deployments
-- should use PostgreSQL + the bootstrap DDL only.

-- No-op placeholder so this file is valid SQL if executed by automation.
SELECT 1;
