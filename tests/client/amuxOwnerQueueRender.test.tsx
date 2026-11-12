import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  readAmuxOwnerExecutionMetadata,
  type AmuxOwnerReviewController,
  type AmuxReviewDetail,
} from "@/components/admin/AdminAmuxRoutingPanel";
import { amuxLegacyCardReadOf, type AmuxLegacyCardRead } from "@/components/admin/AmuxLegacyCardPanel";
import { AmuxOwnerQueueDecision } from "@/components/admin/AmuxOwnerQueueDecision";
import { AmuxOwnerQueueView, isAmuxOwnerQueueRead } from "@/components/admin/AmuxOwnerQueueScreen";
import type { AmuxOwnerQueueItem, AmuxOwnerQueueRead } from "@/lib/amux/ownerQueueCore";
import { amuxOwnerQueueEngineeringButtons } from "@/components/admin/AmuxOwnerQueueEngineeringItems";
import {
  engineeringAgentDecisionRequest,
  engineeringAgentMismatchRequest,
  engineeringAgentRejudgeRequest,
} from "@/lib/engineeringAgentAdminAction";
import type { EngineeringAgentCardItemView } from "@/lib/engineeringAgentOwnerItemContextCore";

const item = (overrides: Partial<AmuxOwnerQueueItem>): AmuxOwnerQueueItem => ({
  taskId: "task-1",
  displayKey: "AMUX-AUTOFILE-004",
  sourceKey: "AUTOFILE-004",
  title: "Tidy the generated file attachment paths",
  status: "blocked",
  worker: "worker-codex",
  channel: "codex",
  attentionReason: "human_review_required",
  ownerQuestion: null,
  escalationId: "clescalation1234567890123",
  waitingSince: "2026-11-08T01:00:00.000Z",
  ...overrides,
});

const items: AmuxOwnerQueueItem[] = [
  item({}),
  item({ taskId: "task-2", displayKey: "AMUX-IMGOUT-002", title: "Match the image size ceiling",
    attentionReason: null, ownerQuestion: "open", escalationId: null, channel: "claude" }),
  item({ taskId: "task-3", displayKey: "AMUX-FILEREQ-003", title: "File request preview",
    attentionReason: "execution_lease_expired", escalationId: "clescalation3333333333333" }),
  item({ taskId: "task-4", displayKey: "AMUX-CONTSEED-004", title: "Measure the overwrite seed",
    attentionReason: "usage_outcome_unknown", escalationId: "clescalation4444444444444" }),
];

const read = (overrides: Partial<AmuxOwnerQueueRead> = {}): AmuxOwnerQueueRead => ({
  items, total: items.length, processedToday: 3, generatedAt: "2026-11-08T03:00:00.000Z", ...overrides,
});

const view = (props: Partial<Parameters<typeof AmuxOwnerQueueView>[0]> = {}) =>
  renderToStaticMarkup(
    <AmuxOwnerQueueView status="ready" read={read()} selectedId="task-1" onSelect={() => {}} navLocked={false}
      query="" onQuery={() => {}} groupFilter={null} onGroupFilter={() => {}} focusMode={false}
      onToggleFocus={() => {}} onRetry={() => {}} detail={<p>decision pane</p>} {...props} />);

test("the list groups every card by why it waits and shows one count per group", () => {
  const html = view();
  for (const heading of ["To decide", "To answer", "To recover", "To read and pass"]) {
    assert.match(html, new RegExp(`aria-label="${heading}"`));
  }
  assert.equal((html.match(/data-testid="amux-owner-queue-item"/g) ?? []).length, 4);
  assert.match(html, /data-task-id="task-1" data-group="decide"/);
  assert.match(html, /data-task-id="task-2" data-group="question"/);
  assert.match(html, /data-task-id="task-3" data-group="recover"/);
  // An unknown outcome is read first, never offered as a retry.
  assert.match(html, /data-task-id="task-4" data-group="read"/);
  assert.match(html, /data-testid="amux-owner-queue-chip-all"[^>]*>All<span[^>]*>4</);
  assert.match(html, /data-testid="amux-owner-queue-chip-recover"[^>]*>Recover<span[^>]*>1</);
  // The chosen card is the current one for assistive technology; its pane is the slot.
  assert.equal((html.match(/aria-current="true"/g) ?? []).length, 1);
  assert.match(html, /decision pane/);
});

test("the strip shows today's number and the cards left, and says when it could not read one", () => {
  const html = view();
  assert.match(html, /data-testid="amux-owner-queue-processed">3</);
  assert.match(html, /data-testid="amux-owner-queue-remaining">4</);
  assert.match(html, /role="progressbar"/);
  const unknown = view({ read: read({ processedToday: null }) });
  assert.match(unknown, /data-testid="amux-owner-queue-processed">Unavailable</);
  assert.doesNotMatch(unknown, /role="progressbar"/);
  // Keys: J and K move, numbers only pick; there is no "Enter to decide".
  assert.match(html, /data-testid="amux-owner-queue-keys"/);
  assert.doesNotMatch(html, />Enter</);
});

test("a list that holds only part of the queue says so and counts the whole of it", () => {
  const html = view({ read: read({ total: 14 }) });
  assert.match(html, /data-testid="amux-owner-queue-partial"/);
  assert.match(html, /Showing the newest 4 of 14 cards/);
  assert.match(html, /data-testid="amux-owner-queue-remaining">14</);
  assert.doesNotMatch(view(), /amux-owner-queue-partial/);
});

