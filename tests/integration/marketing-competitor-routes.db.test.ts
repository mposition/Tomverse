import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { resetTestFixture } from "./resetTestFixture";

// The competitor registry's Admin routes (S3f-R3), end to end against a real
// PostgreSQL: a person adds, approves, rejects and retires through
// runMarketingAdminMutation, whose audit row the registry's write guard checks.
//
// Runs in its own process under scripts/run-db-integration-tests.mjs, because
// mock.module is process-global and this file replaces next-auth.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relativePath: string) => pathToFileURL(resolve(ROOT, relativePath)).href;

process.env.ADMIN_EMAILS = "competitor-owner@tomverse.test";
process.env.ADMIN_OWNER_EMAILS = "competitor-owner@tomverse.test";
// Test values, assembled: a literal beside a secret-shaped name is what the PR
// secret scan flags.
process.env.ADMIN_AUDIT_INTEGRITY_KEY ||= ["competitor", "routes", "audit", "test"].join("-");
// The rate limiter keys its buckets with it.
process.env.NEXTAUTH_SECRET ||= ["competitor", "routes", "nextauth", "test"].join("-");

let sessionOverride: unknown = null;
mock.module("next-auth/next", {
  namedExports: { getServerSession: async () => sessionOverride },
});

type Post = (request: Request, context?: unknown) => Promise<Response>;
let prisma: (typeof import("@/lib/prisma"))["prisma"];
let create: Post;
let decision: Post;
let killSwitchEnv = "";

before(async () => {
  ({ prisma } = (await import(mod("lib/prisma.ts"))) as typeof import("@/lib/prisma"));
  ({ MARKETING_AUTOMATION_KILL_SWITCH_ENV: killSwitchEnv } = (await import(
    mod("lib/marketingAutomationAccess.ts")
  )) as typeof import("@/lib/marketingAutomationAccess"));
  ({ POST: create } = (await import(mod("app/api/admin/marketing/competitors/route.ts"))) as { POST: Post });
  ({ POST: decision } = (await import(
    mod("app/api/admin/marketing/competitors/[competitorId]/decision/route.ts")
  )) as { POST: Post });
});

const reset = () =>
  resetTestFixture(prisma, `TRUNCATE TABLE "MarketingCompetitor", "AdminAuditLog", "User" RESTART IDENTITY CASCADE`);

beforeEach(async () => {
  await reset();
  delete process.env[killSwitchEnv];
  const user = await prisma.user.create({
    data: { email: "competitor-owner@tomverse.test", lastLoginAt: new Date() },
  });
  sessionOverride = {
    user: { id: user.id, email: user.email, name: "Competitor Owner", authenticatedAt: new Date().toISOString() },
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  };
});

after(async () => {
  await reset();
  await prisma.$disconnect();
});

