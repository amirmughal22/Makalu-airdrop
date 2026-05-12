import MakaluAirdropSuite from "@/components/MakaluAirdropSuite";
import { getNormalizedJobStorageServer } from "@/lib/normalized-job-config.server";

export default function DashboardSessionPage() {
  const n = getNormalizedJobStorageServer();
  return <MakaluAirdropSuite view="dashboard" dashboardSection="session-wallet-connect" normalizedJobsEnabled={n} />;
}