test("a failed read is an alert with a retry, never an empty list or a zero", () => {
  const html = view({ status: "failed", read: null });
  assert.match(html, /data-testid="amux-owner-queue-failed"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /Could not read the cards waiting on you/);
  assert.match(html, />Try again</);
  assert.doesNotMatch(html, /amux-owner-queue-empty/);
  assert.match(html, /data-testid="amux-owner-queue-remaining">Unavailable</);
});

test("an empty queue that was read says nothing is waiting", () => {
  const html = view({ read: read({ items: [], total: 0 }), selectedId: null, detail: null });
  assert.match(html, /data-testid="amux-owner-queue-empty"/);
  assert.match(html, /Nothing is waiting on you/);
  assert.doesNotMatch(html, /amux-owner-queue-failed/);
});

test("full screen is a pressed state of one button", () => {
  assert.match(view(), /aria-pressed="false"[^>]*data-testid="amux-owner-queue-fullscreen"[^>]*>(?:.|\n)*Full screen/);
  const on = view({ focusMode: true });
  assert.match(on, /data-focus="true"/);
  assert.match(on, /aria-pressed="true"[^>]*data-testid="amux-owner-queue-fullscreen"[^>]*>(?:.|\n)*Exit full screen/);
});

test("a locked list keeps the chosen card and disables the others", () => {
  const html = view({ navLocked: true });
  const rows = html.match(/<button[^>]*data-testid="amux-owner-queue-item"[^>]*>/g) ?? [];
  assert.equal(rows.length, 4);
  assert.equal(rows.filter((row) => / disabled=""/.test(row)).length, 3);
  assert.doesNotMatch(rows.find((row) => /aria-current/.test(row)) ?? "", / disabled=""/);
});

test("a state word is the reason's own label, never the stored code or the English status", () => {
  const html = view();
  assert.match(html, /Review needed/);
  assert.match(html, /Run signal lost/);
  assert.match(html, /Outcome unknown/);
  assert.doesNotMatch(html, /human_review_required|execution_lease_expired|usage_outcome_unknown/);
});

const controller = (overrides: Partial<AmuxOwnerReviewController> = {}): AmuxOwnerReviewController => ({
  canInspectCards: true, selectedEscalationId: null, review: null, ownerExecution: { state: "idle" },
  reviewLoading: false, reviewBusy: false, reviewError: null, setReviewError: () => {},
  reviewUnavailable: false, reauthenticationRequired: false, selectedOutcome: null,
  setSelectedOutcome: () => {}, retryReadConfirmed: false, setRetryReadConfirmed: () => {},
  noChangeConfirmed: false, setNoChangeConfirmed: () => {}, resolution: "",
  setResolution: () => {}, proposal: null, setProposal: () => {}, setIdempotencyKey: () => {},
  decisionStatusUnknown: false, setDecisionStatusUnknown: () => {}, decisionStatusChecking: false,
  pendingDecision: null, pendingDecisionChecked: true, closeReview: () => {}, openReview: async () => {},
  prepareProposal: async () => {}, confirmDecision: async () => {}, checkDecisionStatus: async () => {},
  ...overrides,
});

const reviewFor = (escalationId: string, overrides: Partial<AmuxReviewDetail> = {}): AmuxReviewDetail => ({
  available: true,
  escalation: { id: escalationId, status: "open", specialty: null, reason_code: null, created_at: "2026-11-08T01:00:00.000Z" },
  task: { id: "task-1", title: "Tidy", status: "review", revision: 8, due_parse_state: "valid" },
  last_attempt: { id: "attempt-1", task_revision: 7, outcome: "succeeded", to_status: "review", ended_at: "2026-11-08T01:30:00.000Z" },
  review_content: { text: "Review text", digest: "a".repeat(64), truncated: false },
  review_context: {
    title: "Tidy", description: "Scope text", result_sha256: "b".repeat(64),
    escalation_reason: "Owner review required", last_attempt_reason: "reported_result", previous_block_reason: null,
  },
  review_report: {
    scope_and_completion_criteria: "Scope and criteria", approved_execution_brief: null,
    worker_report: "Done and tested", worker_report_verified: true,
  },
  review_artifact: null,
  allowed_outcomes: ["approve", "block"],
  retry: { used: 1, limit: 5, remaining: 4 },
  proposed_transitions: { approve: "done", block: "blocked" },
  ...overrides,
});

const decision = (card: AmuxOwnerQueueItem, ctl: AmuxOwnerReviewController, canInspectCards = true,
  legacy: AmuxLegacyCardRead | null = null) =>
  // The panel rides the review's own card detail read, bound or not.
  renderToStaticMarkup(
    <AmuxOwnerQueueDecision item={card}
      controller={legacy === null ? ctl : { ...ctl, ownerExecution: { state: "unavailable", legacyCard: legacy } }}
      canInspectCards={canInspectCards} index={1} total={4}
      generatedAt="2026-11-08T03:00:00.000Z" navLocked={false} advance onAdvanceChange={() => {}}
      onPrevious={null} onNext={() => {}} onAnswered={() => {}} />);

test("a decision card explains why it stopped, offers the next-card checkbox on and links to the full card", () => {
  const html = decision(items[0], controller());
  assert.match(html, /data-testid="amux-owner-queue-decision"[^>]*data-group="decide"/);
  assert.match(html, /Review needed/);
  assert.match(html, /Why it stopped/);
  assert.match(html, /1 \/ 4/);
  assert.match(html, /data-testid="amux-owner-queue-advance"[^>]*checked/);
  assert.match(html, /href="\/admin\/amux-execution\?tab=cards&amp;taskId=task-1"/);
  // Before the protected review is read there is no choice and no recovery step.
  assert.doesNotMatch(html, /amux-owner-queue-recovery-steps/);
  // Ids are folded into technical information.
  assert.match(html, /Technical information|Tech/i);
});

