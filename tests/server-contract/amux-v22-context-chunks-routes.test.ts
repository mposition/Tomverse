import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// docs/policy/amux-v22-result-transfer.md 10.1 (owner direction 2026-11-19):
// the context chunk route and the pull route's feature header. The Rust
// bridge reads these exact keys and status codes. The store that rebuilds a
// file from its rows is tested in amux-v22-context-store.test.ts.

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const attemptId = "00000000-0000-4000-8000-000000000001";
const instanceId = "00000000-0000-4000-8000-000000000003";

let authorized = true;
mock.module(mod("lib/amux/guard.ts"), { namedExports: {
  isAmuxSyncAuthorized: () => authorized } });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {},
  prismaPoolUsage: () => ({ total: 0, idle: 0, waiting: 0 }) } });
type Read = { kind: "binding_mismatch" } | { kind: "absent" } | { kind: "text"; text: string };
let nextRead: Read | Error = { kind: "absent" };
const readCalls: Array<Record<string, unknown>> = [];
mock.module(mod("lib/amux/v22ContextStore.ts"), { namedExports: {
  readAmuxV22ContextPart: async (input: Record<string, unknown>) => {
    readCalls.push(input);
    if (nextRead instanceof Error) throw nextRead;
    return nextRead;
  } } });
let pullInputs: Array<Record<string, unknown>> = [];
let nextDelivery: Record<string, unknown> = {};
mock.module(mod("lib/amux/delivery.ts"), { namedExports: {
  pullAmuxWorkDelivery: async (input: Record<string, unknown>) => {
    pullInputs.push(input);
    return { available: true, delivery: { attemptId, assignmentId: null, taskId: "task-one",
      worker: "worker-one", taskRevision: 3, prompt: "prompt", v22Execution: null,
      receiptId: "receipt-one", leaseExpiresAt: new Date("2026-11-19T12:00:00.000Z"),
      ...nextDelivery } };
  } } });
mock.module(mod("lib/amux/dbBoundary.ts"), { namedExports: {
  AMUX_LIFECYCLE_ROUTE_BUDGET_MS: 12_000,
  withAmuxRouteBudget: async (work: () => Promise<Response>) => work(),
  AmuxDbBoundaryError: class extends Error {},
  admitAmuxOrchestratorWrite: async () => ({ admitted: true }),
  amuxRouteOrchestratorReceiptsMayHaveCommitted: () => false,
} });

// Loaded on first use: a .ts test is CommonJS here, with no top-level await.
const loadContext = () => import(mod("app/api/internal/amux/v22/execution/context/route.ts"));
const loadPull = () => import(mod("app/api/internal/amux/delivery/pull/route.ts"));
const loadCore = () => import(mod("lib/amux/v22TransferCore.ts"));
type Handler = { POST: (request: Request) => Promise<Response> };

