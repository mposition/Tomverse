import { isDmOptionId, isSnapshotTargetSha } from "./decisionMakerCore.ts";
import type { DmProposalForJudgment } from "./decisionMakerBodyCore.ts";
import {
  DM_JUDGMENT_EVENT_KINDS,
  DM_SNAPSHOT_STATES,
  isDmDigest,
  isDmRequestId,
  type DmJudgmentEventKind,
  type DmRequestState,
  type DmSnapshotState,
} from "./decisionMakerRequestCore.ts";
import { DM_INSTANCE_SCOPES, isDmInstanceScope, type DmInstanceScope } from "./decisionMakerSwitchCore.ts";

/**
 * The AMUX Decision Maker's operator judgment, declaration accuracy and
 * delivery records, policy version 1 (docs/policy/amux-decision-maker.md §2
 * steps 6 and 7, §4, §6, §9, §10), stage S1e.
 *
 * Pure: the closed vocabularies that the CHECKs of migration
 * 20261008130100_amux_decision_maker_judgment_delivery hold, the input checks
 * of the one writer (lib/amux/decisionMakerJudgmentStore.ts), the rules its
 * triggers enforce -- written out so the writer refuses before the database
 * has to, and so they can be tested without a database -- and the arithmetic
 * of §4's declaration accuracy report. The triggers stay the authority; this
 * mirrors them.
 *
 * No I/O. No card text, proposal, answer or free text appears here: a
 * judgment carries closed codes and the keyed digests Admin showed, never a
 * body (§10: "본문은 원장에 넣지 않는다").
 */

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * §2-6: a person confirms the proposal as it is, confirms it edited, or
 * rejects it. The same three kinds close the request in the ledger.
 */
export const DM_JUDGMENT_KINDS = DM_JUDGMENT_EVENT_KINDS;
export type DmJudgmentKind = DmJudgmentEventKind;

/** The two judgments that make an answer for the worker; only these are delivered. */
export const DM_CONFIRMING_JUDGMENT_KINDS = ["confirm", "edit_confirm"] as const;

/** §4: "matched·mismatched·not_judged 중 하나로 기록할 수 있고 ... 기본값은 not_judged다". */
export const DM_DECLARATION_ACCURACIES = ["matched", "mismatched", "not_judged"] as const;
export type DmDeclarationAccuracyValue = (typeof DM_DECLARATION_ACCURACIES)[number];
export const DM_DEFAULT_DECLARATION_ACCURACY = "not_judged" as const satisfies DmDeclarationAccuracyValue;

/** §4: "mismatched면 틀린 항목(효과 등급, resolution, 경로)을 고른다". */
export const DM_DECLARATION_ITEMS = ["effect_class", "resolution", "paths"] as const;
export type DmDeclarationItem = (typeof DM_DECLARATION_ITEMS)[number];

/**
 * §2-7, §9, §10: one delivery decision per request (the confirmed answer
 * released for delivery, consumed once), then one receipt or one unknown
 * outcome, and for an unknown outcome one person's resolution.
 */
export const DM_DELIVERY_EVENT_KINDS = [
  "deliver",
  "delivery_receipt",
  "delivery_unknown",
  "delivery_unknown_resolve",
] as const;
export type DmDeliveryEventKind = (typeof DM_DELIVERY_EVENT_KINDS)[number];

/** Recorded by the system (the router's actor); the resolution is a person's. */
export const DM_DELIVERY_SYSTEM_EVENT_KINDS = ["deliver", "delivery_receipt", "delivery_unknown"] as const;
export type DmDeliverySystemEventKind = (typeof DM_DELIVERY_SYSTEM_EVENT_KINDS)[number];

/** What a person found when they checked an unknown delivery (§9: "운영자가 확인하고"). */
export const DM_DELIVERY_RESOLVE_OUTCOMES = ["delivered", "not_delivered"] as const;
export type DmDeliveryResolveOutcome = (typeof DM_DELIVERY_RESOLVE_OUTCOMES)[number];

export const DM_DELIVERY_ACTOR_KINDS = ["human", "system"] as const;

