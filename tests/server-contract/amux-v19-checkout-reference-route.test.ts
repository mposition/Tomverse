import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, mock, test } from "node:test";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const secret = "v19_checkout_reference_agent_secret_0123456789";
const ideaId = "ea86a25b-919f-4714-a3d8-45ef5a18b175";
const reservationId = "dc86a25b-919f-4714-a3d8-45ef5a18b175";
const claimId = "bc86a25b-919f-4714-a3d8-45ef5a18b175";
const names = ["TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET",
  "TOMVERSE_AMUX_SYNC_SECRET", "TOMVERSE_AMUX_V19_CHECKOUT_REFERENCE_READ",
  "TOMVERSE_AMUX_V19_REFERENCE_PIN_READ",
  "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_QUEUE_READ",
  "TOMVERSE_AMUX_SESSION_INTAKE", "TOMVERSE_AMUX_V4_ANALYSIS_QUEUE_READ"] as const;
const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
let reads = 0;
let fail = false;
let missing = false;
let received: unknown;
const reference = { referenceCount: 1, kind: "repository",
  repository: "mposition/Tomverse", pullRequestNumber: null,
  pinnedCommitSha: "a".repeat(40) };
mock.module(mod("lib/amux/ideaSessionCheckoutReferenceRead.ts"), { namedExports: {
  readAmuxSessionCheckoutReference: async (input: unknown) => {
    reads += 1;
    received = input;
    if (fail) throw new Error("synthetic private DB error");
    if (missing) return null;
    return reference;
  },
} });
let route: typeof import("../../app/api/internal/amux/v19/checkout-reference/route.ts");
before(async () => { route = await import(mod(
  "app/api/internal/amux/v19/checkout-reference/route.ts")); });
after(() => { for (const name of names) {
  if (prior[name] === undefined) delete process.env[name];
  else process.env[name] = prior[name];
} });
const reset = () => {
  reads = 0; fail = false; missing = false; received = undefined;
  process.env.TOMVERSE_AMUX_V4_ANALYSIS_AGENT_SECRET = secret;
  delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
  for (const name of names.slice(2)) process.env[name] = "enabled";
};
const post = (body: unknown = { ideaId, reservationId, claimId, referenceOrdinal: 0 },
  headers: Record<string, string> = {}) => new Request(
  "https://tomverse.test/api/internal/amux/v19/checkout-reference", {
    method: "POST", headers: { authorization: `Bearer ${secret}`,
      "x-amux-agent-id": "amux-intake", "content-type": "application/json",
      ...headers }, body: JSON.stringify(body),
  });

test("checkout reference is closed without the exact agent and all read switches", async () => {
  reset();
  assert.equal((await route.POST(post(undefined, { authorization: "" }))).status, 401);
  process.env.TOMVERSE_AMUX_SYNC_SECRET = secret;
  assert.equal((await route.POST(post())).status, 401);
  for (const name of names.slice(2)) {
    reset();
    delete process.env[name];
    assert.equal((await route.POST(post())).status, 409, name);
    assert.equal(reads, 0, name);
  }
});

test("checkout reference requires an exact claim and bounded request", async () => {
  reset();
  for (const body of [
    { ideaId, reservationId, referenceOrdinal: 0 },
    { ideaId, reservationId, claimId: "wrong", referenceOrdinal: 0 },
    { ideaId, reservationId, claimId, referenceOrdinal: -1 },
    { ideaId, reservationId, claimId, referenceOrdinal: 0, extra: true },
  ]) assert.equal((await route.POST(post(body))).status, 400);
  assert.equal((await route.POST(post(undefined,
    { "content-type": "text/plain" }))).status, 415);
  assert.equal(reads, 0);
});

test("checkout reference returns one no-store target and hides read failures", async () => {
  reset();
  const response = await route.POST(post());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.deepEqual(await response.json(), reference);
  assert.deepEqual(received, { ideaId, reservationId, claimId,
    referenceOrdinal: 0 });
  missing = true;
  const notReady = await route.POST(post());
  assert.equal(notReady.status, 409);
  assert.deepEqual(await notReady.json(), { error: "not_ready" });
  missing = false;
  fail = true;
  assert.deepEqual(await (await route.POST(post())).json(),
    { error: "checkout_reference_unavailable" });
});
