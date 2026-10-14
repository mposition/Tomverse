import assert from "node:assert/strict";
import test from "node:test";

import type { ReactNode } from "react";

import {
  AmuxOwnerReviewQueueView,
  AmuxOwnerReviewView,
  AMUX_OWNER_EXECUTION_READ_TIMEOUT_MS,
  amuxAssignmentReviewReturnPath,
  bindAmuxOwnerExecutionMetadata,
  formatAmuxMicrousd,
  isValidAmuxReviewArtifact,
  readAmuxOwnerExecutionMetadata,
  visibleAmuxOwnerReviewOutcomes,
  type AmuxEscalationSummary,
  type AmuxReviewDetail,
} from "@/components/admin/AdminAmuxRoutingPanel";
import { adminAmuxRoutingMessages } from "@/lib/adminMessages/amuxRouting";

type Props = Record<string, unknown>;

const propsOf = (node: ReactNode, found: Props[] = []) => {
  if (node === null || node === undefined || typeof node === "boolean") return found;
  if (typeof node === "string" || typeof node === "number") return found;
  if (Array.isArray(node)) {
    for (const child of node) propsOf(child, found);
    return found;
  }
  const element = node as { props?: Props };
  if (element.props) {
    found.push(element.props);
    propsOf(element.props.children as ReactNode, found);
  }
  return found;
};

const textOf = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  const element = node as { props?: { children?: ReactNode } };
  return element.props ? textOf(element.props.children) : "";
};

const byTestId = (node: ReactNode, id: string) =>
  propsOf(node).filter((props) => props["data-testid"] === id);

const review = (overrides: Partial<AmuxReviewDetail> = {}): AmuxReviewDetail => ({
  available: true,
  escalation: {
    id: "clreview1234567890123456",
    status: "open",
    specialty: "execution-recovery",
    reason_code: "operator_review_required",
    created_at: "2026-10-12T00:00:00.000Z",
  },
  task: {
    id: "task-owner-review",
    title: "Build the owner review report",
    status: "review",
    revision: 8,
    due_parse_state: "valid",
  },
  last_attempt: {
    id: "attempt-8",
    task_revision: 7,
    outcome: "succeeded",
    to_status: "review",
    ended_at: "2026-10-12T01:00:00.000Z",
  },
  review_content: {
    text: "Task and escalation IDs",
    digest: "a".repeat(64),
    truncated: false,
    display_mismatch: false,
  },
  review_context: {
    title: "Build the owner review report",
    description: "Scope and completion criteria:\nShow the evidence.",
    result_sha256: "b".repeat(64),
    escalation_reason: "Owner review required",
    last_attempt_reason: "reported_result",
    previous_block_reason: null,
  },
  review_report: {
    scope_and_completion_criteria: "Show the evidence and decision effects.",
    approved_execution_brief: "Preserve server authority.",
    worker_report: "Implemented the report and ran focused tests.",
    worker_report_verified: true,
  },
  review_artifact: null,
  allowed_outcomes: ["approve", "block"],
  retry: { used: 1, limit: 5, remaining: 4 },
  proposed_transitions: { approve: "done", block: "blocked" },
  ...overrides,
});

const m = adminAmuxRoutingMessages.en;
const render = (
  item: AmuxReviewDetail,
  changes: string[] = [],
  rereads: string[] = [],
  retryConfirmations: boolean[] = [],
  retryReadConfirmed = false,
  ownerExecution: Parameters<typeof AmuxOwnerReviewView>[0]["ownerExecution"] = {
    state: "ready",
    metadata: {
      worker: "worker-openai",
      attemptNumber: 1,
      reservedCostMicrousd: "2500000",
      actualCostMicrousd: "1250000",
      actualCostConfirmed: true,
    },
  },
) => AmuxOwnerReviewView({
  m,
  review: item,
  ownerExecution,
  canInspectCards: true,
  selectedOutcome: null,
  retryReadConfirmed,
  reviewBusy: false,
  reauthenticationRequired: false,
  decisionStatusUnknown: false,
  date: (value) => value,
  number: (value) => String(value),
  onSelectOutcome: (outcome) => changes.push(outcome),
  onRetryReadConfirmed: (confirmed) => retryConfirmations.push(confirmed),
  onReread: () => rereads.push("read"),
}) as ReactNode;

const escalation = (
  overrides: Omit<Partial<AmuxEscalationSummary>, "task"> & {
    task?: Partial<AmuxEscalationSummary["task"]>;
  } = {},
): AmuxEscalationSummary => {
  const { task, ...summary } = overrides;
  return {
    id: "clreview1234567890123456",
    specialty: "execution-recovery",
    reason_code: "operator_review_required",
    status: "open",
    createdAt: "2026-10-12T00:00:00.000Z",
    ...summary,
    task: {
      id: "task-owner-review",
      title: "Build the owner review report",
      sourceKey: "AMUX-OWNER-REVIEW",
      priority: "p1",
      status: "review",
      ...task,
    },
  };
};

