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
 * one place to be read, its own section, and docs/policy/product-research-agent.md §8
 * keeps issue titles there.
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
 *
 * Billing and finance shows its app switch, whether today's price-deadline
 * digest was recorded (the agent's own silence verdict) and when the newest
 * one was stored -- never the verdict, models or deadlines inside it, which
 * docs/policy/billing-finance-ops.md §1.4 keeps to its digest tab.
 */

import type { DeptStatus } from "@/lib/agentOffice/sim";
import { aestStamp } from "@/lib/agentOffice/time";

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

/** One AMUX worker's state, from its catalog row and its runtime row. */
export type AgentOfficeAmuxWorkerState =
  | "ready"
  | "idle"
  | "busy"
  | "starting"
  | "error"
  | "lost"
  | "stopped"
  | "not_running"
  | "paused"
  | "isolated"
  | "blocked";

export type AgentOfficeAmuxState =
  | { kind: "unread" }
  /** The app has no usable worker catalog: unset, or not in the catalog's form. */
  | { kind: "no_catalog" }
  | {
      kind: "observed";
      workers: { name: string; provider: string; state: AgentOfficeAmuxWorkerState; heartbeatAt: string | null }[];
    };

/** The billing-finance-ops agent's own silence verdict (lib/billingFinanceOpsSilence.ts). */
export type AgentOfficeFinanceVerdict =
  | "not_applicable"
  | "control_unreadable"
  | "off"
  | "not_due"
  | "recorded"
  | "silent";

export type AgentOfficeFinanceState =
  | { kind: "unread" }
  | {
      kind: "observed";
      verdict: AgentOfficeFinanceVerdict;
      /** The switch row's revision, or null when it could not be read. */
      controlRevision: number | null;
      /** When the switch was turned on (UTC ISO), or null when it is off or unread. */
      enabledAt: string | null;
      /** When the newest digest was stored (UTC ISO), or null if none ever was. */
      latestDigestAt: string | null;
    };

/** One reviewer of the independent review server, as its latest report shows it. */
export type AgentOfficeReviewerState = "reviewing" | "idle" | "off" | "lost";

/** One reviewer's account quota, as the review server's probe last read it. */
export type AgentOfficeReviewerQuota = {
  state: "available" | "exhausted" | "unknown" | "disabled";
  remaining: number | null;
  unit: "percent" | "credits" | "usd" | null;
  /** Credit left after the included pool, in USD, when the server read it. */
  credit?: number;
};

export type AgentOfficeReviewState =
  | { kind: "unread" }
  /** No report has ever been stored. */
  | { kind: "not_reporting" }
  /** A stored report that is not the report's shape. */
  | { kind: "unreadable" }
  | {
      kind: "observed";
      /** When the app received the latest report (UTC ISO). */
      receivedAt: string;
      /** No report for longer than the reporter's five missed beats. */
      stale: boolean;
      draining: boolean;
      pendingJobs: number;
      reviewers: {
        id: string;
        vendor: string;
        state: AgentOfficeReviewerState;
        running: number;
        maxConcurrent: number;
        /** Null when the server sent none (a server older than the field). */
        quota: AgentOfficeReviewerQuota | null;
      }[];
      last24h: { accept: number; reject: number; unknown: number };
    };

/** An AMUX Decision Maker instance's switch: `off` or `proposal` (docs/policy/amux-decision-maker.md §8). */
export type AgentOfficeDecisionMode = "off" | "proposal";

export type AgentOfficeDecisionState =
  | { kind: "unread" }
  | {
      kind: "observed";
      /** Null when the switch rows did not read as a state: every question then goes to the operator. */
      killSwitch: boolean | null;
      instances: {
        instance: string;
        vendor: string;
        /** Null when its switch did not read. */
        mode: AgentOfficeDecisionMode | null;
        /** Questions routed to it in the last 24 hours. */
        recent: number;
        /** When the newest question was routed to it (UTC ISO), ever. */
        lastRoutedAt: string | null;
        /** When a person last judged one of its results (UTC ISO), ever. */
        lastJudgedAt: string | null;
      }[];
      /** Questions routed to the operator in the last 24 hours. */
      toOperator: number;
    };

export type AgentOfficeDigestState =
  | { kind: "unread" }
  | {
      kind: "observed";
      /** Every agent the digest store accepts, in its order. */
      agents: {
        agentKey: string;
        /** Digests it sent in the last 24 hours. */
        recent: number;
        /** When its newest digest arrived (UTC ISO), ever. */
        lastAt: string | null;
      }[];
    };

export type AgentOfficeLiveRooms = {
  /** When the server read them (UTC ISO). */
  readAt: string;
  review: AgentOfficeReviewState;
  decision: AgentOfficeDecisionState;
  digest: AgentOfficeDigestState;
  /** The operator to-do counts (OPERATOR_QUEUE_KEYS). */
  queue: AgentOfficeOperatorQueue;
  research: AgentOfficeResearchState;
  qa: AgentOfficeQaState;
  finance: AgentOfficeFinanceState;
  engineering: AgentOfficeEngineeringState;
  amux: AgentOfficeAmuxState;
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
  /**
   * What tells one reading from the next when the line cannot: compared for
   * the console's announcement, never shown. The line is drawn to the minute,
   * so two digests from one sender in the same minute draw the same line.
   */
  revision?: string;
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
};

/** The research room's line and detail, from its state and the console's copy. */
export function researchLiveDept(
  state: AgentOfficeResearchState,
  copy: ResearchCopy
): AgentOfficeLiveDept {
  const status = researchTone(state);
  if (state.kind === "unread") {
    return { status, badge: copy.badges.unread, line: copy.unread, detail: "" };
  }
  if (state.kind === "disabled") {
    return { status, badge: copy.badges.disabled, line: copy.disabled, detail: "" };
  }

  // "Latest", never "today": before 21:30 UTC the slot that has passed is
  // yesterday's, so every line names the slot it is about.
  const slot = aestStamp(state.slot);
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
    state.lastSuccessAt ? copy.lastSuccess(aestStamp(state.lastSuccessAt)) : copy.noSuccess,
  ];
  if (state.silence === "silent" && state.silenceHours !== null) {
    facts.push(copy.silent(Math.floor(state.silenceHours)));
  }
  if (state.silence === "anchor_missing") facts.push(copy.anchorMissing);

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
};

