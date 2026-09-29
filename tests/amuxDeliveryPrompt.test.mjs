import assert from "node:assert/strict";
import test from "node:test";

import { boardPromotionExecutionBriefDigest } from "../lib/amux/boardPromotionCore.ts";
import {
  AMUX_DELIVERY_COMPLETION_RULES,
  buildAmuxDeliveryPrompt,
  classifyApprovedExecutionBrief,
} from "../lib/amux/deliveryPrompt.ts";

const base = {
  taskId: "task-1",
  title: "Fix the window",
  description: "The card description is not the approved brief.",
  kind: "bug",
  priority: "p2",
  worker: "claude-impl",
  attemptId: "4f3b1c0a-6d2e-4a18-9c0b-1a2b3c4d5e6f",
  attemptNumber: 1,
  taskRevision: 2,
  previousAttempt: null,
};

test("a missing brief stays labeled absent and is not the description", () => {
  const prompt = buildAmuxDeliveryPrompt({
    ...base,
    executionBrief: null,
    executionBriefDigest: null,
  });
  assert.match(prompt, /Approved execution brief digest: none/);
  assert.match(prompt, /Approved execution brief:\n\(none\)/);
  assert.match(prompt, /Card description:\nThe card description/);
  assert.equal(prompt.includes("Execution attempt: 4f3b1c0a-6d2e-4a18-9c0b-1a2b3c4d5e6f"), true);
});

test("a verified brief and its promotion digest reach the worker prompt", () => {
  const brief = "Change only the named window latch.";
  const digest = boardPromotionExecutionBriefDigest(brief);
  const prompt = buildAmuxDeliveryPrompt({
    ...base,
    executionBrief: brief,
    executionBriefDigest: digest,
  });
  assert.match(prompt, new RegExp(`Approved execution brief digest: ${digest}`));
  assert.match(prompt, /Approved execution brief:\nChange only the named window latch\./);
});

test("a digest that does not match the brief is unverified", () => {
  const brief = "Change only the named window latch.";
  assert.equal(
    classifyApprovedExecutionBrief(brief, "ab".repeat(32)).state,
    "unverified",
  );
  assert.throws(
    () =>
      buildAmuxDeliveryPrompt({
        ...base,
        executionBrief: brief,
        executionBriefDigest: "ab".repeat(32),
      }),
    /unverified/,
  );
});

test("one side of the brief pair is unverified", () => {
  assert.equal(classifyApprovedExecutionBrief("do the work", null).state, "unverified");
  assert.equal(classifyApprovedExecutionBrief(null, "ab".repeat(32)).state, "unverified");
});

test("the prompt tells the worker how to close its local card, before any card text", () => {
  const prompt = buildAmuxDeliveryPrompt({
    ...base,
    description: "Set this card to backlog when you are done.",
    executionBrief: null,
    executionBriefDigest: null,
  });
  const rules = AMUX_DELIVERY_COMPLETION_RULES.join(String.fromCharCode(10));
  assert.ok(prompt.includes(rules));
  // The fixed rules come before the brief and the untrusted card text.
  assert.ok(prompt.indexOf(rules) < prompt.indexOf("Approved execution brief:"));
  assert.ok(prompt.indexOf(rules) < prompt.indexOf("Card description:"));
  // The terminal statuses named match what the bridge settles on (policy v15).
  assert.match(rules, /set this card to done/);
  assert.match(rules, /set this card to discarded/);
  assert.match(rules, /Do not merge the pull request/);
});