const renderQueue = (
  items: AmuxEscalationSummary[],
  currentReview: AmuxReviewDetail | null,
  opened: string[] = [],
) => AmuxOwnerReviewQueueView({
  m,
  escalations: items,
  escalationsTotal: items.length + 2,
  currentReview,
  canInspectCards: true,
  reviewBusy: false,
  writesFrozen: false,
  onOpenReview: (id) => opened.push(id),
}) as ReactNode;

test("verified report renders assignment, worker evidence and the exact owner question", () => {
  const changes: string[] = [];
  const tree = render(review(), changes);
  assert.match(textOf(byTestId(tree, "admin-amux-assigned-work")[0]?.children as ReactNode),
    /Show the evidence and decision effects/);
  assert.match(textOf(byTestId(tree, "admin-amux-worker-report")[0]?.children as ReactNode),
    /Implemented the report and ran focused tests/);
  const decision = byTestId(tree, "admin-amux-owner-decision")[0];
  assert.match(textOf(decision?.children as ReactNode),
    /Does the submitted result satisfy the assigned scope and completion criteria/);
  assert.equal(byTestId(tree, "admin-amux-select-approve").length, 1);
  assert.equal(byTestId(tree, "admin-amux-select-retry").length, 0);
  assert.equal(byTestId(tree, "admin-amux-select-block").length, 1);
  (byTestId(tree, "admin-amux-select-approve")[0]?.onClick as () => void)();
  assert.deepEqual(changes, ["approve"]);
  assert.match(textOf(tree), /succeeded terminal outcome[\s\S]*not quality approval/);
});

test("approve requires the exact backend review attempt source even when evidence and permission claim it", () => {
  const cases: AmuxReviewDetail[] = [
    review({ last_attempt: { ...review().last_attempt!, outcome: "failed", to_status: "todo" } }),
    review({
      last_attempt: { ...review().last_attempt!, outcome: "failed", to_status: "blocked" },
      review_context: { ...review().review_context, escalation_reason: "execution_blocked",
        last_attempt_reason: "attempts" },
    }),
    review({ last_attempt: { ...review().last_attempt!, outcome: "blocked", to_status: "blocked" } }),
    review({ last_attempt: { ...review().last_attempt!, outcome: "succeeded", to_status: "done" } }),
    review({ task: { ...review().task, status: "blocked" } }),
    review({ last_attempt: { ...review().last_attempt!, task_revision: review().task.revision } }),
    review({ task: { ...review().task, revision: Number.MAX_SAFE_INTEGER + 1 } }),
  ];
  for (const item of cases) {
    assert.equal(item.allowed_outcomes.includes("approve"), true);
    assert.equal(item.review_report?.worker_report_verified, true);
    assert.equal(visibleAmuxOwnerReviewOutcomes(item).includes("approve"), false);
    assert.equal(byTestId(render(item), "admin-amux-select-approve").length, 0);
  }
});

test("the queue treats unread evidence as unread and leads with the meaningful task title", () => {
  const opened: string[] = [];
  const sourceUuid = "c20b91ea-81a7-4d9b-a2c1-ea80e3baae67";
  const tree = renderQueue([escalation({
    task: {
      title: "Investigate retained execution evidence",
      sourceKey: sourceUuid,
    },
  })], null, opened);
  assert.match(textOf(byTestId(tree, "admin-amux-queue-count-needs_read")[0]?.children as ReactNode),
    /Evidence check needed.*1/);
  assert.match(textOf(byTestId(tree, "admin-amux-queue-task-title")[0]?.children as ReactNode),
    /Investigate retained execution evidence/);
  assert.doesNotMatch(textOf(byTestId(tree, "admin-amux-queue-task-title")[0]?.children as ReactNode),
    new RegExp(sourceUuid));
  assert.match(textOf(byTestId(tree, "admin-amux-queue-developer-details")[0]?.children as ReactNode),
    new RegExp(sourceUuid));
  assert.match(textOf(tree), /Classification covers these 1 loaded queue items only/);
  assert.match(textOf(byTestId(tree, "admin-amux-escalations-bounded")[0]?.children as ReactNode),
    /oldest 1 of 3/);
  (byTestId(tree, "admin-amux-open-review")[0]?.onClick as () => void)();
  assert.deepEqual(opened, ["clreview1234567890123456"]);
});

