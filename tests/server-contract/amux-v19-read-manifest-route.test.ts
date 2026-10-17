import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, mock, test } from "node:test";

import { inspectAmuxTrackedCheckoutReadManifest } from
  "../../lib/amux/ideaTrackedCheckoutReadManifestCore.ts";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const secret = "v19_manifest_agent_secret_01234567890123456789";
const ideaId = "ea86a25b-919f-4714-a3d8-45ef5a18b175";
const manifestId = "dc86a25b-919f-4714-a3d8-45ef5a18b175";
const envNames = ["TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET",
  "TOMVERSE_AMUX_SYNC_SECRET", "TOMVERSE_AMUX_V19_READ_MANIFEST_WRITE",
  "TOMVERSE_AMUX_V19_READ_MANIFEST_READ",
  "TOMVERSE_AMUX_V4_CONTENT_RETENTION",
  "TOMVERSE_AMUX_V19_READ_MANIFEST_RETENTION"] as const;
const previousEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
let prepares = 0;
let writes = 0;
let reads = 0;
let stored: Record<string, unknown> | null = null;
let intentStored = false;
let writeCode: string | null = null;
let prepareFails = false;
let unknownCommit = false;
let readFails = false;

class SyntheticManifestError extends Error {
  constructor(readonly code: string) { super(code); }
}

mock.module(mod("lib/amux/ideaTrackedCheckoutReadManifestStore.ts"), { namedExports: {
  AmuxTrackedCheckoutReadManifestError: SyntheticManifestError,
  prepareAmuxTrackedCheckoutReadManifest: async (body: Record<string, unknown>) => {
    prepares += 1;
    const inspected = inspectAmuxTrackedCheckoutReadManifest(body as Parameters<
      typeof inspectAmuxTrackedCheckoutReadManifest>[0]);
    if (!inspected) throw new SyntheticManifestError("invalid_manifest");
    inspected.plaintext.fill(0);
    intentStored = true;
    if (prepareFails) throw new Error("synthetic uncertain key write");
    return { input: body, keys: {} };
  },
  recordAmuxTrackedCheckoutReadManifest: async (_tx: unknown,
    input: { manifestId: string; ideaId: string; referenceOrdinal: number; pinnedCommitSha: string;
      observed: { readFiles: string[] } }) => {
    writes += 1;
    if (writeCode) throw new SyntheticManifestError(writeCode);
    stored = { id: input.manifestId, ideaId: input.ideaId,
      referenceOrdinal: input.referenceOrdinal,
      pinnedCommitSha: input.pinnedCommitSha,
      fileCount: input.observed.readFiles.length, digest: "d".repeat(64),
      digestKeyId: "synthetic-digest-key", bodyPurgedAt: null,
      ciphertext: "must never leave the route", auditLogId: "private-audit-id" };
    return { manifestId: input.manifestId, fileCount: input.observed.readFiles.length,
      auditLogId: "private-audit-id" };
  },
  readAmuxTrackedCheckoutReadManifestReceipt: async (_tx: unknown,
    receivedIdeaId: string, ordinal: number) => {
    reads += 1;
    assert.equal(receivedIdeaId, ideaId);
    assert.equal(ordinal, 0);
    if (readFails) throw new Error("synthetic DB failure with private detail");
    return stored;
  },
  readAmuxTrackedCheckoutReadManifestKeyIntentReceipt: async (_tx: unknown,
    receivedIdeaId: string, ordinal: number) => {
    assert.equal(receivedIdeaId, ideaId);
    assert.equal(ordinal, 0);
    return intentStored ? { id: manifestId, ideaId,
      referenceOrdinal: 0, pinnedCommitSha: body.pinnedCommitSha,
      keyRetirementClaimedAt: null, keyDeletedAt: null } : null;
  },
} });
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
    const result = await callback({ $queryRaw: async () => [] });
    if (unknownCommit) throw new Error("synthetic lost commit reply");
    return result;
  },
} } });

let route: typeof import("../../app/api/internal/amux/v19/read-manifest/route.ts");
before(async () => { route = await import(mod(
  "app/api/internal/amux/v19/read-manifest/route.ts")); });
