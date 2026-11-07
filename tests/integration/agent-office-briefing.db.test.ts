import assert from "node:assert/strict";
import { after, afterEach, beforeEach, test } from "node:test";

import { randomUUID } from "node:crypto";
import type { Session } from "next-auth";

import { AGENT_OFFICE_BRIEFING_PER_DAY, agentOfficeBriefingDay, type AgentOfficeBriefingFacts } from "@/lib/agentOffice/briefing";
import {
  AGENT_OFFICE_BRIEFING_ENABLED_ENV,
  AGENT_OFFICE_BRIEFING_LATEST_KEY,
  AGENT_OFFICE_BRIEFING_USAGE_KEY,
  requestAgentOfficeBriefing,
  type AgentOfficeBriefingLlm,
} from "@/lib/agentOfficeBriefing";
import { prisma } from "@/lib/prisma";

// The Agent office's AI briefing at its paid boundary: off by default, the
// day's limit and the one-in-flight claim held under a lock, every reserved
// call audited before it runs, a fresh answer reused, a failed call counted
// and not retried. The model is a stub; nothing here calls a provider.

const NOW = new Date("2026-11-07T02:00:00.000Z");
const FACTS = { clockAest: "2026-11-07 12:00" } as unknown as AgentOfficeBriefingFacts;
const readFacts = async () => FACTS;

let previousEnabled: string | undefined;
let previousKey: string | undefined;
let actor = "";

const session = () => ({ user: { id: actor, email: "owner@example.test" }, expires: new Date(Date.now() + 3_600_000).toISOString() }) as Session;
const request = () => new Request("https://tomverse.app/api/admin/office/briefing", { method: "POST" });

const answer = (calls: { n: number }, ok = true): AgentOfficeBriefingLlm => async () => {
  calls.n += 1;
  return ok ? { modelId: "stub-model", briefing: { headline: "Nothing waits on you.", points: [{ severity: "info", text: "All quiet.", link: null }] } } : null;
};

const audits = () =>
  prisma.adminAuditLog.findMany({ where: { actorUserId: actor, action: "agent_office.briefing_requested" }, select: { metadata: true } });
const setting = async (key: string) => (await prisma.appSetting.findUnique({ where: { key }, select: { value: true } }))?.value ?? null;

beforeEach(async () => {
  previousEnabled = process.env[AGENT_OFFICE_BRIEFING_ENABLED_ENV];
  previousKey = process.env.ADMIN_AUDIT_INTEGRITY_KEY;
  process.env.ADMIN_AUDIT_INTEGRITY_KEY ??= "agent-office-briefing-db-secret-00042";
  process.env[AGENT_OFFICE_BRIEFING_ENABLED_ENV] = "true";
  actor = `office-briefing-${randomUUID()}`;
  await prisma.appSetting.deleteMany({ where: { key: { in: [AGENT_OFFICE_BRIEFING_USAGE_KEY, AGENT_OFFICE_BRIEFING_LATEST_KEY] } } });
});

afterEach(() => {
  if (previousEnabled === undefined) delete process.env[AGENT_OFFICE_BRIEFING_ENABLED_ENV];
  else process.env[AGENT_OFFICE_BRIEFING_ENABLED_ENV] = previousEnabled;
  if (previousKey === undefined) delete process.env.ADMIN_AUDIT_INTEGRITY_KEY;
  else process.env.ADMIN_AUDIT_INTEGRITY_KEY = previousKey;
});

after(async () => {
  await prisma.appSetting.deleteMany({ where: { key: { in: [AGENT_OFFICE_BRIEFING_USAGE_KEY, AGENT_OFFICE_BRIEFING_LATEST_KEY] } } });
  await prisma.$disconnect();
});

test("off unless the switch is \"true\": nothing is reserved, audited or called", async () => {
  delete process.env[AGENT_OFFICE_BRIEFING_ENABLED_ENV];
  const calls = { n: 0 };
  const result = await requestAgentOfficeBriefing({ session: session(), request: request(), locale: "ko", now: () => NOW, llm: answer(calls), readFacts });
  assert.deepEqual(result, { kind: "off" });
  assert.equal(calls.n, 0);
  assert.equal(await setting(AGENT_OFFICE_BRIEFING_USAGE_KEY), null);
  assert.equal((await audits()).length, 0);
});