test("an exact legacy unknown review is classified as technical recovery, not an owner question", () => {
  const item = escalation({
    task: { title: "Legacy closed card", status: "blocked" },
    reason_code: "task_blocked",
  });
  const legacyUnknown = review({
    task: { ...review().task, title: "Legacy closed card", status: "blocked" },
    last_attempt: {
      ...review().last_attempt!,
      outcome: "expired",
      to_status: "blocked",
    },
    review_context: {
      ...review().review_context,
      description: null,
      result_sha256: null,
      last_attempt_reason: "usage_outcome_unknown",
    },
    review_report: null,
    allowed_outcomes: ["retry", "block"],
    proposed_transitions: { retry: "todo", block: "blocked" },
  });
  const tree = renderQueue([item], legacyUnknown);
  assert.equal(byTestId(tree, "admin-amux-queue-item-technical_recovery").length, 1);
  assert.equal(byTestId(tree, "admin-amux-queue-item-owner_decision").length, 0);
  assert.match(textOf(byTestId(tree, "admin-amux-queue-task-title")[0]?.children as ReactNode),
    /Work purpose unavailable/);
  assert.match(textOf(tree), /No meaningful owner choice is available/);
});

test("only the exact current protected review promotes a loaded row to an owner decision", () => {
  const exact = escalation();
  const other = escalation({ id: "clreview-other-123456789", task: { id: "task-other", title: "Other task" } });
  const tree = renderQueue([exact, other], review());
  assert.equal(byTestId(tree, "admin-amux-queue-item-owner_decision").length, 1);
  assert.equal(byTestId(tree, "admin-amux-queue-item-needs_read").length, 1);
  assert.match(textOf(byTestId(tree, "admin-amux-queue-item-owner_decision")[0]?.children as ReactNode),
    /server-permitted decision/);
});

test("a disconnected report is not described as never existing", () => {
  const item = review({
    review_report: null,
    allowed_outcomes: ["block"],
    proposed_transitions: { block: "blocked" },
  });
  const tree = render(item);
  const notice = textOf(byTestId(tree, "admin-amux-report-not-connected")[0]?.children as ReactNode);
  assert.match(notice, /not connected to this review/);
  assert.match(notice, /may have existed elsewhere/);
  assert.doesNotMatch(notice, /never existed/i);
  assert.equal(byTestId(tree, "admin-amux-select-approve").length, 0);
  assert.equal(byTestId(tree, "admin-amux-select-block").length, 1);
  assert.equal(byTestId(tree, "admin-amux-technical-recovery").length, 0);
  assert.match(textOf(byTestId(tree, "admin-amux-block-without-result")[0]?.children as ReactNode),
    /connected assignment and permitted decisions.*review → blocked.*does not prove that a host process stopped.*nor that no process ran/i);
});

test("a contradictory payload cannot offer approve for an unverified worker report", () => {
  const item = review({
    review_report: {
      ...review().review_report!,
      worker_report_verified: false,
    },
    allowed_outcomes: ["approve", "block"],
  });
  assert.deepEqual(visibleAmuxOwnerReviewOutcomes(item), ["block"]);
  const tree = render(item);
  assert.equal(byTestId(tree, "admin-amux-select-approve").length, 0);
  assert.equal(byTestId(tree, "admin-amux-select-block").length, 1);
  assert.match(textOf(tree), /binding is not verified for approval/);
});

test("unknown execution offers read-only recovery and no blind retry", () => {
  const rereads: string[] = [];
  const item = review({
    task: { ...review().task, status: "blocked" },
    last_attempt: {
      ...review().last_attempt!,
      outcome: "expired",
      to_status: "blocked",
    },
    review_context: {
      ...review().review_context,
      result_sha256: null,
      last_attempt_reason: "usage_outcome_unknown",
    },
    review_report: {
      ...review().review_report!,
      worker_report: null,
      worker_report_verified: false,
    },
    allowed_outcomes: ["retry", "block"],
    proposed_transitions: { retry: "todo", block: "blocked" },
  });
  assert.deepEqual(visibleAmuxOwnerReviewOutcomes(item), []);
  const tree = render(item, [], rereads);
  assert.equal(byTestId(tree, "admin-amux-select-retry").length, 0);
  assert.equal(byTestId(tree, "admin-amux-select-block").length, 0);
  assert.equal(byTestId(tree, "admin-amux-technical-recovery").length, 1);
  assert.match(textOf(tree), /missing report is not proof that the work did not run/i);
  assert.match(textOf(tree), /could duplicate work and Agent cost/);
  (byTestId(tree, "admin-amux-owner-reread")[0]?.onClick as () => void)();
  assert.deepEqual(rereads, ["read"]);
  assert.match(textOf(byTestId(tree, "admin-amux-developer-details")[0]?.children as ReactNode),
    /retry, block/);
});

