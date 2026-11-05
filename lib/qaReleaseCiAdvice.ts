/**
 * The daily CI suggestion round (lib/qaReleaseCiAdviceCore.ts), run by the train
 * service after its other rounds, on the train's own key. At most one paid call
 * in 24 hours: the ask is recorded before the call, so no failure repeats it. Its failure never changes the train's outcome.
 */
import type { QaReleaseHttp } from "./qaReleaseMergeLaneGithub.ts";
import { QA_RELEASE_TRAIN_REPOSITORY } from "./qaReleaseTrainCore.ts";
import { QA_RELEASE_TRAIN_RESOLVE_ENDPOINT, QA_RELEASE_TRAIN_RESOLVE_MODEL } from "./qaReleaseTrainResolve.ts";
import {
  QA_RELEASE_CI_ADVICE_COMMITS,
  QA_RELEASE_CI_ADVICE_SCHEMA,
  QA_RELEASE_CI_ADVICE_SYSTEM,
  qaReleaseCiAdviceDue,
  qaReleaseCiAdviceFrom,
  qaReleaseCiAdviceInput,
  qaReleaseCiAdvicePrompt,
  type QaReleaseCiAdviceHour,
  type QaReleaseCiAdviceInput,
  type QaReleaseCiAdviceSuggestion,
  type QaReleaseCiCheckRun,
} from "./qaReleaseCiAdviceCore.ts";

export type QaReleaseCiAdvicePorts = {
  app: {
    read: () => Promise<{ askedAt: string | null; saturation: QaReleaseCiAdviceHour[]; budget: number }>;
    /** `suggestions` null: asked, no answer. */
    save: (at: string, suggestions: QaReleaseCiAdviceSuggestion[] | null) => Promise<void>;
  };
  /** The checks of the newest develop commits, newest first. */
  checks: () => Promise<QaReleaseCiCheckRun[][]>;
  ask: (input: QaReleaseCiAdviceInput) => Promise<QaReleaseCiAdviceSuggestion[] | null>;
};

export type QaReleaseCiAdviceOutcome = "not_due" | "no_data" | "answered" | "unanswered" | "failed";

export async function runQaReleaseCiAdviceRound(ports: QaReleaseCiAdvicePorts, nowMs: number): Promise<QaReleaseCiAdviceOutcome> {
  try {
    const state = await ports.app.read();
    if (!qaReleaseCiAdviceDue(state.askedAt, nowMs)) return "not_due";
    const input = qaReleaseCiAdviceInput({ checksByCommit: await ports.checks(), saturation: state.saturation, budget: state.budget });
    if (input === null) return "no_data";
    const at = new Date(nowMs).toISOString();
    // The ask is recorded before it is paid for: if this fails nothing is
    // called, and if anything after it fails the next round does not call again.
    await ports.app.save(at, null);
    const suggestions = await ports.ask(input).catch(() => null);
    if (suggestions === null) return "unanswered";
    await ports.app.save(at, suggestions);
    return "answered";
  } catch {
    return "failed";
  }
}

export function createQaReleaseCiAdviceModel(input: { http: QaReleaseHttp; apiKey: string }): QaReleaseCiAdvicePorts["ask"] {
  return async (advice) => {
    const response = await input.http({
      method: "POST",
      url: QA_RELEASE_TRAIN_RESOLVE_ENDPOINT,
      headers: { "content-type": "application/json", "x-api-key": input.apiKey, "anthropic-version": "2026-10-21" },
      body: JSON.stringify({
        model: QA_RELEASE_TRAIN_RESOLVE_MODEL,
        max_tokens: 3_000,
        output_config: { effort: "medium", format: { type: "json_schema", schema: QA_RELEASE_CI_ADVICE_SCHEMA } },
        system: QA_RELEASE_CI_ADVICE_SYSTEM,
        messages: [{ role: "user", content: qaReleaseCiAdvicePrompt(advice) }],
      }),
    });
    if (response.status !== 200) return null;
    const message = JSON.parse(response.text) as { stop_reason?: unknown; content?: { type?: unknown; text?: unknown }[] };
    if (message.stop_reason !== "end_turn") return null;
    const text = (message.content ?? []).find((block) => block.type === "text")?.text;
    return qaReleaseCiAdviceFrom(typeof text === "string" ? JSON.parse(text) : null);
  };
}

/** The newest develop commits' checks, one call a commit, with the App's Checks read permission. */
export function createQaReleaseCiAdviceChecks(input: { http: QaReleaseHttp; token: () => Promise<string> }): QaReleaseCiAdvicePorts["checks"] {
  const get = async (path: string): Promise<unknown> => {
    const response = await input.http({
      method: "GET",
      url: `https://api.github.com/repos/${QA_RELEASE_TRAIN_REPOSITORY}${path}`,
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${await input.token()}`, "x-github-api-version": "2022-11-28" },
    });
    if (response.status !== 200) throw new Error(`github_${response.status}`);
    return JSON.parse(response.text);
  };
  return async () => {
    const commits = (await get(`/commits?sha=develop&per_page=${QA_RELEASE_CI_ADVICE_COMMITS + 3}`)) as { sha?: unknown }[];
    const out: QaReleaseCiCheckRun[][] = [];
    for (const commit of commits) {
      if (typeof commit.sha !== "string" || !/^[0-9a-f]{40}$/.test(commit.sha)) continue;
      const { check_runs: runs } = (await get(`/commits/${commit.sha}/check-runs?per_page=100&filter=latest`)) as { check_runs?: Record<string, unknown>[] };
      const finished = (runs ?? []).map((run) => ({
        name: String(run.name ?? ""),
        startedAt: typeof run.started_at === "string" ? run.started_at : null,
        completedAt: typeof run.completed_at === "string" ? run.completed_at : null,
        conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
      }));
      // Only commits whose CI has finished say how long it takes.
      if (finished.length > 0 && finished.every((run) => run.conclusion !== null)) out.push(finished);
      if (out.length === QA_RELEASE_CI_ADVICE_COMMITS) break;
    }
    return out;
  };
}