test("no enabled model: nothing is reserved", async () => {
  const result = await requestAgentOfficeBriefing({ session: session(), request: request(), locale: "ko", now: () => NOW, llm: null, readFacts });
  assert.deepEqual(result, { kind: "model_unavailable" });
  assert.equal(await setting(AGENT_OFFICE_BRIEFING_USAGE_KEY), null);
});

test("one call is reserved, audited, answered and stored; a fresh answer is reused without a call", async () => {
  const calls = { n: 0 };
  const first = await requestAgentOfficeBriefing({ session: session(), request: request(), locale: "ko", now: () => NOW, llm: answer(calls), readFacts });
  assert.equal(first.kind, "done");
  assert.equal(calls.n, 1);
  const usage = JSON.parse((await setting(AGENT_OFFICE_BRIEFING_USAGE_KEY)) ?? "{}");
  assert.deepEqual(usage, { day: agentOfficeBriefingDay(NOW), calls: 1, claimUntil: null });
  const stored = JSON.parse((await setting(AGENT_OFFICE_BRIEFING_LATEST_KEY)) ?? "{}");
  assert.equal(stored.modelId, "stub-model");
  assert.equal(stored.locale, "ko");
  const rows = await audits();
  assert.equal(rows.length, 1);
  assert.equal((rows[0].metadata as { calls: number }).calls, 1);

  const soon = new Date(NOW.getTime() + 60_000);
  const again = await requestAgentOfficeBriefing({ session: session(), request: request(), locale: "ko", now: () => soon, llm: answer(calls), readFacts });
  assert.equal(again.kind, "reused");
  assert.equal(calls.n, 1);
  assert.equal((await audits()).length, 1);
  // Another language is a new briefing.
  const english = await requestAgentOfficeBriefing({ session: session(), request: request(), locale: "en", now: () => soon, llm: answer(calls), readFacts });
  assert.equal(english.kind, "done");
  assert.equal(calls.n, 2);
});

test("the day's limit and a claim in flight refuse before any call", async () => {
  const calls = { n: 0 };
  const day = agentOfficeBriefingDay(NOW);
  await prisma.appSetting.create({ data: { key: AGENT_OFFICE_BRIEFING_USAGE_KEY, value: JSON.stringify({ day, calls: AGENT_OFFICE_BRIEFING_PER_DAY, claimUntil: null }) } });
  assert.deepEqual(
    await requestAgentOfficeBriefing({ session: session(), request: request(), locale: "ko", now: () => NOW, llm: answer(calls), readFacts }),
    { kind: "limit" }
  );
  await prisma.appSetting.update({
    where: { key: AGENT_OFFICE_BRIEFING_USAGE_KEY },
    data: { value: JSON.stringify({ day, calls: 1, claimUntil: new Date(NOW.getTime() + 30_000).toISOString() }) },
  });
  assert.deepEqual(
    await requestAgentOfficeBriefing({ session: session(), request: request(), locale: "ko", now: () => NOW, llm: answer(calls), readFacts }),
    { kind: "busy" }
  );
  assert.equal(calls.n, 0);
  assert.equal((await audits()).length, 0);
});

test("a failed call still counts, ends its claim and stores nothing", async () => {
  const calls = { n: 0 };
  const result = await requestAgentOfficeBriefing({ session: session(), request: request(), locale: "ko", now: () => NOW, llm: answer(calls, false), readFacts });
  assert.deepEqual(result, { kind: "failed" });
  assert.equal(calls.n, 1);
  assert.deepEqual(JSON.parse((await setting(AGENT_OFFICE_BRIEFING_USAGE_KEY)) ?? "{}"), { day: agentOfficeBriefingDay(NOW), calls: 1, claimUntil: null });
  assert.equal(await setting(AGENT_OFFICE_BRIEFING_LATEST_KEY), null);
  assert.equal((await audits()).length, 1);
});

test("two requests at once make one call", async () => {
  const calls = { n: 0 };
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const slow: AgentOfficeBriefingLlm = async (input) => {
    await gate;
    return answer(calls)(input);
  };
  const first = requestAgentOfficeBriefing({ session: session(), request: request(), locale: "ko", now: () => NOW, llm: slow, readFacts });
  // Let the first reserve before the second asks.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const second = await requestAgentOfficeBriefing({ session: session(), request: request(), locale: "ko", now: () => NOW, llm: slow, readFacts });
  release();
  assert.equal((await first).kind, "done");
  assert.deepEqual(second, { kind: "busy" });
  assert.equal(calls.n, 1);
});