/**
 * §10's audit actions. A judgment is a person's `amux.decision.<kind>`,
 * targeting the request (stage S1d already binds an operator's answer body to
 * an `edit_confirm` naming the request). A delivery event's audit targets the
 * event. §10 closes the action list and names `.deliver` and
 * `.delivery_unknown` for the system and `.delivery_unknown_resolve` for a
 * person; it names no action of its own for the receipt, so the receipt is
 * recorded under `.deliver` too, told apart by its event kind and the audit
 * metadata's `kind`.
 */
export const dmJudgmentAuditAction = (kind: DmJudgmentKind): string => `amux.decision.${kind}`;
export const DM_JUDGMENT_AUDIT_TARGET_TYPE = "AmuxDecisionMakerRequest" as const;
export const DM_DELIVERY_EVENT_AUDIT_TARGET_TYPE = "AmuxDecisionMakerDeliveryEvent" as const;
export const DM_DELIVERY_AUDIT_ACTIONS = Object.freeze({
  deliver: "amux.decision.deliver",
  delivery_receipt: "amux.decision.deliver",
  delivery_unknown: "amux.decision.delivery_unknown",
  delivery_unknown_resolve: "amux.decision.delivery_unknown_resolve",
} as const satisfies Record<DmDeliveryEventKind, string>);

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);

const ownKeysWithin = (value: object, allowed: readonly string[], required: readonly string[]) => {
  const own = Object.keys(value);
  return own.every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key));
};

export const isDmJudgmentKind = (value: unknown): value is DmJudgmentKind => isOneOf(DM_JUDGMENT_KINDS, value);
export const isDmConfirmingJudgmentKind = (value: unknown): value is "confirm" | "edit_confirm" =>
  isOneOf(DM_CONFIRMING_JUDGMENT_KINDS, value);

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * §6: what Admin showed the person beside the proposal, as the keyed digests
 * and closed values it read from the stores: the DM's free-text answer body
 * (null for a select), its rationale body, the option a select chose (null
 * for free text), the `irreversible` flag Admin shows first, and the snapshot
 * -- its state, target SHA and manifest digest, the last two null exactly when
 * the state is `none` ("카드만"). A confirmation stands only while every one of
 * them equals the stored value.
 */
export type DmShownProposal = {
  answerDigest: string | null;
  rationaleDigest: string;
  optionId: string | null;
  irreversible: boolean;
  snapshotState: DmSnapshotState;
  snapshotTargetSha: string | null;
  snapshotManifestDigest: string | null;
};

const SHOWN_KEYS = [
  "answerDigest",
  "rationaleDigest",
  "optionId",
  "irreversible",
  "snapshotState",
  "snapshotTargetSha",
  "snapshotManifestDigest",
] as const;

export const parseDmShownProposal = (value: unknown): DmShownProposal | null => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (!ownKeysWithin(value, SHOWN_KEYS, SHOWN_KEYS)) return null;
  const shown = value as Record<string, unknown>;
  if (!isDmDigest(shown.rationaleDigest) || typeof shown.irreversible !== "boolean") return null;
  if (shown.answerDigest !== null && !isDmDigest(shown.answerDigest)) return null;
  if (shown.optionId !== null && !isDmOptionId(shown.optionId)) return null;
  // A proposal is a free-text answer or a select, never both and never neither.
  if ((shown.answerDigest === null) === (shown.optionId === null)) return null;
  if (!isOneOf(DM_SNAPSHOT_STATES, shown.snapshotState)) return null;
  if (shown.snapshotState === "none") {
    if (shown.snapshotTargetSha !== null || shown.snapshotManifestDigest !== null) return null;
  } else if (
    typeof shown.snapshotTargetSha !== "string" ||
    !isSnapshotTargetSha(shown.snapshotTargetSha) ||
    !isDmDigest(shown.snapshotManifestDigest)
  ) {
    return null;
  }
  return {
    answerDigest: shown.answerDigest as string | null,
    rationaleDigest: shown.rationaleDigest,
    optionId: shown.optionId as string | null,
    irreversible: shown.irreversible,
    snapshotState: shown.snapshotState,
    snapshotTargetSha: shown.snapshotTargetSha as string | null,
    snapshotManifestDigest: shown.snapshotManifestDigest as string | null,
  };
};

