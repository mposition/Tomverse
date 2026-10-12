import { expect, test } from "./support/console";

import type { AmuxReviewDetail } from
  "@/components/admin/AdminAmuxRoutingPanel";

const ESCALATION_ID = "clownerreview12345678901234";

const routingReport = {
  generated_at: "2026-10-12T00:00:00.000Z",
  limits: { decisions: 10, attempts: 10 },
  incident: {
    valid: true,
    blocks_admission: false,
    state: {
      state: "normal",
      reason: "synthetic owner review fixture",
      ticket: "e2e-owner-review",
      changed_at: "2026-10-12T00:00:00.000Z",
    },
  },
  queue: { review: 1 },
  policies: [],
  escalations_total: 1,
  escalations_limit: 25,
  escalations: [{
    id: ESCALATION_ID,
    specialty: "execution-recovery",
    reason_code: "operator_review_required",
    status: "open",
    createdAt: "2026-10-12T00:00:00.000Z",
    task: {
      id: "owner-review-task",
      title: "Build the owner review report",
      sourceKey: "AMUX-OWNER-REVIEW-E2E",
      priority: "high",
      status: "review",
    },
  }],
  workers: [],
  decisions: [],
};

const baseReview = (): AmuxReviewDetail => ({
  available: true,
  escalation: {
    id: ESCALATION_ID,
    status: "open",
    specialty: "execution-recovery",
    reason_code: "operator_review_required",
    created_at: "2026-10-12T00:00:00.000Z",
  },
  task: {
    id: "owner-review-task",
    title: "Build the owner review report",
    status: "review",
    revision: 8,
    due_parse_state: "valid",
  },
  last_attempt: {
    id: "owner-review-attempt-8",
    task_revision: 7,
    outcome: "succeeded",
    to_status: "review",
    ended_at: "2026-10-12T01:00:00.000Z",
  },
  review_content: {
    text: "Task ID: owner-review-task\nRevision: 8",
    digest: "a".repeat(64),
    truncated: false,
    display_mismatch: false,
  },
  review_context: {
    title: "Build the owner review report",
    description: "Scope and completion criteria:\nShow the evidence and decision effects.",
    result_sha256: "b".repeat(64),
    escalation_reason: "Owner review required",
    last_attempt_reason: "reported_result",
    previous_block_reason: null,
  },
  review_report: {
    scope_and_completion_criteria:
      "Show the original assignment, the actual worker report, and each allowed decision effect.",
    approved_execution_brief:
      "Preserve server authority and do not invent a new Decision Maker question contract.",
    worker_report:
      "Implemented the responsive owner review and verified the digest-bound evidence projection.",
    worker_report_verified: true,
  },
  review_artifact: null,
  allowed_outcomes: ["approve", "block"],
  retry: { used: 1, limit: 5, remaining: 4 },
  proposed_transitions: { approve: "done", block: "blocked" },
});

const ownerExecution = (review: AmuxReviewDetail) => ({
  id: review.task.id,
  revision: review.task.revision,
  attempts: [{
    id: review.last_attempt?.id,
    taskRevision: review.last_attempt?.task_revision,
    worker: "worker-openai",
    attemptNumber: 1,
    reservedCostMicrousd: "2500000",
    settledCostMicrousd: "1250000",
    costConfirmed: true,
  }],
  result: {
    state: "available",
    attemptId: review.last_attempt?.id,
    sha256: review.review_context.result_sha256,
  },
});