/** The QA room's line and detail, from its state and the console's copy. */
export function qaLiveDept(state: AgentOfficeQaState, copy: QaCopy): AgentOfficeLiveDept {
  const status = qaTone(state);
  if (state.kind === "unread") return { status, badge: copy.badges.unread, line: copy.unread, detail: "" };

  const line =
    state.verdict === "fresh" && state.latestDigestAt
      ? copy.fresh(aestStamp(state.latestDigestAt))
      : state.verdict === "stale"
        ? state.latestDigestAt
          ? copy.stale(aestStamp(state.latestDigestAt))
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
    facts.push(copy.lastReceived(aestStamp(state.latestDigestAt)));
  }
  if (state.mergeLaneLatched) facts.push(copy.latched);
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
};

/** The engineering room's line and detail, from its state and the console's copy. */
export function engineeringLiveDept(
  state: AgentOfficeEngineeringState,
  copy: EngineeringCopy
): AgentOfficeLiveDept {
  const status = engineeringTone(state);
  if (state.kind === "unread") return { status, badge: copy.badges.unread, line: copy.unread, detail: "" };

  const waiting = pendingTotal(state.pending);
  const last = state.lastRun;
  const lastLine = last ? copy.lastRun(last.outcome ?? last.status, aestStamp(last.endedAt)) : copy.noRun;
  const since = state.activeSince ? aestStamp(state.activeSince) : "—";
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
    state.runnerLastFinishAt ? copy.runnerFinish(aestStamp(state.runnerLastFinishAt)) : copy.runnerNever,
    state.publisherLastFinishAt ? copy.publisherFinish(aestStamp(state.publisherLastFinishAt)) : copy.publisherNever
  );
  return { status, badge, line, detail: facts.join(" · ") };
}

