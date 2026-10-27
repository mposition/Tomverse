/**
 * One release-train round (docs/policy/qa-release-agent.md section 8 item
 * 12), run by the merge lane service after its develop round. The order
 * keeps every write behind every check:
 *
 *   start decision -> the operator's cargo in Admin (an emergency request, or
 *   the next scheduled train's pick) -> departure -> this departure's branch
 *   not yet pushed -> no open train (scheduled only) -> the app admits
 *   (revision, once per departure, audit) -> assemble on a fresh clone of
 *   main -> push the branch -> open the main pull request -> report.
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
  qaReleaseTrainEmergencySlot,
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
    /** Open pull requests into main whose head is a train branch, and the pull requests they carry. */
    openTrains(): Promise<{ count: number; riders: number[] }>;
    /** These pull requests, each one that is merged into develop; the rest are left out. */
    cargo(numbers: readonly number[]): Promise<QaReleaseTrainCandidate[]>;
    openPullRequest(input: { head: string; title: string; body: string }): Promise<number>;
  };
  git: {
    /**
     * On a fresh clone of main: a branch with each commit cherry-picked with
     * -m 1, in order, a conflict aborted and left out, an already applied one
     * skipped; once `capacity` have ridden, the rest are over capacity without
     * being picked. A conflict may board the develop pull requests it needs
     * first (`boarded`, the operator did not pick them). Returns main's head
     * before the picks and the branch head after.
     */
    assemble(
      branch: string,
      cargo: readonly QaReleaseTrainCandidate[],
      capacity: number,
      /** Pull requests riding an open train: never boarded as a predecessor. */
      onOpenTrains?: readonly number[],
    ): Promise<{
      mainSha: string;
      headSha: string;
      picks: QaReleaseTrainPick[];
      /** Absent or empty: nothing boarded. */
      boarded?: QaReleaseTrainCandidate[];
      /** Riders whose adjacent-line conflict was settled, with the files; absent or empty: none. */
      settled?: { number: number; files: string[] }[];
    }>;
    push(branch: string): Promise<void>;
  };
  app: {
    /** Tells the app the departure hours this service runs on, for Admin's next-train line. */
    schedule(hours: number[]): Promise<void>;
    /**
     * The pull request numbers the operator picked for the next scheduled
     * train in Admin, and the emergency request waiting, if one is (its id is
     * its audit row).
     */
    selection(): Promise<{ numbers: number[]; emergency: { id: string; numbers: number[] } | null }>;
    /** An emergency admission names the request it was assembled from; the app refuses one since replaced. */
    admit(slot: string, emergencyRequestId?: string): Promise<{ admitted: boolean; reason?: string }>;
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
  /** Set when this round already ran its emergency: the scheduled departure only. */
  scheduledOnly = false,
): Promise<QaReleaseTrainOutcome> {
  const start = decideQaReleaseTrainStart(env);
  if (start === "disabled") return { exitCode: 0, train: "disabled" };
  if (start === "refuse") return { exitCode: 1, train: "refused_to_start" };
  const hours = parseQaReleaseTrainSlots(env.QA_RELEASE_TRAIN_SLOTS);
  if (hours === null) return { exitCode: 1, train: "refused_to_start" };
  // Every round, departure or not, so Admin shows the hours really in use
  // (owner, 2026-10-25). Display only: a failure never stops the train.
  await ports.app.schedule(hours).catch(() => undefined);

  // An emergency request (owner, 2026-10-25) departs on the first round after
  // it, departure hour or not, and does not wait for an open train: it is
  // the operator's call that this cannot wait. Otherwise the scheduled
  // departure, one open train at a time. An emergency never holds up a
  // scheduled departure that is due before anything is cloned: when none of
  // its pull requests is merged into develop, its reads fail, it already left
  // this minute or its admission is refused, the round falls through to the
  // scheduled one (the request stays pending until it departs or is
  // withdrawn). One whose every pull request already rides an open train is
  // admitted and reported empty without a clone, spending the request, and
  // the round goes on to a due scheduled departure. One that is assembled
  // and carries nothing ends the round: a second clone could outrun the
  // service's ten-minute limit after the scheduled pick was spent.
  let departure: { slot: string; emergency: boolean; emergencyRequestId?: string };
  let branch: string;
  let cargo: QaReleaseTrainCandidate[] = [];
  let openTrains = 0;
  // An emergency's pull requests already riding an open train: never picked
  // onto a second release branch, reported as such.
  let onOpenTrain: number[] = [];
  // Every pull request open trains carry: a predecessor among them is not boarded again.
  let openRiders: number[] = [];
  let step = "selection";
  try {
    const scheduledNow = qaReleaseTrainDeparture(nowMs, hours);
    // Off the departure hours the read is only for an emergency request: an
    // app that cannot answer then means no emergency, not a failed round.
    const selection = scheduledNow === null ? await ports.app.selection().catch(() => null) : await ports.app.selection();
    if (selection === null) return { exitCode: 0, train: "no_departure" };
    let emergency: { slot: string; branch: string; cargo: QaReleaseTrainCandidate[]; id: string; onOpenTrain: number[] } | null = null;
    let emergencyLeft = false;
    if (!scheduledOnly && selection.emergency !== null && selection.emergency.numbers.length > 0) {
      const slot = qaReleaseTrainEmergencySlot(nowMs, hours);
      const emergencyBranch = qaReleaseTrainBranch(slot);
      try {
        step = "branch";
        emergencyLeft = await ports.github.branchExists(emergencyBranch);
        if (!emergencyLeft) {
          step = "open_trains";
          const riding = new Set((await ports.github.openTrains()).riders);
          openRiders = [...riding];
          step = "cargo";
          const merged = orderQaReleaseTrainCandidates(await ports.github.cargo(selection.emergency.numbers));
          const riders = merged.filter((c) => !riding.has(c.number));
          const skipped = merged.filter((c) => riding.has(c.number)).map((c) => c.number);
          // With nothing to ride, the request is spent only when every number
          // it names already rides an open train; one not yet merged into
          // develop keeps it pending.
          const allRiding = selection.emergency.numbers.every((number) => riding.has(number));
          if (riders.length > 0 || (skipped.length > 0 && allRiding)) {
            emergency = { slot, branch: emergencyBranch, cargo: riders, id: selection.emergency.id, onOpenTrain: skipped };
          }
        }
      } catch (error) {
        if (scheduledNow === null) throw error;
      }
    }
    if (emergency !== null) {
      departure = { slot: emergency.slot, emergency: true, emergencyRequestId: emergency.id };
      branch = emergency.branch;
      cargo = emergency.cargo;
      onOpenTrain = emergency.onOpenTrain;
    } else {
      if (scheduledNow === null) {
        return { exitCode: 0, train: emergencyLeft ? "departure_done" : selection.emergency && !scheduledOnly ? "no_cargo" : "no_departure" };
      }
      departure = { slot: scheduledNow.slot, emergency: false };
      branch = qaReleaseTrainBranch(departure.slot);
      step = "branch";
      if (await ports.github.branchExists(branch)) return { exitCode: 0, train: "departure_done" };
      step = "open_trains";
      const open = await ports.github.openTrains();
      openTrains = open.count;
      openRiders = open.riders;
      step = "cargo";
      cargo = openTrains > 0 || selection.numbers.length === 0 ? [] : orderQaReleaseTrainCandidates(await ports.github.cargo(selection.numbers));
    }
  } catch (error) {
    return { exitCode: 1, train: "read_failed", failure: qaReleaseTrainReadFailure(step, error) };
  }
  const go = qaReleaseTrainShouldDepart({ departure, openTrainPullRequests: openTrains, candidates: cargo.length + onOpenTrain.length });
  if (!go.depart) return { exitCode: 0, train: go.reason === "no_departure" ? "no_departure" : go.reason };

  let admission;
  try {
    admission = await ports.app.admit(departure.slot, departure.emergencyRequestId);
  } catch (error) {
    return { exitCode: 1, train: "read_failed", failure: qaReleaseTrainReadFailure("admit", error) };
  }
  if (!admission.admitted) {
    // A refused emergency (replaced, withdrawn, or this minute taken) takes
    // no seat from a scheduled departure that is due.
    if (departure.emergency && qaReleaseTrainDeparture(nowMs, hours) !== null) return runQaReleaseTrainRound(env, ports, nowMs, true);
    return { exitCode: 0, train: "not_admitted", reason: admission.reason ?? "unknown" };
  }

  const fail = async (failure: string, picks: QaReleaseTrainPick[] = [], rcSha: string | null = null, pushed = false): Promise<QaReleaseTrainOutcome> => {
    try {
      await ports.app.report({ slot: departure.slot, outcome: "failed", pullRequestNumber: null, branch: pushed ? branch : null, rcSha, failure, picks });
    } catch {
      // The admission row already names the departure; Admin shows it unreported.
    }
    return { exitCode: 1, train: "failed", failure };
  };

  // Everything the emergency names already rides an open train: nothing to
  // clone. Reported empty, the request is spent.
  if (cargo.length === 0) {
    const picks = onOpenTrain.map((number) => ({ number, outcome: "in_open_train" as const }));
    try {
      await ports.app.report({ slot: departure.slot, outcome: "empty", pullRequestNumber: null, branch: null, rcSha: null, failure: null, picks });
    } catch {
      return { exitCode: 1, train: "failed", failure: "report_failed" };
    }
    if (departure.emergency && qaReleaseTrainDeparture(nowMs, hours) !== null) return runQaReleaseTrainRound(env, ports, nowMs, true);
    return { exitCode: 0, train: "empty", slot: departure.slot };
  }

  let assembled;
  try {
    assembled = await ports.git.assemble(branch, cargo, QA_RELEASE_TRAIN_MAX_CARGO, openRiders);
  } catch (error) {
    // The port's own code (git_missing, git_clone ...) says what to fix.
    const message = error instanceof Error ? error.message : "";
    return fail(/^git_[a-z]{1,20}$/.test(message) ? `assemble_${message}` : "assemble_failed");
  }
  const picks: QaReleaseTrainPick[] = [...assembled.picks, ...onOpenTrain.map((number) => ({ number, outcome: "in_open_train" as const }))];
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
  const pr = qaReleaseTrainPullRequest({
    slot: departure.slot,
    candidates: [...cargo, ...(assembled.boarded ?? [])],
    picks,
    rcSha: assembled.headSha,
    rollbackSha: assembled.mainSha,
    emergency: departure.emergency,
    settled: assembled.settled,
  });
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
