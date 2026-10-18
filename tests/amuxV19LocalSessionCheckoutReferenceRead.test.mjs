import assert from "node:assert/strict";
import { after, test } from "node:test";

import { readAmuxV19SessionCheckoutReference } from
  "../lib/amux/ideaLocalSessionCheckoutReferenceRead.mjs";

const name = "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN";
const previous = process.env[name];
process.env[name] = "https://tomverse.test/";
after(() => {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
});
const sha = "a".repeat(40);
const input = (fetchImpl) => ({ origin: "https://tomverse.test/",
  agentSecret: "v19_analysis_agent_secret_01234567890123456789",
  ideaId: "ea86a25b-919f-4714-a3d8-45ef5a18b175",
  claimId: "ea86a25b-919f-4714-a3d8-45ef5a18b176",
  reservationId: "ea86a25b-919f-4714-a3d8-45ef5a18b177",
  referenceOrdinal: 0, fetchImpl });

test("the worker reads one exact active claim's repository target", async () => {
  let calls = 0;
  const target = { referenceCount: 2, kind: "repository",
    repository: "mposition/Tomverse", pullRequestNumber: null,
    pinnedCommitSha: sha };
  const candidate = input(async (url, request) => {
    calls += 1;
    assert.equal(url, "https://tomverse.test/api/internal/amux/v19/checkout-reference");
    assert.equal(request.method, "POST");
    assert.equal(request.redirect, "manual");
    assert.deepEqual(JSON.parse(request.body), {
      claimId: candidate.claimId, reservationId: candidate.reservationId,
      ideaId: candidate.ideaId, referenceOrdinal: 0,
    });
    return Response.json(target);
  });
  assert.deepEqual(await readAmuxV19SessionCheckoutReference(candidate), target);
  assert.equal(calls, 1);
});

test("a PR target retains its repository, number and pinned head SHA", async () => {
  const target = { referenceCount: 2, kind: "pull_request",
    repository: "mposition/tomverse-private-docs", pullRequestNumber: 37,
    pinnedCommitSha: sha };
  assert.deepEqual(await readAmuxV19SessionCheckoutReference({
    ...input(async () => Response.json(target)), referenceOrdinal: 1,
  }), target);
  assert.deepEqual(await readAmuxV19SessionCheckoutReference({
    ...input(async () => Response.json({ ...target,
      pinnedCommitSha: "b".repeat(64) })), referenceOrdinal: 1,
  }), { ...target, pinnedCommitSha: "b".repeat(64) });
});

test("missing authority, malformed targets and uncertain transport fail closed", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return Response.json({ referenceCount: 1, kind: "repository",
      repository: "mposition/Tomverse", pullRequestNumber: null,
      pinnedCommitSha: sha });
  };
  for (const candidate of [{ ...input(fetchImpl), claimId: undefined },
    { ...input(fetchImpl), origin: "https://other.test/" },
    { ...input(fetchImpl), referenceOrdinal: -1 }]) {
    assert.deepEqual(await readAmuxV19SessionCheckoutReference(candidate),
      { kind: "unavailable" });
  }
  assert.equal(calls, 0);
  const valid = { referenceCount: 1, kind: "repository",
    repository: "mposition/Tomverse", pullRequestNumber: null,
    pinnedCommitSha: sha };
  for (const response of [
    Response.redirect("https://other.test/", 302),
    Object.defineProperty(Response.json(valid), "url", {
      value: "https://other.test/" }),
    new Response(JSON.stringify(valid), { headers: {
      "content-type": "text/plain" } }),
    Response.json({ ...valid, pinnedCommitSha: "b".repeat(39) }),
    Response.json({ ...valid, repository: "../private" }),
    Response.json({ ...valid, repository: "owner/.." }),
    Response.json({ ...valid, referenceCount: 0 }),
    Response.json({ ...valid, pullRequestNumber: 37 }),
    Response.json({ ...valid, extra: true }),
    Response.json({ ...valid, kind: "pull_request" }),
    Response.json({ ...valid, kind: "pull_request", pullRequestNumber: 0 }),
    new Response("x".repeat(513), { headers: {
      "content-type": "application/json" } }),
    new Response(null, { status: 503 }),
  ]) {
    assert.deepEqual(await readAmuxV19SessionCheckoutReference(input(
      async () => response)), { kind: "unavailable" });
  }
});
