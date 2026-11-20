import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  amuxV22PromotionBlockedByOperator,
  amuxV22PromotionBlockedNotice,
} from "../lib/amux/v22PromotionBlockedCore.ts";

const task = (displayKey, ...reasons) => ({ taskId: `id-${displayKey}`, displayKey, reasons });

test("a Task with every dependency done and no worker for its grade is named with its reason", () => {
  const notice = amuxV22PromotionBlockedNotice([
    task("AMUX-IMGOUT-003", "no_worker_for_grade"),
    task("AMUX-ARTFMT-003", "cost_reconfirmation_required", "no_worker_for_grade"),
  ]);
  assert.deepEqual(notice, {
    count: 2,
    reasons: { cost_reconfirmation_required: 1, no_worker_for_grade: 2 },
    tasks: "AMUX-ARTFMT-003: cost_reconfirmation_required+no_worker_for_grade; AMUX-IMGOUT-003: no_worker_for_grade",
  });
});

test("waiting on a dependency, a halt or another path is not the operator's to clear", () => {
  assert.equal(amuxV22PromotionBlockedNotice([
    task("AMUX-A-001", "dependency_incomplete"),
    task("AMUX-A-002", "dependency_unpublished", "no_worker_for_grade"),
    task("AMUX-A-003", "orchestrator_halted", "cost_unavailable"),
    task("AMUX-A-004", "already_assigned"),
    task("AMUX-A-005", "not_backlog", "worker_unavailable"),
  ]), null);
  assert.equal(amuxV22PromotionBlockedNotice([]), null);
});

test("every operator reason of the readiness check is reported; an unknown reason alone is not", () => {
  for (const reason of ["no_worker_for_grade", "worker_unavailable", "cost_reconfirmation_required",
    "cost_unavailable", "role_or_grade_missing", "brief_or_scope_missing", "source_approval_invalid",
    "dependency_set_changed", "parent_path_changed"]) {
    assert.equal(amuxV22PromotionBlockedByOperator([task("AMUX-B-001", reason)]).length, 1, reason);
  }
  assert.equal(amuxV22PromotionBlockedByOperator([task("AMUX-B-002", "a_reason_from_tomorrow")]).length, 0);
});

test("one notice names every Task, counts them all and falls back to the id", () => {
  const many = Array.from({ length: 12 }, (_, i) => task(`AMUX-C-${String(i).padStart(3, "0")}`, "worker_unavailable"));
  const notice = amuxV22PromotionBlockedNotice([...many, { taskId: "raw-id", displayKey: null, reasons: ["cost_unavailable"] }]);
  assert.equal(notice.count, 13);
  assert.equal(notice.tasks.split("; ").length, 13, "no Task is left unnamed (owner decision 2026-11-15)");
  assert.ok(amuxV22PromotionBlockedNotice([{ taskId: "raw-id", displayKey: null, reasons: ["cost_unavailable"] }])
    .tasks.startsWith("raw-id: "));
});

test("the tick keeps each refusal's reasons and reports only after nothing could move", () => {
  const source = readFileSync("lib/amux/v22AutoPromotionService.ts", "utf8");
  assert.match(source, /throw new AmuxV22TaskNotReadyError\(ready\.reasons\)/);
  assert.equal(/throw new BoardImportError\("task_not_ready"/.test(source), false);
  const tail = source.slice(source.indexOf("export async function tickV22AutoPromotion"));
  assert.match(tail, /notReady\.push\(\{ taskId: candidate\.taskId/);
  assert.ok(tail.indexOf("await reportPromotionBlocked(notReady)") < tail.indexOf('"no_ready_candidate"'));
  assert.match(source, /code: "AMUX_V22_PROMOTION_BLOCKED"/);
});
