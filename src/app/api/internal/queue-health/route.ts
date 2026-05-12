import { NextResponse } from "next/server";
import { getQueueOperationalSnapshot } from "@/lib/queue/queue-operations-snapshot";
import { getQueueWorkerLivenessSnapshot } from "@/lib/queue/queue-worker-liveness";

/**
 * JSON operational snapshot for this Node process + DB queue shape.
 * Protect with `METRICS_SECRET`: `Authorization: Bearer <secret>` or `?token=`.
 */
export async function GET(request: Request) {
  const secret = process.env.METRICS_SECRET?.trim();
  if (!secret) {
    return NextResponse.json({ error: "METRICS_SECRET not configured" }, { status: 503 });
  }
  const url = new URL(request.url);
  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const token = url.searchParams.get("token")?.trim() ?? bearer;
  if (token !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const snapshot = await getQueueOperationalSnapshot();
    const liveness = getQueueWorkerLivenessSnapshot();
    return NextResponse.json({
      pid: process.pid,
      liveness,
      ...snapshot,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "queue-health failed" },
      { status: 500 },
    );
  }
}