test("a step-up from a review returns to that escalation, and only a well-formed one", () => {
  assert.equal(amuxAssignmentReviewReturnPath("clreview1234567890123456"),
    "/admin/amux-execution?tab=assignment&focusEscalation=clreview1234567890123456");
  for (const bad of [null, undefined, "", "not-an-escalation", "c12&tab=cards0000000000000"]) {
    assert.equal(amuxAssignmentReviewReturnPath(bad), "/admin/amux-execution?tab=assignment");
  }
  const item = review({
    last_attempt: { ...review().last_attempt!, outcome: "expired", to_status: "blocked" },
    review_context: { ...review().review_context, result_sha256: null, last_attempt_reason: "usage_outcome_unknown" },
    review_report: { ...review().review_report!, worker_report: null, worker_report_verified: false },
  });
  const panelProps = (tree: ReactNode) => propsOf(tree).find((props) => "identity" in props && "returnTo" in props);
  assert.equal(panelProps(render(item))?.returnTo,
    "/admin/amux-execution?tab=assignment&focusEscalation=clreview1234567890123456");
  const fromCard = AmuxOwnerReviewView({
    m, review: item, ownerExecution: { state: "idle" }, canInspectCards: true, selectedOutcome: null,
    retryReadConfirmed: false, reviewBusy: false, reauthenticationRequired: false,
    decisionStatusUnknown: false, date: (value) => value, number: (value) => String(value),
    onSelectOutcome: () => {}, onRetryReadConfirmed: () => {}, onReread: () => {},
    reviewReturnPath: "/admin/amux-execution?tab=cards&taskId=task-owner-review",
  }) as ReactNode;
  assert.equal(panelProps(fromCard)?.returnTo, "/admin/amux-execution?tab=cards&taskId=task-owner-review");
});

test("legacy done and closed reasons explain the flag boundary without offering a decision", () => {
  const cases = [
    ["local_card_done", "done.*flag is not the worker report"],
    ["local_card_closed", "does not show whether the work succeeded, failed or was cancelled"],
  ] as const;
  for (const [reason, expected] of cases) {
    const item = review({
      task: { ...review().task, status: reason === "local_card_done" ? "review" : "blocked" },
      review_context: {
        ...review().review_context,
        result_sha256: null,
        last_attempt_reason: reason,
      },
      review_report: null,
      allowed_outcomes: ["retry", "block"],
      proposed_transitions: { retry: "todo", block: "blocked" },
    });
    const tree = render(item);
    assert.equal(byTestId(tree, "admin-amux-owner-decision").length, 0);
    assert.equal(byTestId(tree, "admin-amux-select-retry").length, 0);
    assert.match(textOf(byTestId(tree, "admin-amux-technical-recovery")[0]?.children as ReactNode),
      new RegExp(expected, "i"));
    assert.match(textOf(byTestId(tree, "admin-amux-missing-evidence")[0]?.children as ReactNode),
      /verified previous-execution outcome.*connected worker output or report/);
  }
});

test("ambiguous and nonterminal attempts stay read-only even with verified output or an artifact", () => {
  const artifact = {
    pr_number: 812,
    base_sha: "c".repeat(40),
    head_sha: "d".repeat(40),
    diff_digest: "e".repeat(64),
    diff_text: "diff --git a/a b/a",
    html_url: "https://github.com/mposition/Tomverse/pull/812",
  };
  const cases = [
    { reason: "reported_result", outcome: "running", toStatus: "blocked" },
    { reason: "reported_result", outcome: "started", toStatus: "blocked" },
    { reason: "reported_result", outcome: "arbitrary", toStatus: "blocked" },
    { reason: "local_card_done", outcome: "succeeded", toStatus: "review" },
    { reason: "local_card_closed", outcome: "blocked", toStatus: "blocked" },
    { reason: "usage_outcome_unknown", outcome: "expired", toStatus: "blocked" },
    { reason: "outcome_unknown", outcome: "blocked", toStatus: "blocked" },
  ];
  for (const item of cases) {
    const detail = review({
      task: { ...review().task, status: "blocked" },
      last_attempt: {
        ...review().last_attempt!,
        outcome: item.outcome,
        to_status: item.toStatus,
      },
      review_context: {
        ...review().review_context,
        last_attempt_reason: item.reason,
      },
      review_artifact: artifact,
      allowed_outcomes: ["approve", "retry", "block"],
      proposed_transitions: { approve: "done", retry: "todo", block: "blocked" },
    });
    assert.deepEqual(visibleAmuxOwnerReviewOutcomes(detail), []);
    const tree = render(detail);
    assert.equal(byTestId(tree, "admin-amux-owner-decision").length, 0);
    assert.equal(byTestId(tree, "admin-amux-technical-recovery").length, 1);
  }

  const missingAssignment = review({
    review_context: { ...review().review_context, description: null },
    review_report: {
      ...review().review_report!,
      scope_and_completion_criteria: null,
    },
    review_artifact: artifact,
    allowed_outcomes: ["approve", "retry", "block"],
    proposed_transitions: { approve: "done", retry: "todo", block: "blocked" },
  });
  assert.deepEqual(visibleAmuxOwnerReviewOutcomes(missingAssignment), []);
  const missingAssignmentTree = render(missingAssignment);
  assert.equal(byTestId(missingAssignmentTree, "admin-amux-owner-decision").length, 0);
  assert.equal(byTestId(missingAssignmentTree, "admin-amux-technical-recovery").length, 1);
});

