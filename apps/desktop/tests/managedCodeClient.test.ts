import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createManagedCodeClient } from "../src/host/managed-code-client";
import { managedRefusalFor } from "../src/managed-code-contract";
import { accountOver, fakeManagedServer, origin } from "./managed-code-fake-server";

const reserveBody = (taskId = randomUUID()) => ({
  taskId, catalogVersion: 7, contentHash: "hash-7", executorModelId: "alpha", reviewerModelId: "beta", approvedCredits: 100,
});
function setup(options?: Parameters<typeof fakeManagedServer>[0]) {
  const server = fakeManagedServer(options);
  const { send, signal } = accountOver(server);
  return { server, client: createManagedCodeClient({ send, signal }) };
}
const ok = <T>(outcome: { kind: string; value?: T }) => { assert.equal(outcome.kind, "ok", JSON.stringify(outcome)); return (outcome as { value: T }).value; };

test("reserve goes over the account session exactly as a web page would and shows the server's receipt", async () => {
  const { server, client } = setup();
  const receipt = ok(await client.reserve(reserveBody()));
  const [call] = server.managedCalls();
  assert.equal(call.method, "POST");
  assert.equal(call.url.origin + call.url.pathname, origin + "/api/code/managed");
  assert.equal(call.headers.get("x-tomverse-code"), "1");
  assert.equal(call.headers.get("origin"), origin);
  assert.match(call.headers.get("cookie") ?? "", /^__Secure-next-auth\.session-token=/);
  assert.equal(call.headers.has("authorization"), false);
  assert.equal(receipt.billing.reservedCredits, 100);
  assert.equal(receipt.billing.availableCredits, 100);
  assert.equal(receipt.modelPair.executor.modelId, "alpha");
  // The request names models and the approved amount. It carries no price, usage or charge.
  assert.deepEqual(Object.keys(call.body as object).sort(), ["action", "approvedCredits", "catalogVersion", "contentHash", "executorModelId", "reviewerModelId", "taskId"]);
});

test("the same task id with the same request is the same reservation, so a retry cannot hold credits twice", async () => {
  const { server, client } = setup();
  const body = reserveBody();
  const first = ok(await client.reserve(body));
  const second = ok(await client.reserve(body));
  assert.equal(second.reservationId, first.reservationId);
  assert.equal(server.reservations.size, 1);
  assert.equal(server.control.balance, 900);
  assert.equal((await client.reserve({ ...body, approvedCredits: 200 })).kind, "refused");
});

test("every refusal the server can give reads as one of the app's own reasons", async () => {
  const cases: Array<[string, string]> = [
    ["CODE_MANAGED_DISABLED", "disabled"], ["CREDIT_BALANCE_INSUFFICIENT", "insufficientCredits"], ["ADDON_CREDITS_INSUFFICIENT", "insufficientCredits"],
    ["PLAN_DAILY_CREDIT_LIMIT_REACHED", "dailyLimit"], ["CODE_TASK_CAP_EXCEEDED", "taskCap"], ["CODE_TASK_CALL_CEILING_REACHED", "callCeiling"],
    ["OPERATIONAL_COST_GUARDRAIL_TRIGGERED", "costGuardrail"], ["PROVIDER_COST_BUDGET_EXCEEDED", "costGuardrail"],
    ["CODE_TASK_CONCURRENCY_EXCEEDED", "concurrency"], ["CODE_CALL_CONCURRENCY_EXCEEDED", "concurrency"], ["CODE_RATE_LIMITED", "rateLimited"],
    ["CODE_MODEL_PLAN_FORBIDDEN", "plan"], ["CODE_CATALOG_CHANGED", "catalog"], ["CODE_CATALOG_STALE", "catalog"], ["CODE_MODEL_UNAVAILABLE", "catalog"],
    ["CODE_REVIEWER_PROVIDER_NOT_INDEPENDENT", "sameProvider"], ["CODE_ACCOUNT_UNAVAILABLE", "account"], ["CODE_RESERVATION_NOT_FOUND", "notFound"],
    ["CODE_TASK_NOT_ACTIVE", "notActive"], ["CODE_TASK_IDEMPOTENCY_CONFLICT", "conflict"], ["CODE_TASK_OUTCOME_UNKNOWN", "outcomeUnknown"],
    ["CODE_SETTLEMENT_OUTCOME_UNKNOWN", "outcomeUnknown"], ["CODE_ORIGIN_FORBIDDEN", "origin"], ["SOMETHING_NEW", "unavailable"],
  ];
  for (const [code, reason] of cases) assert.equal(managedRefusalFor(code), reason, code);
  assert.equal(managedRefusalFor(undefined), "unavailable");

  const { server, client } = setup();
  for (const [code, reason] of [["CREDIT_BALANCE_INSUFFICIENT", "insufficientCredits"], ["PLAN_DAILY_CREDIT_LIMIT_REACHED", "dailyLimit"]] as const) {
    server.control.refuse = { action: "reserve", answer: { status: 402, error: code } };
    const outcome = await client.reserve(reserveBody());
    assert.deepEqual([outcome.kind, outcome.kind === "refused" ? outcome.reason : null, outcome.kind === "refused" ? outcome.code : null], ["refused", reason, code]);
  }
  assert.equal(server.reservations.size, 0);
});

test("a reservation that does not fit the balance is refused by the server and Desktop holds nothing", async () => {
  const { server, client } = setup({ balance: 50 });
  const outcome = await client.reserve(reserveBody());
  assert.deepEqual(outcome, { kind: "refused", reason: "insufficientCredits", code: "CREDIT_BALANCE_INSUFFICIENT" });
  assert.equal(server.control.balance, 50);
});