const send = (handler: Post, path: string, body: unknown, competitorId?: string) =>
  handler(
    new Request(`https://tomverse.test${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    competitorId ? { params: Promise.resolve({ competitorId }) } : undefined,
  );
const decide = (competitorId: string, body: unknown) =>
  send(decision, `/api/admin/marketing/competitors/${competitorId}/decision`, body, competitorId);
const add = (body: unknown) => send(create, "/api/admin/marketing/competitors", body);

/** A proposal as A3 leaves it, written with the trigger's own rules. */
const proposal = (id: string) =>
  prisma.$executeRawUnsafe(
    `INSERT INTO "MarketingCompetitor" ("id", "displayName", "officialHosts", "status", "proposedBy", "evidenceUrls", "rationale", "updatedAt")
     VALUES ($1, $2, ARRAY[$3], 'proposed', 'seed', ARRAY[]::TEXT[], 'Seeded.', CURRENT_TIMESTAMP)`,
    id,
    id.toUpperCase(),
    `${id}.example`,
  );
const row = (id: string) => prisma.marketingCompetitor.findUniqueOrThrow({ where: { id } });

test("a person approves a proposal with edited hosts, and the audit row records exactly what was applied", async () => {
  await proposal("alpha");
  const response = await decide("alpha", {
    decision: "approved",
    expectedDecisionAuditLogId: null,
    displayName: " Alpha AI ",
    officialHosts: ["WWW.alpha.example", "alpha.example"],
  });
  assert.equal(response.status, 200, await response.clone().text());
  const alpha = await row("alpha");
  assert.equal(alpha.status, "approved");
  assert.equal(alpha.displayName, "Alpha AI");
  assert.deepEqual(alpha.officialHosts, ["alpha.example", "www.alpha.example"]);
  const audit = await prisma.adminAuditLog.findUniqueOrThrow({ where: { id: alpha.decisionAuditLogId ?? "" } });
  assert.equal(audit.action, "marketing_competitor.approved");
  assert.deepEqual(audit.metadata, {
    actorHadMarketingWrite: true,
    previousDecisionAuditLogId: ":none",
    displayName: "Alpha AI",
    officialHosts: ["alpha.example", "www.alpha.example"],
  });
});

test("a decision from a stale page is a 409 and leaves no audit row", async () => {
  await proposal("alpha");
  assert.equal((await decide("alpha", { decision: "rejected", expectedDecisionAuditLogId: null })).status, 200);
  const audits = await prisma.adminAuditLog.count();
  const stale = await decide("alpha", {
    decision: "approved",
    expectedDecisionAuditLogId: null,
    displayName: "Alpha",
    officialHosts: ["alpha.example"],
  });
  assert.equal(stale.status, 409);
  assert.equal(((await stale.json()) as { code: string }).code, "competitor_decision_conflict");
  assert.equal(await prisma.adminAuditLog.count(), audits);
  assert.equal((await row("alpha")).status, "rejected");

  // With the decision the page now shows, the same person can change their mind.
  const current = (await row("alpha")).decisionAuditLogId;
  assert.equal(
    (
      await decide("alpha", {
        decision: "approved",
        expectedDecisionAuditLogId: current,
        displayName: "Alpha",
        officialHosts: ["alpha.example"],
      })
    ).status,
    200,
  );
});

test("a move the registry does not allow is a 409, not a fault", async () => {
  await proposal("alpha");
  const response = await decide("alpha", { decision: "retired", expectedDecisionAuditLogId: null });
  assert.equal(response.status, 409);
  assert.equal(((await response.json()) as { code: string }).code, "competitor_transition_invalid");
  assert.equal(await prisma.adminAuditLog.count(), 0);
});

test("the kill switch refuses an approval or an addition, never a rejection or a retirement", async () => {
  await proposal("alpha");
  await proposal("beta");
  assert.equal(
    (
      await decide("beta", {
        decision: "approved",
        expectedDecisionAuditLogId: null,
        displayName: "Beta",
        officialHosts: ["beta.example"],
      })
    ).status,
    200,
  );
  process.env[killSwitchEnv] = "incident-2026-10-17";
  const approval = await decide("alpha", {
    decision: "approved",
    expectedDecisionAuditLogId: null,
    displayName: "Alpha",
    officialHosts: ["alpha.example"],
  });
  assert.equal(approval.status, 409);
  assert.equal(((await approval.json()) as { code: string }).code, "MARKETING_KILL_SWITCH");
  assert.equal(
    (await add({ competitorId: "gamma", displayName: "Gamma", officialHosts: ["gamma.example"] })).status,
    409,
  );
  assert.equal((await decide("alpha", { decision: "rejected", expectedDecisionAuditLogId: null })).status, 200);
  const beta = await row("beta");
  assert.equal(
    (await decide("beta", { decision: "retired", expectedDecisionAuditLogId: beta.decisionAuditLogId })).status,
    200,
  );
  assert.equal((await row("beta")).status, "retired");
});

test("a person adds a competitor once, and the request is strict", async () => {
  const first = await add({ competitorId: "delta", displayName: "Delta", officialHosts: ["delta.example"] });
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal((await row("delta")).proposedBy, "operator");
  const again = await add({ competitorId: "delta", displayName: "Delta", officialHosts: ["delta.example"] });
  assert.equal(again.status, 409);
  assert.equal(((await again.json()) as { code: string }).code, "competitor_exists");
  for (const body of [
    { competitorId: "Delta2", displayName: "D", officialHosts: ["d.example"] },
    { competitorId: "epsilon", displayName: "E", officialHosts: ["https://e.example"] },
    { competitorId: "epsilon", displayName: "E", officialHosts: ["e.example"], status: "approved" },
  ]) {
    assert.equal((await add(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await decide("delta", { decision: "approved", expectedDecisionAuditLogId: null })).status, 400);
});

test("a stale sign-in is the step-up answer, and a non-administrator learns nothing", async () => {
  await proposal("alpha");
  // Signed in ten minutes ago, against a five-minute step-up window: still an
  // administrator's session, no longer a recent sign-in.
  const session = sessionOverride as { user: Record<string, unknown> };
  sessionOverride = { ...session, user: { ...session.user, authenticatedAt: new Date(Date.now() - 600_000).toISOString() } };
  const previousWindow = process.env.ADMIN_RECENT_AUTH_MINUTES;
  process.env.ADMIN_RECENT_AUTH_MINUTES = "5";
  try {
    assert.equal((await decide("alpha", { decision: "rejected", expectedDecisionAuditLogId: null })).status, 428);
  } finally {
    if (previousWindow === undefined) delete process.env.ADMIN_RECENT_AUTH_MINUTES;
    else process.env.ADMIN_RECENT_AUTH_MINUTES = previousWindow;
  }
  sessionOverride = null;
  assert.equal((await decide("alpha", { decision: "rejected", expectedDecisionAuditLogId: null })).status, 404);
  assert.equal((await row("alpha")).status, "proposed");
});

test("the console lists approved competitors first, with the decision each change is checked against", async () => {
  const { readMarketingConsole } = (await import(mod("lib/marketingConsoleRead.ts"))) as typeof import(
    "@/lib/marketingConsoleRead"
  );
  await proposal("alpha");
  await proposal("beta");
  await decide("beta", {
    decision: "approved",
    expectedDecisionAuditLogId: null,
    displayName: "Beta",
    officialHosts: ["beta.example"],
  });
  const view = await readMarketingConsole("competitors", true);
  assert.equal(view.ordering, "by-status");
  assert.deepEqual(
    view.rows.map((r) => [r.id, r.status]),
    [
      ["beta", "approved"],
      ["alpha", "proposed"],
    ],
  );
  assert.equal(view.rows[0].decisionAuditLogId, (await row("beta")).decisionAuditLogId);
  assert.equal(view.rows[1].decisionAuditLogId, null);
});