test("the actual attempt-budget terminal failure preserves only the server block choice", () => {
  for (const lastAttemptReason of ["attempt_budget_exhausted", "attempts"]) {
    const item = review({
      task: { ...review().task, status: "blocked" },
      last_attempt: {
        ...review().last_attempt!,
        outcome: "failed",
        to_status: "blocked",
      },
      review_context: {
        ...review().review_context,
        result_sha256: null,
        escalation_reason: lastAttemptReason === "attempts"
          ? "execution_blocked"
          : "attempt_budget_exhausted",
        last_attempt_reason: lastAttemptReason,
      },
      review_report: null,
      allowed_outcomes: ["block"],
      proposed_transitions: { block: "blocked" },
    });
    assert.deepEqual(visibleAmuxOwnerReviewOutcomes(item), ["block"]);
    const tree = render(item);
    assert.equal(byTestId(tree, "admin-amux-select-block").length, 1);
    assert.equal(byTestId(tree, "admin-amux-select-approve").length, 0);
    assert.equal(byTestId(tree, "admin-amux-select-retry").length, 0);
    assert.equal(byTestId(tree, "admin-amux-technical-recovery").length, 0);
  }
});

test("an exact no-attempt human review keeps meaningful block authority but never completion or retry", () => {
  const item = review({
    task: { ...review().task, status: "blocked" },
    last_attempt: null,
    review_context: {
      ...review().review_context,
      result_sha256: null,
      escalation_reason: "human_review_required",
      last_attempt_reason: null,
    },
    review_report: null,
    review_artifact: null,
    allowed_outcomes: ["approve", "retry", "block"],
    proposed_transitions: { approve: "done", retry: "todo", block: "blocked" },
  });
  assert.deepEqual(visibleAmuxOwnerReviewOutcomes(item), ["block"]);
  const tree = render(item);
  assert.equal(byTestId(tree, "admin-amux-select-block").length, 1);
  assert.equal(byTestId(tree, "admin-amux-select-approve").length, 0);
  assert.equal(byTestId(tree, "admin-amux-select-retry").length, 0);
  const notice = textOf(
    byTestId(tree, "admin-amux-block-without-result")[0]?.children as ReactNode,
  );
  assert.match(notice, /connected assignment and permitted decisions/i);
  assert.match(notice, /does not prove that a host process stopped, nor that no process ran/i);
  assert.doesNotMatch(notice, /protected terminal outcome|only .*→/i);
  const koreanNotice = adminAmuxRoutingMessages.ko.blockWithoutResultNotice(
    "blocked", "blocked",
  );
  assert.match(koreanNotice, /확인할 수 있는 요청과 허용된 결정/);
  assert.match(koreanNotice, /멈췄거나 애초에 실행되지 않았다고 단정하지 않/);
  assert.doesNotMatch(koreanNotice, /종결된|종료 결과|선택만/);

  for (const unsupported of [
    review({
      ...item,
      review_context: { ...item.review_context, description: null },
    }),
    review({
      ...item,
      review_context: {
        ...item.review_context,
        escalation_reason: "canonical_deadline_review_required",
      },
    }),
    review({
      ...item,
      task: { ...item.task, status: "review" },
    }),
    review({
      ...item,
      last_attempt: {
        id: "attempt-revision-only",
        task_revision: 7,
        outcome: null,
        to_status: null,
        ended_at: null,
      } as unknown as NonNullable<AmuxReviewDetail["last_attempt"]>,
    }),
  ]) {
    assert.deepEqual(visibleAmuxOwnerReviewOutcomes(unsupported), []);
    const unsupportedTree = render(unsupported);
    assert.equal(byTestId(unsupportedTree, "admin-amux-select-block").length, 0);
    assert.equal(byTestId(unsupportedTree, "admin-amux-owner-decision").length, 0);
    assert.equal(byTestId(unsupportedTree, "admin-amux-technical-recovery").length, 1);
  }
});

