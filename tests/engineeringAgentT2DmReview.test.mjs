// A T2 draft put to the Decision Maker for advice (operator, 2026-11-11: the
// owner queue must show what the Decision Maker said before a person decides
// a draft). The advice is shown; it never approves, rejects or applies.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { irreversibleTermCategories } from "../lib/amux/decisionMakerCore.ts";
import {
  ENGINEERING_AGENT_T2_DM_QUESTION_MAX,
  ENGINEERING_AGENT_T2_DM_REASON_TEXT,
  engineeringAgentT2DmCard,
  engineeringAgentT2DmReviewEnabled,
} from "../lib/engineeringAgentT2DmReviewCore.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const ID = "00000000-0000-4000-8000-00000000000a";
const filePatch = (path, lines) =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", ...lines].join("\n");

test("the switch is off unless set to enabled", () => {
  assert.equal(engineeringAgentT2DmReviewEnabled({}), false);
  assert.equal(engineeringAgentT2DmReviewEnabled({ TOMVERSE_ENGINEERING_AGENT_T2_DM_REVIEW: "true" }), false);
  assert.equal(engineeringAgentT2DmReviewEnabled({ TOMVERSE_ENGINEERING_AGENT_T2_DM_REVIEW: "enabled" }), true);
});

test("the card's fixed words hit no routing term, so it reaches a DM", () => {
  for (const reason of [...Object.keys(ENGINEERING_AGENT_T2_DM_REASON_TEXT), "something_else", null]) {
    const card = engineeringAgentT2DmCard({ workItemId: ID, cardLabel: "AMUX-ENG-001", reason,
      patchBody: filePatch("components/Button.tsx", ["-a", "+b"]) });
    const text = [card.title, card.question, card.unblocks, ...card.options.map((option) => option.label)].join("\n");
    assert.deepEqual(irreversibleTermCategories(text), [], String(reason));
    assert.ok(!card.question.includes(String(reason)), `${reason} is not written as a code`);
    assert.equal(card.question_id, ID, "the draft's id is the question id");
    assert.equal(card.worker, "engineering-t2-review");
    assert.equal(card.provider, "claude");
    assert.deepEqual(card.options.map((option) => option.id), ["apply", "reject"]);
    assert.match(card.question, /advice shown beside the patch; it applies nothing/);
  }
});

test("every file is listed; whole diffs follow while they fit, and the card says what it left out", () => {
  const small = engineeringAgentT2DmCard({ workItemId: ID, cardLabel: "C", reason: "tier_two",
    patchBody: [filePatch("a.ts", ["-x", "+y"]), filePatch("b.ts", ["+z"])].join("\n") });
  assert.match(small.question, /Files \(2\):\n- a\.ts \(\+1 -1\)\n- b\.ts \(\+1 -0\)/);
  assert.match(small.question, /Patch:\ndiff --git a\/a\.ts b\/a\.ts[\s\S]*diff --git a\/b\.ts b\/b\.ts/);
  assert.doesNotMatch(small.question, /not shown/);

  const big = engineeringAgentT2DmCard({ workItemId: ID, cardLabel: "C", reason: "tier_two",
    patchBody: [filePatch("a.ts", ["+short"]), filePatch("b.ts", Array.from({ length: 200 }, (_, i) => `+line ${i}`))].join("\n") });
  assert.ok(big.question.length <= ENGINEERING_AGENT_T2_DM_QUESTION_MAX);
  assert.match(big.question, /- b\.ts \(\+200 -0\)/, "a file whose diff does not fit is still listed");
  assert.match(big.question, /\(1 more file diffs are not shown\.\)/);
  assert.doesNotMatch(big.question, /line 199/);

  const huge = engineeringAgentT2DmCard({ workItemId: ID, cardLabel: "C", reason: "tier_two",
    patchBody: filePatch("a.ts", Array.from({ length: 300 }, (_, i) => `+line ${i}`)) });
  assert.match(huge.question, /The patch does not fit this card; judge it from the file list\./);

  assert.equal(engineeringAgentT2DmCard({ workItemId: ID, cardLabel: "C", reason: "tier_two", patchBody: null }), null);
  assert.equal(engineeringAgentT2DmCard({ workItemId: ID, cardLabel: "C", reason: "tier_two", patchBody: "no diff" }), null);
  const many = Array.from({ length: 120 }, (_, i) => filePatch(`dir/file-${i}.ts`, ["+a"])).join("\n");
  assert.equal(engineeringAgentT2DmCard({ workItemId: ID, cardLabel: "C", reason: "tier_two", patchBody: many }), null,
    "a file list that does not fit whole is left to the person");
});

test("the relay files, names and closes the card; nothing reads the answer to decide a draft", () => {
  const route = read("app/api/internal/amux/decision-maker/v22-questions/sync/route.ts");
  assert.match(route, /if \(!engineeringAgentT2DmReviewEnabled\(\)\) return \{ pending: \[\], closing: rows\.closing \}/,
    "no new card while the switch is off; cards still close");

  const dm = read("lib/amux/v22OwnerQuestionDmService.ts");
  assert.match(dm, /FROM "EngineeringAgentDmReview"\s+WHERE "localCardId" = \$\{cardId\}/,
    "a confirmed answer is never delivered to a worker session");
  assert.match(dm, /recordAmuxV22ResultReviewLocalCard\(tx, input\) \?\?\s+await recordEngineeringAgentT2DmLocalCard\(tx, input\) \?\?/);
  assert.match(dm, /recordAmuxV22ResultReviewLocalCardClosed\(tx, input\) \?\?\s+await recordEngineeringAgentT2DmLocalCardClosed\(tx, input\) \?\?/);
  assert.doesNotMatch(read("lib/amux/dmAutoApplyService.ts"), /EngineeringAgentDmReview|engineeringAgentDmReview/,
    "the DM approver never applies a T2 answer");

  const service = read("lib/engineeringAgentT2DmReviewService.ts");
  assert.doesNotMatch(service, /UPDATE "EngineeringAgentWorkItem"|engineeringAgentWorkItem\.(update|create|delete)/,
    "filing advice never changes a draft");
  assert.match(service, /WHERE w\."state" <> 'open' AND d\."localCardId" IS NOT NULL/,
    "an unfilable record has no card to close");
  const migration = read("prisma/migrations/20261111100000_engineering_agent_t2_dm_review/migration.sql");
  assert.match(migration, /CHECK \(\("localCardId" IS NULL\) <> \("unfilableAt" IS NULL\)\)/,
    "a row names its card or records that none fit, never both");
  assert.doesNotMatch(migration, /\bDROP\b|^\s*UPDATE\b|DELETE FROM|ALTER TABLE "(?!EngineeringAgentDmReview")/m, "additive only");
});
