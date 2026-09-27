import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AMUX_UNTRUSTED_REASON_MAX_BYTES,
  normalizeAmuxUntrustedReason,
  publicAmuxEscalationReasonCode,
  storedAmuxEscalationReasonCode,
} from "../lib/amux/escalation.ts";

test("worker reasons are deterministic, single-line, control-free, and byte bounded", () => {
  const input = `  cafe\u0301\tfirst\nsecond\u0007\u202e  ${"🚀".repeat(400)}`;
  const first = normalizeAmuxUntrustedReason(input);
  assert.equal(first, normalizeAmuxUntrustedReason(input));
  assert.ok(first.startsWith("café first second "));
  assert.doesNotMatch(first, /[\u0000-\u001f\u007f-\u009f]/u);
  assert.ok(Buffer.byteLength(first, "utf8") <= AMUX_UNTRUSTED_REASON_MAX_BYTES);
  assert.ok(first.endsWith("🚀"));
  assert.equal(normalizeAmuxUntrustedReason("  \u0007\t "), null);
  assert.equal(normalizeAmuxUntrustedReason("private\u0000payload"), null);
  assert.equal(normalizeAmuxUntrustedReason("invalid \ud800 surrogate"), null);
  assert.equal(normalizeAmuxUntrustedReason(`${"x".repeat(2_000)}\ud800`), null);
});

test("escalation creation stores only server reason codes and audits its opening", async () => {
  const source = await readFile(
    new URL("../lib/amux/escalation.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /reason: reasonCode/);
  assert.match(source, /openedTaskRevision: task\.revision/);
  assert.match(source, /amux\.human_escalation\.opened/);
  assert.doesNotMatch(source, /reason:\s*input\.reason/);
  assert.equal(storedAmuxEscalationReasonCode("secret\n".repeat(2_000), "execution-recovery"), "execution_blocked");
  assert.equal(storedAmuxEscalationReasonCode("secret", "planning-review"), "canonical_deadline_review_required");
  assert.equal(storedAmuxEscalationReasonCode("secret", "cost-operations"), "operational_cost_blocked");
  assert.equal(storedAmuxEscalationReasonCode("attempt_budget_exhausted", null), "attempt_budget_exhausted");
});

test("routing copy is fixed by task status, not persisted reason text", () => {
  assert.equal(publicAmuxEscalationReasonCode("review"), "human_review_required");
  assert.equal(publicAmuxEscalationReasonCode("blocked"), "task_blocked");
  assert.equal(publicAmuxEscalationReasonCode("doing"), "operator_review_required");
});

test("old reason rows and new worker text cannot cross the routing, storage, or retry prompt boundary", async () => {
  const execution = await readFile(
    new URL("../lib/amux/execution.ts", import.meta.url),
    "utf8",
  );
  const report = await readFile(
    new URL("../lib/amux/explainability.ts", import.meta.url),
    "utf8",
  );
  assert.match(execution, /select: \{ outcome: true, toStatus: true \}/);
  assert.doesNotMatch(execution, /previousAttempt\.reason|input\.reason\?\.trim\(\)|normalizeAmuxUntrustedReason\(input\.reason\)/);
  assert.match(execution, /Previous status: \$\{previousStatus\}/);
  assert.match(execution, /reason: budgetDestination\.exhausted_limit/);
  assert.doesNotMatch(execution, /reason:\s*input\.reason\?\.trim\(\)/);
  assert.match(report, /reason_code: publicAmuxEscalationReasonCode\(escalation\.task\.status\)/);
  assert.doesNotMatch(report, /\breason:\s*true\b/);
});
