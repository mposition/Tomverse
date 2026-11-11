import assert from "node:assert/strict";
import test from "node:test";
import { openRouterLocation, routerLocationDigest, sealRouterLocation } from "../../lib/chatRouterLocationContinuation";

test("a consent continuation conceals its execution view, expires and is bound to the exact saved request", () => {
  const request = { userId: "owner", source: "saved", answer: "answer", query: "Where am I?", bundle: "quote", candidates: ["A", "B"] };
  const digest = routerLocationDigest(request);
  const decision = { requestDigest: digest, routerDigest: routerLocationDigest(["guidance", "candidates"]), traceId: "original",
    expiresAt: 2_000, searchPlan: true, image: { image: false as const },
    pick: { modelId: "A", rewrite: "private rewrite", searchQueries: ["private query"], requiresLocation: true } };
  const opaque = sealRouterLocation(decision, "test-secret");
  assert.deepEqual(openRouterLocation(opaque, digest, "test-secret", 1_999), decision);
  assert.ok(!Buffer.from(opaque, "base64url").toString("utf8").includes("private"));
  assert.notEqual(sealRouterLocation(decision, "test-secret"), opaque);
  assert.equal(openRouterLocation(opaque, digest, "test-secret", 2_000), null);
  assert.equal(openRouterLocation(opaque, digest, "wrong", 0), null);
  const changed = Buffer.from(opaque, "base64url");
  changed[30] ^= 1;
  assert.equal(openRouterLocation(changed.toString("base64url"), digest, "test-secret", 0), null);
  for (const settings of [{ userId: "other" }, { source: "other" }, { answer: "other" }, { bundle: "renewed" },
    { query: "Changed" }, { candidates: ["B", "A"] }]) {
    assert.equal(openRouterLocation(opaque, routerLocationDigest({ ...request, ...settings }), "test-secret", 0), null);
  }
});
