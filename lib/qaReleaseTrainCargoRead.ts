import "server-only";

import {
  QA_RELEASE_TRAIN_CANDIDATE_DAYS,
  QA_RELEASE_TRAIN_CARGO_MAX,
  qaReleaseTrainCargoCandidates,
  type QaReleaseTrainCargoCandidate,
} from "@/lib/qaReleaseTrainCargoCore";
import { createGithubRepoReader, githubReadFailure } from "@/lib/githubRepoRead";

/**
 * Reads the next train's candidates for Admin (lib/qaReleaseTrainCargoCore.ts),
 * GitHub through lib/githubRepoRead.ts. One read is kept for ten minutes and
 * shared by every viewer; files are read only for pull requests that could
 * ride. A failed read is "unread" with why, never "none", and is kept for a
 * minute so a page left open does not spend the hourly allowance retrying.
 */
const CACHE_MS = 10 * 60 * 1000;
const FAILURE_CACHE_MS = 60 * 1000;
const FILE_READS_AT_ONCE = 6;

export type QaReleaseTrainCargoCandidatesRead =
  | { status: "ok"; readAt: string; candidates: QaReleaseTrainCargoCandidate[] }
  | { status: "unread"; failure: string };

/**
 * Closed pull requests into `base`, newest update first, page by page until
 * the window is covered: a pull request merged in the window was updated in
 * it too. One page held only four of fourteen days on 2026-10-23 (#2761 fell
 * off). A list the page cap cuts short is unread, never partial: a missing
 * main release would offer what it already carried.
 */
const PAGE_CAP = 8;
async function readClosedSince(readJson: (path: string) => Promise<unknown>, base: string, sinceMs: number): Promise<unknown[]> {
  const pulls: unknown[] = [];
  for (let page = 1; page <= PAGE_CAP; page += 1) {
    const list = await readJson(`/pulls?state=closed&base=${base}&sort=updated&direction=desc&per_page=100&page=${page}`);
    if (!Array.isArray(list)) throw new Error("github_shape");
    pulls.push(...list);
    const last = list[list.length - 1] as { updated_at?: unknown } | undefined;
    if (list.length < 100 || (typeof last?.updated_at === "string" && Date.parse(last.updated_at) < sinceMs)) return pulls;
  }
  throw new Error("github_pages");
}

let cached: { atMs: number; value: QaReleaseTrainCargoCandidatesRead } | null = null;

export async function readQaReleaseTrainCargoCandidates(nowMs = Date.now()): Promise<QaReleaseTrainCargoCandidatesRead> {
  if (cached && nowMs - cached.atMs < (cached.value.status === "ok" ? CACHE_MS : FAILURE_CACHE_MS)) return cached.value;
  const readJson = createGithubRepoReader();
  try {
    const sinceMs = nowMs - QA_RELEASE_TRAIN_CANDIDATE_DAYS * 24 * 60 * 60 * 1000;
    const [mergedDevelopJson, mergedMainJson, openMainJson] = await Promise.all([
      readClosedSince(readJson, "develop", sinceMs),
      // A release that carried a candidate was merged after it, so inside the window too.
      readClosedSince(readJson, "main", sinceMs),
      readJson("/pulls?state=open&base=main&per_page=100"),
    ]);
    // First without files, to learn which could ride; only those are read.
    const unchecked = qaReleaseTrainCargoCandidates({ mergedDevelopJson, mergedMainJson, openMainJson, files: new Map(), nowMs })
      .filter((candidate) => candidate.status === "unchecked")
      .slice(0, QA_RELEASE_TRAIN_CARGO_MAX);
    const files = new Map<number, string[]>();
    for (let index = 0; index < unchecked.length; index += FILE_READS_AT_ONCE) {
      await Promise.all(
        unchecked.slice(index, index + FILE_READS_AT_ONCE).map(async ({ number }) => {
          try {
            const list = await readJson(`/pulls/${number}/files?per_page=100`);
            if (Array.isArray(list)) files.set(number, list.map((file) => String((file as { filename?: unknown }).filename ?? "")));
          } catch {
            // Left unchecked: the train itself still leaves a workflow change out.
          }
        }),
      );
    }
    const value: QaReleaseTrainCargoCandidatesRead = {
      status: "ok",
      readAt: new Date(nowMs).toISOString(),
      candidates: qaReleaseTrainCargoCandidates({ mergedDevelopJson, mergedMainJson, openMainJson, files, nowMs }),
    };
    cached = { atMs: nowMs, value };
    return value;
  } catch (error) {
    const value: QaReleaseTrainCargoCandidatesRead = { status: "unread", failure: githubReadFailure(error) };
    cached = { atMs: nowMs, value };
    return value;
  }
}