test("malformed PR artifacts never become completion or retry evidence", () => {
  const artifact = {
    pr_number: 812,
    base_sha: "c".repeat(40),
    head_sha: "d".repeat(40),
    diff_digest: "e".repeat(64),
    diff_text: "diff --git a/a b/a",
    html_url: "https://github.com/mposition/Tomverse/pull/812",
  };
  assert.equal(isValidAmuxReviewArtifact(artifact), true);
  const malformed = [
    { ...artifact, pr_number: 0 },
    { ...artifact, pr_number: -1 },
    { ...artifact, pr_number: Number.NaN },
    { ...artifact, pr_number: 1.5 },
    { ...artifact, pr_number: Number.MAX_SAFE_INTEGER + 1 },
    { ...artifact, base_sha: "c".repeat(39) },
    { ...artifact, base_sha: `${"c".repeat(39)}z` },
    { ...artifact, head_sha: "d".repeat(41) },
    { ...artifact, head_sha: `${"d".repeat(39)}z` },
    { ...artifact, diff_digest: "e".repeat(63) },
    { ...artifact, diff_digest: `${"e".repeat(63)}z` },
  ];
  for (const invalid of malformed) {
    assert.equal(isValidAmuxReviewArtifact(invalid), false);
    const evidence = {
      scope_and_completion_criteria: "Show the evidence and decision effects.",
      approved_execution_brief: "Preserve server authority.",
      worker_report: null,
      worker_report_verified: false,
    };
    const completion = review({
      review_report: evidence,
      review_artifact: invalid,
      allowed_outcomes: ["approve", "block"],
      proposed_transitions: { approve: "done", block: "blocked" },
    });
    assert.deepEqual(visibleAmuxOwnerReviewOutcomes(completion), ["block"]);
    const completionTree = render(completion);
    assert.equal(byTestId(completionTree, "admin-amux-select-approve").length, 0);
    assert.equal(byTestId(completionTree, "admin-amux-review-artifact").length, 0);

    const retry = review({
      task: { ...review().task, status: "blocked" },
      last_attempt: {
        ...review().last_attempt!, outcome: "blocked", to_status: "blocked",
      },
      review_report: evidence,
      review_artifact: invalid,
      allowed_outcomes: ["retry", "block"],
      proposed_transitions: { retry: "todo", block: "blocked" },
    });
    assert.deepEqual(visibleAmuxOwnerReviewOutcomes(retry), ["block"]);
    const retryTree = render(retry);
    assert.equal(byTestId(retryTree, "admin-amux-select-retry").length, 0);
    assert.equal(byTestId(retryTree, "admin-amux-select-block").length, 1);
  }
});

test("terminal blocked context without output preserves only the server block choice", () => {
  const item = review({
    task: { ...review().task, status: "blocked" },
    last_attempt: {
      ...review().last_attempt!,
      outcome: "blocked",
      to_status: "blocked",
    },
    review_context: {
      ...review().review_context,
      result_sha256: null,
      last_attempt_reason: "reported_result",
    },
    review_report: null,
    allowed_outcomes: ["block"],
    proposed_transitions: { block: "blocked" },
  });
  assert.deepEqual(visibleAmuxOwnerReviewOutcomes(item), ["block"]);
  const tree = render(item);
  assert.equal(byTestId(tree, "admin-amux-select-approve").length, 0);
  assert.equal(byTestId(tree, "admin-amux-select-retry").length, 0);
  assert.equal(byTestId(tree, "admin-amux-select-block").length, 1);
  assert.equal(byTestId(tree, "admin-amux-technical-recovery").length, 0);
  assert.match(textOf(byTestId(tree, "admin-amux-block-without-result")[0]?.children as ReactNode),
    /connected assignment and permitted decisions.*blocked → blocked.*does not prove that a host process stopped.*nor that no process ran.*does not delete, cancel, requeue, or run/i);
});

test("a legitimate existing retry shows exact scope, nonzero prior cost and explicit read confirmation", () => {
  const changes: string[] = [];
  const confirmations: boolean[] = [];
  const item = review({
    task: { ...review().task, status: "blocked" },
    last_attempt: {
      ...review().last_attempt!,
      outcome: "blocked",
      to_status: "blocked",
    },
    review_context: {
      ...review().review_context,
      last_attempt_reason: "reported_result",
    },
    allowed_outcomes: ["retry", "block"],
    proposed_transitions: { retry: "todo", block: "blocked" },
  });
  assert.deepEqual(visibleAmuxOwnerReviewOutcomes(item), ["retry", "block"]);
  const tree = render(item, changes, [], confirmations);
  const preview = textOf(byTestId(tree, "admin-amux-retry-preview")[0]?.children as ReactNode);
  assert.match(preview, /Show the evidence and decision effects/);
  assert.match(preview, /1 of 5 attempts used.*4 remain/);
  assert.match(preview, /US\$2\.5/);
  assert.match(preview, /US\$1\.25/);
  assert.match(preview, /No new amount is reserved or validated/);
  assert.match(preview, /blocked → todo/);
  assert.match(preview, /does not claim that a host process has stopped/);
  (byTestId(tree, "admin-amux-select-retry")[0]?.onClick as () => void)();
  (byTestId(tree, "admin-amux-retry-read-confirmation")[0]?.onChange as
    (event: { target: { checked: boolean } }) => void)({ target: { checked: true } });
  assert.deepEqual(changes, ["retry"]);
  assert.deepEqual(confirmations, [true]);
});

