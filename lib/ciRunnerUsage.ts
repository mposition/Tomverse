import "server-only";

import type { CiRunnerOwner } from "@/lib/ciAdmissionCore";
import { ciAdmissionGithubConfig, createCiAdmissionGithub } from "@/lib/ciAdmissionGithub";

/**
 * Who holds GitHub-hosted runners right now -- each pull request, deploy and
 * other workflow, with its jobs -- for the Admin CI admission page, which
 * refreshes it every few seconds. One read is shared by every viewer for
 * CACHE_MS, so open tabs never multiply the GitHub calls (a read is about one
 * call per active workflow run, on the CI admission App's hourly budget).
 * Works whatever the admission mode; needs the App.
 */

export const CI_RUNNER_USAGE_CACHE_MS = 20_000;

export type CiRunnerUsage =
  /** `failure`: set by the page when a later read failed and this one is still shown. */
  | { status: "ok"; at: string; owners: CiRunnerOwner[]; failure?: string }
  | { status: "not_configured" }
  | { status: "unavailable"; at: string; failure: string };

let cached: { atMs: number; value: CiRunnerUsage } | null = null;
let inFlight: Promise<CiRunnerUsage> | null = null;

export async function readCiRunnerUsage(now: () => number = Date.now): Promise<CiRunnerUsage> {
  if (cached && now() - cached.atMs < CI_RUNNER_USAGE_CACHE_MS) return cached.value;
  inFlight ??= (async () => {
    const config = ciAdmissionGithubConfig();
    if (!config) return { status: "not_configured" } as const;
    const at = new Date(now()).toISOString();
    try {
      return { status: "ok", at, owners: await createCiAdmissionGithub(config, now).runnerUsage() } as const;
    } catch (error) {
      return { status: "unavailable", at, failure: (error instanceof Error ? error.message : "unknown").slice(0, 60) } as const;
    }
  })().then((value) => {
    cached = { atMs: now(), value };
    inFlight = null;
    return value;
  });
  return inFlight;
}
