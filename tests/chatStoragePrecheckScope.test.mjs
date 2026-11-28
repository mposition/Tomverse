import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/*
  Review finding (B3, 2026-11-28): the early message-storage pre-check assumed
  every turn needs a new row, but a refused desktop Deep Research submission
  retries by updating its existing answer row. Deep Research turns, reattach
  POSTs and turns whose attempt peek failed leave the decision to the durable
  claim and the locked Message write.
*/
const route = readFileSync(new URL("../app/api/chat/route.ts", import.meta.url), "utf8");

test("the early storage pre-check skips Deep Research, reattach and unknown-attempt turns", () => {
  const definition = route.match(/const deepResearchTurn = ([^;]+);/);
  assert.ok(definition, "the route names a Deep Research turn before the pre-check");
  for (const part of ["DEEP_RESEARCH_MODEL_ID", "deepResearchDepth", "isResearchPreview"]) {
    assert.ok(definition[1].includes(part), `a Deep Research turn includes ${part}`);
  }
  const guard = route.match(/if \(([^\n]*)\) \{\s*try \{\s*await checkMessageCapacity\(/);
  assert.ok(guard, "the pre-check has one guard");
  for (const part of ["!attemptAlreadyBound", "!attemptPeekFailed", "!deepResearchTurn"]) {
    assert.ok(guard[1].includes(part), `the pre-check guard requires ${part}`);
  }
});