/**
 * An AMUX worker's colour. A worker AMUX could hand work to now is done; one
 * at work is working; an error or a heartbeat that ran out needs a look;
 * everything the operator or the worker chose -- paused, isolated, blocked,
 * stopped, not started, starting, idle without being ready -- is waiting.
 */
export function amuxWorkerTone(state: AgentOfficeAmuxWorkerState): DeptStatus {
  if (state === "ready") return "done";
  if (state === "busy") return "working";
  if (state === "error" || state === "lost") return "attention";
  return "waiting";
}

type AmuxCopy = {
  states: Record<AgentOfficeAmuxWorkerState, string>;
  unread: string;
  noCatalog: string;
  noWorkers: string;
  summary: (connected: number, total: number, busy: number, attention: number) => string;
  more: (count: number) => string;
  heartbeat: (time: string) => string;
  noHeartbeat: string;
  facts: { provider: string; state: string; heartbeat: string };
};

/** One line of a seated figure's profile: what it is, read from its record. */
export type AgentOfficeSeatedFact = { label: string; value: string };

/** A figure drawn seated at a desk from a real record: an AMUX worker or a reviewer. */
export type AgentOfficeSeatedView = {
  name: string;
  state: string;
  status: DeptStatus;
  label: string;
  /** Name, kind, state and when it was last heard, for the sprite's tooltip. */
  title: string;
  /** Not running at all: drawn faded. */
  dim: boolean;
  /** The profile a click opens: the same facts as the tooltip, one per line. */
  facts: AgentOfficeSeatedFact[];
};

export type AgentOfficeAmuxWorkerView = {
  name: string;
  state: AgentOfficeAmuxWorkerState;
  status: DeptStatus;
  label: string;
  /** Name, provider, state and last heartbeat, for the sprite's tooltip. */
  title: string;
  /** Not running at all: drawn faded. */
  dim: boolean;
  facts: AgentOfficeSeatedFact[];
};

export type AgentOfficeAmuxView = {
  status: DeptStatus;
  summary: string;
  /** Words drawn in the room itself: why it is empty, or how many are not drawn. */
  note: string | null;
  /** In drawing order: when they do not all fit, the ones that need a look come first. */
  workers: AgentOfficeAmuxWorkerView[];
};

const DRAW_ORDER: readonly DeptStatus[] = ["attention", "working", "done", "waiting"];

/** The AMUX room: its colour, its one-line summary and each worker's sprite. */
export function amuxRoomView(
  state: AgentOfficeAmuxState,
  desks: number,
  copy: AmuxCopy
): AgentOfficeAmuxView {
  if (state.kind === "unread") {
    return { status: "attention", summary: copy.unread, note: copy.unread, workers: [] };
  }
  if (state.kind === "no_catalog") {
    return { status: "waiting", summary: copy.noCatalog, note: copy.noCatalog, workers: [] };
  }

  const workers = state.workers.map((worker): AgentOfficeAmuxWorkerView => {
    const status = amuxWorkerTone(worker.state);
    const label = copy.states[worker.state];
    const heartbeat = worker.heartbeatAt ? copy.heartbeat(aestStamp(worker.heartbeatAt)) : copy.noHeartbeat;
    return {
      name: worker.name,
      state: worker.state,
      status,
      label,
      title: [worker.name, worker.provider, label, heartbeat].join(" · "),
      dim: worker.state === "stopped" || worker.state === "not_running",
      facts: [
        { label: copy.facts.provider, value: worker.provider },
        { label: copy.facts.state, value: label },
        { label: copy.facts.heartbeat, value: worker.heartbeatAt ? aestStamp(worker.heartbeatAt) : copy.noHeartbeat },
      ],
    };
  });
  const count = (tone: DeptStatus) => workers.filter((worker) => worker.status === tone).length;
  const connected = workers.filter((worker) => ["ready", "idle", "busy"].includes(worker.state)).length;
  const status: DeptStatus =
    count("attention") > 0 ? "attention" : count("working") > 0 ? "working" : count("done") > 0 ? "done" : "waiting";
  const overflow = Math.max(0, workers.length - desks);
  const parts = [copy.summary(connected, workers.length, count("working"), count("attention"))];
  if (overflow > 0) parts.push(copy.more(overflow));
  return {
    status,
    summary: parts.join(" · "),
    note: workers.length === 0 ? copy.noWorkers : overflow > 0 ? copy.more(overflow) : null,
    // Catalog order, unless they do not all fit: then a worker that needs a
    // look is never the one left off the floor.
    workers:
      overflow > 0
        ? [...workers].sort((a, b) => DRAW_ORDER.indexOf(a.status) - DRAW_ORDER.indexOf(b.status))
        : workers,
  };
}

