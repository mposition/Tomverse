import "server-only";

import { getPublicBuildInfo } from "@/lib/buildInfo";
import { qaReleaseMainCandidates, type QaReleaseMainCandidates } from "@/lib/qaReleaseMainCandidatesCore";

/**
 * Reads what S-M3 shows (lib/qaReleaseMainCandidatesCore.ts). The repository
 * is public, so GitHub is read without a credential; the serving build is
 * this app's own. A failed read is shown as unread, never as "none".
 */
const API = "https://api.github.com/repos/mposition/Tomverse";
const TIMEOUT_MS = 5_000;

const readJson = async (path: string): Promise<unknown> => {
  try {
    const response = await fetch(`${API}${path}`, {
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
};

export async function readQaReleaseMainCandidates(): Promise<QaReleaseMainCandidates> {
  const [openPullsJson, mainHeadJson, build] = await Promise.all([
    readJson("/pulls?state=open&base=main&per_page=50"),
    readJson("/commits/main"),
    getPublicBuildInfo(),
  ]);
  return qaReleaseMainCandidates({ openPullsJson, mainHeadJson, environment: build.environment, servingSha: build.commitSha });
}
