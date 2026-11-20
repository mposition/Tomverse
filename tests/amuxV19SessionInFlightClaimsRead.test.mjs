import assert from "node:assert/strict";
import { after, test } from "node:test";

import { readAmuxV19SessionInFlightShadowClaims } from
  "../lib/amux/ideaLocalSessionInFlightClaimsRead.mjs";
import { installAmuxV19FakeAppTiming } from "./support/amuxV19FakeAppTiming.mjs";

installAmuxV19FakeAppTiming();
const originName = "TOMVERSE_AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN";
const secretName = "TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET";
const previous = [originName, secretName].map((name) => [name, process.env[name]]);
process.env[originName] = "https://tomverse.test/";
process.env[secretName] = "v19_max_launcher_secret_01234567890123456789";
after(() => {
  for (const [name, value] of previous) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const claim = (n) => ({ claimId: `ea86a25b-919f-4714-a3d8-45ef5a18b17${n}`,
  requestId: `ea86a25b-919f-4714-a3d8-45ef5a18b18${n}`,
  reservationId: `ea86a25b-919f-4714-a3d8-45ef5a18b19${n}`,
  ideaId: `ea86a25b-919f-4714-a3d8-45ef5a18b1a${n}`, invocationOrdinal: n });
const beforeMs = Date.now() - 60_000;
const ask = (fetchImpl, overrides = {}) => readAmuxV19SessionInFlightShadowClaims({
  origin: "https://tomverse.test/", beforeMs, fetchImpl, ...overrides });

test("the in-flight list is one authenticated read-only GET bound to the marker time", async () => {
  let calls = 0;
  const result = await ask(async (url, request) => {
    calls += 1;
    const endpoint = new URL(url);
    assert.equal(endpoint.pathname,
      "/api/internal/amux/v19/analysis-budget/in-flight");
    assert.deepEqual([...endpoint.searchParams.entries()],
      [["before", new Date(beforeMs).toISOString()]]);
    assert.equal(request.method, "GET");
    assert.equal(request.redirect, "manual");
    assert.equal(request.cache, "no-store");
    assert.equal(request.body, undefined);
    assert.equal(request.headers.authorization,
      `Bearer ${process.env[secretName]}`);
    assert.equal(request.headers["x-amux-agent-id"], "amux-intake-max");
    return Response.json({ claims: [claim(0), claim(1), claim(2)] });
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { kind: "listed",
    claims: [claim(0), claim(1), claim(2)] });
});

test("an empty list is a list, and the answer has no count limit", async () => {
  assert.deepEqual(await ask(async () => Response.json({ claims: [] })),
    { kind: "listed", claims: [] });
  const many = Array.from({ length: 500 }, (_, index) => ({
    ...claim(0), invocationOrdinal: index }));
  const result = await ask(async () => Response.json({ claims: many }));
  assert.equal(result.kind, "listed");
  assert.equal(result.claims.length, 500);
});

test("a listed claim is rebuilt from its five identity fields only", async () => {
  // An extra field is a reply this runner does not understand, not a field to copy.
  const result = await ask(async () => Response.json({
    claims: [{ ...claim(0), prompt: "secret" }] }));
  assert.deepEqual(result, { kind: "unavailable", reason: "response_invalid" });
});

test("a reply that is not the exact shape is unavailable, never a partial list", async () => {
  const bad = [{}, { claims: "x" }, { claims: [{ ...claim(0), claimId: "x" }] },
    { claims: [claim(0), { ...claim(1), invocationOrdinal: -1 }] },
    { claims: [{ ...claim(0), invocationOrdinal: "0" }] },
    { claims: [claim(0)], extra: 1 }, { claims: [null] }];
  for (const body of bad) {
    assert.deepEqual(await ask(async () => Response.json(body)),
      { kind: "unavailable", reason: "response_invalid" }, JSON.stringify(body));
  }
  assert.deepEqual(await ask(async () => new Response("not json", { status: 200,
    headers: { "content-type": "text/plain" } })),
  { kind: "unavailable", reason: "response_invalid" });
});

test("a refusal or an app error is unavailable and names why", async () => {
  for (const status of [400, 401, 403, 409]) {
    assert.deepEqual(await ask(async () => Response.json({ error: "x" }, { status })),
      { kind: "unavailable", reason: "response_invalid" }, String(status));
  }
});

test("a read is asked again through a dropped link and a gateway answer", async () => {
  let calls = 0;
  const result = await ask(async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new TypeError("fetch failed"),
      { cause: { code: "EAI_AGAIN" } });
    if (calls === 2) return new Response("", { status: 503 });
    return Response.json({ claims: [claim(0)] });
  });
  assert.equal(calls, 3);
  assert.equal(result.kind, "listed");
});

test("a time that is missing, not a number or in the future, or an unpinned origin, is refused before any request", async () => {
  const never = async () => { throw new Error("must not be sent"); };
  for (const overrides of [{ beforeMs: undefined }, { beforeMs: Number.NaN },
    { beforeMs: 0 }, { beforeMs: -1 }, { beforeMs: Date.now() + 60_000 },
    { origin: "https://other.test/" }, { origin: "http://tomverse.test/" },
    { origin: "https://tomverse.test/path" }, { fetchImpl: "not a function" }]) {
    assert.deepEqual(await readAmuxV19SessionInFlightShadowClaims({
      origin: "https://tomverse.test/", beforeMs, fetchImpl: never,
      ...overrides }), { kind: "refused" }, JSON.stringify(overrides));
  }
  const old = process.env[secretName];
  process.env[secretName] = "short";
  try { assert.deepEqual(await ask(never), { kind: "refused" }); }
  finally { process.env[secretName] = old; }
});
