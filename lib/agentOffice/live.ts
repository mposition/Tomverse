/**
 * The rooms of the Agent office that show a real record instead of the demo.
 *
 * The server reads (lib/agentOfficeLiveRead.ts) and hands the client plain
 * values of these shapes; everything here is pure, so the client and the
 * tests share the one mapping from a state to what a room says.
 *
 * Product research is the first such room. What the office shows of it is the
 * agent's operating state -- the app switch, whether today's run was recorded,
 * when the last success was, whether it has gone silent -- and never what it
 * observed: docs/policy/product-research-agent.md §4 gives its observations
 * one place to be read, its own section, and §8 keeps issue titles there.
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

export type AgentOfficeLiveRooms = {
  /** When the server read them (UTC ISO). */
  readAt: string;
  research: AgentOfficeResearchState;
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
  ok: (time: string) => string;
  failed: (stage: string) => string;
  duplicate: string;
  missingOpen: string;
  missing: string;
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

  const line =
    state.slotState === "ok"
      ? copy.ok(utcStamp(state.slot))
      : state.slotState === "failed"
        ? copy.failed(state.failureStage ?? "unknown")
        : state.slotState === "duplicate"
          ? copy.duplicate
          : state.windowOpen
            ? copy.missingOpen
            : copy.missing;

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
