import { getRecentClaimAttempts } from "./claim-attempt-stats";
import { buildQueueDiagnosticsPayload } from "./queue-diagnostics-payload";

export async function buildRuntimeDebugPayload(): Promise<Record<string, unknown>> {
  const base = await buildQueueDiagnosticsPayload();
  return {
    ...base,
    process: {
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      execArgv: process.execArgv,
      argv: process.argv,
      pm2: {
        PM2_INSTANCE_ID: process.env.PM2_INSTANCE_ID,
        pm_id: process.env.pm_id,
        INSTANCE_ID: process.env.INSTANCE_ID,
      },
    },
    recentClaimAttempts: getRecentClaimAttempts(),
  };
}