after(() => {
  for (const name of envNames) {
    const value = previousEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const reset = () => {
  prepares = 0; writes = 0; reads = 0; stored = null;
  intentStored = false;
  writeCode = null; prepareFails = false; unknownCommit = false;
  readFails = false;
  process.env.TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET = secret;
  delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
  process.env.TOMVERSE_AMUX_V19_READ_MANIFEST_WRITE = "enabled";
  process.env.TOMVERSE_AMUX_V19_READ_MANIFEST_READ = "enabled";
  process.env.TOMVERSE_AMUX_V4_CONTENT_RETENTION = "enabled";
  process.env.TOMVERSE_AMUX_V19_READ_MANIFEST_RETENTION = "enabled";
};
const body = { ideaId, referenceOrdinal: 0, pinnedCommitSha: "a".repeat(40),
  manifestId,
  observed: { kind: "verified_success", readFiles: ["docs/guide.md"] } };
const headers = { authorization: `Bearer ${secret}`,
  "x-amux-agent-id": "amux-intake" };
const post = (payload: unknown = body, extraHeaders: Record<string, string> = {}) =>
  new Request("https://tomverse.test/api/internal/amux/v19/read-manifest", {
    method: "POST", headers: { ...headers, "content-type": "application/json",
      ...extraHeaders }, body: JSON.stringify(payload),
  });
const get = (query = `?ideaId=${ideaId}&referenceOrdinal=0`,
  extraHeaders: Record<string, string> = {}) => new Request(
  `https://tomverse.test/api/internal/amux/v19/read-manifest${query}`,
  { headers: { ...headers, ...extraHeaders } });

test("dedicated worker auth and both gates guard manifest writes", async () => {
  reset();
  assert.equal((await route.POST(post(body, { authorization: "" }))).status, 401);
  assert.equal((await route.GET(get(undefined, { "x-amux-agent-id": "other" }))).status, 401);
  process.env.TOMVERSE_AMUX_SYNC_SECRET = secret;
  assert.equal((await route.POST(post())).status, 401);
  reset();
  delete process.env.TOMVERSE_AMUX_V19_READ_MANIFEST_WRITE;
  assert.equal((await route.POST(post())).status, 409);
  assert.equal((await route.GET(get())).status, 404);
  delete process.env.TOMVERSE_AMUX_V19_READ_MANIFEST_READ;
  process.env.TOMVERSE_AMUX_V19_READ_MANIFEST_WRITE = "enabled";
  assert.equal((await route.POST(post())).status, 409);
  assert.equal((await route.GET(get())).status, 409);
  reset();
  delete process.env.TOMVERSE_AMUX_V19_READ_MANIFEST_RETENTION;
  assert.equal((await route.POST(post())).status, 409);
  reset();
  delete process.env.TOMVERSE_AMUX_V4_CONTENT_RETENTION;
  assert.equal((await route.POST(post())).status, 200);
  assert.equal(prepares, 1);
});

test("malformed observations and lookups stop before key creation", async () => {
  reset();
  for (const payload of [{ ...body, ideaId: "bad" },
    { ...body, manifestId: "bad" },
    { ideaId, referenceOrdinal: 0, pinnedCommitSha: body.pinnedCommitSha,
      observed: body.observed },
    { ...body, referenceOrdinal: 2_147_483_648 },
    { ...body, pinnedCommitSha: "short" },
    { ...body, observed: { kind: "unverified", readFiles: [] } },
    { ...body, observed: { ...body.observed, extra: "x" } },
    { ...body, readFiles: ["docs/private.md"] }]) {
    assert.equal((await route.POST(post(payload))).status, 400);
  }
  assert.equal((await route.POST(post({ ...body,
    observed: { kind: "verified_success", readFiles: ["../secret"] } }))).status, 400);
  assert.equal((await route.POST(post(body,
    { "content-type": "text/plain" }))).status, 415);
  assert.equal((await route.POST(new Request(
    "https://tomverse.test/api/internal/amux/v19/read-manifest", {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: "{invalid-json",
    }))).status, 400);
  for (const query of ["", `?ideaId=${ideaId}&referenceOrdinal=00`,
    `?ideaId=${ideaId}&referenceOrdinal=2147483648`,
    `?ideaId=${ideaId}&referenceOrdinal=0&other=x`,
    `?ideaId=${ideaId}&ideaId=${ideaId}&referenceOrdinal=0`]) {
    assert.equal((await route.GET(get(query))).status, 400);
  }
  assert.equal(prepares, 1, "only the valid-shape path reaches core validation");
  assert.equal(writes, 0);
  assert.equal(reads, 0);
});

test("large verified read list is accepted without an arbitrary byte or file cap", async () => {
  reset();
  const paths = Array.from({ length: 20_000 }, (_, i) =>
    `docs/${String(i).padStart(5, "0")}-${"x".repeat(64)}.md`);
  const response = await route.POST(post({ ...body,
    observed: { kind: "verified_success", readFiles: paths } }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.deepEqual(await response.json(), { manifestId,
    ideaId, referenceOrdinal: 0, fileCount: paths.length });
  assert.equal(writes, 1);
  const readback = await route.GET(get());
  assert.equal(readback.status, 200);
  assert.deepEqual(await readback.json(), { status: "recorded", manifestId,
    ideaId, referenceOrdinal: 0, pinnedCommitSha: body.pinnedCommitSha,
    fileCount: paths.length, digest: "d".repeat(64),
    digestKeyId: "synthetic-digest-key", bodyPurged: false });
  assert.equal(reads, 1);
  stored = { ...stored, bodyPurgedAt: new Date() };
  assert.equal((await (await route.GET(get())).json() as { bodyPurged: boolean })
    .bodyPurged, true);
});

test("receipt and readback retain the caller-generated manifest ID", async () => {
  reset();
  const callerId = "fc86a25b-919f-4714-a3d8-45ef5a18b175";
  const response = await route.POST(post({ ...body, manifestId: callerId }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { manifestId: callerId,
    ideaId, referenceOrdinal: 0, fileCount: 1 });
  const readback = await route.GET(get());
  assert.equal(readback.status, 200);
  assert.equal((await readback.json() as { manifestId: string }).manifestId,
    callerId);
});

test("known refusals and uncertain key or commit outcomes forbid blind retries", async () => {
  reset();
  for (const code of ["already_recorded", "idea_unavailable",
    "evidence_unavailable"]) {
    writeCode = code;
    const refused = await route.POST(post());
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { error: code, retryWrite: false });
  }
  assert.deepEqual(await (await route.GET(get())).json(), {
    status: "key_intent", manifestId, ideaId, referenceOrdinal: 0,
    pinnedCommitSha: body.pinnedCommitSha,
    keyRetirementClaimed: false, keyRetirementRecorded: false,
    retryWrite: false });
  reset();
  prepareFails = true;
  const keyFailure = await route.POST(post());
  assert.equal(keyFailure.status, 503);
  assert.deepEqual(await keyFailure.json(), {
    error: "outcome_unknown", retryWrite: false });
  assert.equal(writes, 0);
  assert.deepEqual(await (await route.GET(get())).json(), {
    status: "key_intent", manifestId, ideaId, referenceOrdinal: 0,
    pinnedCommitSha: body.pinnedCommitSha,
    keyRetirementClaimed: false, keyRetirementRecorded: false,
    retryWrite: false });
  reset();
  unknownCommit = true;
  const uncertain = await route.POST(post());
  assert.equal(uncertain.status, 503);
  assert.deepEqual(await uncertain.json(), {
    error: "outcome_unknown", retryWrite: false });
  assert.equal(writes, 1);
  unknownCommit = false;
  assert.equal((await route.GET(get())).status, 200);
  readFails = true;
  const failedRead = await route.GET(get());
  assert.equal(failedRead.status, 503);
  assert.deepEqual(await failedRead.json(), {
    error: "readback_unavailable", retryWrite: false });
});
