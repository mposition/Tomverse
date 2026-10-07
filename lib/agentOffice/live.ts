/**
 * The rooms of the Agent office that show a real record instead of the demo.
 *
 * The server reads (lib/agentOfficeLiveRead.ts) and hands the client plain
 * values of these shapes; everything here is pure, so the client and the
 * tests share the one mapping from a state to what a room says.
 *
 * Product research was the first such room. What the office shows of it is the
 * agent's operating state -- the app switch, whether its latest scheduled run
 * was recorded, when the last success was, whether it has gone silent -- and never what it
 * observed: docs/policy/product-research-agent.md §4 gives its observations
 * one place to be read, its own section, and §8 keeps issue titles there.
 *
 * QA and release reads the same way: whether its daily digest arrived in time
 * (the agent's own freshness verdict), when the newest one was stored, the
 * operator control revision it runs under and whether its merge lane is
 * latched -- never what a digest says (docs/policy/qa-release-agent.md §4 keeps
 * that to the common digest area).
 *
 * Engineering shows its switches, the agent's own halt verdict, how many
 * decisions wait for a person and its newest run's status -- enums, counts and
 * times only. Patch bodies, reasons and card text stay on its own screen
 * (docs/policy/engineering-agent.md §11).
 */

import type { DeptStatus } from "@/lib/agentOffice/sim";

export type AgentOfficeSlotState = "ok" | "failed" | "missing" | "duplicate";

export type AgentOfficeSilence =
  | "disabled"
  | "anchor_missing"
  | "no_observation_yet"
  | "recent"
  | "silent";

export type AgentOfficeResearchState =
  /** The read failed. Not an empty result and not a status (admin IA rule 8). */
  | { kind: "unread" }
  /** The app switch is unset: the agent stores nothing. */
  | { kind: "disabled" }
  | {
      kind: "observed";
      /** The slot a run at the moment of reading answers for (UTC ISO). */
      slot: string;
      slotState: AgentOfficeSlotState;
      failureStage: string | null;
      /** Whether that slot's submission window was still open when read. */
      windowOpen: boolean;
      lastSuccessAt: string | null;
      silence: AgentOfficeSilence;
      silenceHours: number | null;
    };

/** The QA agent's own freshness verdict (lib/qaReleaseDigestFreshnessCore.ts). */
export type AgentOfficeQaVerdict =
  | "fresh"
  | "stale"
  | "operator_disabled"
  | "dark_not_configured"
  | "control_mismatch";

export type AgentOfficeQaState =
  | { kind: "unread" }
  | {
      kind: "observed";
      verdict: AgentOfficeQaVerdict;
      /** When the newest digest was stored (UTC ISO), or null if none ever was. */
      latestDigestAt: string | null;
      /** The newest operator control revision, or null when none is recorded. */
      controlRevision: number | null;
      mergeLaneLatched: boolean;
    };

/** The engineering agent's halt values (lib/engineeringAgentCore.ts HALT_VALUES). */
export type AgentOfficeEngineeringHalt =
  | "none"
  | "config_missing"
  | "circuit_open"
  | "unbound_app_pr"
  | "unbound_app_ref"
  | "state_mismatch";

export type AgentOfficeEngineeringState =
  | { kind: "unread" }
  | {
      kind: "observed";
      /** The effective mode: unset, unknown or killed reads as off. */
      mode: "off" | "shadow" | "t1";
      frozen: boolean;
      killSwitch: boolean;
      /** The halt the agent tells its services (currentEngineeringAgentHalt). */
      halt: AgentOfficeEngineeringHalt;
      /** Open items waiting for a person (policy §12). */
      pending: { t2Draft: number; decision: number; stateMismatch: number };
      activeRuns: number;
      /** When the earliest run still in progress started (UTC ISO), or null when none is. */
      activeSince: string | null;
      /**
       * The newest run that ended, by its end: status and outcome enums, its
       * times (UTC ISO), and whether it needs a look -- anything the agent's
       * own settlement did not hand to a person as a result.
       */
      lastRun: {
        status: string;
        outcome: string | null;
        startedAt: string;
        endedAt: string;
        needsLook: boolean;
      } | null;
      runnerLastFinishAt: string | null;
      publisherLastFinishAt: string | null;
    };

export type AgentOfficeLiveRooms = {
  /** When the server read them (UTC ISO). */
  readAt: string;
  research: AgentOfficeResearchState;
  qa: AgentOfficeQaState;
  engineering: AgentOfficeEngineeringState;
};

/** What a live room hands the demo engine: its colour and its lines, already in the console's language. */
export type AgentOfficeLiveDept = {
  status: DeptStatus;
  /** A word or two for the room's badge, in place of the demo status word. */
  badge: string;
  /** The one-line state: what the room says, and what its lead says. */
  line: string;
  /** Supporting facts: last success, silence, the read time. */
  detail: string;
};

/**
 * The room colour for a state. Only a recorded run is done. A failed or
 * duplicated run, a silent agent and a read that failed need a look; a slot not
 * yet recorded and a switch that is off are waiting. None of them is "waiting
 * on a link": the room has its link, and says what it read.
 */
