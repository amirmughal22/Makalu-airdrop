import MakaluAirdropSuite from "@/components/MakaluAirdropSuite";
import { getNormalizedJobStorageServer } from "@/lib/normalized-job-config.server";

export default function DashboardWalletGenerationPage() {
  const n = getNormalizedJobStorageServer();
  return <MakaluAirdropSuite view="dashboard" dashboardSection="wallet-generation" normalizedJobsEnabled={n} />;
}
