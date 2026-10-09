import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  classifyExistingInitialPlan, classifyInitialPlanPost, classifyInitialPlanReadback,
  clearPendingInitialPlan, readPendingInitialPlan, reservePendingInitialPlan,
} from "../lib/amux/ideaInitialPlanUiCore.ts";

const ideaId = "cbf3723d-5be5-432e-bddd-d3b70fa6d401";
const revisionId = "a1e5bfda-d556-4e5b-bfa8-4172753f9844";
const owner = "synthetic-owner";
const entries = new Map();
const store = {
  getItem: (key) => entries.get(key) ?? null,
  setItem: (key, value) => { entries.set(key, value); },
  removeItem: (key) => { entries.delete(key); },
};

test("one opaque idea receipt survives ambiguity and cannot be replaced", () => {
  entries.clear();
  assert.deepEqual(readPendingInitialPlan(store, owner), { kind: "none" });
  assert.equal(reservePendingInitialPlan(store, owner, ideaId), true);
  assert.equal(reservePendingInitialPlan(store, owner, revisionId), false);
  assert.deepEqual(readPendingInitialPlan(store, owner), { kind: "pending", ideaId });
  clearPendingInitialPlan(store, owner, revisionId);
  assert.deepEqual(readPendingInitialPlan(store, owner), { kind: "pending", ideaId });
  clearPendingInitialPlan(store, owner, ideaId);
  assert.deepEqual(readPendingInitialPlan(store, owner), { kind: "none" });
});

test("unavailable or corrupt browser storage fails closed", () => {
  assert.deepEqual(readPendingInitialPlan(null, owner), { kind: "unavailable" });
  assert.equal(reservePendingInitialPlan(null, owner, ideaId), false);
  entries.set(`amux-v4-initial-plan-unresolved:${owner}`, "corrupt");
  assert.deepEqual(readPendingInitialPlan(store, owner), { kind: "unavailable" });
  entries.clear();
});

test("only the exact successful POST is final; ambiguous replies need read-back", () => {
  assert.deepEqual(classifyInitialPlanPost({ status: 201, body: {
    ideaId, revisionId, status: "committed", transferAuthorized: false,
  } }, ideaId), { kind: "committed", revisionId });
  for (const body of [
    { ideaId, revisionId, status: "committed", transferAuthorized: true },
    { ideaId: revisionId, revisionId, status: "committed", transferAuthorized: false },
    { ideaId, revisionId: "bad", status: "committed", transferAuthorized: false },
  ]) assert.deepEqual(classifyInitialPlanPost({ status: 201, body }, ideaId), { kind: "verify" });
  assert.deepEqual(classifyInitialPlanPost({ status: 409, body: { error: "not_ready" } }, ideaId),
    { kind: "verify" });
  assert.deepEqual(classifyInitialPlanPost({ status: 409, body: {
    error: "external_scope_required" } }, ideaId),
  { kind: "refused", code: "external_scope_required" });
});

test("absent, partial, malformed and failed read-back never invite retry", () => {
  assert.deepEqual(classifyInitialPlanReadback({ status: 200,
    body: { ideaId, status: "committed", revisionId } }, ideaId),
  { kind: "committed", revisionId });
  for (const body of [
    { ideaId, status: "absent" }, { ideaId, status: "partial" },
    { ideaId: revisionId, status: "committed", revisionId },
    { ideaId, status: "committed", revisionId: "bad" },
  ]) assert.deepEqual(classifyInitialPlanReadback({ status: 200, body }, ideaId),
    { kind: "outcome_unknown" });
});

test("a clean load shows an existing plan without another POST", () => {
  assert.deepEqual(classifyExistingInitialPlan({ status: 200,
    body: { ideaId, status: "committed", revisionId } }, ideaId),
  { kind: "committed", revisionId });
  assert.deepEqual(classifyExistingInitialPlan({ status: 200,
    body: { ideaId, status: "absent" } }, ideaId), { kind: "absent" });
  for (const body of [
    { ideaId, status: "partial" },
    { ideaId, status: "absent", revisionId },
    { ideaId: revisionId, status: "absent" },
  ]) assert.deepEqual(classifyExistingInitialPlan({ status: 200, body }, ideaId),
    { kind: "outcome_unknown" });
});

test("Admin UI calls plan only for a saved idea with no external sources", () => {
  const panel = readFileSync(new URL("../components/admin/AmuxIdeaInputPanel.tsx", import.meta.url), "utf8");
  const plan = readFileSync(new URL("../components/admin/AmuxInitialPlanPanel.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("../app/(site)/(application)/admin/amux-backlog/page.tsx", import.meta.url), "utf8");
  assert.match(panel, /ideaId=\{submission\.kind === "submitted" \? submission\.ideaId : null\}/);
  assert.match(panel, /declaredExternalSources=\{submission\.kind === "submitted" && submission\.hasExternalSources\}/);
  assert.match(plan, /!ideaId \|\| !available \|\| declaredExternalSources/);
  assert.match(plan, /reservePendingInitialPlan\(receiptStore\(\), operatorId, ideaId\)/);
  assert.match(plan, /classifyExistingInitialPlan/);
  assert.match(plan, /checkedIdeaId !== ideaId/);
  assert.match(plan, /await readBack\(ideaId\)/);
  assert.match(page, /initialPlanWritePermitted\(process\.env\[AMUX_V4_INITIAL_PLAN_WRITE_ENV\]\)/);
  assert.match(page, /initialPlanReadbackPermitted\(process\.env\[AMUX_V4_INITIAL_PLAN_READBACK_ENV\]\)/);
});
