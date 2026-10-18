import { DM_OUTPUT_KINDS, type DmOutputKind } from "./decisionMakerBodyCore.ts";
import { dmInstanceForProvider } from "./decisionMakerCore.ts";
import {
  DM_DECLARATION_ACCURACIES,
  DM_DELIVERY_RESOLVE_OUTCOMES,
  isDmConfirmingJudgmentKind,
  type DmDeliveryResolveOutcome,
} from "./decisionMakerJudgmentCore.ts";
import {
  DM_CLOSING_EVENT_KINDS,
  DM_REQUEST_ROUTES,
  DM_RESULT_KINDS,
  DM_ROUTING_REFUSAL_CODES,
  DM_SNAPSHOT_STATES,
  isDmLedgerIdentifier,
  isDmProviderId,
  isDmRequestId,
  type DmRequestRoute,
  type DmResultKind,
  type DmSnapshotState,
} from "./decisionMakerRequestCore.ts";
import {
  DM_SWITCH_LATCH_REASONS,
  isDmInstanceScope,
  isDmSwitchScope,
  type DmInstanceScope,
  type DmSwitchLatchReason,
} from "./decisionMakerSwitchCore.ts";

/**
 * The AMUX Decision Maker's Admin request list, stage S2
 * (docs/policy/amux-decision-maker.md §2, §6, §9, §12): what the operator sees
 * of each recent request before opening one -- where it was routed, how far it
 * got, what the DM returned, what the person decided and whether the answer
 * reached the worker.
 *
 * Pure: the row the store's one list read returns, checked field by field, and
 * the two statuses Admin shows, derived from the ledger's own events. No I/O
 * and no free text: the list carries identifiers, closed codes and flags only.
 * Card text, proposals and rationales stay in the body store and are read for
 * one request at a time.
 */

/** The newest requests the list shows; the panel states the number (docs/ui-contracts/admin-console-ia.md). */
export const DM_ADMIN_REQUEST_LIST_LIMIT = 50;

export type DmAdminRequestRow = {
  requestId: string;
  cardId: string;
  questionRevision: number;
  askingWorkerId: string;
  askingProvider: string;
  route: DmRequestRoute;
  instance: DmInstanceScope | null;
  /** Why §3 kept the question with the operator; empty for a request routed to a DM. */
  refusalCodes: string[];
  createdAtMs: number;
  assignmentDeadlineAtMs: number;
  assigned: boolean;
  /** The snapshot state of the transmit intent; null before one is recorded. */
  snapshotState: DmSnapshotState | null;
  transmitOutcome: "receipt" | "unknown" | null;
  resultKind: DmResultKind | null;
  resultUnknown: boolean;
  closingKind: (typeof DM_CLOSING_EVENT_KINDS)[number] | null;
  /** The result detail of a terminal result; null before one, and null fields for a result without output. */
  outputKind: DmOutputKind | null;
  irreversible: boolean | null;
  declarationAccuracy: (typeof DM_DECLARATION_ACCURACIES)[number] | null;
  delivered: boolean;
  deliveryOutcome: "receipt" | "unknown" | null;
  deliveryResolution: DmDeliveryResolveOutcome | null;
  /**
   * The database clock of the request's `cleanup_unknown` report (§5: the
   * broker could not confirm that the request's directories were deleted); null
   * when none was reported. A closed flag and a time, not a body: it is shown
   * with the status, whatever the request's status is.
   */
  cleanupUnknownAtMs: number | null;
};

export type DmAdminRequestList = {
  /** The database clock when the list was read. */
  dbNowMs: number;
  rows: DmAdminRequestRow[];
};

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);

