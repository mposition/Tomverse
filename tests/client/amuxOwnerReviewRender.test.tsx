import assert from "node:assert/strict";
import test from "node:test";

import type { ReactNode } from "react";

import {
  AmuxOwnerReviewQueueView,
  AmuxOwnerReviewView,
  AMUX_OWNER_EXECUTION_READ_TIMEOUT_MS,
  bindAmuxOwnerExecutionMetadata,
  formatAmuxMicrousd,
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
) => AmuxOwnerReviewView({
  m,
  review: item,
  ownerExecution: {
    state: "ready",
    metadata: {
      worker: "worker-openai",
      attemptNumber: 1,
      reservedCostMicrousd: "2500000",
      actualCostMicrousd: "1250000",
      actualCostConfirmed: true,
    },
  },
  canInspectCards: true,
  selectedOutcome: null,
  reviewBusy: false,
  reauthenticationRequired: false,
  decisionStatusUnknown: false,
  date: (value) => value,
  number: (value) => String(value),
  onSelectOutcome: (outcome) => changes.push(outcome),
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
  (byTestId(tree, "admin-amux-owner-reread")[0]?.onClick as () => void)();
  assert.deepEqual(rereads, ["read"]);
  assert.match(textOf(byTestId(tree, "admin-amux-developer-details")[0]?.children as ReactNode),
    /retry, block/);
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
    result: { ...detail.result, sha256: "c".repeat(64) },
  }), null);
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