test("the choices shown are the ones the server allows, numbered, and the keys only pick", () => {
  const escalationId = items[0].escalationId!;
  const html = decision(items[0], controller({ selectedEscalationId: escalationId, review: reviewFor(escalationId) }));
  assert.match(html, /data-testid="amux-owner-queue-choices"/);
  assert.match(html, /<kbd[^>]*>1<\/kbd>Approve/);
  assert.match(html, /<kbd[^>]*>2<\/kbd>Block/);
  assert.doesNotMatch(html, /Retry<\/li>/);
  assert.match(html, /only picks the choice/);
  // The existing review parts draw the decision itself, with their own test ids.
  assert.match(html, /data-testid="admin-amux-owner-review"/);
  assert.match(html, /data-testid="admin-amux-select-approve"/);
  assert.doesNotMatch(html, /data-testid="admin-amux-select-retry"/);
});

test("a lost run is checked first and decided second, and no retry is offered while the outcome is unknown", () => {
  const card = items[2];
  const escalationId = card.escalationId!;
  const html = decision(card, controller({
    selectedEscalationId: escalationId,
    review: reviewFor(escalationId, {
      last_attempt: { id: "attempt-9", task_revision: 7, outcome: "expired", to_status: "blocked", ended_at: null },
      allowed_outcomes: ["retry", "block"],
      proposed_transitions: { retry: "todo", block: "blocked" },
    }),
  }));
  assert.match(html, /data-group="recover"/);
  assert.match(html, /data-testid="amux-owner-queue-recovery-steps"/);
  assert.match(html, /Check the result first/);
  assert.match(html, /data-state="locked"/);
  assert.match(html, /href="\/admin\/amux-recovery\?tab=safety"/);
  assert.match(html, /went silent/);
  assert.doesNotMatch(html, /data-testid="admin-amux-select-retry"/);
});

test("an unknown outcome card opens the reading step and a card with nothing read yet shows a read status", () => {
  const html = decision(items[3], controller({ selectedEscalationId: "other", review: null }));
  assert.match(html, /data-group="read"/);
  assert.match(html, /data-testid="amux-owner-queue-recovery-steps"/);
  assert.match(html, /role="status"/);
});

test("a worker question is the existing answer box, and only the owner may answer it", () => {
  const owner = decision(items[1], controller());
  assert.match(owner, /data-group="question"/);
  assert.match(owner, /The worker stopped to ask something only you can answer/);
  assert.doesNotMatch(owner, /data-testid="amux-owner-queue-recovery-steps"/);
  assert.doesNotMatch(owner, /admin-amux-owner-review/);
  const other = decision(items[1], controller(), false);
  assert.match(other, /data-testid="amux-worker-question-owner-only"/);
  assert.doesNotMatch(other, /amux-owner-queue-full-detail/);
});

test("a card with no open escalation says what to open instead of drawing an empty review", () => {
  const html = decision(item({ attentionReason: null, escalationId: null, ownerQuestion: null }), controller());
  assert.match(html, /data-testid="amux-owner-queue-no-review"/);
});

test("the read validator accepts what the route returns and rejects anything else", () => {
  assert.equal(isAmuxOwnerQueueRead(read()), true);
  assert.equal(isAmuxOwnerQueueRead({ ...read(), processedToday: null }), true);
  assert.equal(isAmuxOwnerQueueRead({ ...read(), items: "no" }), false);
  assert.equal(isAmuxOwnerQueueRead({ error: "Server error." }), false);
  assert.equal(isAmuxOwnerQueueRead(null), false);
});

test("a finished run in review with no pull request says so, shows the report and offers retry", () => {
  // AMUX-FILEGEN-003: an implement Task whose result was saved with no PR.
  const card = item({ status: "review" });
  const escalationId = card.escalationId!;
  const html = decision(card, controller({
    selectedEscalationId: escalationId,
    review: reviewFor(escalationId, {
      task: { id: "task-1", title: "Tidy", status: "review", revision: 8,
        due_parse_state: "valid", review_pr_number: null },
      review_report: {
        scope_and_completion_criteria: "Scope and criteria", approved_execution_brief: null,
        worker_report: "Added the notice decision.\nNo PR, merge or deploy.\n\nTests blocked: tsx is not installed.",
        worker_report_verified: true,
      },
      allowed_outcomes: ["block", "retry"],
      proposed_transitions: { block: "blocked", retry: "todo" },
    }),
  }));
  assert.match(html, /The work result is saved, but there is no pull request/);
  assert.doesNotMatch(html, /opened a pull request/);
  assert.match(html, /data-testid="amux-owner-queue-report-excerpt"/);
  assert.match(html, /Tests blocked: tsx is not installed\./);
  assert.match(html, /<kbd[^>]*>1<\/kbd>Block/);
  assert.match(html, /<kbd[^>]*>2<\/kbd>Retry/);
  assert.doesNotMatch(html, /Approve<\/li>/);
  assert.match(html, /data-testid="admin-amux-select-retry"/);
  assert.doesNotMatch(html, /data-testid="admin-amux-select-approve"/);
  assert.match(html, /This result has no pull request\. Should this same task run again\?/);
});

