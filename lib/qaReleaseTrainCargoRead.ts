import "server-only";

import {
  QA_RELEASE_TRAIN_CARGO_MAX,
  qaReleaseTrainCargoCandidates,
  type QaReleaseTrainCargoCandidate,
} from "@/lib/qaReleaseTrainCargoCore";

/**
 * Reads the next train's candidates for Admin (lib/qaReleaseTrainCargoCore.ts).
 * The repository is public, so GitHub is read without a credential, as S-M3
 * does. Unauthenticated reads are rationed per address, so one read is kept
 * for ten minutes and shared by every viewer; files are read only for pull
 * requests that could ride. A failed read is "unread", never "none".
 */
const API = "https://api.github.com/repos/mposition/Tomverse";
const TIMEOUT_MS = 5_000;
const CACHE_MS = 10 * 60 * 1000;
const FILE_READS_AT_ONCE = 6;

export type QaReleaseTrainCargoCandidatesRead = { status: "ok"; readAt: string; candidates: QaReleaseTrainCargoCandidate[] } | { status: "unread" };

const readJson = async (path: string): Promise<unknown> => {
  const response = await fetch(`${API}${path}`, {
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`github_${response.status}`);
  return response.json();
};

let cached: { atMs: number; value: QaReleaseTrainCargoCandidatesRead } | null = null;

export async function readQaReleaseTrainCargoCandidates(nowMs = Date.now()): Promise<QaReleaseTrainCargoCandidatesRead> {
  if (cached && nowMs - cached.atMs < CACHE_MS) return cached.value;
  try {
    const [mergedDevelopJson, mergedMainJson, openMainJson] = await Promise.all([
      readJson("/pulls?state=closed&base=develop&sort=updated&direction=desc&per_page=100"),
      readJson("/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100"),
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
  } catch {
    return { status: "unread" };
  }
}
