/**
 * One release-train round (docs/policy/qa-release-agent.md section 8 item
 * 12), run by the merge lane service after its develop round. The order
 * keeps every write behind every check:
 *
 *   start decision -> departure -> this departure's branch not yet pushed ->
 *   no open train -> the operator picked cargo in Admin -> the app admits (revision,
 *   latch, audit) -> assemble on a fresh clone of main -> push the branch ->
 *   open the main pull request -> report.
 *
 * GitHub writes are the branch push and the pull request, nothing else: no
 * label, comment or status. Every failure after admission is reported with a
 * short code; nothing is retried in the same round, and a departure whose
 * branch was pushed is never started again.
 */
import {
  QA_RELEASE_TRAIN_LEFT_OUT,
  QA_RELEASE_TRAIN_MAX_CARGO,
  orderQaReleaseTrainCandidates,
  parseQaReleaseTrainSlots,
  qaReleaseTrainBranch,
  qaReleaseTrainDeparture,
  qaReleaseTrainPullRequest,
  qaReleaseTrainShouldDepart,
  type QaReleaseTrainCandidate,
  type QaReleaseTrainPick,
} from "./qaReleaseTrainCore.ts";
import { decideQaReleaseTrainStart } from "./qaReleaseServiceEnvCore.ts";

export type QaReleaseTrainPorts = {
  github: {
    /** Whether the departure's branch already exists on GitHub. */
    branchExists(branch: string): Promise<boolean>;
    /** Open pull requests into main whose head is a train branch. */
    openTrains(): Promise<number>;
    /** These pull requests, each one that is merged into develop; the rest are left out. */
    cargo(numbers: readonly number[]): Promise<QaReleaseTrainCandidate[]>;
    openPullRequest(input: { head: string; title: string; body: string }): Promise<number>;
  };
  git: {
    /**
     * On a fresh clone of main: a branch with each commit cherry-picked with
     * -m 1, in order, a conflict aborted and left out, an already applied one
     * skipped; once `capacity` have ridden, the rest are over capacity without
     * being picked. Returns main's head before the picks and the branch head after.
     */
    assemble(branch: string, cargo: readonly QaReleaseTrainCandidate[], capacity: number): Promise<{
      mainSha: string;
      headSha: string;
      picks: QaReleaseTrainPick[];
    }>;
    push(branch: string): Promise<void>;
  };
  app: {
    /** The pull request numbers the operator picked for the next train in Admin. */
    selection(): Promise<number[]>;
    admit(slot: string): Promise<{ admitted: boolean; reason?: string }>;
    report(report: {
      slot: string;
      outcome: "opened" | "empty" | "failed";
      pullRequestNumber: number | null;
      branch: string | null;
      rcSha: string | null;
      failure: string | null;
      picks: QaReleaseTrainPick[];
    }): Promise<void>;
  };
};

export type QaReleaseTrainOutcome =
  | { exitCode: 0; train: "disabled" | "no_departure" | "departure_done" | "train_open" | "no_cargo" }
  | { exitCode: 0; train: "not_admitted"; reason: string }
  | { exitCode: 0; train: "opened"; slot: string; pullRequestNumber: number; included: number; leftOut: number }
  | { exitCode: 0; train: "empty"; slot: string }
  | { exitCode: 1; train: "refused_to_start" | "read_failed" | "failed"; failure?: string };

/**
 * A read failure as `<step>:<code>`, for the round's log line. The ports
 * throw fixed codes (`github_403`, `app_409`, `github_shape`); anything else
 * -- a network error's own message -- is reduced to `unknown`, so no URL or
 * text from elsewhere reaches the log.
 */
export const qaReleaseTrainReadFailure = (step: string, error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  return `${step}:${/^[a-z0-9_]{1,40}$/.test(message) ? message : "unknown"}`;
};