/** §4's record on a judgment: the value and, when mismatched, the items that were wrong. */
export type DmDeclarationAccuracy = {
  accuracy: DmDeclarationAccuracyValue;
  /** Non-empty exactly when mismatched, each item once, in the list's order. */
  mismatchedItems: DmDeclarationItem[];
};

/**
 * The person's accuracy record, or null when malformed. Omitted means §4's
 * default, `not_judged`. `mismatched` needs at least one item and repeats
 * none; `matched` and `not_judged` carry none. Items come back in the list's
 * order, so the same record is always stored the same way.
 */
export const parseDmDeclarationAccuracy = (value: unknown): DmDeclarationAccuracy | null => {
  if (value === undefined) return { accuracy: DM_DEFAULT_DECLARATION_ACCURACY, mismatchedItems: [] };
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (!ownKeysWithin(value, ["accuracy", "mismatchedItems"], ["accuracy"])) return null;
  const record = value as { accuracy?: unknown; mismatchedItems?: unknown };
  if (!isOneOf(DM_DECLARATION_ACCURACIES, record.accuracy)) return null;
  const items = record.mismatchedItems === undefined ? [] : record.mismatchedItems;
  if (!Array.isArray(items) || !items.every((item) => isOneOf(DM_DECLARATION_ITEMS, item))) return null;
  if (new Set(items).size !== items.length) return null;
  if ((record.accuracy === "mismatched") !== (items.length > 0)) return null;
  return {
    accuracy: record.accuracy,
    mismatchedItems: DM_DECLARATION_ITEMS.filter((item) => (items as string[]).includes(item)),
  };
};

export type DmJudgmentInput =
  | { kind: "confirm"; shown: DmShownProposal; accuracy: DmDeclarationAccuracy }
  | { kind: "edit_confirm"; shown: DmShownProposal; accuracy: DmDeclarationAccuracy; operatorAnswer: string }
  | { kind: "reject"; accuracy: DmDeclarationAccuracy };

/**
 * A judgment's input, checked for shape: a confirmation names what Admin
 * showed and an edited confirmation also the person's answer (as a string;
 * whether it may be stored is `dmBodyRefusal()`'s); a rejection names neither.
 * Null when anything is missing, extra or malformed.
 */
export const parseDmJudgmentInput = (value: {
  kind: unknown;
  shown?: unknown;
  accuracy?: unknown;
  operatorAnswer?: unknown;
}): DmJudgmentInput | null => {
  if (!isDmJudgmentKind(value.kind)) return null;
  const accuracy = parseDmDeclarationAccuracy(value.accuracy);
  if (!accuracy) return null;
  if (value.kind === "reject") {
    if (value.shown !== undefined && value.shown !== null) return null;
    if (value.operatorAnswer !== undefined) return null;
    return { kind: "reject", accuracy };
  }
  const shown = parseDmShownProposal(value.shown);
  if (!shown) return null;
  if (value.kind === "confirm") {
    if (value.operatorAnswer !== undefined) return null;
    return { kind: "confirm", shown, accuracy };
  }
  if (typeof value.operatorAnswer !== "string") return null;
  return { kind: "edit_confirm", shown, accuracy, operatorAnswer: value.operatorAnswer };
};

// ---------------------------------------------------------------------------
// The judgment's preconditions, as the judgment guard holds them
// ---------------------------------------------------------------------------

export type DmJudgmentRefusal =
  | "not_routed_to_dm"
  | "closed"
  | "no_proposal"
  | "settings_unreadable"
  | "kill_switch_on"
  | "proposal_detail_missing"
  | "operator_answer_present"
  | "shown_mismatch"
  | "digest_key_unavailable";

/**
 * The request's own state (§6: "운영자의 확정은 요청이 열려 있고"): routed to a
 * DM, not closed -- by the router, or by an earlier judgment, which makes the
 * judgment one per request -- and its one terminal result a proposal, which a
 * transmission always precedes. The guard refuses the same.
 */
export const dmJudgmentStateRefusal = (state: DmRequestState): DmJudgmentRefusal | null => {
  if (state.route !== "dm_proposal") return "not_routed_to_dm";
  if (state.closing !== null) return "closed";
  if (state.terminal === null || state.terminal.resultKind !== "proposal" || state.transmission === null) {
    return "no_proposal";
  }
  return null;
};