test("an unconfirmed zero settlement remains unknown rather than becoming actual cost", () => {
  const item = review({
    task: { ...review().task, status: "blocked" },
    last_attempt: { ...review().last_attempt!, outcome: "blocked", to_status: "blocked" },
    allowed_outcomes: ["retry"],
    proposed_transitions: { retry: "todo" },
  });
  const tree = render(item, [], [], [], false, {
    state: "ready",
    metadata: {
      worker: "worker-openai",
      attemptNumber: 1,
      reservedCostMicrousd: "2500000",
      actualCostMicrousd: null,
      actualCostConfirmed: false,
    },
  });
  const preview = textOf(byTestId(tree, "admin-amux-retry-preview")[0]?.children as ReactNode);
  assert.match(preview, /Previous reservation maximum US\$2\.5/);
  assert.match(preview, /Previous recorded settlement Unknown — not zero/);
  assert.doesNotMatch(preview, /US\$0/);
});

test("legacy closed card with no purpose or result offers checks, not a made-up retry question", () => {
  const item = review({
    task: { ...review().task, status: "blocked", title: "Legacy card" },
    last_attempt: {
      ...review().last_attempt!,
      outcome: "blocked",
      to_status: "blocked",
    },
    review_context: {
      ...review().review_context,
      description: null,
      result_sha256: null,
      last_attempt_reason: null,
    },
    review_report: null,
    allowed_outcomes: ["retry", "block"],
    proposed_transitions: { retry: "todo", block: "blocked" },
  });
  assert.deepEqual(visibleAmuxOwnerReviewOutcomes(item), []);
  const tree = render(item);
  assert.equal(byTestId(tree, "admin-amux-owner-decision").length, 0);
  assert.equal(byTestId(tree, "admin-amux-technical-recovery").length, 1);
  assert.match(textOf(byTestId(tree, "admin-amux-no-owner-decision")[0]?.children as ReactNode),
    /No task-review decision is currently permitted/);
});

test("owner cost metadata binds task, revision, attempt and retained result exactly", () => {
  const item = review();
  const detail = {
    id: item.task.id,
    revision: item.task.revision,
    attempts: [{
      id: item.last_attempt!.id,
      taskRevision: item.last_attempt!.task_revision,
      worker: "worker-openai",
      attemptNumber: 1,
      reservedCostMicrousd: "2500000",
      settledCostMicrousd: "1250000",
      costConfirmed: true,
    }],
    result: {
      state: "available",
      attemptId: item.last_attempt!.id,
      sha256: item.review_context.result_sha256,
    },
  };
  assert.deepEqual(bindAmuxOwnerExecutionMetadata(item, detail), {
    worker: "worker-openai",
    attemptNumber: 1,
    reservedCostMicrousd: "2500000",
    actualCostMicrousd: "1250000",
    actualCostConfirmed: true,
  });
  assert.equal(bindAmuxOwnerExecutionMetadata(item, {
    ...detail,
    revision: item.task.revision + 1,
  }), null);
  assert.equal(bindAmuxOwnerExecutionMetadata(item, {
    ...detail,
    id: "other-task",
  }), null);
  assert.equal(bindAmuxOwnerExecutionMetadata(item, {
    ...detail,
    attempts: [{ ...detail.attempts[0], taskRevision: item.last_attempt!.task_revision + 1 }],
  }), null);
  assert.equal(bindAmuxOwnerExecutionMetadata(item, {
    ...detail,
    result: { ...detail.result, sha256: "c".repeat(64) },
  }), null);
  assert.deepEqual(bindAmuxOwnerExecutionMetadata(item, {
    ...detail,
    attempts: [{
      ...detail.attempts[0],
      settledCostMicrousd: "0",
      costConfirmed: false,
    }],
  }), {
    worker: "worker-openai",
    attemptNumber: 1,
    reservedCostMicrousd: "2500000",
    actualCostMicrousd: null,
    actualCostConfirmed: false,
  });
  assert.equal(formatAmuxMicrousd("2500000"), "US$2.5");
  assert.equal(formatAmuxMicrousd("0"), "US$0");
  assert.equal(formatAmuxMicrousd("not-known"), null);
});

