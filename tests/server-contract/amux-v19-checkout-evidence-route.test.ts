import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const secret = "v19_checkout_agent_secret_01234567890123456789";
const ideaId = "ea86a25b-919f-4714-a3d8-45ef5a18b175";
const evidenceId = "dc86a25b-919f-4714-a3d8-45ef5a18b175";
const envNames = ["TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET",
  "TOMVERSE_AMUX_SYNC_SECRET", "TOMVERSE_AMUX_V19_CHECKOUT_EVIDENCE_WRITE",
  "TOMVERSE_AMUX_V19_CHECKOUT_EVIDENCE_READ"] as const;
const previousEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
let writes = 0;
let reads = 0;
let stored: Record<string, unknown> | null = null;
let writeCode: string | null = null;
let unknownCommit = false;
let readFails = false;

class SyntheticEvidenceError extends Error {
  constructor(readonly code: string) { super(code); }
}

mock.module(mod("lib/amux/ideaTrackedCheckoutEvidenceStore.ts"), { namedExports: {
  AmuxTrackedCheckoutEvidenceError: SyntheticEvidenceError,
  recordAmuxTrackedCheckoutEvidence: async (_tx: unknown,
    body: Record<string, unknown>) => {
    writes += 1;
    if (writeCode) throw new SyntheticEvidenceError(writeCode);
    stored = { evidenceId, ...body, auditLogId: "audit-id" };
    return stored;
  },
  readAmuxTrackedCheckoutEvidence: async (_tx: unknown,
    receivedIdeaId: string, ordinal: number) => {
    reads += 1;
    assert.equal(receivedIdeaId, ideaId);
    assert.equal(ordinal, 0);
    if (readFails) throw new Error("synthetic DB failure with private detail");
    return stored;
  },
} });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
    const result = await callback({ $queryRaw: async () => [] });
    if (unknownCommit) throw new Error("synthetic lost commit reply");
    return result;
  },
} } });

let route: typeof import("../../app/api/internal/amux/v19/checkout-evidence/route.ts");
before(async () => { route = await import(mod(
  "app/api/internal/amux/v19/checkout-evidence/route.ts")); });