test("owner review renders verified, legacy and unknown evidence honestly at 390px and 320px", async ({
  page,
  signInAs,
}) => {
  let currentReview = baseReview();
  let currentOwnerExecution: unknown = ownerExecution(currentReview);

  await page.route("**/api/admin/amux/routing", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(routingReport),
  }));
  await page.route("**/api/admin/amux/escalations/review?**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(currentReview),
  }));
  await page.route("**/api/admin/amux/execution-view?**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(currentOwnerExecution),
  }));

  await signInAs("owner");

  const open = async (width: 390 | 320) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/admin/amux-execution?tab=assignment");
    await page.getByRole("button", { name: "Open protected review" }).click();
    await expect(page.getByTestId("admin-amux-owner-review")).toBeVisible();
    expect(await page.evaluate(() =>
      document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  };

  await open(390);
  await expect(page.getByTestId("admin-amux-assigned-work")).toContainText(
    "Show the original assignment",
  );
  await expect(page.getByTestId("admin-amux-worker-report")).toContainText(
    "Implemented the responsive owner review",
  );
  await expect(page.getByTestId("admin-amux-owner-decision")).toContainText(
    "Does the submitted result satisfy the assigned scope and completion criteria?",
  );
  await expect(page.getByTestId("admin-amux-cost-summary")).toContainText(
    "Reserved maximum",
  );
  await expect(page.getByTestId("admin-amux-cost-summary")).toContainText(
    "Recorded settled cost",
  );
  await page.screenshot({
    path: "test-results-admin/amux-owner-review-verified-390.png",
    fullPage: true,
  });

  currentReview = {
    ...baseReview(),
    review_report: null,
    review_context: {
      ...baseReview().review_context,
      result_sha256: null,
      last_attempt_reason: "local_card_done",
    },
    allowed_outcomes: ["block"],
    proposed_transitions: { block: "blocked" },
  };
  currentOwnerExecution = { error: "not connected" };
  await open(390);
  await expect(page.getByTestId("admin-amux-report-not-connected")).toContainText(
    "may have existed elsewhere",
  );
  await expect(page.getByTestId("admin-amux-worker-report")).toContainText(
    "succeeded terminal outcome",
  );
  await expect(page.getByTestId("admin-amux-technical-recovery")).toContainText(
    "flag is not the worker report",
  );
  await expect(page.getByTestId("admin-amux-missing-evidence")).toContainText(
    "verified previous-execution outcome",
  );
  await expect(page.getByTestId("admin-amux-owner-decision")).toHaveCount(0);

  currentReview = {
    ...baseReview(),
    task: { ...baseReview().task, status: "blocked", title: "Terminal block without output" },
    last_attempt: {
      ...baseReview().last_attempt!,
      outcome: "blocked",
      to_status: "blocked",
    },
    review_context: {
      ...baseReview().review_context,
      result_sha256: null,
      last_attempt_reason: "reported_result",
    },
    review_report: null,
    allowed_outcomes: ["block"],
    proposed_transitions: { block: "blocked" },
  };
  currentOwnerExecution = { error: "not connected" };
  await open(390);
  await expect(page.getByTestId("admin-amux-owner-decision")).toBeVisible();
  await expect(page.getByTestId("admin-amux-select-block")).toBeVisible();
  await expect(page.getByTestId("admin-amux-select-retry")).toHaveCount(0);
  await expect(page.getByTestId("admin-amux-block-without-result")).toContainText(
    "blocked → blocked",
  );
  await expect(page.getByTestId("admin-amux-block-without-result")).toContainText(
    "does not prove that a host process stopped",
  );

  currentReview = {
    ...baseReview(),
    task: { ...baseReview().task, status: "blocked", title: "Legacy closed card" },
    last_attempt: {
      ...baseReview().last_attempt!,
      outcome: "blocked",
      to_status: "blocked",
    },
    review_context: {
      ...baseReview().review_context,
      description: null,
      result_sha256: null,
      last_attempt_reason: "local_card_closed",
    },
    review_report: null,
    allowed_outcomes: ["retry", "block"],
    proposed_transitions: { retry: "todo", block: "blocked" },
  };
  await open(320);
  await expect(page.getByTestId("admin-amux-technical-recovery")).toBeVisible();
  await expect(page.getByTestId("admin-amux-technical-recovery")).toContainText(
    "does not show whether the work succeeded, failed or was cancelled",
  );
  await expect(page.getByTestId("admin-amux-owner-decision")).toHaveCount(0);
  await expect(page.getByTestId("admin-amux-select-retry")).toHaveCount(0);
  await page.screenshot({
    path: "test-results-admin/amux-owner-review-legacy-closed-320.png",
    fullPage: true,
  });

  currentReview = {
    ...baseReview(),
    task: { ...baseReview().task, status: "blocked", title: "Evidence-bound retry" },
    last_attempt: {
      ...baseReview().last_attempt!,
      outcome: "blocked",
      to_status: "blocked",
    },
    review_context: {
      ...baseReview().review_context,
      last_attempt_reason: "reported_result",
    },
    allowed_outcomes: ["retry", "block"],
    proposed_transitions: { retry: "todo", block: "blocked" },
  };
  currentOwnerExecution = ownerExecution(currentReview);
  await open(390);
  await expect(page.getByTestId("admin-amux-retry-preview")).toContainText(
    "Show the original assignment",
  );
  await expect(page.getByTestId("admin-amux-retry-preview")).toContainText(
    "US$2.5",
  );
  await expect(page.getByTestId("admin-amux-retry-preview")).toContainText(
    "No new amount is reserved or validated",
  );
  await page.getByTestId("admin-amux-select-retry").click();
  await page.getByTestId("admin-amux-resolution").fill("Retry only the exact bound scope.");
  await expect(page.getByTestId("admin-amux-prepare-proposal")).toBeDisabled();
  await page.getByTestId("admin-amux-retry-read-confirmation").check();
  await expect(page.getByTestId("admin-amux-prepare-proposal")).toBeEnabled();

  currentReview = {
    ...baseReview(),
    task: { ...baseReview().task, status: "blocked", title: "Unknown v4 execution" },
    last_attempt: {
      ...baseReview().last_attempt!,
      outcome: "expired",
      to_status: "blocked",
    },
    review_context: {
      ...baseReview().review_context,
      result_sha256: null,
      last_attempt_reason: "usage_outcome_unknown",
    },
    review_report: {
      ...baseReview().review_report!,
      worker_report: null,
      worker_report_verified: false,
    },
    allowed_outcomes: ["retry", "block"],
    proposed_transitions: { retry: "todo", block: "blocked" },
  };
  await open(320);
  await expect(page.getByTestId("admin-amux-technical-recovery")).toContainText(
    "missing report is not proof that the work did not run",
  );
  await expect(page.getByTestId("admin-amux-select-retry")).toHaveCount(0);
  await expect(page.getByTestId("admin-amux-select-block")).toHaveCount(0);
  const reread = page.getByTestId("admin-amux-owner-reread");
  await expect(reread).toBeVisible();
  expect((await reread.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({
    path: "test-results-admin/amux-owner-review-unknown-320.png",
    fullPage: true,
  });
});
