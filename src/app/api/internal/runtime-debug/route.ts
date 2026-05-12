import { NextResponse } from "next/server";
import { buildRuntimeDebugPayload } from "@/lib/queue/runtime-debug-payload";

/**
 * Deep runtime + queue snapshot (claim stats, process argv, heartbeats, DB flags).
 * Same auth as other internal ops routes: `METRICS_SECRET` via Bearer or `?token=`.
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
    const payload = await buildRuntimeDebugPayload();
    return NextResponse.json(payload, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "runtime-debug failed" },
      { status: 500 },
    );
  }
}
