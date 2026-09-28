import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AMUX_REVIEW_PR_NUMBER_MAX,
  amuxHumanReviewRequired,
  amuxReviewPrNumberAccepted,
} from "../lib/amux/humanReviewCore.ts";

test("a promoted card or one that asks for review requires a human review", () => {
  assert.equal(amuxHumanReviewRequired({ requiresHumanReview: false, executionBriefDigest: "a".repeat(64) }), true);
  assert.equal(amuxHumanReviewRequired({ requiresHumanReview: true, executionBriefDigest: null }), true);
  assert.equal(amuxHumanReviewRequired({ requiresHumanReview: false, executionBriefDigest: null }), false);
});

test("a review PR number is accepted only with succeeded to review", () => {
  assert.equal(amuxReviewPrNumberAccepted({ outcome: "succeeded", toStatus: "review", reviewPrNumber: 1733 }), true);
  assert.equal(amuxReviewPrNumberAccepted({ outcome: "failed", toStatus: "todo", reviewPrNumber: null }), true);
  assert.equal(amuxReviewPrNumberAccepted({ outcome: "blocked", toStatus: "blocked", reviewPrNumber: undefined }), true);
  for (const [outcome, toStatus] of [["succeeded", "done"], ["failed", "todo"], ["blocked", "blocked"]]) {
    assert.equal(amuxReviewPrNumberAccepted({ outcome, toStatus, reviewPrNumber: 5 }), false, `${outcome} -> ${toStatus}`);
  }
  for (const bad of [0, -1, 1.5, AMUX_REVIEW_PR_NUMBER_MAX + 1, Number.NaN]) {
    assert.equal(amuxReviewPrNumberAccepted({ outcome: "succeeded", toStatus: "review", reviewPrNumber: bad }), false, String(bad));
  }
});

test("settle uses the shared predicate for both done-to-review and the escalation", async () => {
  const execution = await readFile(new URL("../lib/amux/execution.ts", import.meta.url), "utf8");
  const settle = execution.slice(
    execution.indexOf("export async function settleAmuxExecution"),
    execution.indexOf("export async function reclaimExpiredAmuxExecutions"),
  );
  assert.match(settle, /const humanReviewRequired = amuxHumanReviewRequired\(task\);/);
  assert.match(settle, /budgetDestination\.to_status === "done" && humanReviewRequired/);
  assert.match(settle, /effectiveToStatus === "review" && humanReviewRequired/);
  assert.doesNotMatch(settle, /&& task\.requiresHumanReview/);
  assert.match(settle, /effectiveToStatus === "review" \? \(input\.reviewPrNumber \?\? null\) : null/);

  const route = await readFile(new URL("../app/api/internal/amux/execution/settle/route.ts", import.meta.url), "utf8");
  assert.match(route, /review_pr_number: z/);
  assert.match(route, /\.refine\(/);
  assert.match(route, /reviewPrNumber: body\.review_pr_number \?\? null/);
});
