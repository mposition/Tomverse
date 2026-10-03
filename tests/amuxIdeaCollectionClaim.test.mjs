import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { AMUX_V4_COLLECTION_CLAIM_CODE_LATCH,
  AMUX_V4_COLLECTION_CLAIM_MAX_BYTES, collectionClaimEnabled,
  collectionClaimRequestSchema } from "../lib/amux/ideaCollectionClaimCore.ts";

const route = readFileSync(new URL("../app/api/internal/amux/v4/collection-claim/route.ts",
  import.meta.url), "utf8");

test("claim request is exact and bounded while its latch remains off", () => {
  assert.equal(AMUX_V4_COLLECTION_CLAIM_CODE_LATCH, false);
  assert.equal(collectionClaimEnabled("enabled"), false);
  assert.equal(AMUX_V4_COLLECTION_CLAIM_MAX_BYTES, 256);
  const id = "d218de81-0c91-4f5b-8dcb-11f335d68110";
  assert.equal(collectionClaimRequestSchema.safeParse({ collectionRequestId: id }).success, true);
  for (const rejected of [{ collectionRequestId: "not-a-uuid" },
    { collectionRequestId: id, source: "private" }, {}]) {
    assert.equal(collectionClaimRequestSchema.safeParse(rejected).success, false);
  }
});

test("claim route authenticates before any availability or source disclosure", () => {
  const auth = route.indexOf("isCollectionAgentAuthorized(request");
  const gate = route.indexOf("collectionClaimEnabled(process.env");
  const parse = route.indexOf("readLimitedJson(request");
  const claim = route.indexOf("claimAmuxCollection(collectionRequestId)");
  assert.ok(auth >= 0 && gate > auth && parse > gate && claim > parse);
  assert.match(route, /AMUX_V4_COLLECTION_AGENT_SECRET_ENV/);
  assert.match(route, /amuxJsonNoStore/);
  assert.match(route, /retryClaim: false/);
  assert.match(route, /readBack: error\.readBack/);
});
