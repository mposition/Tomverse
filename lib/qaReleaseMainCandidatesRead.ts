import "server-only";

import { getPublicBuildInfo } from "@/lib/buildInfo";
import { createGithubRepoReader, githubReadFailure } from "@/lib/githubRepoRead";
import { qaReleaseMainCandidates, type QaReleaseMainCandidates } from "@/lib/qaReleaseMainCandidatesCore";

/**
 * Reads what S-M3 shows (lib/qaReleaseMainCandidatesCore.ts): GitHub through
 * lib/githubRepoRead.ts, the serving build this app's own. A failed read is
 * shown as unread with why, never as "none".
 */
export async function readQaReleaseMainCandidates(): Promise<QaReleaseMainCandidates> {
  const read = createGithubRepoReader();
  let readFailure: string | null = null;
  const readJson = (path: string) =>
    read(path).catch((error: unknown) => {
      readFailure ??= githubReadFailure(error);
      return null;
    });
  const [openPullsJson, mainHeadJson, build] = await Promise.all([
    readJson("/pulls?state=open&base=main&per_page=50"),
    readJson("/commits/main"),
    getPublicBuildInfo(),
  ]);
  return qaReleaseMainCandidates({ openPullsJson, mainHeadJson, environment: build.environment, servingSha: build.commitSha, readFailure });
}
