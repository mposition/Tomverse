import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_V4_COLLECTION_RESULT_PURGE_AGENT_ID,
  AMUX_V4_COLLECTION_RESULT_PURGE_BATCH_SIZE,
  collectionResultPurgeEnabled,
  collectionResultPurgeRequestSchema,
  isCollectionResultPurgeAuthorized,
} from "../lib/amux/ideaCollectionResultPurgeCore.ts";

const secret = "a".repeat(48);
const auth = (value = secret, agentId = AMUX_V4_COLLECTION_RESULT_PURGE_AGENT_ID) =>
  new Request("https://tomverse.test/api/internal/amux/v4/collection-result-purge", {
    method: "POST", headers: { authorization: `Bearer ${value}`,
      "x-amux-agent-id": agentId },
  });

test("retention route stays dark and a batch is bounded", () => {
  assert.equal(collectionResultPurgeEnabled("enabled"), false);
  assert.equal(AMUX_V4_COLLECTION_RESULT_PURGE_BATCH_SIZE, 8);
  assert.equal(collectionResultPurgeRequestSchema.safeParse({ schemaVersion: 1 }).success, true);
  assert.equal(collectionResultPurgeRequestSchema.safeParse({ schemaVersion: 1,
    requestId: "injected" }).success, false);
});

test("retention secret is isolated from the collector and analysis agents", () => {
  assert.equal(isCollectionResultPurgeAuthorized(auth(), secret, ["b".repeat(48)]), true);
  assert.equal(isCollectionResultPurgeAuthorized(auth(), secret, [secret]), false);
  assert.equal(isCollectionResultPurgeAuthorized(auth("b".repeat(48)), secret, []), false);
  assert.equal(isCollectionResultPurgeAuthorized(auth(secret, "amux-v4-source-collector"),
    secret, []), false);
  assert.equal(isCollectionResultPurgeAuthorized(auth(), "weak", []), false);
});
