import MakaluAirdropSuite from "@/components/MakaluAirdropSuite";
import { getNormalizedJobStorageServer } from "@/lib/normalized-job-config.server";

export default function Home() {
  return <MakaluAirdropSuite view="execution" normalizedJobsEnabled={getNormalizedJobStorageServer()} />;
}