/**
 * The billing and finance room's colour. A day with no digest behind an
 * enabled switch, and a switch row nobody can read, need a look; a digest
 * recorded today is done; off, not yet due, or an environment the agent does
 * not run in is waiting.
 */
export function financeTone(state: AgentOfficeFinanceState): DeptStatus {
  if (state.kind === "unread") return "attention";
  if (state.verdict === "silent" || state.verdict === "control_unreadable") return "attention";
  if (state.verdict === "recorded") return "done";
  return "waiting";
}

type FinanceCopy = {
  badges: Record<AgentOfficeFinanceVerdict | "unread", string>;
  unread: string;
  recorded: (time: string) => string;
  /** Recorded today, but the newest digest's time was not read with it. */
  recordedUntimed: string;
  silent: (time: string) => string;
  silentNever: string;
  notDue: string;
  off: string;
  controlUnreadable: string;
  notApplicable: string;
  revision: (revision: number) => string;
  noRevision: string;
  enabledAt: (time: string) => string;
  lastDigest: (time: string) => string;
};

/** The billing and finance room's line and detail, from its state and the console's copy. */
export function financeLiveDept(state: AgentOfficeFinanceState, copy: FinanceCopy): AgentOfficeLiveDept {
  const status = financeTone(state);
  if (state.kind === "unread") return { status, badge: copy.badges.unread, line: copy.unread, detail: "" };

  const last = state.latestDigestAt ? aestStamp(state.latestDigestAt) : null;
  const line =
    state.verdict === "recorded"
      ? last
        ? copy.recorded(last)
        : copy.recordedUntimed
      : state.verdict === "silent"
        ? last
          ? copy.silent(last)
          : copy.silentNever
        : state.verdict === "not_due"
          ? copy.notDue
          : state.verdict === "off"
            ? copy.off
            : state.verdict === "control_unreadable"
              ? copy.controlUnreadable
              : copy.notApplicable;

  const facts = [state.controlRevision === null ? copy.noRevision : copy.revision(state.controlRevision)];
  if (state.enabledAt) facts.push(copy.enabledAt(aestStamp(state.enabledAt)));
  // The recorded and silent lines already carry the newest digest's time.
  if (last && state.verdict !== "recorded" && state.verdict !== "silent") facts.push(copy.lastDigest(last));
  return { status, badge: copy.badges[state.verdict], line, detail: facts.join(" · ") };
}

/** A reviewer's colour: reviewing is working, idle is ready, off waits, lost needs a look. */
export function reviewerTone(state: AgentOfficeReviewerState): DeptStatus {
  if (state === "reviewing") return "working";
  if (state === "idle") return "done";
  if (state === "lost") return "attention";
  return "waiting";
}

type ReviewCopy = {
  states: Record<AgentOfficeReviewerState, string>;
  unread: string;
  notReporting: string;
  unreadable: string;
  stale: (time: string) => string;
  draining: string;
  summary: (pending: number, accept: number, reject: number, unknown: number) => string;
  lastReport: (time: string) => string;
  load: (running: number, max: number) => string;
  more: (count: number) => string;
  facts: { vendor: string; state: string; load: string; lastReport: string };
};

