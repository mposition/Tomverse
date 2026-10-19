import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const secret = "max_checkout_secret_01234567890123456789";
const claimId = "916e54c9-63b2-4d0e-b449-5d562ae16a4b";
const requestId = "a2ce7b61-71b5-4d45-b5f9-7f7b579cc69a";
const reservationId = "bb3c01fe-8f75-4e14-8a0a-bc63536240f2";
const ideaId = "7542f64d-a8c1-4da7-8292-d953095f217e";
const evidenceId = "9b7e4b8e-2d34-48b2-95a5-333360b10816";
const envNames = ["TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET",
  "TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET", "TOMVERSE_AMUX_SYNC_SECRET",
  "TOMVERSE_AMUX_V19_MAX_CHECKOUT_EVIDENCE_WRITE",
  "TOMVERSE_AMUX_V19_MAX_CHECKOUT_EVIDENCE_READ",
  "TOMVERSE_AMUX_V19_CHECKOUT_EVIDENCE_WRITE",
  "TOMVERSE_AMUX_V19_CHECKOUT_EVIDENCE_READ"] as const;
const oldEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
let writes = 0;
let reads = 0;
let unknownCommit = false;
let stored: Record<string, unknown> | null = null;
let refusal: string | null = null;

class SyntheticEvidenceError extends Error {
  constructor(readonly code: string) { super(code); }
}
mock.module(mod("lib/amux/ideaTrackedCheckoutEvidenceStore.ts"), { namedExports: {
  AmuxTrackedCheckoutEvidenceError: SyntheticEvidenceError,
  recordAmuxTrackedCheckoutEvidence: async (_tx: unknown,
    proof: Record<string, unknown>, claim: Record<string, unknown>) => {
    writes += 1;
    assert.deepEqual(claim, { claimId, requestId, reservationId,
      invocationOrdinal: 0 });
    if (refusal) throw new SyntheticEvidenceError(refusal);
    stored = { evidenceId, ...proof };
    return stored;
  },
  readAmuxMaxTrackedCheckoutEvidence: async (_tx: unknown,
    receivedIdeaId: string, ordinal: number, claim: Record<string, unknown>) => {
    reads += 1;
    assert.equal(receivedIdeaId, ideaId);
    assert.equal(ordinal, 0);
    assert.deepEqual(claim, { claimId, requestId, reservationId,
      invocationOrdinal: 0 });
    return stored;
  },
} });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
    const result = await callback({ $queryRaw: async () => [] });
    if (unknownCommit) throw new Error("synthetic lost reply");
    return result;
  },
} } });

let route: typeof import("../../app/api/internal/amux/v19/max-checkout-evidence/route.ts");
before(async () => { route = await import(mod(
  "app/api/internal/amux/v19/max-checkout-evidence/route.ts")); });
after(() => { for (const name of envNames) {
  const value = oldEnv[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
} });
const reset = () => {
  writes = 0; reads = 0; stored = null; refusal = null; unknownCommit = false;
  process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET = secret;
  delete process.env.TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET;
  delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
  for (const name of envNames.filter((name) => name.endsWith("EVIDENCE_WRITE") ||
      name.endsWith("EVIDENCE_READ"))) process.env[name] = "enabled";
};
const body = { claimId, requestId, reservationId, ideaId,
  invocationOrdinal: 0, referenceOrdinal: 0,
  pinnedCommitSha: "a".repeat(40), excludedCount: 1,
  excludedPathDigest: "b".repeat(64),
  excludedPathDigestKeyId: "synthetic-key",
  excludedReasons: { secret_path: 1, secret_content: 0,
    non_regular: 0, unscannable_content: 0 } };
const headers = { authorization: `Bearer ${secret}`,
  "x-amux-agent-id": "amux-intake-max" };
const post = (payload: unknown = body,
  extra: Record<string, string> = {}) => new Request(
  "https://tomverse.test/api/internal/amux/v19/max-checkout-evidence", {
    method: "POST", headers: { ...headers,
      "content-type": "application/json", ...extra },
    body: JSON.stringify(payload),
  });
const get = (query?: string, extra: Record<string, string> = {}) => {
  const params = new URLSearchParams({ claimId, requestId, reservationId,
    ideaId, invocationOrdinal: "0", referenceOrdinal: "0" });
  return new Request("https://tomverse.test/api/internal/amux/v19/" +
    `max-checkout-evidence?${query ?? params.toString()}`,
  { headers: { ...headers, ...extra } });
};

test("Max proof route requires separate credential and both readback gates", async () => {
  reset();
  assert.equal((await route.POST(post(body, {
    "x-amux-agent-id": "amux-intake" }))).status, 401);
  assert.equal((await route.GET(get(undefined,
    { authorization: "Bearer wrong" }))).status, 401);
  process.env.TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET = secret;
  assert.equal((await route.POST(post())).status, 401);
  reset();
  delete process.env.TOMVERSE_AMUX_V19_MAX_CHECKOUT_EVIDENCE_WRITE;
  assert.equal((await route.POST(post())).status, 409);
  assert.equal(writes, 0);
  assert.equal((await route.GET(get())).status, 404);
  delete process.env.TOMVERSE_AMUX_V19_MAX_CHECKOUT_EVIDENCE_READ;
  assert.equal((await route.GET(get())).status, 409);
});

test("Max proof route rejects malformed identity and does not write", async () => {
  reset();
  for (const payload of [{ ...body, claimId: "bad" },
    { ...body, invocationOrdinal: 2_147_483_648 },
    { ...body, referenceOrdinal: -1 },
    { ...body, filePaths: ["private/path"] }]) {
    assert.equal((await route.POST(post(payload))).status, 400);
  }
  assert.equal((await route.GET(get(`claimId=${claimId}&ideaId=${ideaId}`))).status,
    400);
  assert.equal(writes, 0);
  assert.equal(reads, 0);
});

test("Max proof write and exact readback expose only aggregate evidence", async () => {
  reset();
  const response = await route.POST(post());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { evidenceId, ideaId,
    referenceOrdinal: 0 });
  assert.equal(writes, 1);
  const receipt = await route.GET(get());
  assert.equal(receipt.status, 200);
  assert.equal((await receipt.json()).excludedPathDigest,
    body.excludedPathDigest);
  assert.equal(reads, 1);
});

test("refused and uncertain writes never invite a second POST", async () => {
  reset();
  refusal = "claim_unavailable";
  const denied = await route.POST(post());
  assert.deepEqual(await denied.json(), { error: "claim_unavailable",
    retryWrite: false });
  reset();
  unknownCommit = true;
  const uncertain = await route.POST(post());
  assert.equal(uncertain.status, 503);
  assert.deepEqual(await uncertain.json(), { error: "outcome_unknown",
    retryWrite: false });
});
