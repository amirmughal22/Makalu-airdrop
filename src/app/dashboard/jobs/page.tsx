import MakaluAirdropSuite from "@/components/MakaluAirdropSuite";
import { getNormalizedJobStorageServer } from "@/lib/normalized-job-config.server";

export default function DashboardJobsPage() {
  const n = getNormalizedJobStorageServer();
  return <MakaluAirdropSuite view="dashboard" dashboardSection="jobs-history" normalizedJobsEnabled={n} />;
}
