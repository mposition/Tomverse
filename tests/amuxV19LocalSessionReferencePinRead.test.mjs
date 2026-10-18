import assert from "node:assert/strict";
import { after, test } from "node:test";

import { readAmuxV19ClaimReferencePin } from
  "../lib/amux/ideaLocalSessionReferencePinRead.mjs";

const name = "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN";
const previous = process.env[name];
process.env[name] = "https://tomverse.test/";
after(() => {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
});
const input = (fetchImpl) => ({ origin: "https://tomverse.test/",
  agentSecret: "v19_analysis_agent_secret_01234567890123456789",
  ideaId: "ea86a25b-919f-4714-a3d8-45ef5a18b175",
  claimId: "ea86a25b-919f-4714-a3d8-45ef5a18b176",
  reservationId: "ea86a25b-919f-4714-a3d8-45ef5a18b177",
  referenceOrdinal: 0, fetchImpl });

test("the in-flight worker reads its exact canonical pin before checkout", async () => {
  let calls = 0;
  const candidate = input(async (url, request) => {
    calls += 1;
    assert.equal(url, "https://tomverse.test/api/internal/amux/v19/reference-pin");
    assert.equal(request.method, "POST");
    assert.equal(request.redirect, "manual");
    assert.deepEqual(JSON.parse(request.body), {
      claimId: candidate.claimId, reservationId: candidate.reservationId,
      ideaId: candidate.ideaId, referenceOrdinal: 0,
    });
    return Response.json({ referenceCount: 1, pinnedCommitSha: "a".repeat(40) });
  });
  assert.deepEqual(await readAmuxV19ClaimReferencePin(candidate), {
    kind: "pinned", referenceCount: 1, commitSha: "a".repeat(40),
  });
  assert.equal(calls, 1);
});

test("uncertain, malformed, and cross-origin pin reads fail closed", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return Response.json({ referenceCount: 1, pinnedCommitSha: "a".repeat(40) });
  };
  assert.deepEqual(await readAmuxV19ClaimReferencePin({
    ...input(fetchImpl), origin: "https://other.test/",
  }), { kind: "unavailable" });
  assert.deepEqual(await readAmuxV19ClaimReferencePin({
    ...input(fetchImpl), claimId: "not-a-claim",
  }), { kind: "unavailable" });
  assert.equal(calls, 0);
  for (const response of [
    Response.json({ referenceCount: 1, pinnedCommitSha: "b".repeat(39) }),
    Response.json({ referenceCount: 0, pinnedCommitSha: null }),
    Response.json({ referenceCount: 1, pinnedCommitSha: "a".repeat(40),
      extra: true }),
    new Response("x".repeat(257), { headers: {
      "content-type": "application/json" } }),
    new Response(null, { status: 503 }),
  ]) {
    assert.deepEqual(await readAmuxV19ClaimReferencePin(input(
      async () => response)), { kind: "unavailable" });
  }
});