const post = async (load: () => Promise<Handler>, path: string,
  body: unknown, headers: Record<string, string> = {}) => {
  const response = await (await load()).POST(new Request(`https://tomverse.test/api/internal/amux/${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body) }));
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};
const ask = (body: unknown) => post(loadContext, "v22/execution/context", body);
const request = { attemptId, worker: "worker-one", name: "prior.patch", index: 0 };

test("a chunk is the file's bytes at the transfer range, with the whole file's digest", async () => {
  const { AMUX_V22_TRANSFER_CHUNK_BYTES } = await loadCore();
  const text = "é".repeat(AMUX_V22_TRANSFER_CHUNK_BYTES) + "tail";
  const whole = Buffer.from(text, "utf8");
  nextRead = { kind: "text", text };
  const parts: Buffer[] = [];
  for (let index = 0; index < 3; index += 1) {
    const answer = await ask({ ...request, index });
    assert.equal(answer.status, 200);
    assert.deepEqual(Object.keys(answer.body).sort(), ["attemptId", "bytesBase64", "chunkCount",
      "index", "name", "sha256", "totalBytes"]);
    assert.equal(answer.body.attemptId, attemptId);
    assert.equal(answer.body.name, "prior.patch");
    assert.equal(answer.body.index, index);
    assert.equal(answer.body.totalBytes, whole.length);
    assert.equal(answer.body.chunkCount, 3);
    assert.equal(answer.body.sha256, sha256(whole));
    parts.push(Buffer.from(String(answer.body.bytesBase64), "base64"));
  }
  assert.equal(parts[0]!.length, AMUX_V22_TRANSFER_CHUNK_BYTES);
  assert.ok(Buffer.concat(parts).equals(whole));
  assert.deepEqual(readCalls.at(-1), { attemptId, worker: "worker-one", name: "prior.patch" });
  const named = await ask({ ...request, name: "prior-conclusions.md" });
  assert.equal(named.status, 200);
  assert.equal(readCalls.at(-1)?.name, "prior-conclusions.md");
});

test("an index past the file, a bad request or a body of the wrong kind is 400 and never reads", async () => {
  nextRead = { kind: "text", text: "small" };
  const before = readCalls.length;
  const invalid = { status: 400, body: { error: "Invalid request." } };
  assert.deepEqual(await ask({ ...request, index: 1 }), invalid, "past the one chunk");
  for (const [label, body] of [
    ["not JSON", "{"],
    ["an unknown key", { ...request, extra: 1 }],
    ["a name outside the two files", { ...request, name: "brief.md" }],
    ["a path as the name", { ...request, name: "../prior.patch" }],
    ["no name", { ...request, name: undefined }],
    ["an attempt that is not a uuid", { ...request, attemptId: "attempt-one" }],
    ["a worker with a slash", { ...request, worker: "a/b" }],
    ["a negative index", { ...request, index: -1 }],
    ["a fractional index", { ...request, index: 0.5 }],
    ["an index as text", { ...request, index: "0" }],
    ["a body over 1 KiB", { ...request, worker: "w".repeat(2_000) }],
  ] as Array<[string, unknown]>) {
    assert.deepEqual(await ask(body), invalid, label);
  }
  assert.equal(readCalls.length, before + 1, "only the in-schema request with a late index reads");
});

test("the refusals carry the bridge's codes", async () => {
  nextRead = { kind: "binding_mismatch" };
  assert.deepEqual(await ask(request), { status: 409, body: { error: "binding_mismatch" } });
  nextRead = { kind: "absent" };
  assert.deepEqual(await ask(request), { status: 404, body: { error: "context_absent" } });
  nextRead = new Error("database unavailable");
  assert.deepEqual(await ask(request), { status: 503, body: { error: "outcome_unknown" } });
});

test("the route needs the sync secret and a JSON body", async () => {
  nextRead = { kind: "text", text: "small" };
  authorized = false;
  assert.equal((await ask(request)).status, 401);
  authorized = true;
  const wrongType = await (await loadContext()).POST(new Request("https://tomverse.test/x", {
    method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(request) }));
  assert.equal(wrongType.status, 415);
});

test("the pull route passes the bridge's context_chunks feature to the delivery", async () => {
  const body = { worker: "worker-one", instance_id: instanceId, generation: 1 };
  nextDelivery = {};
  pullInputs = [];
  await post(loadPull, "delivery/pull", body);
  await post(loadPull, "delivery/pull", body, { "x-amux-bridge-features": "something_else" });
  await post(loadPull, "delivery/pull", body, { "x-amux-bridge-features": "context_chunks" });
  await post(loadPull, "delivery/pull", body, { "x-amux-bridge-features": "other, context_chunks" });
  assert.deepEqual(pullInputs.map((input) => input.contextChunks), [false, false, true, true]);
});

test("the pull answer carries context_parts in snake case, and no key when there are none", async () => {
  const body = { worker: "worker-one", instance_id: instanceId, generation: 1 };
  const parts = [{ name: "prior.patch", bytes: 40_000_000, sha256: "a".repeat(64) },
    { name: "prior-conclusions.md", bytes: 12, sha256: "b".repeat(64) }];
  nextDelivery = { contextParts: parts };
  let answer = await post(loadPull, "delivery/pull", body, { "x-amux-bridge-features": "context_chunks" });
  assert.equal(answer.status, 200);
  const delivery = answer.body.delivery as Record<string, unknown>;
  assert.deepEqual(delivery.context_parts, parts);
  assert.equal("contextParts" in delivery, false);
  assert.equal(delivery.attempt_id, attemptId);
  for (const none of [{}, { contextParts: [] }]) {
    nextDelivery = none;
    answer = await post(loadPull, "delivery/pull", body, { "x-amux-bridge-features": "context_chunks" });
    assert.equal("context_parts" in (answer.body.delivery as Record<string, unknown>), false);
  }
});
