import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const root = resolve(import.meta.dirname, "../..");
const url = (path: string) => pathToFileURL(resolve(root, path)).href;
const require = createRequire(import.meta.url);
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
process.env.NEXTAUTH_SECRET = "response-latency-test-only";
process.env.ALLOWED_REQUEST_HOSTS = "localhost:3100";
process.env.NEXTAUTH_URL = "http://localhost:3100";
delete process.env.E2E_DISABLE_DATABASE;

const writes: Record<string, unknown>[] = [];
const samples = new Map<string, unknown>();
let unavailable = false;
const prisma = {
  responseLatencySample: {
    createMany: async (args: { data: { id: string }[]; skipDuplicates: boolean }) => {
      writes.push(args);
      assert.equal(args.skipDuplicates, true);
      for (const row of args.data) if (!samples.has(row.id)) samples.set(row.id, row);
      if (unavailable) throw new Error("database unavailable");
    },
    findMany: async () => { if (unavailable) throw new Error("database unavailable"); return [...samples.values()]; },
  },
  comparisonReviewRun: { findMany: async () => [] },
};
mock.module(url("lib/prisma.ts"), { namedExports: { prisma } });
const security = require(resolve(root, "lib/apiSecurity.ts")) as Record<string, unknown>;
let limited = false;
mock.module(url("lib/apiSecurity.ts"), { namedExports: { ...security,
  consumeApiRateLimit: async () => { if (limited) throw new Error("rate limited"); },
} });

let loaded: {
  POST: (request: Request) => Promise<Response>;
  createToken: (id: string, product: "chat", mode: "auto") => string | null;
  evidence: () => Promise<{ status: string }>;
} | undefined;
async function load() {
  if (!loaded) {
    const route = await import(url("app/api/chat/timing/route.ts"));
    const token = await import(url("lib/responseLatencyToken.ts"));
    const store = await import(url("lib/responseLatencyStore.ts"));
    loaded = { POST: route.POST, createToken: token.createResponseLatencyToken, evidence: store.readResponseLatencyEvidence };
  }
  return loaded;
}
const request = (body: unknown, origin: string | null = "http://localhost:3100") => new Request("http://localhost:3100/api/chat/timing", {
  method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body),
});

test("timing endpoint rejects absent/foreign origins, forged proofs and content fields before writing", async () => {
  const { POST, createToken } = await load();
  const body = { token: createToken(randomUUID(), "chat", "auto"), outcome: "completed", prepareMs: 5, firstContentMs: 10, completionMs: 20 };
  const before = writes.length;
  assert.equal((await POST(request(body, null))).status, 403);
  assert.equal((await POST(request(body, "https://attacker.test"))).status, 403);
  assert.equal((await POST(request({ ...body, token: "forged" }))).status, 403);
  assert.equal((await POST(request({ ...body, prompt: "never store this" }))).status, 400);
  assert.equal((await POST(request({ ...body, firstContentMs: 3 }))).status, 400);
  assert.equal(writes.length, before);
});

test("a valid proof records one sample; replay cannot overwrite it or choose dimensions", async () => {
  const { POST, createToken } = await load();
  const id = randomUUID();
  const body = { token: createToken(id, "chat", "auto"), outcome: "completed", prepareMs: 5, firstContentMs: 10, completionMs: 20 };
  assert.equal((await POST(request(body))).status, 204);
  assert.equal((await POST(request({ ...body, completionMs: 30 }))).status, 204);
  assert.deepEqual(samples.get(`${id}:client`), {
    id: `${id}:client`, product: "chat", mode: "auto", modelId: null, provider: null, source: "client", outcome: "completed",
    timings: { prepareMs: 5, firstContentMs: 10, completionMs: 20 },
  });
  limited = true;
  const before = writes.length;
  assert.notEqual((await POST(request(body))).status, 204);
  assert.equal(writes.length, before);
  limited = false;
});

test("telemetry outages do not break responses and are not represented as zero latency", async () => {
  const { POST, createToken, evidence } = await load();
  unavailable = true;
  try {
    assert.equal((await POST(request({ token: createToken(randomUUID(), "chat", "auto"), outcome: "failed", prepareMs: 5, firstContentMs: null, completionMs: 20 }))).status, 204);
    assert.deepEqual(await evidence(), { status: "unavailable", windowDays: 7 });
  } finally { unavailable = false; }
});
