/**
 * How long develop merges take to reach dev (owner request 2026-10-20, the
 * QA-release digest's CI and deploy timing): for each develop pull request
 * merged in the window, minutes from the merge to the first check starting
 * (runner wait), to the last check starting (a late, short job still holds
 * a deploy that waits for CI), to the last check finishing, and to Railway
 * reporting the dev deployment successful.
 *
 * Read with the digest's read-only GitHub token only: Railway records its
 * deployments on GitHub (environment "Tomverse / dev"), so no Railway
 * credential is needed. Numbers only; no job name, log or title. A failed
 * read is "unavailable", never an empty list.
 *
 * Pure apart from the injected `fetchJson`.
 */

export const QA_RELEASE_LATENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const QA_RELEASE_LATENCY_MAX_MERGES = 15;
export const QA_RELEASE_DEV_DEPLOY_ENVIRONMENT = "Tomverse / dev";

export type QaReleaseLatencyMerge = {
  pullRequest: number;
  mergedAt: string;
  firstCheckStartMin: number | null;
  lastCheckStartMin: number | null;
  lastCheckDoneMin: number | null;
  devDeployedMin: number | null;
};

export type QaReleaseLatency =
  | { status: "unavailable" }
  | {
      status: "ok";
      merges: QaReleaseLatencyMerge[];
      /** Medians and the worst case over the merges that have the value; null when none do. */
      summary: {
        medianDevDeployedMin: number | null;
        maxDevDeployedMin: number | null;
        medianLastCheckDoneMin: number | null;
        maxLastCheckStartMin: number | null;
      };
    };

type FetchJson = (path: string) => Promise<unknown>;
const SHA = /^[0-9a-f]{40}$/;
const minutes = (fromMs: number, toIso: unknown): number | null => {
  if (typeof toIso !== "string") return null;
  const to = Date.parse(toIso);
  if (Number.isNaN(to) || to < fromMs) return null;
  return Math.round((to - fromMs) / 6_000) / 10;
};
const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10;
};
const asArray = (value: unknown, key?: string): unknown[] => {
  const list = key ? (value as Record<string, unknown> | null)?.[key] : value;
  if (!Array.isArray(list)) throw new Error("github_shape");
  return list;
};

export function summariseQaReleaseLatency(merges: QaReleaseLatencyMerge[]): Extract<QaReleaseLatency, { status: "ok" }>["summary"] {
  const values = (key: keyof QaReleaseLatencyMerge) => merges.map((m) => m[key]).filter((v): v is number => typeof v === "number");
  const max = (list: number[]) => (list.length === 0 ? null : Math.max(...list));
  return {
    medianDevDeployedMin: median(values("devDeployedMin")),
    maxDevDeployedMin: max(values("devDeployedMin")),
    medianLastCheckDoneMin: median(values("lastCheckDoneMin")),
    maxLastCheckStartMin: max(values("lastCheckStartMin")),
  };
}

export async function collectQaReleaseLatency(input: { fetchJson: FetchJson; nowMs: number }): Promise<QaReleaseLatency> {
  try {
    const pulls = asArray(await input.fetchJson("/repos/mposition/Tomverse/pulls?state=closed&base=develop&sort=updated&direction=desc&per_page=100"));
    const merged = pulls
      .map((pull) => pull as Record<string, unknown>)
      .filter((pull) => typeof pull.merged_at === "string" && typeof pull.merge_commit_sha === "string" && SHA.test(pull.merge_commit_sha as string))
      .filter((pull) => input.nowMs - Date.parse(pull.merged_at as string) <= QA_RELEASE_LATENCY_WINDOW_MS)
      .sort((a, b) => Date.parse(b.merged_at as string) - Date.parse(a.merged_at as string))
      .slice(0, QA_RELEASE_LATENCY_MAX_MERGES);

    const merges: QaReleaseLatencyMerge[] = [];
    for (const pull of merged) {
      const sha = pull.merge_commit_sha as string;
      const mergedMs = Date.parse(pull.merged_at as string);
      const runs = asArray(await input.fetchJson(`/repos/mposition/Tomverse/commits/${sha}/check-runs?per_page=100`), "check_runs") as Record<string, unknown>[];
      const starts = runs.map((run) => minutes(mergedMs, run.started_at)).filter((v): v is number => v !== null);
      // The last finish counts only once every check has finished.
      const allDone = runs.length > 0 && runs.every((run) => run.status === "completed");
      const dones = runs.map((run) => minutes(mergedMs, run.completed_at)).filter((v): v is number => v !== null);
      const deployments = asArray(
        await input.fetchJson(`/repos/mposition/Tomverse/deployments?sha=${sha}&environment=${encodeURIComponent(QA_RELEASE_DEV_DEPLOY_ENVIRONMENT)}&per_page=5`),
      ) as Record<string, unknown>[];
      let devDeployedMin: number | null = null;
      for (const deployment of deployments) {
        if (typeof deployment.id !== "number") continue;
        const statuses = asArray(await input.fetchJson(`/repos/mposition/Tomverse/deployments/${deployment.id}/statuses?per_page=20`)) as Record<string, unknown>[];
        const success = statuses.find((status) => status.state === "success");
        const at = success ? minutes(mergedMs, success.created_at) : null;
        if (at !== null && (devDeployedMin === null || at < devDeployedMin)) devDeployedMin = at;
      }
      merges.push({
        pullRequest: typeof pull.number === "number" ? pull.number : 0,
        mergedAt: new Date(mergedMs).toISOString(),
        firstCheckStartMin: starts.length > 0 ? Math.min(...starts) : null,
        lastCheckStartMin: starts.length > 0 ? Math.max(...starts) : null,
        lastCheckDoneMin: allDone && dones.length > 0 ? Math.max(...dones) : null,
        devDeployedMin,
      });
    }
    return { status: "ok", merges, summary: summariseQaReleaseLatency(merges) };
  } catch {
    return { status: "unavailable" };
  }
}
