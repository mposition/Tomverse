import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  AmuxOwnerReviewController,
  AmuxReviewDetail,
} from "@/components/admin/AdminAmuxRoutingPanel";
import { AmuxOwnerQueueDecision } from "@/components/admin/AmuxOwnerQueueDecision";
import { AmuxOwnerQueueView, isAmuxOwnerQueueRead } from "@/components/admin/AmuxOwnerQueueScreen";
import type { AmuxOwnerQueueItem, AmuxOwnerQueueRead } from "@/lib/amux/ownerQueueCore";

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
  setSelectedOutcome: () => {}, retryReadConfirmed: false, setRetryReadConfirmed: () => {}, resolution: "",
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

const decision = (card: AmuxOwnerQueueItem, ctl: AmuxOwnerReviewController, canInspectCards = true) =>
  renderToStaticMarkup(
    <AmuxOwnerQueueDecision item={card} controller={ctl} canInspectCards={canInspectCards} index={1} total={4}
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