/**
 * §6's table: "제안의 확정·고쳐서 확정 — 거부" under the kill switch, and "제안
 * 거절 — 허용". A confirmation needs the kill switch read and off; an
 * unreadable switch store is not off. A rejection reads nothing.
 */
export const dmJudgmentSwitchRefusal = (
  kind: DmJudgmentKind,
  killSwitch: boolean | null,
): "settings_unreadable" | "kill_switch_on" | null => {
  if (kind === "reject") return null;
  if (killSwitch === null) return "settings_unreadable";
  return killSwitch ? "kill_switch_on" : null;
};

/**
 * §6: everything Admin showed equals what is stored -- the rationale body (a
 * proposal always has one), the free-text answer body exactly when the
 * proposal is free text, the select's option, the `irreversible` flag, and the
 * snapshot of the transmission. A body erased since Admin showed it is not
 * stored any more, so it cannot be confirmed.
 */
export const dmShownProposalMatches = (
  state: DmRequestState,
  proposal: DmProposalForJudgment,
  shown: DmShownProposal,
): boolean =>
  proposal.detail !== null &&
  state.transmission !== null &&
  proposal.rationaleDigest !== null &&
  shown.rationaleDigest === proposal.rationaleDigest &&
  shown.answerDigest === proposal.answerDigest &&
  (proposal.detail.outputKind === "free_text") === (shown.answerDigest !== null) &&
  shown.optionId === proposal.detail.optionId &&
  shown.irreversible === proposal.detail.irreversible &&
  shown.snapshotState === state.transmission.snapshotState &&
  shown.snapshotTargetSha === state.transmission.snapshotTargetSha &&
  shown.snapshotManifestDigest === state.transmission.snapshotManifestDigest;

/**
 * What the body store holds of the proposal, against the judgment (§6, §10):
 * the detail of the request's own terminal proposal (stage S1d writes it with
 * the result); no operator answer stored before this judgment; for a
 * confirmation, everything Admin showed equal to what is stored; and for an
 * edited confirmation, the request's key period registered under the key the
 * caller holds (`keyCheck`, its check value) and not destroyed, so the
 * person's answer can be stored with it. The guard refuses the same, except
 * the key, which the body's own guard holds.
 */
