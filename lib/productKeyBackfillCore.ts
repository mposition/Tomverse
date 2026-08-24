/**
 * What the productKey backfill would write, and what stops it.
 *
 * Product boundary decision record v1.2, §2 — "DB 규칙이 정본, 로그는 방증".
 *
 * ## The order, and the gate in the middle
 *
 *   1. extract every row with selectionMode = 'auto'  -- extraction, not
 *      classification;
 *   2. classify each extracted row from drill logs, traces and operational
 *      evidence, by hand;
 *   3. GATE: if one row is still unclassified, neither the backfill nor the
 *      strict transition may proceed;
 *   4. kind = 'image'  -> studio;
 *   5. remaining NULL  -> review;
 *   6. verify: NULL = 0, unclassified = 0, every drill conversation is chat.
 *
 * ## Why selectionMode = 'auto' is not a classification rule
 *
 * Decision 3 has just established that selectionMode cannot imply or backfill
 * a product. Using it as a classification rule two sections later would
 * contradict the same document. It is a *signal* -- these rows are either
 * drills or anomalies -- and what it selects is a list for a person to look
 * at, not a set to relabel.
 *
 * The expected count is zero: the column defaults to manual and the Auto
 * toggle has never been mounted, so no path existed to set it. But a default
 * and an unmounted component are an expectation, not evidence, which is why
 * the report runs against production rather than being reasoned about here.
 *
 * ## Why an unclassified row has no safe default
 *
 * Both directions break:
 *
 *   - relabel it `review` and the evidence is gone; nothing can undo it,
 *     because there is nothing left that says what it was;
 *   - leave it NULL and the exit condition (NULL = 0) can never be met, so
 *     the NOT NULL transition cannot pass either.
 *
 * So the only path through is a person resolving every exception first. The
 * exception list is not a list of rows to skip while proceeding -- it is what
 * blocks proceeding.
 *
 * Pure: it takes rows and returns a plan. The script does the reading and,
 * under approval, the writing.
 */

import type { ConversationProductKey } from "@/lib/conversationProduct";

export type BackfillCandidateRow = {
  id: string;
  kind: string;
  selectionMode: string;
  productKey: string | null;
};

/**
 * A classification a person made, keyed by conversation id.
 *
 * Supplied as a file to the report. The absence of an entry is what makes a
 * row unclassified; there is no "assume" branch.
 */
export type ManualClassification = {
  conversationId: string;
  productKey: ConversationProductKey;
  /** The drill log, trace or operational record that established it. */
  evidence: string;
};

export type BackfillPlan = {
  /** Step 1: rows selectionMode = 'auto' singled out for human review. */
  extracted: BackfillCandidateRow[];
  /** Step 2: extracted rows a person resolved, with their evidence. */
  classified: { row: BackfillCandidateRow; classification: ManualClassification }[];
  /** Step 3: extracted rows nobody has resolved. Any one of these is a stop. */
  unclassified: BackfillCandidateRow[];
  /** Step 4. */
  toStudio: BackfillCandidateRow[];
  /** Step 5. */
  toReview: BackfillCandidateRow[];
  /** Rows that already carry a product; the backfill does not touch them. */
  alreadySet: BackfillCandidateRow[];
  /**
   * Why a write is refused, empty when it is not. A write is permitted only
   * when this is empty AND the caller carries an approval.
   */
  blockers: BackfillBlocker[];
};

export type BackfillBlocker = {
  code: "unclassified_rows" | "classification_conflicts_modality" | "unknown_product";
  message: string;
};

export const planProductKeyBackfill = ({
  rows,
  classifications,
}: {
  rows: readonly BackfillCandidateRow[];
  classifications: readonly ManualClassification[];
}): BackfillPlan => {
  const byId = new Map(classifications.map((entry) => [entry.conversationId, entry]));

  const alreadySet = rows.filter((row) => row.productKey !== null);
  const nulls = rows.filter((row) => row.productKey === null);

  // Step 1 -- extraction. Every NULL row whose mode is 'auto', whatever its
  // kind: an image conversation marked auto is exactly as anomalous as a chat
  // one, and routing it to step 4 on its kind alone would relabel the row this
  // step exists to stop and look at.
  const extracted = nulls.filter((row) => row.selectionMode === "auto");
  const extractedIds = new Set(extracted.map((row) => row.id));

  const classified: BackfillPlan["classified"] = [];
  const unclassified: BackfillCandidateRow[] = [];
  const blockers: BackfillBlocker[] = [];

  for (const row of extracted) {
    const classification = byId.get(row.id);
    if (!classification) {
      unclassified.push(row);
      continue;
    }
    classified.push({ row, classification });
  }

  if (unclassified.length > 0) {
    blockers.push({
      code: "unclassified_rows",
      message:
        `${unclassified.length} conversation(s) with selectionMode='auto' have not ` +
        "been classified from drill logs, traces or operational evidence. The " +
        "backfill and the strict transition are both blocked until every one is " +
        "resolved: relabelling them review destroys the evidence, and leaving " +
        "them NULL makes the NULL = 0 exit condition unreachable.",
    });
  }

  // A person's classification still has to agree with the row's modality; the
  // CHECK would refuse the write otherwise, and finding that out mid-backfill
  // is worse than finding it out in the report.
  for (const { row, classification } of classified) {
    const expectedKind = classification.productKey === "studio" ? "image" : "chat";
    if (row.kind !== expectedKind) {
      blockers.push({
        code: "classification_conflicts_modality",
        message:
          `Conversation ${row.id} was classified ${classification.productKey} but ` +
          `has kind='${row.kind}'. Conversation_product_modality_check would ` +
          "refuse the write.",
      });
    }
  }

  const remaining = nulls.filter((row) => !extractedIds.has(row.id));

  // Step 4 then step 5. Order matters: an image row must reach studio before
  // the catch-all sees it.
  const toStudio = remaining.filter((row) => row.kind === "image");
  const toReview = remaining.filter((row) => row.kind !== "image");

  return {
    extracted,
    classified,
    unclassified,
    toStudio,
    toReview,
    alreadySet,
    blockers,
  };
};