export type AgentOfficeReviewView = {
  status: DeptStatus;
  summary: string;
  /** Words drawn in the room itself: why it is empty or quiet. */
  note: string | null;
  reviewers: AgentOfficeSeatedView[];
};

/** The independent review room: its colour, its summary and each reviewer's sprite. */
export function reviewRoomView(
  state: AgentOfficeReviewState,
  desks: number,
  copy: ReviewCopy
): AgentOfficeReviewView {
  if (state.kind === "unread") return { status: "attention", summary: copy.unread, note: copy.unread, reviewers: [] };
  if (state.kind === "unreadable") {
    return { status: "attention", summary: copy.unreadable, note: copy.unreadable, reviewers: [] };
  }
  if (state.kind === "not_reporting") {
    return { status: "waiting", summary: copy.notReporting, note: copy.notReporting, reviewers: [] };
  }

  const last = aestStamp(state.receivedAt);
  const everyone = state.reviewers.map((reviewer): AgentOfficeSeatedView => {
    const label = copy.states[reviewer.state];
    return {
      name: reviewer.id,
      state: reviewer.state,
      status: reviewerTone(reviewer.state),
      label,
      title: [reviewer.id, reviewer.vendor, label, copy.load(reviewer.running, reviewer.maxConcurrent), copy.lastReport(last)].join(
        " · "
      ),
      dim: reviewer.state === "off",
      facts: [
        { label: copy.facts.vendor, value: reviewer.vendor },
        { label: copy.facts.state, value: label },
        { label: copy.facts.load, value: `${reviewer.running}/${reviewer.maxConcurrent}` },
        { label: copy.facts.lastReport, value: last },
      ],
    };
  });
  // The room speaks for every reviewer, drawn or not; only the people are cut to the desks.
  const any = (tone: DeptStatus) => everyone.some((reviewer) => reviewer.status === tone);
  const status: DeptStatus = state.stale
    ? "attention"
    : state.draining
      ? "waiting"
      : any("working")
        ? "working"
        : any("done")
          ? "done"
          : "waiting";
  const summary = [
    copy.summary(state.pendingJobs, state.last24h.accept, state.last24h.reject, state.last24h.unknown),
    copy.lastReport(last),
  ].join(" · ");
  const undrawn = Math.max(0, everyone.length - desks);
  const note =
    [state.stale ? copy.stale(last) : state.draining ? copy.draining : null, undrawn > 0 ? copy.more(undrawn) : null]
      .filter((part): part is string => part !== null)
      .join(" · ") || null;
  return { status, summary, note, reviewers: everyone.slice(0, desks) };
}

type DigestCopy = {
  badges: { received: string; quiet: string; unread: string };
  unread: string;
  latest: (agent: string, time: string) => string;
  none: string;
  count: (agent: string, count: number) => string;
};

/**
 * The digest desk: which agent's digest arrived last and when, and how many
 * each sent in the last 24 hours. The line names the newest digest, so a new
 * one changes it and the desk's lead says so in the console (setLive).
 * Whether an agent is late is its own room's judgement, not the desk's.
 */
export function digestLiveDept(
  state: AgentOfficeDigestState,
  copy: DigestCopy,
  /** Each agent's room name, by its digest key. */
  names: Readonly<Record<string, string>>
): AgentOfficeLiveDept {
  if (state.kind === "unread") return { status: "attention", badge: copy.badges.unread, line: copy.unread, detail: "" };
  const name = (agentKey: string) => names[agentKey] ?? agentKey;
  const newest = state.agents.reduce<(typeof state.agents)[number] | null>(
    (best, agent) => (agent.lastAt && (!best?.lastAt || agent.lastAt > best.lastAt) ? agent : best),
    null
  );
  const recent = state.agents.reduce((sum, agent) => sum + agent.recent, 0);
  return {
    status: recent > 0 ? "done" : "waiting",
    badge: recent > 0 ? copy.badges.received : copy.badges.quiet,
    line: newest?.lastAt ? copy.latest(name(newest.agentKey), aestStamp(newest.lastAt)) : copy.none,
    detail: [...state.agents.map((agent) => copy.count(name(agent.agentKey), agent.recent))].join(" · "),
    // Every sender's newest arrival to the millisecond: any new digest moves it.
    revision: state.agents.map((agent) => `${agent.agentKey}@${agent.lastAt ?? ""}`).join(","),
  };
}