const epochMs = (value: unknown): number | null => {
  if (typeof value !== "bigint" && typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^-?\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
};

const nullableOneOf = <T extends string>(list: readonly T[], value: unknown): T | null | undefined =>
  value === null ? null : isOneOf(list, value) ? value : undefined;

/**
 * One row of the store's list read, or null when it holds anything the
 * ledger's CHECKs and triggers could not have produced. The store then refuses
 * the whole list rather than show a request nobody can read.
 */
export const dmAdminRequestRowFromRow = (row: unknown): DmAdminRequestRow | null => {
  if (row === null || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  if (!isDmRequestId(r.id) || !isDmLedgerIdentifier(r.cardId) || !isDmLedgerIdentifier(r.askingWorkerId)) return null;
  if (!isDmProviderId(r.askingProvider)) return null;
  if (typeof r.questionRevision !== "number" || !Number.isInteger(r.questionRevision) || r.questionRevision < 0) return null;
  if (!isOneOf(DM_REQUEST_ROUTES, r.route)) return null;
  if (r.instance !== null && !isDmInstanceScope(r.instance)) return null;
  if (!Array.isArray(r.refusalCodes) || !r.refusalCodes.every((code) => isOneOf(DM_ROUTING_REFUSAL_CODES, code))) {
    return null;
  }
  // The ledger's own CHECKs: the instance is the asking provider's (none for
  // a provider outside the verified two), it is missing exactly when §3-5
  // refused the provider, and a DM route always has one. A question kept with
  // the operator still names the instance it would have gone to.
  if (r.instance !== dmInstanceForProvider(r.askingProvider)) return null;
  if (r.refusalCodes.includes("provider_unverified") !== (r.instance === null)) return null;
  if (r.route === "dm_proposal" && r.instance === null) return null;
  const createdAtMs = epochMs(r.createdAtEpochMs);
  const assignmentDeadlineAtMs = epochMs(r.assignmentDeadlineAtEpochMs);
  if (createdAtMs === null || assignmentDeadlineAtMs === null) return null;
  // The statement returns the column for every row (null when no report), so a
  // missing key is not a row this reader was written for.
  const cleanupUnknownAtMs = r.cleanupUnknownAtEpochMs === null ? null : epochMs(r.cleanupUnknownAtEpochMs);
  if (r.cleanupUnknownAtEpochMs === undefined || (r.cleanupUnknownAtEpochMs !== null && cleanupUnknownAtMs === null)) {
    return null;
  }
  if (typeof r.assigned !== "boolean" || typeof r.resultUnknown !== "boolean" || typeof r.delivered !== "boolean") {
    return null;
  }

  const snapshotState = nullableOneOf(DM_SNAPSHOT_STATES, r.snapshotState);
  const resultKind = nullableOneOf(DM_RESULT_KINDS, r.resultKind);
  const closingKind = nullableOneOf(DM_CLOSING_EVENT_KINDS, r.closingKind);
  const outputKind = nullableOneOf(DM_OUTPUT_KINDS, r.outputKind);
  const declarationAccuracy = nullableOneOf(DM_DECLARATION_ACCURACIES, r.declarationAccuracy);
  const deliveryResolution = nullableOneOf(DM_DELIVERY_RESOLVE_OUTCOMES, r.deliveryResolution);
  if (
    snapshotState === undefined ||
    resultKind === undefined ||
    closingKind === undefined ||
    outputKind === undefined ||
    declarationAccuracy === undefined ||
    deliveryResolution === undefined
  ) {
    return null;
  }
  if (r.irreversible !== null && typeof r.irreversible !== "boolean") return null;

  let transmitOutcome: DmAdminRequestRow["transmitOutcome"] = null;
  if (r.transmitOutcome === "transmit_receipt") transmitOutcome = "receipt";
  else if (r.transmitOutcome === "transmit_unknown") transmitOutcome = "unknown";
  else if (r.transmitOutcome !== null) return null;

  let deliveryOutcome: DmAdminRequestRow["deliveryOutcome"] = null;
  if (r.deliveryOutcomeKind === "delivery_receipt") deliveryOutcome = "receipt";
  else if (r.deliveryOutcomeKind === "delivery_unknown") deliveryOutcome = "unknown";
  else if (r.deliveryOutcomeKind !== null) return null;

  // The order the triggers enforce, read back: an operator route has no
  // events; a transmission follows an assignment; output details belong to a
  // result; a judgment's accuracy belongs to a judgment; a delivery follows a
  // confirmation, an outcome the delivery, a resolution an unknown outcome.
  if (r.route === "operator" && (r.assigned || snapshotState !== null || resultKind !== null || closingKind !== null)) {
    return null;
  }
  if (snapshotState !== null && !r.assigned) return null;
  // §5, S2-2a3: a cleanup report is received only for an assigned request, so
  // an operator route (no events) or an unassigned request cannot carry one.
  if (cleanupUnknownAtMs !== null && (r.route === "operator" || !r.assigned)) return null;
  if (transmitOutcome !== null && snapshotState === null) return null;
  if ((outputKind !== null || r.irreversible !== null) && resultKind === null) return null;
  const judged = closingKind === "confirm" || closingKind === "edit_confirm" || closingKind === "reject";
  if (declarationAccuracy !== null && !judged) return null;
  if (judged && declarationAccuracy === null) return null;
  if (r.delivered && !isDmConfirmingJudgmentKind(closingKind)) return null;
  if (deliveryOutcome !== null && !r.delivered) return null;
  if (deliveryResolution !== null && deliveryOutcome !== "unknown") return null;

  return {
    requestId: r.id,
    cardId: r.cardId,
    questionRevision: r.questionRevision,
    askingWorkerId: r.askingWorkerId,
    askingProvider: r.askingProvider,
    route: r.route,
    instance: r.instance as DmInstanceScope | null,
    refusalCodes: [...r.refusalCodes] as string[],
    createdAtMs,
    assignmentDeadlineAtMs,
    assigned: r.assigned,
    snapshotState,
    transmitOutcome,
    resultKind,
    resultUnknown: r.resultUnknown,
    closingKind,
    outputKind,
    irreversible: r.irreversible as boolean | null,
    declarationAccuracy,
    delivered: r.delivered,
    deliveryOutcome,
    deliveryResolution,
    cleanupUnknownAtMs,
  };
};

/**
 * Where a request stands, as one code. A closing event decides first (a
 * person's judgment, a discarded assignment, a stale close); then an unknown
 * result; then the terminal result; then how far the DM path got before it.
 * A request routed to the operator never had a DM path.
 */
export const DM_ADMIN_REQUEST_STATUSES = [
  "routed_to_operator",
  "awaiting_assignment",
  "assignment_expired",
  "assigned",
  "running",
  "transmit_unknown",
  "result_unknown",
  "proposal",
  "escalate",
  "validation_failure",
  "timeout",
  "unavailable",
  "confirm",
  "edit_confirm",
  "reject",
  "assign_discarded",
  "stale_close",
] as const;
export type DmAdminRequestStatus = (typeof DM_ADMIN_REQUEST_STATUSES)[number];

export const dmAdminRequestStatus = (row: DmAdminRequestRow, dbNowMs: number): DmAdminRequestStatus => {
  if (row.route === "operator") return "routed_to_operator";
  if (row.closingKind !== null) return row.closingKind;
  if (row.resultUnknown) return "result_unknown";
  if (row.resultKind !== null) return row.resultKind;
  if (row.transmitOutcome === "unknown") return "transmit_unknown";
  if (row.snapshotState !== null) return "running";
  if (row.assigned) return "assigned";
  return dbNowMs >= row.assignmentDeadlineAtMs ? "assignment_expired" : "awaiting_assignment";
};

/**
 * Whether a confirmed answer reached the worker (§2-7, §9). Only a
 * confirmation or an edited confirmation is ever delivered; every other
 * request has nothing to deliver.
 */
export const DM_ADMIN_DELIVERY_STATUSES = [
  "not_applicable",
  "pending",
  "in_flight",
  "delivered",
  "unknown",
  "resolved_delivered",
  "resolved_not_delivered",
] as const;
export type DmAdminDeliveryStatus = (typeof DM_ADMIN_DELIVERY_STATUSES)[number];

export const dmAdminDeliveryStatus = (row: DmAdminRequestRow): DmAdminDeliveryStatus => {
  if (!isDmConfirmingJudgmentKind(row.closingKind)) return "not_applicable";
  if (!row.delivered) return "pending";
  if (row.deliveryOutcome === null) return "in_flight";
  if (row.deliveryOutcome === "receipt") return "delivered";
  if (row.deliveryResolution === null) return "unknown";
  return row.deliveryResolution === "delivered" ? "resolved_delivered" : "resolved_not_delivered";
};

/**
 * The newest switch event of one scope, as the Admin switch read returns it
 * (lib/amux/decisionMakerSwitchStore.ts, `readDecisionMakerSwitchRowsForAdmin()`).
 */
export type DmAdminSwitchRow = { scope: unknown; value: unknown; actorKind: unknown; reasonCode: unknown };

/**
 * Why an instance is off when the system turned it off and no person has
 * released it since (§8, §5): the reason of its newest switch event when that
 * event is a system latch. A person's newest event is a release or an
 * ordinary change, so it is null; an instance with no event is null.
 */
export type DmAdminSwitchLatches = Record<DmInstanceScope, DmSwitchLatchReason | null>;

/**
 * The instances' latch reasons from the newest event of each scope, or null
 * when any row could not have been written by the switch table's CHECKs (a
 * system event that is not a latch reason, an instance latch that is not
 * `off`, a person's event with a reason, an event in a scope outside the
 * lists). Null shows no reason at all: the switch state itself is read
 * separately and still decides what the screen offers.
 */
export const dmAdminSwitchLatchesFromRows = (rows: unknown): DmAdminSwitchLatches | null => {
  if (!Array.isArray(rows)) return null;
  const latches: DmAdminSwitchLatches = { "decision-maker-openai": null, "decision-maker-anthropic": null };
  const seen = new Set<string>();
  for (const row of rows as unknown[]) {
    if (row === null || typeof row !== "object") return null;
    const { scope, value, actorKind, reasonCode } = row as Partial<DmAdminSwitchRow>;
    if (!isDmSwitchScope(scope) || seen.has(scope)) return null;
    seen.add(scope);
    if (actorKind === "human") {
      if (reasonCode !== "operator") return null;
      continue;
    }
    if (actorKind !== "system" || !isOneOf(DM_SWITCH_LATCH_REASONS, reasonCode)) return null;
    // The table accepts a system event only as an instance turned off.
    if (!isDmInstanceScope(scope) || value !== "off") return null;
    latches[scope] = reasonCode;
  }
  return latches;
};