export function researchTone(state: AgentOfficeResearchState): DeptStatus {
  if (state.kind === "unread") return "attention";
  if (state.kind === "disabled") return "waiting";
  if (state.slotState === "ok") return "done";
  if (state.slotState === "failed" || state.slotState === "duplicate") return "attention";
  return state.silence === "silent" ? "attention" : "waiting";
}

/** A UTC instant as `MM-DD HH:mm UTC`: the same on the server and in any browser. */
export const utcStamp = (iso: string) => `${iso.slice(5, 10)} ${iso.slice(11, 16)} UTC`;

type ResearchCopy = {
  badges: {
    ok: string;
    failed: string;
    duplicate: string;
    missingOpen: string;
    missing: string;
    silent: string;
    disabled: string;
    unread: string;
  };
  unread: string;
  disabled: string;
  ok: (slot: string) => string;
  failed: (slot: string, stage: string) => string;
  duplicate: (slot: string) => string;
  missingOpen: (slot: string) => string;
  missing: (slot: string) => string;
  lastSuccess: (time: string) => string;
  noSuccess: string;
  silent: (hours: number) => string;
  anchorMissing: string;
  readAt: (time: string) => string;
};

/** The research room's line and detail, from its state and the console's copy. */
export function researchLiveDept(
  state: AgentOfficeResearchState,
  readAt: string,
  copy: ResearchCopy
): AgentOfficeLiveDept {
  const read = copy.readAt(utcStamp(readAt));
  const status = researchTone(state);
  if (state.kind === "unread") {
    return { status, badge: copy.badges.unread, line: copy.unread, detail: read };
  }
  if (state.kind === "disabled") {
    return { status, badge: copy.badges.disabled, line: copy.disabled, detail: read };
  }

  // "Latest", never "today": before 21:30 UTC the slot that has passed is
  // yesterday's, so every line names the slot it is about.
  const slot = utcStamp(state.slot);
  const line =
    state.slotState === "ok"
      ? copy.ok(slot)
      : state.slotState === "failed"
        ? copy.failed(slot, state.failureStage ?? "unknown")
        : state.slotState === "duplicate"
          ? copy.duplicate(slot)
          : state.windowOpen
            ? copy.missingOpen(slot)
            : copy.missing(slot);

  const facts = [
    state.lastSuccessAt ? copy.lastSuccess(utcStamp(state.lastSuccessAt)) : copy.noSuccess,
  ];
  if (state.silence === "silent" && state.silenceHours !== null) {
    facts.push(copy.silent(Math.floor(state.silenceHours)));
  }
  if (state.silence === "anchor_missing") facts.push(copy.anchorMissing);
  facts.push(read);

  const badge =
    state.slotState === "ok"
      ? copy.badges.ok
      : state.slotState === "failed"
        ? copy.badges.failed
        : state.slotState === "duplicate"
          ? copy.badges.duplicate
          : state.silence === "silent"
            ? copy.badges.silent
            : state.windowOpen
              ? copy.badges.missingOpen
              : copy.badges.missing;

  return { status, badge, line, detail: facts.join(" · ") };
}

/**
 * The QA room's colour. A fresh digest is done unless the merge lane is
 * latched; a silent digest, a switch recorded on with no secret behind it, a
 * latched lane and a read that failed need a look; an agent the operator
 * switched off, or never configured here, is waiting.
 */
export function qaTone(state: AgentOfficeQaState): DeptStatus {
  if (state.kind === "unread") return "attention";
  if (state.mergeLaneLatched) return "attention";
  if (state.verdict === "fresh") return "done";
  if (state.verdict === "stale" || state.verdict === "control_mismatch") return "attention";
  return "waiting";
}

type QaCopy = {
  badges: {
    fresh: string;
    stale: string;
    disabled: string;
    notConfigured: string;
    mismatch: string;
    latched: string;
    unread: string;
  };
  unread: string;
  fresh: (time: string) => string;
  stale: (time: string) => string;
  staleNever: string;
  disabled: string;
  notConfigured: string;
  mismatch: string;
  revision: (revision: number) => string;
  noRevision: string;
  latched: string;
  lastReceived: (time: string) => string;
  readAt: (time: string) => string;
};

/** The QA room's line and detail, from its state and the console's copy. */
export function qaLiveDept(state: AgentOfficeQaState, readAt: string, copy: QaCopy): AgentOfficeLiveDept {
  const read = copy.readAt(utcStamp(readAt));
  const status = qaTone(state);
  if (state.kind === "unread") return { status, badge: copy.badges.unread, line: copy.unread, detail: read };

  const line =
    state.verdict === "fresh" && state.latestDigestAt
      ? copy.fresh(utcStamp(state.latestDigestAt))
      : state.verdict === "stale"
        ? state.latestDigestAt
          ? copy.stale(utcStamp(state.latestDigestAt))
          : copy.staleNever
        : state.verdict === "operator_disabled"
          ? copy.disabled
          : state.verdict === "control_mismatch"
            ? copy.mismatch
            : copy.notConfigured;

  const badge = state.mergeLaneLatched
    ? copy.badges.latched
    : state.verdict === "fresh"
      ? copy.badges.fresh
      : state.verdict === "stale"
        ? copy.badges.stale
        : state.verdict === "operator_disabled"
          ? copy.badges.disabled
          : state.verdict === "control_mismatch"
            ? copy.badges.mismatch
            : copy.badges.notConfigured;

  const facts = [state.controlRevision === null ? copy.noRevision : copy.revision(state.controlRevision)];
  // The fresh and stale lines already carry the time; the others do not.
  if (state.latestDigestAt && state.verdict !== "fresh" && state.verdict !== "stale") {
    facts.push(copy.lastReceived(utcStamp(state.latestDigestAt)));
  }
  if (state.mergeLaneLatched) facts.push(copy.latched);
  facts.push(read);
  return { status, badge, line, detail: facts.join(" · ") };
}