export type AgentOfficeDecisionMemberState = "proposal" | "off" | "killed" | "unread";

type DecisionCopy = {
  states: Record<AgentOfficeDecisionMemberState, string>;
  unread: string;
  unreadable: string;
  killed: string;
  allOff: string;
  summary: (proposal: number, total: number, dm: number, operator: number) => string;
  none: string;
  facts: { vendor: string; mode: string; recent: string; lastRouted: string; lastJudged: string };
};

export type AgentOfficeDecisionView = {
  status: DeptStatus;
  summary: string;
  /** Words drawn in the room itself: why nothing reaches the instances. */
  note: string | null;
  members: AgentOfficeSeatedView[];
};

/**
 * The Decision Maker room: one desk for each instance. A question reaches an
 * instance only while the kill switch is off and its own switch is
 * `proposal`; otherwise it goes to the operator, and the room says so.
 */
export function decisionRoomView(state: AgentOfficeDecisionState, copy: DecisionCopy): AgentOfficeDecisionView {
  if (state.kind === "unread") return { status: "attention", summary: copy.unread, note: copy.unread, members: [] };

  const unreadable = state.killSwitch === null || state.instances.some((instance) => instance.mode === null);
  const members = state.instances.map((instance): AgentOfficeSeatedView => {
    const memberState: AgentOfficeDecisionMemberState =
      state.killSwitch === null || instance.mode === null
        ? "unread"
        : state.killSwitch
          ? "killed"
          : instance.mode === "proposal"
            ? "proposal"
            : "off";
    const label = copy.states[memberState];
    const routed = instance.lastRoutedAt ? aestStamp(instance.lastRoutedAt) : copy.none;
    const judged = instance.lastJudgedAt ? aestStamp(instance.lastJudgedAt) : copy.none;
    return {
      name: instance.instance,
      state: memberState,
      status: memberState === "unread" ? "attention" : memberState === "proposal" ? "done" : "waiting",
      label,
      title: [instance.instance, instance.vendor, label].join(" · "),
      dim: memberState === "off" || memberState === "killed",
      facts: [
        { label: copy.facts.vendor, value: instance.vendor },
        { label: copy.facts.mode, value: label },
        { label: copy.facts.recent, value: String(instance.recent) },
        { label: copy.facts.lastRouted, value: routed },
        { label: copy.facts.lastJudged, value: judged },
      ],
    };
  });
  const proposing = members.filter((member) => member.state === "proposal").length;
  const dm = state.instances.reduce((sum, instance) => sum + instance.recent, 0);
  const note = unreadable ? copy.unreadable : state.killSwitch ? copy.killed : proposing === 0 ? copy.allOff : null;
  const status: DeptStatus = unreadable ? "attention" : proposing > 0 && !state.killSwitch ? "done" : "waiting";
  const summary = [note, copy.summary(proposing, members.length, dm, state.toOperator)]
    .filter((part): part is string => part !== null)
    .join(" · ");
  return { status, summary, note, members };
}

/** Below this share left, an available quota is drawn as running low. */
export const REVIEW_QUOTA_LOW_PERCENT = 20;

type QuotaCopy = {
  states: Record<"available" | "low" | "onCredit" | "exhausted" | "unknown" | "disabled", string>;
  percent: (value: string) => string;
  credit: (value: string) => string;
  creditOnly: (value: string) => string;
  credits: (value: string) => string;
  usd: (value: string) => string;
  noAmount: string;
  notSent: string;
  unread: string;
  notReporting: string;
  unreadable: string;
  stale: (time: string) => string;
  asOf: (time: string) => string;
};

