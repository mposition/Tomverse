import "server-only";

import { ciAdmissionGithubConfig, createCiAdmissionGithub } from "@/lib/ciAdmissionGithub";

/**
 * A reader of the repository's API for Admin pages (QA and release: main's
 * open pull requests, the next train's candidates). GET only; a failed answer
 * throws `github_<status>`.
 *
 * With the CI admission GitHub App configured it reads with the App's
 * read-only installation token (5,000 requests an hour), asking only for the
 * permission the path needs; when no such token can be had it falls back to
 * the read below. Without the App, it reads
 * without a credential, as these pages first did: GitHub allows that 60 times
 * an hour per address, and the production server shares its address with
 * other Railway services -- on 2026-10-25 those reads ran out and the page
 * said "GitHub could not be read" all day.
 *
 * One reader per page read: the App token it fetches is used for that read only.
 */

const API = "https://api.github.com/repos/mposition/Tomverse";
const TIMEOUT_MS = 5_000;

const readWithoutCredential = async (path: string): Promise<unknown> => {
  const response = await fetch(`${API}${path}`, {
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`github_${response.status}`);
  return response.json();
};

export function createGithubRepoReader(): (path: string) => Promise<unknown> {
  const config = ciAdmissionGithubConfig();
  if (!config) return readWithoutCredential;
  const github = createCiAdmissionGithub(config);
  return (path) =>
    github.readRepo(path).catch((error: unknown) => {
      // GitHub refused a token for this path (the installation lacks the
      // permission, or is not installed): read as before rather than not at
      // all. A network failure or timeout is not retried here: it is shown as
      // the read's failure, and the next read tries again.
      if (error instanceof Error && /^github_(token|installation)_/.test(error.message)) return readWithoutCredential(path);
      throw error;
    });
}

/** A failure as a short code for the page: `github_403`, `timeout`, `unknown`. */
export const githubReadFailure = (error: unknown): string => {
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  return error instanceof Error && /^github_[a-z0-9_]{1,40}$/.test(error.message) ? error.message : "unknown";
};
