import type { PoolClient } from "pg";

/**
 * End a client transaction with ROLLBACK and log context (never throws — pool release must still run).
 */
export async function safeRollbackPgClient(conn: PoolClient, reason: string): Promise<void> {
  try {
    await conn.query("ROLLBACK");
    if (reason) {
      console.error(`[pg] ROLLBACK ok reason=${reason}`);
    }
  } catch (e) {
    console.error(`[pg] ROLLBACK failed reason=${reason}`, e instanceof Error ? e.stack ?? e.message : e);
  }
}