export type AgentOfficeQuotaRow = {
  id: string;
  vendor: string;
  status: DeptStatus;
  label: string;
  amount: string;
};

export type AgentOfficeQuotaView = {
  rows: AgentOfficeQuotaRow[];
  /** Why there are no rows, or how old the numbers are; null when fresh. */
  note: string | null;
};

const quotaAmount = (quota: AgentOfficeReviewerQuota, copy: QuotaCopy) => {
  const credit = quota.credit !== undefined ? copy.credit(quota.credit.toFixed(2)) : "";
  if (quota.remaining === null || quota.unit === null) {
    return quota.credit !== undefined ? copy.creditOnly(quota.credit.toFixed(2)) : copy.noAmount;
  }
  if (quota.unit === "percent") return copy.percent(String(Math.round(quota.remaining))) + credit;
  if (quota.unit === "usd") return copy.usd(quota.remaining.toFixed(2)) + credit;
  return copy.credits(String(Math.round(quota.remaining))) + credit;
};

/**
 * The CLI quota card: each reviewer's account quota from the review server's
 * latest report. A stale report keeps its numbers but says how old they are,
 * and draws every row grey -- they describe a moment that has passed.
 */
export function reviewQuotaView(state: AgentOfficeReviewState, copy: QuotaCopy): AgentOfficeQuotaView {
  if (state.kind === "unread") return { rows: [], note: copy.unread };
  if (state.kind === "unreadable") return { rows: [], note: copy.unreadable };
  if (state.kind === "not_reporting") return { rows: [], note: copy.notReporting };
  const withQuota = state.reviewers.filter((reviewer) => reviewer.quota !== null);
  if (withQuota.length === 0) return { rows: [], note: copy.notSent };
  const rows = withQuota.map((reviewer): AgentOfficeQuotaRow => {
    const quota = reviewer.quota as AgentOfficeReviewerQuota;
    // The included pool is low: under 20% when it is a share, or empty when it is an amount.
    const low =
      quota.state === "available" &&
      quota.remaining !== null &&
      (quota.unit === "percent"
        ? quota.remaining < REVIEW_QUOTA_LOW_PERCENT
        : // judged on the amount the card shows (USD to the cent, credits whole),
          // so "$0.00 left" or "0 credits left" never reads as plenty
          (quota.unit === "usd" ? Math.round(quota.remaining * 100) : Math.round(quota.remaining)) <= 0);
    // The included pool is (nearly) spent but credit keeps the account
    // working: say so rather than "running low".
    const onCredit = low && (quota.credit ?? 0) > 0;
    const key = onCredit ? "onCredit" : low ? "low" : quota.state;
    const status: DeptStatus = state.stale
      ? "waiting"
      : quota.state === "exhausted"
        ? "attention"
        : low
          ? "working"
          : quota.state === "available"
            ? "done"
            : "waiting";
    return { id: reviewer.id, vendor: reviewer.vendor, status, label: copy.states[key], amount: quotaAmount(quota, copy) };
  });
  const time = aestStamp(state.receivedAt);
  return { rows, note: state.stale ? copy.stale(time) : copy.asOf(time) };
}

/**
 * The operator's to-do: real queues where an agent waits on a person. The
 * same counts the console sidebar badges (lib/adminNavigationCounts.ts), and
 * each links to the screen where it is acted on. Nothing here decides; the
 * office only counts and points.
 */
export const OPERATOR_QUEUE_KEYS = ["marketing", "amuxEscalations", "amuxHalts", "autoFix"] as const;
export type OperatorQueueKey = (typeof OPERATOR_QUEUE_KEYS)[number];
/** `null` is a count that could not be read: never shown as zero. */
export type AgentOfficeOperatorQueue = Record<OperatorQueueKey, number | null>;

export const OPERATOR_QUEUE_HREFS: Record<OperatorQueueKey, string> = {
  marketing: "/admin/marketing",
  amuxEscalations: "/admin/amux-execution?tab=assignment",
  amuxHalts: "/admin/amux-execution?tab=halts",
  autoFix: "/admin/support",
};

