import { NextResponse } from "next/server";
import { buildQueueDiagnosticsPayload } from "@/lib/queue/queue-diagnostics-payload";

/**
 * Full queue / worker diagnostics for Plesk ops.
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
    const payload = await buildQueueDiagnosticsPayload();
    return NextResponse.json(payload, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "queue-diagnostics failed" },
      { status: 500 },
    );
  }
}