export async function runQaReleaseTrainRound(
  env: Readonly<Record<string, string | undefined>>,
  ports: QaReleaseTrainPorts,
  nowMs: number,
): Promise<QaReleaseTrainOutcome> {
  const start = decideQaReleaseTrainStart(env);
  if (start === "disabled") return { exitCode: 0, train: "disabled" };
  if (start === "refuse") return { exitCode: 1, train: "refused_to_start" };
  const hours = parseQaReleaseTrainSlots(env.QA_RELEASE_TRAIN_SLOTS);
  if (hours === null) return { exitCode: 1, train: "refused_to_start" };
  const departure = qaReleaseTrainDeparture(nowMs, hours);
  if (departure === null) return { exitCode: 0, train: "no_departure" };
  const branch = qaReleaseTrainBranch(departure.slot);

  let cargo: QaReleaseTrainCandidate[];
  let openTrains: number;
  let step = "branch";
  try {
    if (await ports.github.branchExists(branch)) return { exitCode: 0, train: "departure_done" };
    step = "open_trains";
    openTrains = await ports.github.openTrains();
    if (openTrains > 0) {
      cargo = [];
    } else {
      step = "selection";
      const numbers = await ports.app.selection();
      step = "cargo";
      cargo = numbers.length === 0 ? [] : orderQaReleaseTrainCandidates(await ports.github.cargo(numbers));
    }
  } catch (error) {
    return { exitCode: 1, train: "read_failed", failure: qaReleaseTrainReadFailure(step, error) };
  }
  const go = qaReleaseTrainShouldDepart({ departure, openTrainPullRequests: openTrains, candidates: cargo.length });
  if (!go.depart) return { exitCode: 0, train: go.reason === "no_departure" ? "no_departure" : go.reason };

  let admission;
  try {
    admission = await ports.app.admit(departure.slot);
  } catch (error) {
    return { exitCode: 1, train: "read_failed", failure: qaReleaseTrainReadFailure("admit", error) };
  }
  if (!admission.admitted) return { exitCode: 0, train: "not_admitted", reason: admission.reason ?? "unknown" };

  const fail = async (failure: string, picks: QaReleaseTrainPick[] = [], rcSha: string | null = null, pushed = false): Promise<QaReleaseTrainOutcome> => {
    try {
      await ports.app.report({ slot: departure.slot, outcome: "failed", pullRequestNumber: null, branch: pushed ? branch : null, rcSha, failure, picks });
    } catch {
      // The admission row already names the departure; Admin shows it unreported.
    }
    return { exitCode: 1, train: "failed", failure };
  };

  let assembled;
  try {
    assembled = await ports.git.assemble(branch, cargo, QA_RELEASE_TRAIN_MAX_CARGO);
  } catch {
    return fail("assemble_failed");
  }
  const picks = assembled.picks;
  if (!picks.some((p) => p.outcome === "included")) {
    try {
      await ports.app.report({ slot: departure.slot, outcome: "empty", pullRequestNumber: null, branch: null, rcSha: null, failure: null, picks });
    } catch {
      return { exitCode: 1, train: "failed", failure: "report_failed" };
    }
    return { exitCode: 0, train: "empty", slot: departure.slot };
  }

  try {
    await ports.git.push(branch);
  } catch {
    return fail("push_failed", picks, assembled.headSha);
  }
  const pr = qaReleaseTrainPullRequest({ slot: departure.slot, candidates: cargo, picks, rcSha: assembled.headSha, rollbackSha: assembled.mainSha });
  let number: number;
  try {
    number = await ports.github.openPullRequest({ head: branch, title: pr.title, body: pr.body });
  } catch {
    return fail("pull_request_failed", picks, assembled.headSha, true);
  }
  try {
    await ports.app.report({ slot: departure.slot, outcome: "opened", pullRequestNumber: number, branch, rcSha: assembled.headSha, failure: null, picks });
  } catch {
    return { exitCode: 1, train: "failed", failure: "report_failed" };
  }
  return {
    exitCode: 0,
    train: "opened",
    slot: departure.slot,
    pullRequestNumber: number,
    included: picks.filter((p) => p.outcome === "included").length,
    leftOut: picks.filter((p) => QA_RELEASE_TRAIN_LEFT_OUT.has(p.outcome)).length,
  };
}