/** The to-do total over the counts that were read, and whether any could not be. */
export function operatorQueueTotal(queue: AgentOfficeOperatorQueue): { total: number; unknown: boolean } {
  let total = 0;
  let unknown = false;
  for (const key of OPERATOR_QUEUE_KEYS) {
    const value = queue[key];
    if (value === null) unknown = true;
    else total += value;
  }
  return { total, unknown };
}

/**
 * One automation the office reads for real, as the dashboard lists it: a team
 * room with a live record, the AMUX execution room or the review server.
 */
export type AgentOfficeLiveRow = {
  id: string;
  name: string;
  status: DeptStatus;
  /** The state in a word or two. */
  badge: string;
  /** What the room says, from its record. */
  line: string;
  /** The console screen that holds its record, when there is one. */
  href: string | null;
};

export type AgentOfficeBrief = {
  /** Rows that need a look, in the order given. */
  attention: AgentOfficeLiveRow[];
  /** Rows at work right now. */
  working: AgentOfficeLiveRow[];
  /** How many rows are fine or waiting on their next run. */
  quiet: number;
};

/**
 * The digest desk's brief over the live rows: what needs a look first, then
 * what is at work, then how many are quiet. It reads only the rows' states;
 * nothing here is a demo figure.
 */
export function agentOfficeBrief(rows: readonly AgentOfficeLiveRow[]): AgentOfficeBrief {
  const attention = rows.filter((row) => row.status === "attention" || row.status === "blocked");
  const working = rows.filter((row) => row.status === "working");
  return { attention, working, quiet: rows.length - attention.length - working.length };
}

type ReportCopy = {
  title: (time: string) => string;
  attention: (count: number) => string;
  working: (count: number) => string;
  quiet: (count: number) => string;
  notConnected: (count: number) => string;
  todo: (text: string) => string;
  quota: string;
  none: string;
  footer: string;
};

/**
 * The status report the operator copies or downloads: the same states the
 * office shows, as plain Markdown. Content-free by construction -- it is
 * built only from the rows' state words and record lines, the to-do counts
 * and the quota rows, never from what an agent produced.
 */
export function agentOfficeReport(
  input: {
    readAt: string;
    rows: readonly AgentOfficeLiveRow[];
    notConnected: readonly string[];
    queue: { label: string; count: number | null }[];
    quota: AgentOfficeQuotaView;
    unknownCount: string;
  },
  copy: ReportCopy
): string {
  const brief = agentOfficeBrief(input.rows);
  const quiet = input.rows.filter((row) => !brief.attention.includes(row) && !brief.working.includes(row));
  const item = (row: AgentOfficeLiveRow) => `- ${row.name} · ${row.badge} · ${row.line}`;
  const section = (heading: string, lines: string[]) => [heading, ...(lines.length > 0 ? lines : [`- ${copy.none}`]), ""];
  const known = input.queue.filter((entry) => entry.count !== null);
  const total = known.reduce((sum, entry) => sum + (entry.count ?? 0), 0);
  const todoText = known.length < input.queue.length ? `${total}+?` : String(total);
  return [
    copy.title(aestStamp(input.readAt)),
    "",
    ...section(copy.attention(brief.attention.length), brief.attention.map(item)),
    ...section(copy.working(brief.working.length), brief.working.map(item)),
    ...section(copy.quiet(quiet.length), quiet.map(item)),
    ...section(copy.notConnected(input.notConnected.length), input.notConnected.map((name) => `- ${name}`)),
    ...section(
      copy.todo(todoText),
      input.queue.map((entry) => `- ${entry.label}: ${entry.count === null ? input.unknownCount : entry.count}`)
    ),
    ...section(
      copy.quota,
      [
        ...input.quota.rows.map((row) => `- ${row.id} (${row.vendor}) · ${row.label} · ${row.amount}`),
        ...(input.quota.note ? [`- ${input.quota.note}`] : []),
      ]
    ),
    copy.footer,
    "",
  ].join("\n");
}
