import "server-only";

import { ciAdmissionGithubConfig, createCiAdmissionGithub } from "@/lib/ciAdmissionGithub";

/**
 * The repository's open pull requests and those whose pull_request CI runs
 * right now, read with the CI admission GitHub App, so Admin pages that show
 * a stored record (the merge lane's latest verdicts) can drop pull requests
 * closed or merged since it was written and tell which ones' CI has finished.
 * One read is shared by every viewer for CACHE_MS. Null without the App or
 * when GitHub cannot be read: the caller then shows the record as is.
 */

export type GithubPullActivity = { open: number[]; ciRunning: number[] };

const CACHE_MS = 20_000;

let cached: { atMs: number; value: GithubPullActivity | null } | null = null;
let inFlight: Promise<GithubPullActivity | null> | null = null;

export async function readGithubPullActivity(now: () => number = Date.now): Promise<GithubPullActivity | null> {
  if (cached && now() - cached.atMs < CACHE_MS) return cached.value;
  inFlight ??= (async () => {
    const config = ciAdmissionGithubConfig();
    if (!config) return null;
    try {
      const github = createCiAdmissionGithub(config, now);
      const [pulls, running] = await Promise.all([github.openPulls(), github.runningPulls()]);
      return {
        open: pulls.map((pull) => pull.number),
        ciRunning: [...new Set([...running.keys].map((key) => Number(key.split("@")[0])))],
      };
    } catch {
      return null;
    }
  })().then((value) => {
    cached = { atMs: now(), value };
    inFlight = null;
    return value;
  });
  return inFlight;
}