test("interactive controls expose focus styles and at least 44px minimum height", () => {
  const tree = render(review());
  for (const id of ["admin-amux-select-approve", "admin-amux-select-block"]) {
    const control = byTestId(tree, id)[0];
    assert.match(String(control?.className), /min-h-11/);
    assert.match(String(control?.className), /focus-visible:outline/);
  }
});

test("developer details retain specialty, due state, terminal transition and an accurate ended label", () => {
  const tree = render(review());
  const lifecycle = textOf(
    byTestId(tree, "admin-amux-task-lifecycle")[0]?.children as ReactNode,
  );
  const details = textOf(
    byTestId(tree, "admin-amux-developer-details")[0]?.children as ReactNode,
  );
  assert.equal(lifecycle.trim(), "Awaiting owner review");
  assert.doesNotMatch(lifecycle, /r8/);
  assert.match(details, /Revision 8/);
  assert.match(details, /Specialty execution-recovery/);
  assert.match(details, /Deadline parse valid/);
  assert.match(details, /Last attempt result succeeded → review/);
  assert.match(details, /Attempt ended 2026-10-12T01:00:00.000Z/);
  assert.doesNotMatch(details, /Expires 2026-10-12T01:00:00.000Z/);
});

test("block effect distinguishes moving a review from leaving a blocked Task blocked", () => {
  const fromReview = textOf(
    byTestId(render(review()), "admin-amux-select-block")[0]?.children as ReactNode,
  );
  assert.match(fromReview, /moves the reviewed Task to blocked/);
  assert.match(fromReview, /does not delete or cancel/);

  const blocked = review({
    task: { ...review().task, status: "blocked" },
    last_attempt: {
      ...review().last_attempt!,
      outcome: "blocked",
      to_status: "blocked",
    },
    allowed_outcomes: ["block"],
    proposed_transitions: { block: "blocked" },
  });
  const whileBlocked = textOf(
    byTestId(render(blocked), "admin-amux-select-block")[0]?.children as ReactNode,
  );
  assert.match(whileBlocked, /leaves the Task blocked/);
  assert.match(whileBlocked, /does not delete or cancel/);
});

const ownerDetail = (item: AmuxReviewDetail) => ({
  id: item.task.id,
  revision: item.task.revision,
  attempts: [{
    id: item.last_attempt!.id,
    taskRevision: item.last_attempt!.task_revision,
    worker: "worker-openai",
    attemptNumber: 1,
    reservedCostMicrousd: "2500000",
    settledCostMicrousd: "1250000",
    costConfirmed: true,
  }],
  result: {
    state: "available",
    attemptId: item.last_attempt!.id,
    sha256: item.review_context.result_sha256,
  },
});

test("a newer owner read wins when the older response body resolves late", async () => {
  const item = review();
  let generation = 1;
  let releaseLateJson!: (value: unknown) => void;
  let markJsonStarted!: () => void;
  const jsonStarted = new Promise<void>((resolve) => { markJsonStarted = resolve; });
  const lateJson = new Promise<unknown>((resolve) => { releaseLateJson = resolve; });
  const firstController = new AbortController();
  const first = readAmuxOwnerExecutionMetadata({
    review: item,
    controller: firstController,
    isCurrent: () => generation === 1,
    fetcher: async () => ({
      ok: true,
      json: async () => {
        markJsonStarted();
        return lateJson;
      },
    }) as Response,
  });
  await jsonStarted;

  generation = 2;
  const secondController = new AbortController();
  const second = await readAmuxOwnerExecutionMetadata({
    review: item,
    controller: secondController,
    isCurrent: () => generation === 2,
    fetcher: async () => new Response(JSON.stringify(ownerDetail(item)), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  assert.equal(second?.state, "ready");

  releaseLateJson(ownerDetail(item));
  assert.equal(await first, null);
  assert.equal(firstController.signal.aborted, false);
});

test("an owner metadata timeout resolves unavailable instead of leaving loading stuck", async () => {
  const item = review();
  const controller = new AbortController();
  let receivedTimeout: number | null | undefined;
  const result = await readAmuxOwnerExecutionMetadata({
    review: item,
    controller,
    isCurrent: () => true,
    timeoutMs: 5,
    fetcher: async (_input, init) => {
      receivedTimeout = init?.timeoutMs;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    },
  });
  assert.equal(receivedTimeout, 5);
  assert.deepEqual(result, { state: "unavailable" });
  assert.equal(controller.signal.aborted, true);
  assert.equal(AMUX_OWNER_EXECUTION_READ_TIMEOUT_MS, 10_000);
});
