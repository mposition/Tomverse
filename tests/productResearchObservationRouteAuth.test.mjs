// Who may reach the submission route, and what an answer may carry.
//
// Two gates in a fixed order. The app switch decides whether the path exists
// at all, so a caller with the wrong secret cannot learn that this agent is
// deployed here; the secret then decides who may write a row.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  PRODUCT_RESEARCH_INGEST_SECRET_ENV,
  PRODUCT_RESEARCH_SWITCH_ENV,
  isProductResearchRouteAuthorized,
  isProductResearchRouteEnabled,
  productResearchJson,
  productResearchNotFound,
  productResearchUnauthorized,
} from "../lib/productResearchObservationRouteAuth.ts";

const SECRET = "s".repeat(40);
const env = { [PRODUCT_RESEARCH_INGEST_SECRET_ENV]: SECRET };

const call = (authorization) =>
  new Request("https://tomverse.test/api/internal/product-research/observations", {
    method: "POST",
    headers: authorization === undefined ? {} : { authorization },
  });

test("the switch is unset by default and is the only thing that opens the route", () => {
  assert.equal(isProductResearchRouteEnabled({}), false);
  assert.equal(isProductResearchRouteEnabled({ [PRODUCT_RESEARCH_SWITCH_ENV]: "" }), false);
  assert.equal(isProductResearchRouteEnabled({ [PRODUCT_RESEARCH_SWITCH_ENV]: "true" }), true);
  // Any value is on. The switch says whether an operator set it, not what they
  // meant by the word -- a variable set to `false` that silently meant off
  // would be a switch nobody could read.
  assert.equal(isProductResearchRouteEnabled({ [PRODUCT_RESEARCH_SWITCH_ENV]: "false" }), true);
});

test("the correct secret authorises and everything else does not", () => {
  assert.equal(isProductResearchRouteAuthorized(call(`Bearer ${SECRET}`), env), true);

  for (const [label, header] of [
    ["no header", undefined],
    ["empty", ""],
    ["no scheme", SECRET],
    ["wrong scheme", `Basic ${SECRET}`],
    ["lowercase scheme", `bearer ${SECRET}`],
    ["empty token", "Bearer "],
    ["wrong secret", `Bearer ${"x".repeat(40)}`],
    ["a prefix of the secret", `Bearer ${SECRET.slice(0, 39)}`],
    ["the secret with something after it", `Bearer ${SECRET}x`],
  ]) {
    assert.equal(isProductResearchRouteAuthorized(call(header), env), false, label);
  }
});

test("a secret too short to be one authorises nothing, including itself", () => {
  // The caller would otherwise be authenticated by a value an operator could
  // have typed, and a short secret is the most likely way for one to exist.
  for (const short of ["", "s", "s".repeat(31)]) {
    const weak = { [PRODUCT_RESEARCH_INGEST_SECRET_ENV]: short };
    assert.equal(isProductResearchRouteAuthorized(call(`Bearer ${short}`), weak), false, short.length);
  }
  assert.equal(
    isProductResearchRouteAuthorized(call(`Bearer ${"s".repeat(32)}`), {
      [PRODUCT_RESEARCH_INGEST_SECRET_ENV]: "s".repeat(32),
    }),
    true
  );
});

test("every answer is no-store JSON, and the off answer is a 404", async () => {
  const off = productResearchNotFound();
  assert.equal(off.status, 404);
  assert.equal(off.headers.get("Cache-Control"), "no-store");
  // Not a 503 naming the feature: that tells an unauthenticated caller this
  // agent is deployed here.
  assert.deepEqual(await off.json(), { error: "not_found" });

  const unauthorized = productResearchUnauthorized();
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { error: "unauthorized" });

  const ok = productResearchJson({ recorded: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("Cache-Control"), "no-store");
  assert.match(ok.headers.get("Content-Type"), /application\/json/);
});

test("the route checks the switch, then the secret, and only then reads the body", () => {
  // Order as source, because the order is the contract: an unauthenticated
  // caller must not be able to make the server parse half a megabyte of its
  // choosing, and an off feature must not answer 401.
  const source = readFileSync(
    new URL("../app/api/internal/product-research/observations/route.ts", import.meta.url),
    "utf8"
  );
  const switchAt = source.indexOf("isProductResearchRouteEnabled()");
  const secretAt = source.indexOf("isProductResearchRouteAuthorized(request)");
  const bodyAt = source.indexOf("readLimitedText(");
  assert.ok(switchAt > 0 && secretAt > 0 && bodyAt > 0);
  assert.ok(switchAt < secretAt, "the secret is checked before the switch");
  assert.ok(secretAt < bodyAt, "the body is read before the secret");

  // And the route never puts the submitted payload into a response or a log.
  // What a caller gets back is an enum, the slot, the outcome and the server's
  // own digest.
  assert.equal(source.includes("body.payload"), false);
  assert.equal(/console\.log/.test(source), false);
});
