import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const mod = (path) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
const NOW = new Date("2026-11-13T00:00:00.000Z");
const settings = new Map();
let suggestions = [], router = [], audits = [], rejectAudit = false;
let tail = Promise.resolve();
const tx = {
  $executeRaw: async () => 1,
  appSetting: {
    findUnique: async ({ where }) => settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null,
    findMany: async ({ where }) => [...settings].filter(([key]) => where.key.startsWith ? key.startsWith(where.key.startsWith) : where.key.in.includes(key)).map(([key, value]) => ({ key, value })),
    upsert: async ({ where, create, update }) => { settings.set(where.key, settings.has(where.key) ? update.value : create.value); },
    create: async ({ data }) => { assert.equal(settings.has(data.key), false); settings.set(data.key, data.value); },
  },
  productResearchSuggestion: {
    findFirst: async ({ where }) => [...suggestions].sort((a, b) => a.createdAt - b.createdAt).find((row) => row.status === where.status && row.amuxIdeaId === null && !where.id.notIn.includes(row.id) &&
      (where.subject ? row.subject.startsWith(where.subject.startsWith) : !row.subject.startsWith(where.NOT.subject.startsWith))) ?? null,
    findUnique: async ({ where }) => suggestions.find((row) => row.id === where.id) ?? null,
  },
};
const prisma = { ...tx, $transaction: async (fn) => {
  const before = tail;
  let release;
  tail = new Promise((done) => { release = done; });
  await before;
  const saved = new Map(settings), auditCount = audits.length;
  try { return await fn(tx); } catch (error) {
    settings.clear(); for (const [key, value] of saved) settings.set(key, value);
    audits.length = auditCount; throw error;
  } finally { release(); }
} };
const writeAudit = async (entry) => { if (rejectAudit) throw new Error("audit refused"); audits.push(entry); };
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma } });
mock.module(mod("lib/adminAudit.ts"), { namedExports: { takeAuditChainLock: async () => {}, writeSystemAuditLog: writeAudit, writeAdminAuditLog: writeAudit } });
mock.module(mod("lib/autoRouterRecAgent.ts"), { namedExports: { claimRecommendationInTransaction: async () => router.shift() ?? null } });

const { claimDailyProductTask, recordDailyProductResult, retryDailyProductTask } = await import(mod("lib/dailyProductAgentStore.ts"));
const { reserveScoutSend } = await import(mod("lib/productResearchScoutStore.ts"));
const { sendScoutSuggestion } = await import(mod("lib/productResearchScoutSend.ts"));
const { DAILY_PRODUCT_AGENT_CURSOR, DAILY_PRODUCT_AGENT_DAY, dailyProductAgentKey } = await import(mod("lib/dailyProductAgentCore.ts"));
const oldSwitch = process.env.DAILY_PRODUCT_AGENT_ENABLED;
test.beforeEach(() => { settings.clear(); suggestions = []; router = []; audits = []; rejectAudit = false; process.env.DAILY_PRODUCT_AGENT_ENABLED = "true"; });
test.after(() => { if (oldSwitch === undefined) delete process.env.DAILY_PRODUCT_AGENT_ENABLED; else process.env.DAILY_PRODUCT_AGENT_ENABLED = oldSwitch; });
const row = (id, subject = "home.en", age = 0) => ({ id, subject, status: "open", amuxIdeaId: null,
  createdAt: new Date(NOW.getTime() + age), title: `Improve ${id}`, evidence: "Synthetic evidence", suggestion: "Fix and verify", area: "copy", severity: "low" });
const claim = () => claimDailyProductTask({ origin: "https://app.example.test", now: NOW });

test("disabled daily mode performs no claim or audit", async () => {
  delete process.env.DAILY_PRODUCT_AGENT_ENABLED; suggestions = [row("one")];
  assert.equal(await claim(), null); assert.equal(settings.size, 0); assert.equal(audits.length, 0);
});

test("research, routing and embedded memory rotate with oldest-first selection", async () => {
  suggestions = [row("new", "home.en", 100), row("old", "home.en", -100), row("memory", "memory.continuation.ko")];
  router = [{ id: "cycle:0", recommendation: "Code recommendation" }];
  const claims = [await claim(), await claim(), await claim(), await claim()];
  assert.deepEqual(claims.map((item) => item.id), ["scout.old", "cycle:0", "scout.memory", "scout.new"]);
  assert.ok(claims[0].instruction.includes("Synthetic evidence"));
  assert.equal(JSON.parse(settings.get(DAILY_PRODUCT_AGENT_DAY)).count, 4);
  assert.ok(suggestions.every((item) => item.status === "open"));
});

test("concurrent claims get different suggestions and audit failure rolls back ownership", async () => {
  suggestions = [row("one"), row("two")];
  const claims = await Promise.all([claim(), claim()]);
  assert.equal(new Set(claims.map((item) => item.id)).size, 2);
  assert.equal(audits.length, 2);
  suggestions.push(row("three")); rejectAudit = true;
  await assert.rejects(claim(), /audit refused/);
  assert.equal(settings.has(dailyProductAgentKey("scout.three")), false);
  assert.equal(JSON.parse(settings.get(DAILY_PRODUCT_AGENT_DAY)).count, 2);
});

test("an expired, failed or corrupt source is never automatically reclaimed", async () => {
  suggestions = [row("one")];
  const first = await claim();
  assert.equal(await claimDailyProductTask({ origin: "https://app.example.test", now: new Date("2026-11-15T00:00:00Z") }), null);
  assert.deepEqual(await recordDailyProductResult({ id: first.id, claimId: first.claimId, outcome: "failed", reason: "no_change" }), { ok: true, changed: true });
  assert.equal(await claim(), null);
  settings.set(dailyProductAgentKey(first.id), "corrupt");
  assert.equal(await claim(), null);
});

