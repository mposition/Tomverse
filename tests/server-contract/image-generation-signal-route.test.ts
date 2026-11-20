// Contract: the signal route authenticates first, accepts only the kinds a
// browser may send (never `download`), answers 204 for the caller's own
// generation and 404 for anyone else's, and never echoes the id it was given.
// The writer itself is exercised in tests/imageGenerationSignals.test.ts and
// against a real database in tests/integration.

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(ROOT, path)).href;
const require = createRequire(import.meta.url);

process.env.E2E_DISABLE_DATABASE = "true";
process.env.NEXTAUTH_URL ||= "http://127.0.0.1:3100";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";
process.env.NEXTAUTH_SECRET ||= "image-signal-contract-2026";

type Call = { userId: string; generationId: string; kind: string };

let sessionOverride: unknown = null;
let ownGenerations = new Set<string>();
const recorded: Call[] = [];
const cleared: Call[] = [];
let mocksInstalled = false;

async function loadRoute() {
  if (!mocksInstalled) {
    mocksInstalled = true;
    const realApiSecurity = require(resolve(ROOT, "lib/apiSecurity.ts")) as Record<string, unknown>;
    mock.module("next-auth/next", { namedExports: { getServerSession: async () => sessionOverride } });
    mock.module(mod("lib/apiSecurity.ts"), {
      namedExports: { ...realApiSecurity, consumeApiRateLimit: async () => undefined },
    });
    mock.module(mod("lib/imageGenerationSignals.ts"), {
      namedExports: {
        recordImageGenerationSignal: async (input: Call) => {
          recorded.push(input);
          return ownGenerations.has(input.generationId) ? { ok: true } : { ok: false, reason: "not_found" };
        },
        clearImageGenerationSignal: async (input: Call) => {
          cleared.push(input);
          return ownGenerations.has(input.generationId) ? { ok: true } : { ok: false, reason: "not_found" };
        },
      },
    });
  }
  return import(mod("app/api/images/generations/[generationId]/signal/route.ts"));
}

const url = "http://127.0.0.1:3100/api/images/generations/gen-1/signal";
const post = (body: unknown) =>
  new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const del = (kind?: string) => new Request(kind ? `${url}?kind=${kind}` : url, { method: "DELETE" });
const params = (generationId: string) => ({ params: Promise.resolve({ generationId }) });

test("no session is a 401 before anything is written", async () => {
  sessionOverride = null;
  recorded.length = 0;
  cleared.length = 0;
  const { POST, DELETE } = await loadRoute();
  assert.equal((await POST(post({ kind: "helpful" }), params("gen-1"))).status, 401);
  assert.equal((await DELETE(del("helpful"), params("gen-1"))).status, 401);
  assert.equal(recorded.length, 0);
  assert.equal(cleared.length, 0);
});

test("a kind the browser may not send is a 400 and writes nothing", async () => {
  sessionOverride = { user: { id: "u1" } };
  ownGenerations = new Set(["gen-1"]);
  recorded.length = 0;
  const { POST } = await loadRoute();
  for (const body of [{ kind: "download" }, { kind: "bogus" }, {}, { kind: "helpful", extra: 1 }]) {
    assert.equal((await POST(post(body), params("gen-1"))).status, 400, JSON.stringify(body));
  }
  assert.equal(recorded.length, 0);
});

test("the caller's own generation answers 204 and records the signal for that user", async () => {
  sessionOverride = { user: { id: "u1" } };
  ownGenerations = new Set(["gen-1"]);
  recorded.length = 0;
  const { POST } = await loadRoute();
  for (const kind of ["selected", "helpful", "not_helpful", "wanted_text"]) {
    const response = await POST(post({ kind }), params("gen-1"));
    assert.equal(response.status, 204);
    assert.equal(await response.text(), "");
  }
  assert.deepEqual(recorded.at(-1), { userId: "u1", generationId: "gen-1", kind: "wanted_text" });
  assert.equal(recorded.length, 4);
});

test("a generation that is not the caller's is a 404 that does not repeat the id", async () => {
  sessionOverride = { user: { id: "u1" } };
  ownGenerations = new Set();
  const { POST, DELETE } = await loadRoute();
  for (const response of [
    await POST(post({ kind: "helpful" }), params("gen-1")),
    await DELETE(del("helpful"), params("gen-1")),
  ]) {
    assert.equal(response.status, 404);
    assert.ok(!JSON.stringify(await response.json()).includes("gen-1"));
  }
});

test("DELETE takes back a toggle kind, and refuses a kind that cannot be taken back", async () => {
  sessionOverride = { user: { id: "u1" } };
  ownGenerations = new Set(["gen-1"]);
  cleared.length = 0;
  const { DELETE } = await loadRoute();
  assert.equal((await DELETE(del("not_helpful"), params("gen-1"))).status, 204);
  assert.deepEqual(cleared, [{ userId: "u1", generationId: "gen-1", kind: "not_helpful" }]);
  for (const kind of ["selected", "download", undefined]) {
    assert.equal((await DELETE(del(kind), params("gen-1"))).status, 400, String(kind));
  }
  assert.equal(cleared.length, 1);
});
