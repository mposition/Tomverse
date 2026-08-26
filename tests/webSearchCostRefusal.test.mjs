import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  isWebSearchCostRefusal,
  WEB_SEARCH_COST_UNBOUNDED,
  webSearchCostRefusalError,
} from "../lib/webSearchCostRefusal.ts";
import { ChatAccessError } from "../lib/chatSecurity.ts";
import { classifyChatLimitCode } from "../lib/chatCostSafetyCore.ts";

// A refusal nobody can look up afterwards is a refusal that gets diagnosed by
// screenshot. `WEB_SEARCH_COST_UNBOUNDED` was in exactly that state: built
// inline at four sites, missing from the cost-safety log because its code is
// not a cost-safety code, and thrown before the call that writes
// `ChatLimitDecisionEvent` -- so a user's Trace ID resolved to nothing.

const ROOT = resolve(import.meta.dirname, "..");
const source = (relativePath) =>
  readFileSync(resolve(ROOT, relativePath), "utf8");

test("the refusal carries its reason as the scope, not in the sentence", () => {
  for (const reason of [
    "unbounded_search_queries",
    "unpriced_search_queries",
    "search_query_ceiling_breached",
  ]) {
    const error = webSearchCostRefusalError(reason);
    assert.equal(error.status, 503);
    assert.equal(error.code, WEB_SEARCH_COST_UNBOUNDED);
    assert.equal(error.details.scope, reason);
    // The three reasons are indistinguishable on screen on purpose: none of
    // them is something the reader can act on. They are told apart in the
    // record.
    assert.equal(
      error.message,
      "Web search is temporarily unavailable for this model."
    );
  }
});

test("the predicate recognises only this refusal", () => {
  assert.equal(
    isWebSearchCostRefusal(webSearchCostRefusalError("unbounded_search_queries")),
    true
  );
  assert.equal(
    isWebSearchCostRefusal(
      new ChatAccessError(503, "MODEL_WEB_SEARCH_UNAVAILABLE", "different")
    ),
    false
  );
  assert.equal(isWebSearchCostRefusal(new Error("not even a chat error")), false);
  assert.equal(isWebSearchCostRefusal(null), false);
  assert.equal(isWebSearchCostRefusal(undefined), false);
});

test("the recorded layer is whatever the shared classifier says", () => {
  // Deliberately not asserted to be `operational_guardrail`. Moving this code
  // into `CHAT_COST_SAFETY_CODES` would change what the UI tells people and
  // what the guardrail metrics count -- a product decision. What this pins is
  // that the row and the response cannot give two different answers, because
  // one function answers for both.
  assert.equal(classifyChatLimitCode(WEB_SEARCH_COST_UNBOUNDED), "other");
});

test("nothing builds this refusal by hand any more", () => {
  // Four sites used to construct it inline, which is how the status, the
  // sentence and the scope get to drift apart -- and how a fifth site gets
  // added that forgets the scope entirely.
  const builders = [
    "app/api/chat/route.ts",
    "app/api/chat/preflight/route.ts",
    "app/api/chat/availability/route.ts",
    "lib/chatAttemptExecution.ts",
  ];
  for (const path of builders) {
    const text = source(path);
    assert.equal(
      /new ChatAccessError\(\s*503,\s*"WEB_SEARCH_COST_UNBOUNDED"/.test(text),
      false,
      `${path}: build it with webSearchCostRefusalError()`
    );
    assert.ok(
      text.includes("webSearchCostRefusalError("),
      `${path}: expected the shared factory`
    );
  }
});

test("every route that can raise it also records it", () => {
  // The gap this file exists for. A route that raises the refusal and writes
  // no row leaves a Trace ID that resolves to nothing, which is what happened.
  for (const [path, phase] of [
    ["app/api/chat/route.ts", "chat_reservation"],
    ["app/api/chat/preflight/route.ts", "comparison_preflight"],
    ["app/api/chat/availability/route.ts", "availability_probe"],
  ]) {
    const text = source(path);
    assert.ok(
      text.includes("recordWebSearchCostRefusal("),
      `${path}: must record the refusal`
    );
    assert.ok(
      text.includes(`phase: "${phase}"`),
      `${path}: must record it under its own phase`
    );
  }
});

test("the fallback plan raises it as a value and records nothing", () => {
  // `planAttemptExecution` is pure and synchronous, and on a candidate this
  // refusal is "not this one" rather than a block -- the run carries on. The
  // primary path is what records, and recording here would enter one turn
  // twice.
  const text = source("lib/chatAttemptExecution.ts");
  assert.ok(text.includes("webSearchCostRefusalError("));
  assert.equal(text.includes("recordWebSearchCostRefusal("), false);
});

test("the record carries no request content", () => {
  // Model ids, a hashed subject, a fixed reason identifier and a tool name.
  // Never the prompt, and never anything the caller attached to the error
  // beyond the scope this module put there.
  const text = source("lib/webSearchCostRefusal.ts");
  for (const key of ["...error.details", "promptText", "messages"]) {
    assert.equal(text.includes(key), false, `${key} must not reach the record`);
  }
});
