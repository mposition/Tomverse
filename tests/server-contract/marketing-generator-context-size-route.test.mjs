import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

// The context route's size cap (2026-11-14: a 136,138-byte production context
// passed the old 128 KiB cap, the morning run got a 500 and nobody was told).
const mod = (path) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
let context = null;
let alerts = [];
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {} } });
mock.module(mod("lib/marketingStore.ts"), { namedExports: {
  runMarketingTransaction: async () => context,
} });
mock.module(mod("lib/operationalMonitoring.ts"), { namedExports: {
  reportOperationalIncident: async (input) => { alerts.push(input); return { notified: true }; },
} });
const { POST } = await import(mod("app/api/internal/marketing-generator-context/route.ts"));
const { MARKETING_GENERATOR_CONTEXT_MAX_BYTES } = await import(mod("lib/marketingGeneratorContext.ts"));

const SECRET = "g".repeat(40);
const before = { ...process.env };
const request = () => new Request("https://app.example.test/api/internal/marketing-generator-context", {
  method: "POST",
  headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
  body: JSON.stringify({ generatorRunId: "run-1" }),
});
// The analysis switch off: the morning inputs add nothing outside the transaction.
const contextOf = (bytes) => ({ analysis: { enabled: false, strategyDue: false }, assets: "a".repeat(bytes), marketIntel: "m".repeat(64) });

test.beforeEach(() => {
  alerts = [];
  process.env.MARKETING_GENERATOR_SUBMIT_SECRET = SECRET;
  delete process.env.MARKETING_AUTOMATION_KILL_SWITCH;
});
test.after(() => {
  for (const key of ["MARKETING_GENERATOR_SUBMIT_SECRET", "MARKETING_AUTOMATION_KILL_SWITCH"]) {
    if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
  }
});

test("the 2026-11-14 production context size fits under the cap", async () => {
  assert.ok(MARKETING_GENERATOR_CONTEXT_MAX_BYTES >= 1.5 * 136_138);
  context = contextOf(136_138);
  const response = await POST(request());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).context.assets.length, 136_138);
  assert.equal(alerts.length, 0);
});

test("a context over the cap is refused and reported with its largest parts", async () => {
  context = contextOf(MARKETING_GENERATOR_CONTEXT_MAX_BYTES + 1);
  const response = await POST(request());
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { code: "context_too_large" });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].code, "MARKETING_GENERATOR_CONTEXT_TOO_LARGE");
  assert.equal(alerts[0].context.capBytes, MARKETING_GENERATOR_CONTEXT_MAX_BYTES);
  assert.ok(alerts[0].context.bytes > MARKETING_GENERATOR_CONTEXT_MAX_BYTES);
  assert.match(alerts[0].context.largestParts, /^assets=\d+,marketIntel=\d+/);
});