const pendingTotal = (pending: { t2Draft: number; decision: number; stateMismatch: number }) =>
  pending.t2Draft + pending.decision + pending.stateMismatch;

/**
 * The engineering room's colour, from the agent's own verdicts. A halt, a
 * decision waiting for a person and a latest run that needs a look come
 * first, because a switched-off agent can still hold all three; an agent
 * switched off, killed or frozen is waiting; a run in progress is working;
 * otherwise the room is clear.
 */
export function engineeringTone(state: AgentOfficeEngineeringState): DeptStatus {
  if (state.kind === "unread") return "attention";
  if (state.halt !== "none" || pendingTotal(state.pending) > 0 || state.lastRun?.needsLook) return "attention";
  if (state.killSwitch || state.mode === "off" || state.frozen) return "waiting";
  if (state.activeRuns > 0) return "working";
  return state.lastRun ? "done" : "waiting";
}

type EngineeringCopy = {
  badges: {
    halted: string;
    decisions: string;
    lastRunLook: string;
    killSwitch: string;
    off: string;
    frozen: string;
    running: string;
    clear: string;
    noRun: string;
    unread: string;
  };
  unread: string;
  halt: (reason: string) => string;
  halts: Record<Exclude<AgentOfficeEngineeringHalt, "none">, string>;
  decisions: (count: number) => string;
  killSwitch: string;
  off: string;
  frozen: string;
  running: (time: string) => string;
  runningMany: (count: number, time: string) => string;
  lastRun: (result: string, time: string) => string;
  noRun: string;
  mode: (mode: string) => string;
  pending: (t2Draft: number, decision: number, stateMismatch: number) => string;
  runnerFinish: (time: string) => string;
  runnerNever: string;
  publisherFinish: (time: string) => string;
  publisherNever: string;
  readAt: (time: string) => string;
};

/** The engineering room's line and detail, from its state and the console's copy. */
export function engineeringLiveDept(
  state: AgentOfficeEngineeringState,
  readAt: string,
  copy: EngineeringCopy
): AgentOfficeLiveDept {
  const read = copy.readAt(utcStamp(readAt));
  const status = engineeringTone(state);
  if (state.kind === "unread") return { status, badge: copy.badges.unread, line: copy.unread, detail: read };

  const waiting = pendingTotal(state.pending);
  const last = state.lastRun;
  const lastLine = last ? copy.lastRun(last.outcome ?? last.status, utcStamp(last.endedAt)) : copy.noRun;
  const since = state.activeSince ? utcStamp(state.activeSince) : "—";
  const runningLine = state.activeRuns === 1 ? copy.running(since) : copy.runningMany(state.activeRuns, since);

  const [badge, line]: [string, string] =
    state.halt !== "none"
      ? [copy.badges.halted, copy.halt(copy.halts[state.halt])]
      : waiting > 0
        ? [copy.badges.decisions, copy.decisions(waiting)]
        : last?.needsLook
          ? [copy.badges.lastRunLook, lastLine]
          : state.killSwitch
            ? [copy.badges.killSwitch, copy.killSwitch]
            : state.mode === "off"
              ? [copy.badges.off, copy.off]
              : state.frozen
                ? [copy.badges.frozen, copy.frozen]
                : state.activeRuns > 0
                  ? [copy.badges.running, runningLine]
                  : last
                    ? [copy.badges.clear, lastLine]
                    : [copy.badges.noRun, copy.noRun];

  const facts = [copy.mode(state.mode)];
  if (waiting > 0) facts.push(copy.pending(state.pending.t2Draft, state.pending.decision, state.pending.stateMismatch));
  // The latest ended run is named once: in the line when the room is clear or
  // it needs a look, otherwise here -- including beside runs in progress,
  // which are other runs than it.
  if (last && line !== lastLine) facts.push(lastLine);
  // Runs in progress are a fact even when a halt, a decision or a failed run
  // takes the line.
  if (state.activeRuns > 0 && line !== runningLine) facts.push(runningLine);
  facts.push(
    state.runnerLastFinishAt ? copy.runnerFinish(utcStamp(state.runnerLastFinishAt)) : copy.runnerNever,
    state.publisherLastFinishAt ? copy.publisherFinish(utcStamp(state.publisherLastFinishAt)) : copy.publisherNever,
    read
  );
  return { status, badge, line, detail: facts.join(" · ") };
}
