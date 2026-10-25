import "server-only";

import { ciAdmissionGithubConfig, createCiAdmissionGithub } from "@/lib/ciAdmissionGithub";

/**
 * A reader of the repository's API for Admin pages (QA and release: main's
 * open pull requests, the next train's candidates). GET only; a failed answer
 * throws `github_<status>`.
 *
 * With the CI admission GitHub App configured it reads with the App's
 * read-only installation token (5,000 requests an hour). Without it, it reads
 * without a credential, as these pages first did: GitHub allows that 60 times
 * an hour per address, and the production server shares its address with
 * other Railway services -- on 2026-10-25 those reads ran out and the page
 * said "GitHub could not be read" all day.
 *
 * One reader per page read: the App token it fetches is used for that read only.
 */

const API = "https://api.github.com/repos/mposition/Tomverse";
const TIMEOUT_MS = 5_000;

export function createGithubRepoReader(): (path: string) => Promise<unknown> {
  const config = ciAdmissionGithubConfig();
  if (config) {
    const github = createCiAdmissionGithub(config);
    return (path) => github.readRepo(path);
  }
  return async (path) => {
    const response = await fetch(`${API}${path}`, {
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`github_${response.status}`);
    return response.json();
  };
}

/** A failure as a short code for the page: `github_403`, `timeout`, `unknown`. */
export const githubReadFailure = (error: unknown): string => {
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  return error instanceof Error && /^github_[a-z0-9_]{1,40}$/.test(error.message) ? error.message : "unknown";
};
