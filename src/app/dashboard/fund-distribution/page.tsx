import MakaluAirdropSuite from "@/components/MakaluAirdropSuite";
import { getNormalizedJobStorageServer } from "@/lib/normalized-job-config.server";

export default function DashboardFundDistributionPage() {
  const n = getNormalizedJobStorageServer();
  return <MakaluAirdropSuite view="dashboard" dashboardSection="fund-distribution" normalizedJobsEnabled={n} />;
}