after(() => {
  for (const name of envNames) {
    const value = previousEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const reset = () => {
  writes = 0; reads = 0; stored = null; writeCode = null;
  unknownCommit = false; readFails = false;
  process.env.TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET = secret;
  delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
  process.env.TOMVERSE_AMUX_V19_CHECKOUT_EVIDENCE_WRITE = "enabled";
  process.env.TOMVERSE_AMUX_V19_CHECKOUT_EVIDENCE_READ = "enabled";
};
const body = { ideaId, referenceOrdinal: 0, pinnedCommitSha: "a".repeat(40),
  excludedCount: 2, excludedPathDigest: "b".repeat(64),
  excludedPathDigestKeyId: "synthetic-digest-key",
  excludedReasons: { secret_path: 1, secret_content: 1,
    non_regular: 0, unscannable_content: 0 } };
const headers = { authorization: `Bearer ${secret}`,
  "x-amux-agent-id": "amux-intake" };
const post = (payload: unknown = body, extraHeaders: Record<string, string> = {}) =>
  new Request("https://tomverse.test/api/internal/amux/v19/checkout-evidence", {
    method: "POST", headers: { ...headers, "content-type": "application/json",
      ...extraHeaders }, body: JSON.stringify(payload),
  });
const get = (query = `?ideaId=${ideaId}&referenceOrdinal=0`,
  extraHeaders: Record<string, string> = {}) => new Request(
  `https://tomverse.test/api/internal/amux/v19/checkout-evidence${query}`,
  { headers: { ...headers, ...extraHeaders } });

test("only the dedicated analysis agent can use the closed proof route", async () => {
  reset();
  assert.equal((await route.POST(post(body, { authorization: "" }))).status, 401);
  assert.equal((await route.GET(get(undefined, { "x-amux-agent-id": "other" }))).status, 401);
  process.env.TOMVERSE_AMUX_SYNC_SECRET = secret;
  assert.equal((await route.POST(post())).status, 401);
  reset();
  delete process.env.TOMVERSE_AMUX_V19_CHECKOUT_EVIDENCE_WRITE;
  assert.equal((await route.POST(post())).status, 409);
  assert.equal(writes, 0);
  assert.equal((await route.GET(get())).status, 404,
    "readback remains available when writes stop");
  delete process.env.TOMVERSE_AMUX_V19_CHECKOUT_EVIDENCE_READ;
  process.env.TOMVERSE_AMUX_V19_CHECKOUT_EVIDENCE_WRITE = "enabled";
  assert.equal((await route.POST(post())).status, 409,
    "a write needs its readback gate too");
  assert.equal((await route.GET(get())).status, 409);
});

test("malformed proof or lookup never touches the writer or readback", async () => {
  reset();
  for (const payload of [{ ...body, pinnedCommitSha: "short" },
    { ...body, referenceOrdinal: 2_147_483_648 },
    { ...body, excludedCount: 2_147_483_648 },
    { ...body, excludedReasons: { ...body.excludedReasons, unexpected: 1 } },
    { ...body, filePaths: ["private/secret.md"] }]) {
    assert.equal((await route.POST(post(payload))).status, 400);
  }
  assert.equal((await route.POST(new Request(
    "https://tomverse.test/api/internal/amux/v19/checkout-evidence", {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: "{invalid-json",
    }))).status, 400);
  assert.equal((await route.POST(post({ ...body,
    excess: "x".repeat(5 * 1024) }))).status, 400);
  assert.equal((await route.POST(post(body, { "content-type": "text/plain" }))).status, 415);
  for (const query of ["", `?ideaId=${ideaId}&referenceOrdinal=00`,
    `?ideaId=${ideaId}&referenceOrdinal=2147483648`,
    `?ideaId=${ideaId}&referenceOrdinal=0&other=x`,
    `?ideaId=${ideaId}&ideaId=${ideaId}&referenceOrdinal=0`]) {
    assert.equal((await route.GET(get(query))).status, 400);
  }
  assert.equal(writes, 0);
  assert.equal(reads, 0);
  const absent = await route.GET(get());
  assert.equal(absent.status, 404);
  assert.deepEqual(await absent.json(), {
    status: "absent", ideaId, referenceOrdinal: 0, retryWrite: false });
  assert.equal(reads, 1);
});

test("verified proof commits once and returns only content-free identity", async () => {
  reset();
  const response = await route.POST(post());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.deepEqual(await response.json(), { evidenceId, ideaId, referenceOrdinal: 0 });
  assert.equal(writes, 1);
  const readback = await route.GET(get());
  assert.equal(readback.status, 200);
  assert.deepEqual(await readback.json(), { status: "recorded", evidenceId,
    ideaId, referenceOrdinal: 0, pinnedCommitSha: body.pinnedCommitSha,
    excludedCount: body.excludedCount,
    excludedReasons: body.excludedReasons,
    excludedPathDigest: body.excludedPathDigest,
    excludedPathDigestKeyId: body.excludedPathDigestKeyId });
  assert.equal(reads, 1);
});

test("known refusal and unknown commit both forbid blind POST retry", async () => {
  reset();
  for (const code of ["already_recorded", "idea_unavailable", "invalid_evidence"]) {
    writeCode = code;
    const refused = await route.POST(post());
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { error: code, retryWrite: false });
  }
  reset();
  unknownCommit = true;
  const uncertain = await route.POST(post());
  assert.equal(uncertain.status, 503);
  assert.deepEqual(await uncertain.json(), { error: "outcome_unknown", retryWrite: false });
  assert.equal(writes, 1);
  unknownCommit = false;
  assert.equal((await route.GET(get())).status, 200);
  readFails = true;
  const failedRead = await route.GET(get());
  assert.equal(failedRead.status, 503);
  assert.deepEqual(await failedRead.json(), {
    error: "readback_unavailable", retryWrite: false });
});
