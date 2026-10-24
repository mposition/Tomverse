import "server-only";

import { ciAdmissionGithubConfig, createCiAdmissionGithub } from "@/lib/ciAdmissionGithub";

/**
 * The numbers of the repository's open pull requests, read with the CI
 * admission GitHub App, so Admin pages that show a stored record (the merge
 * lane's latest verdicts) can drop pull requests closed or merged since it was
 * written. One read is shared by every viewer for CACHE_MS. Null without the
 * App or when GitHub cannot be read: the caller then shows the record as is.
 */

const CACHE_MS = 20_000;

let cached: { atMs: number; value: number[] | null } | null = null;
let inFlight: Promise<number[] | null> | null = null;

export async function readGithubOpenPullNumbers(now: () => number = Date.now): Promise<number[] | null> {
  if (cached && now() - cached.atMs < CACHE_MS) return cached.value;
  inFlight ??= (async () => {
    const config = ciAdmissionGithubConfig();
    if (!config) return null;
    try {
      return (await createCiAdmissionGithub(config, now).openPulls()).map((pull) => pull.number);
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