export const dmJudgmentProposalRefusal = (input: {
  state: DmRequestState;
  proposal: DmProposalForJudgment;
  judgment: DmJudgmentInput;
  /** The check value of the key the caller holds for the request's period; edit_confirm only. */
  keyCheck: string | null;
}): DmJudgmentRefusal | null => {
  const { state, proposal, judgment } = input;
  if (
    proposal.detail === null ||
    state.terminal === null ||
    proposal.resultEventId !== state.terminal.eventId ||
    proposal.resultKind !== "proposal"
  ) {
    return "proposal_detail_missing";
  }
  if (proposal.operatorAnswerDigest !== null) return "operator_answer_present";
  if (judgment.kind === "reject") return null;
  if (!dmShownProposalMatches(state, proposal, judgment.shown)) return "shown_mismatch";
  if (judgment.kind === "edit_confirm") {
    if (input.keyCheck === null || proposal.keyCheck !== input.keyCheck || proposal.keyDestroyed) {
      return "digest_key_unavailable";
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/** One request's delivery records, from the store's one delivery read. */
export type DmDeliveryState = {
  requestId: string;
  /** The request's judgment; null when none is recorded (or no such request exists). */
  judgmentKind: DmJudgmentKind | null;
  delivered: boolean;
  /** The receipt or the unknown outcome after the decision; null before either. */
  outcome: "receipt" | "unknown" | null;
  /** A person's resolution of an unknown outcome; null before it. */
  resolution: DmDeliveryResolveOutcome | null;
};

/** Null when the row holds anything the delivery table's rules could not have produced. */
export const dmDeliveryStateFromRow = (requestId: string, row: unknown): DmDeliveryState | null => {
  if (!isDmRequestId(requestId) || row === null || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  if (r.judgmentKind !== null && !isDmJudgmentKind(r.judgmentKind)) return null;
  if (typeof r.delivered !== "boolean") return null;
  let outcome: DmDeliveryState["outcome"] = null;
  if (r.outcomeKind === "delivery_receipt") outcome = "receipt";
  else if (r.outcomeKind === "delivery_unknown") outcome = "unknown";
  else if (r.outcomeKind !== null) return null;
  if (r.resolution !== null && !isOneOf(DM_DELIVERY_RESOLVE_OUTCOMES, r.resolution)) return null;
  // The guard's order: a decision only after a confirmation, an outcome only
  // after the decision, a resolution only after an unknown outcome.
  if (r.delivered && !isDmConfirmingJudgmentKind(r.judgmentKind)) return null;
  if (outcome !== null && !r.delivered) return null;
  if (r.resolution !== null && outcome !== "unknown") return null;
  return {
    requestId,
    judgmentKind: r.judgmentKind as DmJudgmentKind | null,
    delivered: r.delivered,
    outcome,
    resolution: r.resolution as DmDeliveryResolveOutcome | null,
  };
};

export type DmDeliveryAttempt =
  | { kind: "deliver" }
  | { kind: "delivery_receipt" }
  | { kind: "delivery_unknown" }
  | { kind: "delivery_unknown_resolve"; outcome: DmDeliveryResolveOutcome };

export type DmDeliveryRefusal =
  | "not_confirmed"
  | "already_delivered"
  | "not_delivered"
  | "outcome_recorded"
  | "not_unknown"
  | "already_resolved";

/**
 * The delivery graph the guard enforces (§2-7, §9): the decision once, only
 * after a confirmation or an edited confirmation (a rejection is never
 * delivered); then a receipt or an unknown outcome, one of the two once; and
 * a person's resolution once, only after an unknown outcome. Single
 * consumption is also the database's partial unique indexes.
 */
export const dmDeliveryRefusal = (state: DmDeliveryState, attempt: DmDeliveryAttempt): DmDeliveryRefusal | null => {
  switch (attempt.kind) {
    case "deliver":
      if (!isDmConfirmingJudgmentKind(state.judgmentKind)) return "not_confirmed";
      if (state.delivered) return "already_delivered";
      return null;
    case "delivery_receipt":
    case "delivery_unknown":
      if (!state.delivered) return "not_delivered";
      if (state.outcome !== null) return "outcome_recorded";
      return null;
    case "delivery_unknown_resolve":
      if (state.outcome !== "unknown") return "not_unknown";
      if (state.resolution !== null) return "already_resolved";
      return null;
  }
};

/**
 * §6's table: "bridge의 확정 답 조회·전달 — 거부" under the kill switch. Only
 * the decision releases an answer, so only the decision reads the switch; a
 * receipt and an unknown outcome record what already happened, and the
 * resolution is a person's operation, which the table allows.
 */
export const dmDeliverySwitchRefusal = (
  attempt: DmDeliveryAttempt,
  killSwitch: boolean | null,
): "settings_unreadable" | "kill_switch_on" | null => {
  if (attempt.kind !== "deliver") return null;
  if (killSwitch === null) return "settings_unreadable";
  return killSwitch ? "kill_switch_on" : null;
};

// ---------------------------------------------------------------------------
// §4's declaration accuracy report
// ---------------------------------------------------------------------------

/** A rate with its own numerator and denominator; an empty denominator is insufficient evidence. */
export type DmReportMetric =
  | { status: "measured"; numerator: number; denominator: number; value: number }
  | { status: "insufficient_evidence"; numerator: number; denominator: 0; value: null };

export const dmReportMetric = (numerator: number, denominator: number): DmReportMetric => {
  if (
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    numerator < 0 ||
    denominator < 0 ||
    numerator > denominator
  ) {
    throw new Error("AMUX Decision Maker report metric out of range");
  }
  return denominator === 0
    ? { status: "insufficient_evidence", numerator, denominator: 0, value: null }
    : { status: "measured", numerator, denominator, value: numerator / denominator };
};

/** One instance's judgments, counted by kind and by declaration accuracy. */
export type DmJudgmentTally = {
  instance: DmInstanceScope;
  confirm: number;
  editConfirm: number;
  reject: number;
  matched: number;
  mismatched: number;
  notJudged: number;
};

/** One instance's proposals: how many the ledger recorded, and the database clock of the first. */
export type DmProposalTimelineEntry = {
  instance: DmInstanceScope;
  proposals: number;
  firstProposalAtMs: number | null;
};

/** Whole days are 24-hour days by the database clock, never calendar days. */
export const DM_REPORT_DAY_MS = 24 * 60 * 60 * 1000;

export type DmDeclarationAccuracyInstanceReport = {
  instance: DmInstanceScope;
  /** Proposals the operator judged (confirm, edit_confirm, reject), over the proposals the DM made. */
  decidedProposals: DmReportMetric;
  /** Whole 24-hour days from the instance's first proposal to the database clock. */
  daysSinceFirstProposal:
    | { status: "measured"; days: number; firstProposalAtMs: number }
    | { status: "insufficient_evidence" };
  /** Confirmed as proposed (confirm), over the proposals the operator judged. */
  confirmedWithoutEdit: DmReportMetric;
  /** `matched`, over the judgments whose accuracy was judged (matched + mismatched). */
  matchedOverJudged: DmReportMetric;
  /** `not_judged`, over the proposals the operator judged. */
  notJudged: DmReportMetric;
};

export type DmDeclarationAccuracyReport = {
  /** The database clock the report was computed at. */
  dbNowMs: number;
  instances: DmDeclarationAccuracyInstanceReport[];
};

const emptyTally = (instance: DmInstanceScope): DmJudgmentTally => ({
  instance,
  confirm: 0,
  editConfirm: 0,
  reject: 0,
  matched: 0,
  mismatched: 0,
  notJudged: 0,
});

/**
 * §4's report, per DM instance (both always listed): the proposals the
 * operator decided, the days since the first proposal, the rate confirmed
 * without an edit, the `matched` rate among judged declarations and the
 * `not_judged` count -- each with its own denominator, and
 * `insufficient_evidence` wherever that denominator is empty.
 *
 * "보고는 스위치·모드를 바꾸지 않고, 졸업을 기록하지 않으며, 자율을 허락하지
 * 않는다": the report is a value. It names no threshold, compares nothing with
 * §0-2's graduation criteria, and nothing reads it to change a switch.
 */
export const dmDeclarationAccuracyReport = (input: {
  dbNowMs: number;
  tallies: readonly DmJudgmentTally[];
  timeline: readonly DmProposalTimelineEntry[];
}): DmDeclarationAccuracyReport => {
  if (!Number.isSafeInteger(input.dbNowMs) || input.dbNowMs < 0) {
    throw new Error("AMUX Decision Maker report clock out of range");
  }
  return {
    dbNowMs: input.dbNowMs,
    instances: DM_INSTANCE_SCOPES.map((instance) => {
      const tally = input.tallies.find((entry) => entry.instance === instance) ?? emptyTally(instance);
      const timeline = input.timeline.find((entry) => entry.instance === instance) ?? {
        instance,
        proposals: 0,
        firstProposalAtMs: null,
      };
      const decided = tally.confirm + tally.editConfirm + tally.reject;
      const judgedAccuracy = tally.matched + tally.mismatched;
      if (tally.matched + tally.mismatched + tally.notJudged !== decided) {
        throw new Error("AMUX Decision Maker judgment tally does not add up");
      }
      const firstProposalAtMs = timeline.firstProposalAtMs;
      return {
        instance,
        decidedProposals: dmReportMetric(decided, timeline.proposals),
        daysSinceFirstProposal:
          firstProposalAtMs === null
            ? { status: "insufficient_evidence" }
            : {
                status: "measured",
                days: Math.floor(Math.max(0, input.dbNowMs - firstProposalAtMs) / DM_REPORT_DAY_MS),
                firstProposalAtMs,
              },
        confirmedWithoutEdit: dmReportMetric(tally.confirm, decided),
        matchedOverJudged: dmReportMetric(tally.matched, judgedAccuracy),
        notJudged: dmReportMetric(tally.notJudged, decided),
      };
    }),
  };
};

const nonNegativeCount = (value: unknown): number | null => {
  if (typeof value !== "bigint" && typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
};

/** The tallies from the store's one tally read, one row per instance with a judgment; null on any row it could not have produced. */
export const dmJudgmentTalliesFromRows = (rows: unknown): DmJudgmentTally[] | null => {
  if (!Array.isArray(rows)) return null;
  const tallies: DmJudgmentTally[] = [];
  for (const row of rows as unknown[]) {
    if (row === null || typeof row !== "object") return null;
    const r = row as Record<string, unknown>;
    if (!isDmInstanceScope(r.instance) || tallies.some((entry) => entry.instance === r.instance)) return null;
    const counts = ["confirm", "editConfirm", "reject", "matched", "mismatched", "notJudged"].map((key) =>
      nonNegativeCount(r[key]),
    );
    if (counts.some((value) => value === null)) return null;
    const [confirm, editConfirm, reject, matched, mismatched, notJudged] = counts as number[];
    if (matched + mismatched + notJudged !== confirm + editConfirm + reject) return null;
    tallies.push({ instance: r.instance, confirm, editConfirm, reject, matched, mismatched, notJudged });
  }
  return tallies;
};

// ---------------------------------------------------------------------------
// Audit metadata
// ---------------------------------------------------------------------------

export const DM_JUDGMENT_AUDIT_METADATA_KEYS = [
  "request_id",
  "judgment_id",
  "kind",
  "instance",
  "declaration_accuracy",
  "mismatched_items",
] as const;

export const DM_DELIVERY_AUDIT_METADATA_KEYS = [
  "event_id",
  "request_id",
  "kind",
  "judgment_kind",
  "outcome",
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A judgment's audit metadata: closed keys, each with its own closed value --
 * ids, the kind, the instance, the accuracy and its items. Never a digest, a
 * body or free text. `request_id` is the key stage S1d's body guard reads to
 * tie an operator's answer to its `edit_confirm`.
 */
export const dmJudgmentAuditMetadata = (fields: {
  requestId: string;
  judgmentId: string;
  kind: DmJudgmentKind;
  instance: DmInstanceScope;
  accuracy: DmDeclarationAccuracy;
}): Record<string, string | string[]> => {
  if (
    !UUID.test(fields.requestId) ||
    !UUID.test(fields.judgmentId) ||
    !isDmJudgmentKind(fields.kind) ||
    !isDmInstanceScope(fields.instance) ||
    !isOneOf(DM_DECLARATION_ACCURACIES, fields.accuracy.accuracy) ||
    !fields.accuracy.mismatchedItems.every((item) => isOneOf(DM_DECLARATION_ITEMS, item))
  ) {
    throw new Error("AMUX Decision Maker judgment audit metadata value refused");
  }
  return {
    request_id: fields.requestId,
    judgment_id: fields.judgmentId,
    kind: fields.kind,
    instance: fields.instance,
    declaration_accuracy: fields.accuracy.accuracy,
    mismatched_items: [...fields.accuracy.mismatchedItems],
  };
};

/** A delivery event's audit metadata: ids, the event kind, the judgment kind and a resolution's outcome. */
export const dmDeliveryAuditMetadata = (fields: {
  eventId: string;
  requestId: string;
  kind: DmDeliveryEventKind;
  judgmentKind: DmJudgmentKind | null;
  outcome: DmDeliveryResolveOutcome | null;
}): Record<string, string> => {
  if (
    !UUID.test(fields.eventId) ||
    !UUID.test(fields.requestId) ||
    !isOneOf(DM_DELIVERY_EVENT_KINDS, fields.kind) ||
    (fields.judgmentKind !== null && !isDmJudgmentKind(fields.judgmentKind)) ||
    (fields.outcome !== null && !isOneOf(DM_DELIVERY_RESOLVE_OUTCOMES, fields.outcome))
  ) {
    throw new Error("AMUX Decision Maker delivery audit metadata value refused");
  }
  const metadata: Record<string, string> = {
    event_id: fields.eventId,
    request_id: fields.requestId,
    kind: fields.kind,
  };
  if (fields.judgmentKind !== null) metadata.judgment_kind = fields.judgmentKind;
  if (fields.outcome !== null) metadata.outcome = fields.outcome;
  return metadata;
};
