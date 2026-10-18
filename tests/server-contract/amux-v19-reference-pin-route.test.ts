import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const secret = "v19_reference_pin_agent_secret_0123456789012345";
const ideaId = "ea86a25b-919f-4714-a3d8-45ef5a18b175";
const reservationId = "dc86a25b-919f-4714-a3d8-45ef5a18b175";
const claimId = "bc86a25b-919f-4714-a3d8-45ef5a18b175";
const names = ["TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET",
  "TOMVERSE_AMUX_SYNC_SECRET", "TOMVERSE_AMUX_V19_REFERENCE_PIN_READ",
  "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_QUEUE_READ",
  "TOMVERSE_AMUX_SESSION_INTAKE", "TOMVERSE_AMUX_V4_ANALYSIS_QUEUE_READ"] as const;
const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
let reads = 0;
let fail = false;
let received: unknown;
mock.module(mod("lib/amux/ideaSessionReferencePinRead.ts"), { namedExports: {
  readAmuxSessionReferencePin: async (input: unknown) => {
    reads += 1;
    received = input;
    if (fail) throw new Error("synthetic private DB error");
    return { referenceCount: 1, pinnedCommitSha: "a".repeat(40) };
  },
} });
let route: typeof import("../../app/api/internal/amux/v19/reference-pin/route.ts");
before(async () => { route = await import(mod(
  "app/api/internal/amux/v19/reference-pin/route.ts")); });
after(() => { for (const name of names) {
  if (prior[name] === undefined) delete process.env[name];
  else process.env[name] = prior[name];
} });
const reset = () => {
  reads = 0; fail = false; received = undefined;
  process.env.TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET = secret;
  delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
  for (const name of names.slice(2)) process.env[name] = "enabled";
};
const post = (body: unknown = { ideaId, reservationId, referenceOrdinal: 0 },
  headers: Record<string, string> = {}) => new Request(
  "https://tomverse.test/api/internal/amux/v19/reference-pin", {
    method: "POST", headers: { authorization: `Bearer ${secret}`,
      "x-amux-agent-id": "amux-intake", "content-type": "application/json",
      ...headers }, body: JSON.stringify(body),
  });

test("reference-pin read requires the exact agent and closed switches", async () => {
  reset();
  assert.equal((await route.POST(post(undefined, { authorization: "" }))).status, 401);
  process.env.TOMVERSE_AMUX_SYNC_SECRET = secret;
  assert.equal((await route.POST(post())).status, 401);
  reset();
  delete process.env.TOMVERSE_AMUX_V19_REFERENCE_PIN_READ;
  assert.equal((await route.POST(post())).status, 409);
  assert.equal(reads, 0);
});

test("reference-pin read refuses malformed identities before storage", async () => {
  reset();
  for (const body of [{ ideaId, reservationId, referenceOrdinal: -1 },
    { ideaId, reservationId, referenceOrdinal: 2_147_483_648 },
    { ideaId, reservationId, referenceOrdinal: 0, extra: true },
    { ideaId: "wrong", reservationId, referenceOrdinal: 0 },
    { ideaId, reservationId, referenceOrdinal: 0, claimId: "wrong" }]) {
    assert.equal((await route.POST(post(body))).status, 400);
  }
  assert.equal((await route.POST(post(undefined,
    { "content-type": "text/plain" }))).status, 415);
  assert.equal(reads, 0);
});

test("reference-pin read returns only a bounded content-free pin", async () => {
  reset();
  const response = await route.POST(post());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.deepEqual(await response.json(), { referenceCount: 1,
    pinnedCommitSha: "a".repeat(40) });
  assert.equal(reads, 1);
  assert.deepEqual(received, { ideaId, reservationId, referenceOrdinal: 0 });
  const claimed = await route.POST(post({ ideaId, reservationId,
    referenceOrdinal: 0, claimId }));
  assert.equal(claimed.status, 200);
  assert.deepEqual(received, { ideaId, reservationId,
    referenceOrdinal: 0, claimId });
  fail = true;
  assert.deepEqual(await (await route.POST(post())).json(),
    { error: "reference_pin_unavailable" });
});
