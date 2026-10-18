import assert from "node:assert/strict";
import { after, test } from "node:test";

import { readAmuxV19SessionBudgetClaimReceipt } from
  "../lib/amux/ideaLocalSessionBudgetClaimReceiptRead.mjs";

const name = "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN";
const previous = process.env[name];
process.env[name] = "https://tomverse.test/";
after(() => {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
});
const requestId = "ea86a25b-919f-4714-a3d8-45ef5a18b175";
const reservationId = "ea86a25b-919f-4714-a3d8-45ef5a18b176";
const claimId = "ea86a25b-919f-4714-a3d8-45ef5a18b177";
const input = (fetchImpl) => ({ origin: "https://tomverse.test/",
  agentSecret: "v19_analysis_agent_secret_01234567890123456789",
  requestId, reservationId, invocationOrdinal: 0, fetchImpl });

test("readback binds the exact request and returns a committed claim", async () => {
  let calls = 0;
  const result = await readAmuxV19SessionBudgetClaimReceipt(input(
    async (url, request) => {
      calls += 1;
      const endpoint = new URL(url);
      assert.equal(endpoint.pathname,
        "/api/internal/amux/v19/analysis-budget/claim");
      assert.deepEqual([...endpoint.searchParams.entries()], [
        ["requestId", requestId], ["reservationId", reservationId],
        ["invocationOrdinal", "0"],
      ]);
      assert.equal(request.method, "GET");
      assert.equal(request.redirect, "manual");
      assert.equal(request.cache, "no-store");
      assert.equal(request.body, undefined);
      return Response.json({ status: "committed", claimId,
        claimStatus: "in_flight" });
    }));
  assert.deepEqual(result, { kind: "committed", claimId,
    claimStatus: "in_flight", retryWrite: false });
  assert.equal(calls, 1);
});

test("absent and partial never authorize another claim write", async () => {
  for (const status of ["absent", "partial"]) {
    assert.deepEqual(await readAmuxV19SessionBudgetClaimReceipt(input(
      async () => Response.json({ status }))), {
      kind: "unresolved", status, retryWrite: false,
    });
  }
});

test("readback accepts the server's case-insensitive UUID grammar", async () => {
  const nonV4ClaimId = "ea86a25b-919f-1714-a3d8-45ef5a18b177";
  assert.deepEqual(await readAmuxV19SessionBudgetClaimReceipt({
    ...input(async () => Response.json({ status: "committed",
      claimId: nonV4ClaimId, claimStatus: "succeeded" })),
    requestId: requestId.toUpperCase(),
    reservationId: reservationId.toUpperCase(),
  }), { kind: "committed", claimId: nonV4ClaimId,
    claimStatus: "succeeded", retryWrite: false });
});

test("invalid identity and uncertain responses fail closed", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error("network"); };
  for (const candidate of [
    { ...input(fetchImpl), requestId: "wrong" },
    { ...input(fetchImpl), origin: "https://other.test/" },
    { ...input(fetchImpl), invocationOrdinal: -1 },
    { ...input(fetchImpl), agentSecret: "bad" },
    { ...input(fetchImpl), fetchImpl: undefined },
  ]) assert.deepEqual(await readAmuxV19SessionBudgetClaimReceipt(candidate),
    { kind: "refused" });
  assert.equal(calls, 0);
  for (const response of [
    Response.redirect("https://other.test/", 302),
    Object.defineProperty(Response.json({ status: "absent" }), "url", {
      value: "https://other.test/" }),
    Response.json({ status: "committed", claimId: "wrong",
      claimStatus: "in_flight" }),
    Response.json({ status: "absent", retryWrite: true }),
    new Response(JSON.stringify({ status: "absent" }), {
      headers: { "content-type": "text/plain" } }),
    new Response("x".repeat(513), {
      headers: { "content-type": "application/json" } }),
    new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(300)));
      controller.enqueue(new TextEncoder().encode("x".repeat(300)));
      controller.close();
    } }), { headers: { "content-type": "application/json" } }),
    new Response(null, { status: 503 }),
  ]) {
    assert.deepEqual(await readAmuxV19SessionBudgetClaimReceipt(input(
      async () => response)), { kind: "unavailable", retryWrite: false });
  }
  assert.deepEqual(await readAmuxV19SessionBudgetClaimReceipt(input(fetchImpl)),
    { kind: "unavailable", retryWrite: false });
});
