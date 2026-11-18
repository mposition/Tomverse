import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// The upload route's checks and the settlement and review record routes'
// changed-path digest (docs/policy/amux-v22-result-transfer.md 1.6 1 and 5),
// with the stores replaced: the answer keys and status codes the Rust bridge
// reads, and what reaches the settlement. The stores themselves run against
// PostgreSQL in tests/integration/amuxV22TransferStaging.db.test.mjs.

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const attemptId = "00000000-0000-4000-8000-000000000001";
const instanceId = "00000000-0000-4000-8000-000000000003";

mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {},
  prismaPoolUsage: () => ({ total: 0, idle: 0, waiting: 0 }) } });
mock.module(mod("lib/amux/guard.ts"), {
  namedExports: { isAmuxSyncAuthorized: () => true },
});
let nextPut = null;
const putCalls = [];
const realTransfer = await import(`${mod("lib/amux/v22TransferStore.ts")}?real`);
mock.module(mod("lib/amux/v22TransferStore.ts"), { namedExports: { ...realTransfer,
  putAmuxV22TransferChunk: async (input) => {
    putCalls.push(input);
    if (nextPut instanceof Error) throw nextPut;
    return nextPut;
  } } });
let nextNamed = null;
const namedCalls = [];
const realPaths = await import(`${mod("lib/amux/v22ChangedPathsStore.ts")}?real`);
mock.module(mod("lib/amux/v22ChangedPathsStore.ts"), { namedExports: { ...realPaths,
  resolveAmuxV22NamedChangedPaths: async (id, body) => {
    namedCalls.push({ id, body });
    return nextNamed ?? realPaths.resolveAmuxV22NamedChangedPaths(id, body, null);
  },
  amuxV22SettlementAllowanceMs: async () => 2_000,
} });
const settleCalls = [];
const reviewCalls = [];
mock.module(mod("lib/amux/execution.ts"), { namedExports: {
  AMUX_V22_CHANGED_PATHS_UNRECORDED: "changed_paths_unrecorded",
  settleAmuxV22TaskExecution: async (input) => {
    settleCalls.push(input);
    return { settled: true, toStatus: "review" };
  },
  recordAmuxV52Review: async (input) => {
    reviewCalls.push(input);
    return { recorded: true, duplicate: false };
  },
} });
mock.module(mod("lib/amux/v52ReviewFindingsStore.ts"), {
  namedExports: { prepareAmuxV52ReviewFindings: async () => null },
});

const upload = await import(mod("app/api/internal/amux/v22/execution/upload/route.ts"));
const settle = await import(mod("app/api/internal/amux/v22/execution/settle/route.ts"));
const review = await import(mod("app/api/internal/amux/v22/review/record/route.ts"));
const { AMUX_V22_EMPTY_SHA256, AMUX_V22_STORAGE_MAX_BYTES } =
  await import(mod("lib/amux/v22TransferCore.ts"));

