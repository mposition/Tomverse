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

export type AgentOfficeLiveRooms = {
  /** When the server read them (UTC ISO). */
  readAt: string;
  research: AgentOfficeResearchState;
  qa: AgentOfficeQaState;
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