test("a finished run in review names its pull request, and an unread review claims none", () => {
  const card = item({ status: "review" });
  const escalationId = card.escalationId!;
  const withPr = decision(card, controller({
    selectedEscalationId: escalationId,
    review: reviewFor(escalationId, {
      task: { id: "task-1", title: "Tidy", status: "review", revision: 8,
        due_parse_state: "valid", review_pr_number: 3501 },
    }),
  }));
  assert.match(withPr, /pull request #3501 is open/);
  assert.doesNotMatch(withPr, /amux-owner-queue-report-excerpt/);
  const unread = decision(card, controller());
  assert.match(unread, /The worker finished\. This card needs your review/);
  assert.doesNotMatch(unread, /pull request/);
});

test("a finished review run whose usage was never reported still offers the server's block", () => {
  // AMUX-AGENTOPS-001: no choice at all was shown for nine days.
  const card = item({ status: "review", taskId: "task-1" });
  const escalationId = card.escalationId!;
  const html = decision(card, controller({
    selectedEscalationId: escalationId,
    review: reviewFor(escalationId, {
      task: { id: "task-1", title: "Tidy", status: "review", revision: 8,
        due_parse_state: "valid", review_pr_number: null },
      review_context: {
        title: "Tidy", description: "Scope text", result_sha256: "b".repeat(64),
        escalation_reason: "human_review_required",
        last_attempt_reason: "usage_outcome_unknown", previous_block_reason: null,
      },
      allowed_outcomes: ["block"],
      proposed_transitions: { block: "blocked" },
    }),
  }));
  assert.doesNotMatch(html, /No choice is open for this card yet/);
  assert.match(html, /<kbd[^>]*>1<\/kbd>Block/);
  assert.match(html, /data-testid="admin-amux-select-block"/);
  assert.match(html, /data-testid="amux-owner-queue-usage-unknown"/);
  assert.match(html, /its usage was never reported/);
  assert.doesNotMatch(html, /data-testid="admin-amux-select-retry"/);
});

test("the no-PR words follow the choices shown: approvable, retryable or block only", () => {
  const card = item({ status: "review" });
  const escalationId = card.escalationId!;
  const noPrTask = { id: "task-1", title: "Tidy", status: "review", revision: 8,
    due_parse_state: "valid", review_pr_number: null };
  // A verified design Task is approved on its result without a PR.
  const approvable = decision(card, controller({ selectedEscalationId: escalationId,
    review: reviewFor(escalationId, { task: noPrTask }) }));
  assert.match(approvable, /this kind of task is approved on its verified result/);
  assert.doesNotMatch(approvable, /so it cannot be approved/);
  // No retry left (budget spent, publication pending): block only.
  const blockOnly = decision(card, controller({ selectedEscalationId: escalationId,
    review: reviewFor(escalationId, { task: noPrTask, allowed_outcomes: ["block"],
      proposed_transitions: { block: "blocked" } }) }));
  assert.match(blockOnly, /cannot be run again right now\. You can block it\./);
  assert.doesNotMatch(blockOnly, /You can run it again/);
});

test("an implement card that left no change offers 'no change needed', not a plain approve", () => {
  // AMUX-ARTFMT-002 (owner decision 2026-11-11).
  const card = item({ status: "review" });
  const escalationId = card.escalationId!;
  const html = decision(card, controller({ selectedEscalationId: escalationId,
    review: reviewFor(escalationId, {
      task: { id: "task-1", title: "Tidy", status: "review", revision: 8,
        due_parse_state: "valid", review_pr_number: null },
      allowed_outcomes: ["approve", "block", "retry"], approval_basis: "no_change",
      proposed_transitions: { approve: "done", block: "blocked", retry: "todo" },
    }) }));
  assert.match(html, /reports the work is already in place/);
  assert.match(html, /data-testid="amux-owner-queue-choices"[\s\S]*Complete: no change needed/);
  assert.match(html, /data-testid="admin-amux-select-approve"[^>]*>[\s\S]*?Complete: no change needed/);
  assert.match(html, /Is there nothing left to change\?/);
  assert.doesNotMatch(html, /this kind of task is approved on its verified result/);
  // The same card on evidence keeps the plain approve words.
  const evidence = decision(card, controller({ selectedEscalationId: escalationId,
    review: reviewFor(escalationId, { approval_basis: "evidence" }) }));
  assert.doesNotMatch(evidence, /no change needed/);
});

test("choosing 'no change needed' asks once more that the report and code were checked", () => {
  const card = item({ status: "review" });
  const escalationId = card.escalationId!;
  const review = reviewFor(escalationId, {
    task: { id: "task-1", title: "Tidy", status: "review", revision: 8,
      due_parse_state: "valid", review_pr_number: null },
    allowed_outcomes: ["approve", "block"], approval_basis: "no_change",
  });
  const html = decision(card, controller({ selectedEscalationId: escalationId, review,
      selectedOutcome: "approve", resolution: "no change needed (owner verified)" }));
  assert.match(html, /data-testid="admin-amux-no-change-confirmation"/);
  assert.match(html, /I read the worker report and checked the current code: there is nothing to change\./);
  // Preparing waits for that confirmation.
  assert.match(html, /disabled=""[^>]*data-testid="admin-amux-prepare-proposal"/);
  const confirmed = decision(card, controller({ selectedEscalationId: escalationId, review,
      selectedOutcome: "approve", noChangeConfirmed: true,
      resolution: "no change needed (owner verified)" }));
  assert.doesNotMatch(confirmed, /disabled=""[^>]*data-testid="admin-amux-prepare-proposal"/);
});

test("a blocked card says what its own attempt reason was, not only 'blocked before it finished'", () => {
  // AMUX-FILEREQ-003: the worker ended the run and reported it blocked
  // (reported_result); the escalation stores only execution_blocked.
  const card = item({ status: "blocked", attentionReason: "execution_blocked" });
  const escalationId = card.escalationId!;
  const html = decision(card, controller({
    selectedEscalationId: escalationId,
    review: reviewFor(escalationId, {
      task: { id: "task-1", title: "Tidy", status: "blocked", revision: 8,
        due_parse_state: "valid", review_pr_number: null },
      last_attempt: { id: "attempt-1", task_revision: 7, outcome: "blocked",
        to_status: "blocked", ended_at: "2026-11-08T01:30:00.000Z" },
      review_context: {
        title: "Tidy", description: "Scope text", result_sha256: "b".repeat(64),
        escalation_reason: "execution_blocked",
        last_attempt_reason: "reported_result", previous_block_reason: null,
      },
      review_report: {
        scope_and_completion_criteria: "Scope and criteria", approved_execution_brief: null,
        worker_report: "Changed lib/generatedArtifactToolPolicy.ts locally.\nTests deferred to a separate Task.",
        worker_report_verified: true,
      },
      allowed_outcomes: ["block", "retry"],
      proposed_transitions: { block: "blocked", retry: "todo" },
    }),
  }));
  assert.match(html, /reported it as blocked itself, so no pull request was prepared/);
  assert.doesNotMatch(html, /The run was blocked before it could finish/);
  assert.match(html, /Tests deferred to a separate Task\./);
  // An attempt reason with no sentence keeps the reason's own words.
  const other = decision(card, controller({
    selectedEscalationId: escalationId,
    review: reviewFor(escalationId, {
      task: { id: "task-1", title: "Tidy", status: "blocked", revision: 8, due_parse_state: "valid" },
      review_context: {
        title: "Tidy", description: "Scope text", result_sha256: null,
        escalation_reason: "execution_blocked",
        last_attempt_reason: "something_else", previous_block_reason: null,
      },
    }),
  }));
  assert.match(other, /The run was blocked before it could finish/);
});

test("a done or todo card left with an earlier attempt's escalation offers its close, to the owner", () => {
  const card = item({ status: "done", attentionReason: "usage_outcome_unknown" });
  for (const shown of [card, item({ status: "todo", attentionReason: "usage_outcome_unknown" })]) {
    const html = decision(shown, controller());
    assert.match(html, /data-testid="amux-settled-card-escalation"/);
    assert.match(html, /data-testid="amux-settled-card-escalation-close"/);
  }
  // Not for a viewer who is not the owner, and not for a card that still waits on a decision.
  assert.doesNotMatch(decision(card, controller(), false), /amux-settled-card-escalation/);
  assert.doesNotMatch(decision(item({}), controller()), /amux-settled-card-escalation/);
});

test("a done card's leftover escalation reads like its card detail: close right under why, no recovery", () => {
  // AMUX-FILEREQ-004 (2026-11-10): the close sat under the recovery steps,
  // "no choice", the Ubuntu inspection and one-click recovery, out of sight.
  const card = item({ status: "done", displayKey: "AMUX-FILEREQ-004", attentionReason: "usage_outcome_unknown" });
  const escalationId = card.escalationId!;
  const settledReview = reviewFor(escalationId, {
    task: { id: "task-1", title: "Tidy", status: "done", revision: 12, due_parse_state: "valid",
      review_pr_number: null, recovery_inspectable: true, host_recovery_available: true },
    last_attempt: { id: "attempt-3", task_revision: 9, outcome: "expired", to_status: "blocked", ended_at: null },
    review_context: { title: "Tidy", description: "Scope text", result_sha256: null,
      escalation_reason: "usage_outcome_unknown", last_attempt_reason: "usage_outcome_unknown",
      previous_block_reason: null },
    allowed_outcomes: [], proposed_transitions: {},
  });
  for (const ctl of [controller(), controller({ selectedEscalationId: escalationId, review: settledReview })]) {
    const html = decision(card, ctl);
    const why = html.indexOf('data-testid="amux-owner-queue-why"');
    const panel = html.indexOf('data-testid="amux-settled-card-escalation"');
    assert.ok(why >= 0 && why < panel);
    // Nothing but the why box comes between: the panel is the next block.
    assert.doesNotMatch(html.slice(why, panel), /amux-owner-queue-(?:recovery-steps|choices)|admin-amux-/);
    assert.match(html, /The work is already done; only the escalation an earlier attempt left is still open/);
    assert.match(html, /data-testid="amux-owner-queue-settled-action"/);
    // Words that do not fit this card stay out.
    assert.doesNotMatch(html, /could not confirm how this run ended|cannot be approved or run again yet/);
    assert.doesNotMatch(html, /amux-owner-queue-recovery-steps|amux-owner-queue-choices|amux-owner-queue-usage-unknown/);
    assert.doesNotMatch(html, /admin-amux-technical-recovery|Request Ubuntu inspection|admin-amux-one-click-recovery/);
  }
  // The protected review stays below the panel as reading: the worker report is still there.
  const read = decision(card, controller({ selectedEscalationId: escalationId, review: settledReview }));
  assert.ok(read.indexOf('data-testid="amux-settled-card-escalation"') < read.indexOf('data-testid="admin-amux-worker-report"'));
  // A todo card says it waits to run again; a viewer who is not the owner gets no close instruction.
  assert.match(decision(item({ status: "todo", attentionReason: "usage_outcome_unknown" }), controller()),
    /The card is waiting to run again; only the escalation an earlier attempt left is still open/);
  assert.doesNotMatch(decision(card, controller(), false), /amux-owner-queue-settled-action/);
  // A blocked card with the same reason keeps its recovery steps.
  assert.match(decision(item({ status: "blocked", attentionReason: "usage_outcome_unknown" }), controller()),
    /data-testid="amux-owner-queue-recovery-steps"/);
});

const preV22Legacy: AmuxLegacyCardRead = { revision: 9, view: { kind: "pre_v22_task", closeRefusal: null,
  alreadyArchived: false, idea: { state: "ready", title: "Can the PR check be reused?", truncated: false,
    text: "Can the PR check be reused?\n\n원래 카드: AMUX-GITHUB-002" } } };

test("a legacy card with no decision is remade or closed right under the why box, with no second click", () => {
  // The panel used to be only on the board's card overview, one more click away.
  const card = item({ status: "review", displayKey: "AMUX-GITHUB-002" });
  const escalationId = card.escalationId!;
  const html = decision(card, controller({ selectedEscalationId: escalationId,
    review: reviewFor(escalationId, {
      task: { id: "task-1", title: "Tidy", status: "review", revision: 9, due_parse_state: "valid",
        review_pr_number: null, recovery_inspectable: true, host_recovery_available: false },
      allowed_outcomes: [], proposed_transitions: {},
    }) }), true, preV22Legacy);
  assert.match(html, /data-testid="amux-legacy-card"/);
  assert.match(html, /Task made before v22/);
  assert.match(html, /data-testid="amux-legacy-card-recreate"/);
  assert.match(html, /data-testid="amux-legacy-card-close"/);
  // The panel sits right below the why box, before the review parts.
  const why = html.indexOf('data-testid="amux-owner-queue-why"');
  const panel = html.indexOf('data-testid="amux-legacy-card"');
  const choices = html.indexOf('data-testid="amux-owner-queue-choices"');
  assert.ok(why >= 0 && why < panel && panel < choices);
  // The why box and the choices point at the panel: no false "you can block it", no recovery steps.
  assert.match(html, /No review decision can open on this card/);
  assert.doesNotMatch(html, /You can block it/);
  assert.match(html, /data-testid="amux-owner-queue-choices-none"[^>]*>[^<]*legacy card panel above/);
  assert.doesNotMatch(html, /No choice is open for this card yet/);
  assert.doesNotMatch(html, /amux-owner-queue-recovery-steps/);
  // Its Ubuntu inspection is not offered; the note points at the panel.
  assert.match(html, /data-testid="admin-amux-host-recovery-not-applicable">This Task is archived, or has no v22 receipt/);
  assert.match(html, /in the legacy card panel on this screen/);
  assert.doesNotMatch(html, /Request Ubuntu inspection/);
  assert.doesNotMatch(html, /admin-amux-one-click-recovery/);
});

test("a legacy panel is the owner's only, and a card with an open choice keeps its decision words", () => {
  const card = item({ status: "review" });
  const escalationId = card.escalationId!;
  const ctl = controller({ selectedEscalationId: escalationId, review: reviewFor(escalationId, {
    task: { id: "task-1", title: "Tidy", status: "review", revision: 8, due_parse_state: "valid",
      host_recovery_available: false } }) });
  // A v22 Task the Ubuntu inspection can take has its panel read too (owner decision 2026-11-12).
  assert.match(decision(card, controller({ selectedEscalationId: escalationId,
    review: reviewFor(escalationId) }), true, preV22Legacy), /data-testid="amux-legacy-card"/);
  // Nor before this card's own review is read.
  assert.doesNotMatch(decision(card, controller(), true, preV22Legacy), /data-testid="amux-legacy-card"/);
  // Not the owner: the panel is never read or shown.
  assert.doesNotMatch(decision(card, ctl, false, preV22Legacy), /data-testid="amux-legacy-card"/);
  // A question is answered first; its legacy panel waits.
  assert.doesNotMatch(decision(items[1], controller(), true, preV22Legacy), /data-testid="amux-legacy-card"/);
  // With an allowed choice the panel shows, but the decision words stay.
  const open = decision(card, ctl, true, preV22Legacy);
  assert.match(open, /data-testid="amux-legacy-card"/);
  assert.match(open, /<kbd[^>]*>1<\/kbd>Approve/);
  assert.doesNotMatch(open, /No review decision can open on this card/);
});

test("a stopped v22 Task is settled by the owner beside whatever the server offers", () => {
  const stopped: AmuxLegacyCardRead = { revision: 8, view: { kind: "stopped_task", closeRefusal: null,
    completeRefusal: null, alreadyArchived: false, idea: { state: "ready", title: "Tidy the paths",
      truncated: false, text: "Tidy the paths\n\n원래 카드: AMUX-AUTOFILE-004" } } };
  const card = item({ status: "review" });
  const escalationId = card.escalationId!;
  // The server offers nothing for this card: the owner still completes, remakes or closes it.
  const none = decision(card, controller({ selectedEscalationId: escalationId,
    review: reviewFor(escalationId, { allowed_outcomes: [], proposed_transitions: {} }) }), true, stopped);
  assert.match(none, /data-testid="amux-legacy-card"/);
  assert.match(none, /Settle this card yourself/);
  assert.match(none, /data-testid="amux-legacy-card-complete"[^>]*>Complete as done</);
  assert.match(none, /data-testid="amux-legacy-card-recreate"/);
  assert.match(none, /data-testid="amux-legacy-card-close"/);
  // It is not a card no decision can ever open on, so it never says so.
  assert.doesNotMatch(none, /No review decision can open on this card/);
  // With a choice offered, both stay.
  const open = decision(card, controller({ selectedEscalationId: escalationId,
    review: reviewFor(escalationId) }), true, stopped);
  assert.match(open, /<kbd[^>]*>1<\/kbd>Approve/);
  assert.match(open, /data-testid="amux-legacy-card-complete"/);
  // A Task the server says cannot be done (archived, or no v22 receipt) has no completion button.
  const refused = decision(card, controller({ selectedEscalationId: escalationId,
    review: reviewFor(escalationId) }), true,
    { revision: 8, view: { ...stopped.view!, completeRefusal: "not_completable" } });
  assert.doesNotMatch(refused, /data-testid="amux-legacy-card-complete"/);
  // A legacy kind never completes.
  assert.doesNotMatch(decision(card, controller({ selectedEscalationId: escalationId,
    review: reviewFor(escalationId) }), true, preV22Legacy), /data-testid="amux-legacy-card-complete"/);
});

test("a no-PR card with no choice at all does not say it can be blocked", () => {
  const card = item({ status: "review" });
  const escalationId = card.escalationId!;
  const html = decision(card, controller({ selectedEscalationId: escalationId,
    review: reviewFor(escalationId, {
      task: { id: "task-1", title: "Tidy", status: "review", revision: 8, due_parse_state: "valid",
        review_pr_number: null },
      allowed_outcomes: [], proposed_transitions: {},
    }) }));
  assert.match(html, /no decision is open for this card right now/);
  assert.doesNotMatch(html, /You can block it/);
  assert.match(html, /No choice is open for this card yet/);
  assert.doesNotMatch(html, /data-testid="amux-legacy-card"/);
});

test("the legacy panel comes out of the card detail the review reads and keeps only a legacy view", async () => {
  assert.deepEqual(amuxLegacyCardReadOf("task 1", { id: "task 1", revision: 9, legacyCard: preV22Legacy.view }),
    preV22Legacy);
  // Another card's answer, a malformed view or no answer: no panel.
  assert.equal(amuxLegacyCardReadOf("task-1", { id: "task-2", revision: 9, legacyCard: preV22Legacy.view }), null);
  assert.deepEqual(amuxLegacyCardReadOf("task-1", { id: "task-1", revision: 9, legacyCard: null }),
    { revision: 9, view: null });
  assert.deepEqual(amuxLegacyCardReadOf("task-1", { id: "task-1", revision: 9,
    legacyCard: { kind: "something_else", closeRefusal: null, idea: { state: "refused", code: "x" } } }),
  { revision: 9, view: null });
  assert.equal(amuxLegacyCardReadOf("task-1", { error: "not_found" }), null);
  assert.equal(amuxLegacyCardReadOf("task-1", null), null);

  // One read serves both: the review's attempt metadata read hands the panel
  // on, whether or not the metadata itself could be bound to the review.
  const sent: string[] = [];
  const read = await readAmuxOwnerExecutionMetadata({
    review: reviewFor("esc-1"), controller: new AbortController(), isCurrent: () => true,
    fetcher: async (url) => {
      sent.push(String(url));
      return Response.json({ id: "task-1", revision: 8, attempts: [], legacyCard: preV22Legacy.view });
    },
  });
  assert.deepEqual(sent, ["/api/admin/amux/execution-view?view=detail&taskId=task-1"]);
  assert.deepEqual(read, { state: "unavailable", legacyCard: { revision: 8, view: preV22Legacy.view } });
});

// Owner decision 2026-11-10: a run whose CLI usage was never fully reported
// holds its worker; the queue says so and the owner may accept it as unknown,
// with the cost explicitly not treated as zero.
test("a run with unknown usage shows that it holds its worker, and only the owner gets the acceptance", () => {
  const card = items[3];
  const escalationId = card.escalationId!;
  const ctl = controller({ selectedEscalationId: escalationId, review: reviewFor(escalationId, {
    task: { id: "task-4", title: "Measure", status: "blocked", revision: 8, due_parse_state: "valid" },
    last_attempt: { id: "attempt-4", task_revision: 7, outcome: "blocked", to_status: "blocked",
      ended_at: "2026-11-09T08:18:00.000Z" },
    unknown_usage_attempts: [{ id: "attempt-4", worker: "codex-chore", started_at: "2026-11-09T08:18:00.000Z" }],
    allowed_outcomes: ["block"], proposed_transitions: { block: "blocked" },
  }) });
  const owner = decision(card, ctl);
  assert.match(owner, /data-testid="amux-owner-queue-unknown-usage"/);
  assert.match(owner, /codex-chore/);
  assert.match(owner, /takes no other Task until the usage is settled or accepted/);
  assert.match(owner, /data-testid="amux-attempt-usage-accept"[^>]*>Accept this run&#x27;s usage as unknown</);
  assert.match(owner, /The cost is not treated as zero/);
  const reader = decision(card, ctl, false);
  assert.match(reader, /data-testid="amux-owner-queue-unknown-usage"/);
  assert.doesNotMatch(reader, /data-testid="amux-attempt-usage-accept"/);
  // No unknown run, no panel.
  const settled = decision(card, controller({ selectedEscalationId: escalationId,
    review: reviewFor(escalationId, { unknown_usage_attempts: [] }) }));
  assert.doesNotMatch(settled, /data-testid="amux-owner-queue-unknown-usage"/);
});

// Operator, 2026-11-11: AMUX-FILEGEN-003 waited in review with an open T2 draft
// the owner could only judge again from Admin › Engineering › Decisions.
const engineeringDraft = (overrides: Partial<EngineeringAgentCardItemView> = {}): EngineeringAgentCardItemView => ({
  id: "item-draft", kind: "t2_draft", reason: "patch_unavailable", causeKey: "run:1",
  createdAt: "2026-11-11T01:00:00.000Z", patchBody: "diff --git a/lib/a.ts b/lib/a.ts\n",
  patchDigest: "d".repeat(64), baseSha: "b".repeat(40), rejudgeable: true,
  files: [{ path: "lib/a.ts", added: 1, removed: 1 }], fileCount: 1, ...overrides,
});
const reviewPrMismatch = engineeringDraft({
  id: "item-mismatch", kind: "state_mismatch", reason: "bound_review_pr_not_recorded", causeKey: "review_pr:publish-1",
  patchBody: null, patchDigest: null, baseSha: null, rejudgeable: false, files: [], fileCount: 0,
});

const withEngineering = (engineeringItems: EngineeringAgentCardItemView[], canWriteEngineering: boolean) =>
  renderToStaticMarkup(
    <AmuxOwnerQueueDecision item={item({ status: "review", engineeringItems })} controller={controller()}
      canInspectCards index={1} total={1} generatedAt="2026-11-08T03:00:00.000Z" navLocked={false} advance
      onAdvanceChange={() => {}} onPrevious={null} onNext={null} onAnswered={() => {}}
      canWriteEngineering={canWriteEngineering} onEngineeringChanged={() => {}} />);

test("a card's open T2 draft is decided on the card: approve, reject and judge again", () => {
  const html = withEngineering([engineeringDraft()], true);
  assert.match(html, /data-testid="amux-owner-queue-engineering"/);
  assert.match(html, /Engineering agent items on this card/);
  assert.match(html, /data-testid="amux-owner-queue-engineering-item" data-kind="t2_draft"/);
  assert.match(html, /data-testid="amux-owner-queue-engineering-approve"/);
  assert.match(html, /data-testid="amux-owner-queue-engineering-reject"/);
  assert.match(html, /data-testid="amux-owner-queue-engineering-rejudge"/);
  assert.match(html, /lib\/a\.ts/);
  assert.match(html, /href="\/admin\/engineering-agent\?tab=queue"/);
  // A draft the tier round cannot take again offers no rejudge.
  const kept = withEngineering([engineeringDraft({ rejudgeable: false })], true);
  assert.match(kept, /amux-owner-queue-engineering-approve/);
  assert.doesNotMatch(kept, /amux-owner-queue-engineering-rejudge/);
});

test("a review_pr mismatch records the pull request number on the card; other mismatches go to the console", () => {
  const html = withEngineering([reviewPrMismatch], true);
  assert.match(html, /data-kind="state_mismatch"/);
  assert.match(html, /data-testid="amux-owner-queue-engineering-record-pr"/);
  assert.match(html, /Record the pull request number on the card/);
  assert.doesNotMatch(html, /amux-owner-queue-engineering-approve/);
  const other = withEngineering([{ ...reviewPrMismatch, causeKey: "run:2" }], true);
  assert.doesNotMatch(other, /amux-owner-queue-engineering-record-pr/);
});

test("without engineering write access the items are read only, and a card without items shows none", () => {
  const html = withEngineering([engineeringDraft(), reviewPrMismatch], false);
  assert.match(html, /data-testid="amux-owner-queue-engineering"/);
  assert.match(html, /takes engineering agent write access/);
  assert.doesNotMatch(html, /<button[^>]*amux-owner-queue-engineering-/);
  assert.doesNotMatch(withEngineering([], true), /amux-owner-queue-engineering/);
  assert.deepEqual(amuxOwnerQueueEngineeringButtons(engineeringDraft(), false), []);
  assert.deepEqual(amuxOwnerQueueEngineeringButtons(engineeringDraft({ patchDigest: null }), true), []);
  assert.deepEqual(amuxOwnerQueueEngineeringButtons(engineeringDraft(), true), ["approve", "reject", "rejudge"]);
  assert.deepEqual(amuxOwnerQueueEngineeringButtons(reviewPrMismatch, true), ["record_pr"]);
});

test("the card's requests are the console's own, bound to the digest and base shown", () => {
  const draft = engineeringDraft();
  assert.deepEqual(engineeringAgentDecisionRequest(draft, "approved"), {
    url: "/api/admin/engineering-agent/decisions",
    body: { workItemId: "item-draft", decision: "approved", patchDigest: draft.patchDigest, baseSha: draft.baseSha },
  });
  assert.deepEqual(engineeringAgentRejudgeRequest(draft), {
    url: "/api/admin/engineering-agent/rejudge",
    body: { workItemId: "item-draft", patchDigest: draft.patchDigest, baseSha: draft.baseSha },
  });
  assert.equal(engineeringAgentRejudgeRequest({ ...draft, baseSha: null }), null);
  assert.deepEqual(engineeringAgentMismatchRequest("item-mismatch", "record_bound_review_pr"), {
    url: "/api/admin/engineering-agent/mismatches",
    body: { workItemId: "item-mismatch", action: "record_bound_review_pr" },
  });
});
