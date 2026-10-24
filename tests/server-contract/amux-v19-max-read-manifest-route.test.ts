import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const secret = "max_manifest_secret_01234567890123456789";
const claimId = "916e54c9-63b2-4d0e-b449-5d562ae16a4b";
const requestId = "a2ce7b61-71b5-4d45-b5f9-7f7b579cc69a";
const reservationId = "bb3c01fe-8f75-4e14-8a0a-bc63536240f2";
const ideaId = "7542f64d-a8c1-4da7-8292-d953095f217e";
const manifestId = "9b7e4b8e-2d34-48b2-95a5-333360b10816";
const envNames = ["TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET",
  "TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET", "TOMVERSE_AMUX_SYNC_SECRET",
  "TOMVERSE_AMUX_V19_MAX_READ_MANIFEST_WRITE",
  "TOMVERSE_AMUX_V19_MAX_READ_MANIFEST_READ",
  "TOMVERSE_AMUX_V19_READ_MANIFEST_WRITE",
  "TOMVERSE_AMUX_V19_READ_MANIFEST_READ",
  "TOMVERSE_AMUX_V19_READ_MANIFEST_RETENTION"] as const;
const oldEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
let prepares = 0;
let writes = 0;
let reads = 0;
let bound = true;
let unknownCommit = false;
let stored = false;
class SyntheticManifestError extends Error {
  constructor(readonly code: string) { super(code); }
}
const claim = { claimId, requestId, reservationId, invocationOrdinal: 0 };
mock.module(mod("lib/amux/ideaTrackedCheckoutReadManifestStore.ts"), {
  namedExports: {
    AmuxTrackedCheckoutReadManifestError: SyntheticManifestError,
    prepareAmuxTrackedCheckoutReadManifest: async (input: unknown,
      givenClaim: unknown) => {
      prepares += 1;
      assert.deepEqual(givenClaim, claim);
      return { input, keys: {} };
    },
    recordAmuxTrackedCheckoutReadManifest: async (_tx: unknown,
      input: { observed: { readFiles: string[] } }, _keys: unknown,
      givenClaim: unknown) => {
      writes += 1;
      assert.deepEqual(givenClaim, claim);
      stored = true;
      return { manifestId, fileCount: input.observed.readFiles.length };
    },
    readAmuxMaxManifestForClaim: async (_tx: unknown,
      receivedIdeaId: string, ordinal: number, givenClaim: unknown) => {
      reads += 1;
      assert.equal(receivedIdeaId, ideaId);
      assert.equal(ordinal, 0);
      assert.deepEqual(givenClaim, claim);
      // Only the page this claim's binding names is readable.
      return stored && bound ? {
        intent: { id: manifestId, ideaId, referenceOrdinal: 0,
          pinnedCommitSha: "a".repeat(40), auditLogId: "audit-id",
          keyRetirementClaimedAt: null, keyDeletedAt: null },
        manifest: { id: manifestId, ideaId, referenceOrdinal: 0,
          pinnedCommitSha: "a".repeat(40), fileCount: 1,
          digest: "d".repeat(64), digestKeyId: "digest-key",
          bodyPurgedAt: null },
      } : null;
    },
  },
});
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
    const result = await callback({ $queryRaw: async () => [] });
    if (unknownCommit) throw new Error("synthetic lost commit reply");
    return result;
  },
} } });

let route: typeof import("../../app/api/internal/amux/v19/max-read-manifest/route.ts");
before(async () => { route = await import(mod(
  "app/api/internal/amux/v19/max-read-manifest/route.ts")); });
after(() => { for (const name of envNames) {
  const value = oldEnv[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
} });
const reset = () => {
  prepares = 0; writes = 0; reads = 0; bound = true;
  unknownCommit = false; stored = false;
  process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET = secret;
  delete process.env.TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET;
  delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
  for (const name of envNames.filter((name) => name.includes("MANIFEST_") &&
      (name.endsWith("WRITE") || name.endsWith("READ") ||
        name.endsWith("RETENTION")))) process.env[name] = "enabled";
};
const body = { ...claim, ideaId, referenceOrdinal: 0, manifestId,
  pinnedCommitSha: "a".repeat(40),
  observed: { kind: "verified_success", readFiles: ["README.md"] } };
const headers = { authorization: `Bearer ${secret}`,
  "x-amux-agent-id": "amux-intake-max" };
const endpoint = "https://tomverse.test/api/internal/amux/v19/max-read-manifest";
const post = (payload: unknown = body,
  extra: Record<string, string> = {}) => new Request(endpoint, {
    method: "POST", headers: { ...headers,
      "content-type": "application/json", ...extra },
    body: JSON.stringify(payload),
  });
const get = (query?: string, extra: Record<string, string> = {}) => {
  const params = new URLSearchParams({ ...claim, ideaId,
    invocationOrdinal: "0", referenceOrdinal: "0" });
  return new Request(`${endpoint}?${query ?? params.toString()}`,
    { headers: { ...headers, ...extra } });
};

test("Max manifest needs a separate credential and both readback gates", async () => {
  reset();
  assert.equal((await route.POST(post(body,
    { "x-amux-agent-id": "amux-intake" }))).status, 401);
  process.env.TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET = secret;
  assert.equal((await route.POST(post())).status, 401);
  reset();
  delete process.env.TOMVERSE_AMUX_V19_MAX_READ_MANIFEST_WRITE;
  assert.equal((await route.POST(post())).status, 409);
  assert.equal(prepares, 0);
  assert.equal((await route.GET(get())).status, 404);
  delete process.env.TOMVERSE_AMUX_V19_MAX_READ_MANIFEST_READ;
  assert.equal((await route.GET(get())).status, 409);
});

test("malformed claim or paths never prepare an external key", async () => {
  reset();
  for (const payload of [{ ...body, claimId: "bad" },
    { ...body, invocationOrdinal: 2_147_483_648 },
    { ...body, observed: { kind: "unknown", readFiles: [] } },
    { ...body, filePaths: ["private/path"] }]) {
    assert.equal((await route.POST(post(payload))).status, 400);
  }
  assert.equal((await route.GET(get(`claimId=${claimId}`))).status, 400);
  assert.equal(prepares, 0);
});

test("Max manifest commits once and only its claim may read it", async () => {
  reset();
  const response = await route.POST(post());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { manifestId, ideaId,
    referenceOrdinal: 0, fileCount: 1 });
  assert.equal(prepares, 1);
  assert.equal(writes, 1);
  const receipt = await route.GET(get());
  assert.equal(receipt.status, 200);
  assert.equal((await receipt.json()).manifestId, manifestId);
  assert.equal(reads, 1);
  bound = false;
  assert.equal((await route.GET(get())).status, 404);
  assert.equal(reads, 2);
});

test("uncertain manifest commit does not invite a second POST", async () => {
  reset();
  unknownCommit = true;
  const response = await route.POST(post());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "outcome_unknown",
    retryWrite: false });
  assert.equal(prepares, 1);
  assert.equal(writes, 1);
});