test("result replay is idempotent and a factual result does not overwrite a human completion", async () => {
  suggestions = [row("one")]; const first = await claim();
  const result = { id: first.id, claimId: first.claimId, outcome: "pr_opened", prUrl: "https://github.com/mposition/Tomverse/pull/4000" };
  assert.deepEqual(await recordDailyProductResult({ ...result, claimId: "11111111-2222-4333-8444-555555555555" }), { refused: "not_claimed" });
  assert.deepEqual(await recordDailyProductResult(result), { ok: true, changed: true });
  assert.deepEqual(await recordDailyProductResult(result), { ok: true, changed: false });
  assert.equal(audits.length, 2); assert.equal(suggestions[0].status, "open");
  suggestions.push(row("two")); const second = await claim(); suggestions[1].status = "completed";
  assert.deepEqual(await recordDailyProductResult({ ...result, id: second.id, claimId: second.claimId }), { ok: true, changed: true });
  assert.equal(suggestions[1].status, "completed");
});

test("the app bounds daily claims including failures and does not reset a corrupt counter", async () => {
  suggestions = [row("one")];
  settings.set(DAILY_PRODUCT_AGENT_DAY, JSON.stringify({ day: "2026-11-13", count: 24 }));
  assert.equal(await claim(), null); assert.equal(audits.length, 0);
  settings.set(DAILY_PRODUCT_AGENT_DAY, "bad"); assert.equal(await claim(), null);
  for (const invalid of [{ day: "wrong", count: 0 }, { day: "2026-11-14", count: 0 }, { day: "2026-11-13", count: 25 }, { day: "2026-11-13", count: 0, bypass: true }]) {
    settings.set(DAILY_PRODUCT_AGENT_DAY, JSON.stringify(invalid)); assert.equal(await claim(), null);
  }
  settings.set(DAILY_PRODUCT_AGENT_DAY, JSON.stringify({ day: "2026-11-12", count: 24 }));
  assert.equal((await claim()).id, "scout.one");
  assert.equal(JSON.parse(settings.get(DAILY_PRODUCT_AGENT_DAY)).count, 1);
});

test("an AMUX send reservation and the daily worker cannot own the same suggestion", async () => {
  suggestions = [row("one")];
  const input = { id: "one", session: { user: { id: "owner" } }, request: new Request("https://app.example.test") };
  assert.equal(await reserveScoutSend(input), true);
  assert.equal(await claim(), null);
  assert.equal(await reserveScoutSend(input), true);
  assert.equal(audits.length, 1);
  settings.clear(); audits = [];
  await claim();
  assert.equal(await reserveScoutSend(input), false);
  delete process.env.DAILY_PRODUCT_AGENT_ENABLED;
  assert.equal(await reserveScoutSend(input), false);
  assert.equal(audits.length, 1);
});

test("sent or completed source records are not offered and empty lanes do not advance the cursor", async () => {
  suggestions = [{ ...row("done"), status: "completed" }, { ...row("sent"), amuxIdeaId: "idea" }];
  settings.set(DAILY_PRODUCT_AGENT_CURSOR, "memory");
  assert.equal(await claim(), null);
  assert.equal(settings.get(DAILY_PRODUCT_AGENT_CURSOR), "memory");
});

test("an owner can queue a known pre-publication failure with a new token and unchanged daily cap", async () => {
  suggestions = [row("one")]; const first = await claim();
  const input = { id: "one", session: { user: { id: "owner" } }, request: new Request("https://app.example.test") };
  assert.equal(await retryDailyProductTask(input), false);
  await recordDailyProductResult({ id: first.id, claimId: first.claimId, outcome: "failed", reason: "agent_error" });
  assert.equal(await retryDailyProductTask(input), true);
  assert.equal(await retryDailyProductTask(input), false);
  const second = await claim(); assert.notEqual(second.claimId, first.claimId);
  assert.equal(JSON.parse(settings.get(DAILY_PRODUCT_AGENT_DAY)).count, 2);
  assert.deepEqual(await recordDailyProductResult({ id: first.id, claimId: first.claimId, outcome: "failed", reason: "agent_error" }), { refused: "not_claimed" });
});

test("published or unknown outcomes cannot be retried or handed off to AMUX", async () => {
  const input = { id: "one", session: { user: { id: "owner" } }, request: new Request("https://app.example.test") };
  for (const reason of ["pr_failed", "push_rejected", "review_unknown"]) {
    settings.clear(); suggestions = [row("one")]; const first = await claim();
    await recordDailyProductResult({ id: first.id, claimId: first.claimId, outcome: "failed", reason });
    assert.equal(await retryDailyProductTask(input), false);
    assert.equal(await reserveScoutSend(input), false);
  }
  settings.clear(); suggestions = [row("one")]; const first = await claim();
  await recordDailyProductResult({ id: first.id, claimId: first.claimId, outcome: "failed", reason: "setup_failed" });
  assert.equal(await reserveScoutSend(input), true);
  assert.equal(await retryDailyProductTask(input), false);
  // A failed/unknown send keeps its reservation; the same human send can
  // read back/retry its deterministic AMUX request without an agent takeover.
  await assert.rejects(sendScoutSuggestion({ readBack: async () => ({ status: "absent" }),
    submit: async () => { throw new Error("send transport failed"); }, isAlreadySeen: () => false,
    close: async () => true }), /send transport failed/);
  assert.equal(await reserveScoutSend(input), true);
  assert.equal(await claim(), null);
});