test("heartbeat, status and release read the server's receipt; release returns only what was not used", async () => {
  const { server, client } = setup();
  const made = ok(await client.reserve(reserveBody()));
  const beat = ok(await client.heartbeat(made.reservationId));
  assert.equal(beat.state, "active");
  const completed = await client.complete({ reservationId: made.reservationId, callId: randomUUID(), role: "executor", modelId: "alpha",
    prompt: { system: "s", user: "u" }, schema: { type: "object" }, maxOutputTokens: 100 });
  assert.equal(completed.kind, "ok");
  const released = ok(await client.release(made.reservationId, "completed"));
  assert.deepEqual(released.billing, { reservedCredits: 100, settledCredits: 2, releasedCredits: 98, heldCredits: 0, unknownHeldCredits: 0, availableCredits: 0 });
  assert.equal(released.state, "closed");
  assert.equal(server.control.balance, 998);
  assert.equal(ok(await client.status(made.reservationId)).state, "closed");
  assert.deepEqual(server.sent.map((request) => request.action), ["reserve", "heartbeat", "complete", "release", "status"]);
});

test("a call is sent once: a lost answer is asked about, never sent again", async () => {
  const { server, client } = setup();
  const made = ok(await client.reserve(reserveBody()));
  const callId = randomUUID();
  const request = { reservationId: made.reservationId, callId, role: "reviewer" as const, modelId: "beta", prompt: { system: "s", user: "u" },
    schema: { type: "object" }, maxOutputTokens: 100 };
  server.control.drop = { action: "complete", after: true };
  const outcome = await client.complete(request);
  assert.deepEqual(outcome, { kind: "unknown", callId });
  assert.equal(server.sent.filter((sent) => sent.action === "complete").length, 1);
  // The way to learn the result is the reservation's status, which shows what the server settled.
  const status = ok(await client.status(made.reservationId, callId));
  assert.equal(status.billing.settledCredits, 2);
  assert.equal(server.sent.filter((sent) => sent.action === "complete").length, 1);
});

test("a call the server says it dispatched, or answered with garbage, stays unknown", async () => {
  const { server, client } = setup();
  const made = ok(await client.reserve(reserveBody()));
  const request = (callId: string) => ({ reservationId: made.reservationId, callId, role: "executor" as const, modelId: "alpha",
    prompt: { system: "s", user: "u" }, schema: { type: "object" }, maxOutputTokens: 100 });
  const first = randomUUID();
  server.control.refuse = { action: "complete", answer: { status: 409, error: "CODE_CALL_ALREADY_DISPATCHED", dispatchState: "dispatched" } };
  assert.deepEqual(await client.complete(request(first)), { kind: "unknown", callId: first });
  server.control.refuse = { action: "complete", answer: { status: 503, error: "CODE_SETTLEMENT_OUTCOME_UNKNOWN", dispatchState: "dispatched" } };
  const second = randomUUID();
  assert.deepEqual(await client.complete(request(second)), { kind: "unknown", callId: second });
});

test("a call refused before dispatch is a plain refusal, and invalid model output is settled but not a result", async () => {
  const { server, client } = setup();
  const made = ok(await client.reserve(reserveBody()));
  const request = () => ({ reservationId: made.reservationId, callId: randomUUID(), role: "executor" as const, modelId: "alpha",
    prompt: { system: "s", user: "u" }, schema: { type: "object" }, maxOutputTokens: 100 });
  server.control.refuse = { action: "complete", answer: { status: 402, error: "CODE_TASK_CAP_EXCEEDED" } };
  assert.deepEqual(await client.complete(request()), { kind: "refused", reason: "taskCap", code: "CODE_TASK_CAP_EXCEEDED" });
  server.control.completeOutput = null;
  const invalid = await client.complete(request());
  assert.equal(invalid.kind, "invalidOutput");
  assert.equal(invalid.kind === "invalidOutput" ? invalid.receipt?.billing.settledCredits : null, 2);
});

test("a transport failure on a bookkeeping request is unreachable; a signed-out answer and an unreadable body are not trusted", async () => {
  const { server, client } = setup();
  server.control.drop = { action: "reserve", after: false };
  assert.deepEqual(await client.reserve(reserveBody()), { kind: "unreachable" });
  server.control.catalogFails = true;
  assert.deepEqual(await client.catalog(), { kind: "refused", reason: "unavailable" });

  const signedOut = createManagedCodeClient({ signal: new AbortController().signal, send: async () => new Response("", { status: 401 }) });
  assert.deepEqual(await signedOut.heartbeat(randomUUID()), { kind: "refused", reason: "account", code: "SIGNED_OUT" });
  const garbage = createManagedCodeClient({ signal: new AbortController().signal, send: async () => Response.json({ reservationId: "x", billing: "lots" }) });
  assert.deepEqual(await garbage.heartbeat(randomUUID()), { kind: "refused", reason: "unavailable" });
});

test("the model list keeps what Desktop shows and drops everything else", async () => {
  const { client } = setup();
  const catalog = ok(await client.catalog());
  assert.equal(catalog.version, 7);
  assert.equal(catalog.contentHash, "hash-7");
  assert.deepEqual(Object.keys(catalog.models[0]).sort(), ["capabilities", "channels", "minimumPlan", "modelId", "name", "provider"]);
});
