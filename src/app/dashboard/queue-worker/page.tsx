import MakaluAirdropSuite from "@/components/MakaluAirdropSuite";
import { getNormalizedJobStorageServer } from "@/lib/normalized-job-config.server";

export default function DashboardQueueWorkerPage() {
  const n = getNormalizedJobStorageServer();
  return <MakaluAirdropSuite view="dashboard" dashboardSection="queue-worker" normalizedJobsEnabled={n} />;
}