const call = async (handler, path, body) => {
  const response = await handler.POST(new Request(`https://tomverse.test/api/internal/amux/v22/${path}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body) }));
  return { status: response.status, body: await response.json() };
};

// --- upload ---------------------------------------------------------------
const bytes = Buffer.from("lib/a.ts\0lib/b.ts\0", "utf8");
const chunk = { attemptId, worker: "worker-one", part: "changed_paths",
  totalBytes: bytes.length, sha256: sha256(bytes), count: 2, index: 0,
  chunkSha256: sha256(bytes), bytesBase64: bytes.toString("base64") };
nextPut = { kind: "stored", duplicate: false, received: 1, chunkCount: 1 };
let answer = await call(upload, "execution/upload", chunk);
assert.deepEqual(answer, { status: 200, body: { attemptId, part: "changed_paths",
  index: 0, duplicate: false, received: 1, chunkCount: 1 } });
assert.equal(putCalls.length, 1);
assert.ok(putCalls[0].bytes.equals(Buffer.alloc(bytes.length)),
  "the route zeroes the chunk once the store has it");
nextPut = { kind: "stored", duplicate: true, received: 1, chunkCount: 1 };
answer = await call(upload, "execution/upload", chunk);
assert.equal(answer.body.duplicate, true);

const invalid = { status: 400, body: { error: "Invalid request." } };
const nonCanonical = Buffer.from("a").toString("base64").replace("Q==", "R==");
for (const [label, body] of [
  ["not JSON", "{"],
  ["an unknown key", { ...chunk, extra: 1 }],
  ["a part outside the list", { ...chunk, part: "report" }],
  ["a list without its count", { ...chunk, count: undefined }],
  ["a count on a result", { ...chunk, part: "result" }],
  ["a patch without its base", { ...chunk, part: "patch", count: undefined }],
  ["a base on a list", { ...chunk, baseSha: "a".repeat(40) }],
  ["non-canonical base64", { ...chunk, totalBytes: 1, bytesBase64: nonCanonical,
    chunkSha256: sha256(Buffer.from("a")) }],
  ["a chunk digest of other bytes", { ...chunk, chunkSha256: "f".repeat(64) }],
  ["an index past the part", { ...chunk, index: 1 }],
  ["a chunk shorter than its range", { ...chunk, totalBytes: bytes.length + 1 }],
  ["no bytes", { ...chunk, bytesBase64: "" }],
]) {
  assert.deepEqual(await call(upload, "execution/upload", body), invalid, label);
}
assert.equal(putCalls.length, 2, "no invalid chunk reaches the store");
answer = await call(upload, "execution/upload", { ...chunk,
  totalBytes: AMUX_V22_STORAGE_MAX_BYTES + 1 });
assert.deepEqual(answer, { status: 409, body: { error: "exceeds_storage" } });
assert.equal(putCalls.length, 2, "a part past one Postgres value is refused first");
for (const code of ["binding_mismatch", "upload_conflict", "chunk_conflict",
  "already_recorded", "exceeds_storage"]) {
  nextPut = { kind: "refused", code };
  assert.deepEqual(await call(upload, "execution/upload", chunk),
    { status: 409, body: { error: code } }, code);
}
nextPut = new Error("database unavailable");
assert.deepEqual(await call(upload, "execution/upload", chunk),
  { status: 503, body: { error: "outcome_unknown" } });

// --- settlement -----------------------------------------------------------
const settleBody = { attempt_id: attemptId, worker: "worker-one",
  instance_id: instanceId, generation: 1, task_revision: 3, outcome: "succeeded",
  invocation_ids: [] };
const listed = ["lib/a.ts", "lib/b.ts"];
nextNamed = { kind: "paths", paths: listed };
answer = await call(settle, "execution/settle", { ...settleBody,
  changed_paths_digest: sha256(bytes), changed_paths_count: 2 });
assert.equal(answer.status, 200, JSON.stringify(answer.body));
assert.deepEqual(settleCalls.at(-1).changedPaths, listed);
assert.deepEqual(namedCalls.at(-1).body.changed_paths_digest, sha256(bytes));
nextNamed = { kind: "unrecorded" };
const settledBefore = settleCalls.length;
answer = await call(settle, "execution/settle", { ...settleBody,
  changed_paths_digest: "e".repeat(64), changed_paths_count: 2 });
assert.deepEqual(answer, { status: 409, body: { settled: false,
  reason: "changed_paths_unrecorded" } });
assert.equal(settleCalls.length, settledBefore, "an unrecorded list never settles");
// The empty list needs no record; an old bridge's array still settles.
nextNamed = null;
answer = await call(settle, "execution/settle", { ...settleBody,
  changed_paths_digest: AMUX_V22_EMPTY_SHA256, changed_paths_count: 0 });
assert.equal(answer.status, 200);
assert.deepEqual(settleCalls.at(-1).changedPaths, []);
answer = await call(settle, "execution/settle", { ...settleBody, changed_paths: listed });
assert.equal(answer.status, 200);
assert.deepEqual(settleCalls.at(-1).changedPaths, listed);
answer = await call(settle, "execution/settle", settleBody);
assert.equal(answer.status, 200);
assert.equal("changedPaths" in settleCalls.at(-1), false);
for (const [label, body] of [
  ["a digest without its count", { ...settleBody, changed_paths_digest: sha256(bytes) }],
  ["a count without its digest", { ...settleBody, changed_paths_count: 2 }],
  ["a digest beside the array", { ...settleBody, changed_paths: listed,
    changed_paths_digest: sha256(bytes), changed_paths_count: 2 }],
  ["the empty digest with paths", { ...settleBody,
    changed_paths_digest: AMUX_V22_EMPTY_SHA256, changed_paths_count: 2 }],
  ["paths under another digest named empty", { ...settleBody,
    changed_paths_digest: sha256(bytes), changed_paths_count: 0 }],
  ["a digest that is not hex", { ...settleBody, changed_paths_digest: "x",
    changed_paths_count: 1 }],
]) {
  const before = settleCalls.length;
  assert.deepEqual(await call(settle, "execution/settle", body), invalid, label);
  assert.equal(settleCalls.length, before, label);
}

// --- v52 review record ------------------------------------------------------
const reviewBody = { attempt_id: attemptId, worker: "worker-one",
  instance_id: instanceId, generation: 1, task_revision: 3,
  evidence: { job_id: "r-20261118-120000-abcdef", base_sha: "a".repeat(40),
    commit_sha: "c".repeat(40), verdict: "accept", author_vendor: "anthropic",
    reviewer_vendors: ["openai"], touches_contract: false } };
nextNamed = { kind: "paths", paths: listed };
answer = await call(review, "review/record", { ...reviewBody,
  changed_paths_digest: sha256(bytes), changed_paths_count: 2 });
assert.deepEqual(answer, { status: 200, body: { recorded: true, duplicate: false } });
assert.deepEqual(reviewCalls.at(-1).changedPaths, listed);
nextNamed = { kind: "unrecorded" };
answer = await call(review, "review/record", { ...reviewBody,
  changed_paths_digest: sha256(bytes), changed_paths_count: 2 });
assert.deepEqual(answer, { status: 409, body: { recorded: false,
  reason: "changed_paths_unrecorded" } });
nextNamed = null;
const reviewedBefore = reviewCalls.length;
// A review names at least one path, as the array always had to.
assert.deepEqual(await call(review, "review/record", { ...reviewBody,
  changed_paths_digest: AMUX_V22_EMPTY_SHA256, changed_paths_count: 0 }), invalid);
assert.deepEqual(await call(review, "review/record", reviewBody), invalid);
assert.deepEqual(await call(review, "review/record", { ...reviewBody, changed_paths: [] }), invalid);
assert.equal(reviewCalls.length, reviewedBefore);
answer = await call(review, "review/record", { ...reviewBody, changed_paths: listed });
assert.equal(answer.status, 200);
assert.deepEqual(reviewCalls.at(-1).changedPaths, listed);

console.log("AMUX_V22_TRANSFER_ROUTES_OK");
