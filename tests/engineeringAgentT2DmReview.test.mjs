// A T2 draft put to the Decision Maker for advice (operator, 2026-11-11: the
// owner queue must show what the Decision Maker said before a person decides
// a draft). The advice is shown; it never approves, rejects or applies.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { irreversibleTermCategories } from "../lib/amux/decisionMakerCore.ts";
import { dmWorkspaceCardPointer } from "../lib/amux/decisionMakerWorkspaceCore.ts";
import {
  ENGINEERING_AGENT_T2_DM_REASON_TEXT,
  engineeringAgentT2DmCard,
  engineeringAgentT2DmReviewEnabled,
  patchContextPaths,
} from "../lib/engineeringAgentT2DmReviewCore.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const ID = "00000000-0000-4000-8000-00000000000a";
const filePatch = (path, lines) =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", ...lines].join("\n");

test("the switch is on unless set to disabled", () => {
  // Owner decision 2026-11-15: the switches that make the Decision Maker work default on.
  assert.equal(engineeringAgentT2DmReviewEnabled({}), true);
  assert.equal(engineeringAgentT2DmReviewEnabled({ TOMVERSE_ENGINEERING_AGENT_T2_DM_REVIEW: undefined }), true);
  assert.equal(engineeringAgentT2DmReviewEnabled({ TOMVERSE_ENGINEERING_AGENT_T2_DM_REVIEW: "enabled" }), true);
  assert.equal(engineeringAgentT2DmReviewEnabled({ TOMVERSE_ENGINEERING_AGENT_T2_DM_REVIEW: "disabled" }), false);
  assert.equal(engineeringAgentT2DmReviewEnabled({ TOMVERSE_ENGINEERING_AGENT_T2_DM_REVIEW: " disabled " }), false);
  assert.equal(engineeringAgentT2DmReviewEnabled({ TOMVERSE_ENGINEERING_AGENT_T2_DM_REVIEW: "false" }), true);
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

test("every file is listed in the question and the patch is in the workspace: the context only points at it", () => {
  const patchBody = [filePatch("a.ts", ["-x", "+y"]), filePatch("b.ts", ["+z"])].join("\n");
  const card = engineeringAgentT2DmCard({ workItemId: ID, cardLabel: "C", reason: "tier_two", patchBody, workspace: true });
  assert.match(card.question, /Files \(2\):\n- a\.ts \(\+1 -1\)\n- b\.ts \(\+1 -0\)/);
  assert.doesNotMatch(card.question, /diff --git/);
  assert.equal(card.context, dmWorkspaceCardPointer(["PATCH.diff"]), "the context is the workspace pointer to evidence/PATCH.diff");
  assert.match(card.context, /evidence\/PATCH\.diff is the whole patch/);
  assert.doesNotMatch(card.context, /diff --git|\[evidence\]/, "no patch text rides in the card with a workspace");
  assert.deepEqual(card.context_paths, ["a.ts", "b.ts"], "the patch's paths are the card's context paths");
});

test("with the workspace switched off the whole patch rides in the context, never cut, and the card is still filed", () => {
  const small = engineeringAgentT2DmCard({ workItemId: ID, cardLabel: "C", reason: "tier_two",
    patchBody: [filePatch("a.ts", ["-x", "+y"]), filePatch("b.ts", ["+z"])].join("\n"), workspace: false });
  assert.match(small.context, /^\[evidence\]\nThe patch:\ndiff --git a\/a\.ts b\/a\.ts[\s\S]*diff --git a\/b\.ts b\/b\.ts[\s\S]*\[\/evidence\]$/);
  assert.doesNotMatch(small.context, /not shown|does not fit/);
  assert.doesNotMatch(small.question, /diff --git/);

  // No size the old card had (a 2,000-character question, a 6,000-character patch context) applies:
  // 800 lines and the last one are whole in the context.
  const huge = engineeringAgentT2DmCard({ workItemId: ID, cardLabel: "C", reason: "tier_two",
    patchBody: filePatch("a.ts", Array.from({ length: 800 }, (_, i) => `+line ${i}`)), workspace: false });
  assert.match(huge.context, /\+line 799\n\[\/evidence\]$/);
  assert.doesNotMatch(huge.context, /not shown|does not fit/);
  assert.match(huge.question, /- a\.ts \(\+800 -0\)/);

  // Many files: the list is whole, the card is filed, the paths are all there. Nothing is left to the person.
  const many = Array.from({ length: 120 }, (_, i) => filePatch(`dir/file-${i}.ts`, ["+a"])).join("\n");
  for (const workspace of [true, false]) {
    const card = engineeringAgentT2DmCard({ workItemId: ID, cardLabel: "C", reason: "tier_two", patchBody: many, workspace });
    assert.notEqual(card, null, `workspace ${workspace}`);
    assert.match(card.question, /Files \(120\):/);
    assert.match(card.question, /- dir\/file-119\.ts \(\+1 -0\)/);
    assert.equal(card.context_paths.length, 120, "no context path count cap");
  }

  // The title is not cut either.
  const label = "AMUX-ENG-" + "9".repeat(200);
  assert.equal(engineeringAgentT2DmCard({ workItemId: ID, cardLabel: label, reason: "tier_two", patchBody: many }).title, `Patch review: ${label}`);

  // Evidence a card cannot carry whole files no card: the person decides (a DM never judges without it).
  const control = engineeringAgentT2DmCard({ workItemId: ID, cardLabel: "C", reason: "tier_two",
    patchBody: filePatch("a.ts", ["+bell\u0007"]), workspace: false });
  assert.equal(control, null);
  const tooBig = engineeringAgentT2DmCard({ workItemId: ID, cardLabel: "C", reason: "tier_two",
    patchBody: filePatch("a.ts", [`+${"x".repeat(300_000)}`]), workspace: false });
  assert.equal(tooBig, null);

  assert.equal(engineeringAgentT2DmCard({ workItemId: ID, cardLabel: "C", reason: "tier_two", patchBody: null }), null);
  assert.equal(engineeringAgentT2DmCard({ workItemId: ID, cardLabel: "C", reason: "tier_two", patchBody: "no diff" }), null);
});

test("the workspace switch decides the context when the card does not say", () => {
  const patchBody = filePatch("a.ts", ["+x"]);
  const before = process.env.TOMVERSE_AMUX_DM_WORKSPACE;
  try {
    delete process.env.TOMVERSE_AMUX_DM_WORKSPACE;
    assert.equal(engineeringAgentT2DmCard({ workItemId: ID, cardLabel: "C", reason: "tier_two", patchBody }).context, dmWorkspaceCardPointer(["PATCH.diff"]));
    process.env.TOMVERSE_AMUX_DM_WORKSPACE = "disabled";
    assert.match(engineeringAgentT2DmCard({ workItemId: ID, cardLabel: "C", reason: "tier_two", patchBody }).context, /^\[evidence\]\nThe patch:\n/);
  } finally {
    if (before === undefined) delete process.env.TOMVERSE_AMUX_DM_WORKSPACE;
    else process.env.TOMVERSE_AMUX_DM_WORKSPACE = before;
  }
});

test("patchContextPaths: the patch's files once each, and only paths a card may carry", () => {
  assert.deepEqual(patchContextPaths([filePatch("a.ts", ["+1"]), filePatch("lib/b.ts", ["+2"]), filePatch("a.ts", ["+3"])].join("\n")), ["a.ts", "lib/b.ts"]);
  assert.deepEqual(patchContextPaths([filePatch("../escape.ts", ["+1"]), filePatch("ok/c.ts", ["+2"]), filePatch("a%2e.ts", ["+3"])].join("\n")), ["ok/c.ts"]);
  assert.deepEqual(patchContextPaths("no diff"), []);
  // No count cap (the card's old 32 and 64 paths are gone).
  const many = Array.from({ length: 200 }, (_, i) => filePatch(`dir/f${i}.ts`, ["+a"])).join("\n");
  assert.equal(patchContextPaths(many).length, 200);
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