export type BackfillVerification = {
  nullCount: number;
  unclassifiedCount: number;
  /** Conversations named by drill evidence that did not end up as chat. */
  drillRowsNotChat: string[];
  passed: boolean;
};

/**
 * Step 6. All three, together: a verification that reported only the NULL
 * count would pass on a run that relabelled an unresolved exception.
 */
export const verifyProductKeyBackfill = ({
  nullCount,
  unclassifiedCount,
  drillConversations,
}: {
  nullCount: number;
  unclassifiedCount: number;
  drillConversations: readonly { id: string; productKey: string | null }[];
}): BackfillVerification => {
  const drillRowsNotChat = drillConversations
    .filter((row) => row.productKey !== "chat")
    .map((row) => row.id);

  return {
    nullCount,
    unclassifiedCount,
    drillRowsNotChat,
    passed: nullCount === 0 && unclassifiedCount === 0 && drillRowsNotChat.length === 0,
  };
};

/* ------------------------------------------------------------- write gate */

export type BackfillApproval = {
  apply: boolean;
  /** Explicit acknowledgement that this is the approved backfill run. */
  approvedBackfill: boolean;
  ticket: string | null;
  actor: string | null;
  /**
   * The dry run this write is executing.
   *
   * A path plus the digest of what it contained. `--apply` on its own cannot
   * tell "I read the report and the exception list was empty" from "I ran the
   * command with an extra flag", and this backfill overwrites rows whose
   * evidence is not recoverable afterwards. Requiring the report means the
   * numbers were produced before the write, not asserted after it.
   */
  dryRunReportPath: string | null;
  dryRunReportDigest: string | null;
  environment: {
    ci: boolean;
    automatedHook: string | null;
  };
};

export type BackfillApprovalProblem = {
  code:
    | "automated_context"
    | "missing_approval_flag"
    | "missing_ticket"
    | "missing_actor"
    | "missing_dry_run_report"
    | "dry_run_report_mismatch"
    | "plan_blocked";
  message: string;
};

/**
 * Everything wrong with a write-mode invocation. Empty means it may proceed.
 *
 * A dry run is always allowed and never checked: reporting what *would* change
 * is the safe half and should stay one command away.
 */
export const findBackfillApprovalProblems = ({
  approval,
  plan,
  currentReportDigest,
}: {
  approval: BackfillApproval;
  plan: BackfillPlan;
  /** Digest of the plan this invocation just computed. */
  currentReportDigest: string;
}): BackfillApprovalProblem[] => {
  if (!approval.apply) return [];
  const problems: BackfillApprovalProblem[] = [];

  if (approval.environment.automatedHook) {
    problems.push({
      code: "automated_context",
      message:
        `This process is an npm "${approval.environment.automatedHook}" lifecycle ` +
        "step. The backfill overwrites rows whose original state is not " +
        "recoverable, and is never a build, start, migration or cron side effect.",
    });
  } else if (approval.environment.ci) {
    problems.push({
      code: "automated_context",
      message:
        "CI is set. Relabelling every conversation's product is not something a " +
        "pipeline decides.",
    });
  }

  if (!approval.approvedBackfill) {
    problems.push({
      code: "missing_approval_flag",
      message:
        "--approved-backfill is required. It states that the exception list was " +
        "reviewed and resolved by a person, which is the only thing that makes " +
        "steps 4 and 5 safe.",
    });
  }
  if (!approval.ticket) {
    problems.push({
      code: "missing_ticket",
      message: '--ticket="<url or id>" is required: the decision this run implements.',
    });
  }
  if (!approval.actor) {
    problems.push({
      code: "missing_actor",
      message: '--actor="<who is running this>" is required.',
    });
  }
  if (!approval.dryRunReportPath || !approval.dryRunReportDigest) {
    problems.push({
      code: "missing_dry_run_report",
      message:
        '--dry-run-report="<path>" is required, and the report must carry the ' +
        "digest this run recomputes. Without it, --apply cannot tell a reviewed " +
        "run from a copied command.",
    });
  } else if (approval.dryRunReportDigest !== currentReportDigest) {
    problems.push({
      code: "dry_run_report_mismatch",
      message:
        `The dry-run report describes a different set of rows (${approval.dryRunReportDigest}) ` +
        `than this run found (${currentReportDigest}). The data moved since the ` +
        "report was produced; re-run the dry run and review it again.",
    });
  }

  // Last, and separately: the plan's own blockers are not an approval problem
  // an operator can sign away.
  for (const blocker of plan.blockers) {
    problems.push({
      code: "plan_blocked",
      message: blocker.message,
    });
  }

  return problems;
};

/**
 * A stable description of what a plan would write.
 *
 * Sorted ids only -- never conversation content -- so the report can be
 * attached to a ticket without carrying anybody's text, and so two runs over
 * the same rows produce the same digest whatever order the database returned
 * them in.
 */
export const backfillPlanFingerprint = (plan: BackfillPlan): string =>
  JSON.stringify({
    studio: plan.toStudio.map((row) => row.id).sort(),
    review: plan.toReview.map((row) => row.id).sort(),
    classified: plan.classified
      .map(({ row, classification }) => `${row.id}:${classification.productKey}`)
      .sort(),
    unclassified: plan.unclassified.map((row) => row.id).sort(),
  });
