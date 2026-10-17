import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { writeAdminAuditLog, writeSystemAuditLog } from "@/lib/adminAudit";
import { MARKETING_COMPETITOR_ACTIONS } from "@/lib/marketingCompetitorCore";
import {
  createApprovedMarketingCompetitor,
  decideMarketingCompetitor,
  proposeMarketingCompetitors,
  readApprovedMarketingCompetitorHosts,
  readMarketingCompetitorsForGenerator,
} from "@/lib/marketingCompetitorStore";
import { runMarketingTransaction, type MarketingTransaction } from "@/lib/marketingStore";
import { prisma } from "@/lib/prisma";
import { resetTestFixture } from "./resetTestFixture";

// The competitor registry (S3f): A3 proposes, a person decides, and only an
// approved row's hosts are a source. The database checks each decision against
// the person's own audit row, so these run against a real audit chain.

const AUDIT_SECRET = "marketing-competitor-db-secret-0001";
let previousAuditKey: string | undefined;
before(() => {
  previousAuditKey = process.env.ADMIN_AUDIT_INTEGRITY_KEY;
  process.env.ADMIN_AUDIT_INTEGRITY_KEY = AUDIT_SECRET;
});
const reset = () =>
  resetTestFixture(prisma, `TRUNCATE TABLE "MarketingCompetitor", "AdminAuditLog" RESTART IDENTITY CASCADE`);
beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
  if (previousAuditKey === undefined) delete process.env.ADMIN_AUDIT_INTEGRITY_KEY;
  else process.env.ADMIN_AUDIT_INTEGRITY_KEY = previousAuditKey;
});

const operator = {
  user: { id: "marketing-operator", email: "owner@example.test" },
  expires: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
} as Session;

const tx = <T>(fn: (client: MarketingTransaction) => Promise<T>) => runMarketingTransaction(prisma, fn);
const refusedBy = (message: string) => (error: unknown) =>
  error instanceof Error && error.message.includes(message);
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

type Decision = "approved" | "rejected" | "retired";
type Recorded = {
  readonly action?: string;
  readonly targetId?: string;
  readonly previous?: string | null;
  readonly displayName?: string;
  readonly officialHosts?: readonly string[];
};

/** A person's audit row, as `runMarketingAdminMutation` writes it. */
const humanAudit = (client: Prisma.TransactionClient, decision: Decision, competitorId: string, recorded: Recorded) =>
  writeAdminAuditLog({
    session: operator,
    request: new Request("https://tomverse.app/api/admin/marketing/competitors/x"),
    action: recorded.action ?? MARKETING_COMPETITOR_ACTIONS[decision],
    targetType: "MarketingCompetitor",
    targetId: recorded.targetId ?? competitorId,
    summary: "Competitor decision.",
    metadata: {
      actorHadMarketingWrite: true,
      previousDecisionAuditLogId: recorded.previous ?? ":none",
      ...(recorded.displayName ? { displayName: recorded.displayName } : {}),
      ...(recorded.officialHosts ? { officialHosts: [...recorded.officialHosts] } : {}),
    },
    tx: client,
  });

const current = async (id: string) =>
  (await prisma.marketingCompetitor.findUniqueOrThrow({ where: { id } })).decisionAuditLogId;

/** A decision made from a page that showed the row's current decision. */
const decide = async (
  id: string,
  decision: Decision,
  approved?: { displayName: string; officialHosts: string[] },
  recorded?: Recorded,
) => {
  const expected = await current(id);
  return tx(async (client) => {
    const auditLogId = await humanAudit(client, decision, id, { previous: expected, ...approved, ...recorded });
    return decideMarketingCompetitor(client, {
      competitorId: id,
      decision,
      expectedDecisionAuditLogId: expected,
      auditLogId,
      ...approved,
    });
  });
};

const candidate = (competitorId: string, hosts = [`${competitorId}.example`]) => ({
  competitorId,
  displayName: competitorId.toUpperCase(),
  officialHosts: hosts,
  evidenceUrls: [`https://${hosts[0]}/pricing`],
  rationale: "Sells the same comparison.",
});

const propose = (...ids: string[]) =>
  tx((client) => proposeMarketingCompetitors(client, { generatorRunId: "run-1", candidates: ids.map((id) => candidate(id)) }));

test("the migration proposes the market analysis's competitors and approves none", async () => {
  // The migration's own seed statement, run again on an empty table so the
  // answer does not depend on what an earlier run left behind.
  const migration = readFileSync(
    "prisma/migrations/20261017120000_marketing_competitor_registry/migration.sql",
    "utf8",
  );
  const seed = migration.slice(migration.indexOf('INSERT INTO "MarketingCompetitor"')).trim().replace(/;$/u, "");
  assert.match(seed, /^INSERT INTO "MarketingCompetitor"/u);
  await prisma.$executeRawUnsafe(seed);
  const seeded = await prisma.marketingCompetitor.findMany({
    orderBy: { id: "asc" },
    select: { id: true, status: true, proposedBy: true, decisionAuditLogId: true },
  });
  assert.deepEqual(
    seeded.map((row) => row.id),
    ["adot", "chatgpt", "chathub", "chatplayground", "claude", "gemini", "genspark", "perplexity", "poe", "suprmind", "wrtn"],
  );
  for (const row of seeded) {
    assert.equal(row.status, "proposed");
    assert.equal(row.proposedBy, "seed");
    assert.equal(row.decisionAuditLogId, null);
  }
  assert.deepEqual(await readApprovedMarketingCompetitorHosts(prisma), {});
});

test("a generator proposal is stored with its own system audit row and trusted for nothing", async () => {
  const first = await propose("alpha", "beta");
  assert.deepEqual(first, { proposed: ["alpha", "beta"], alreadyKnown: [] });
  assert.deepEqual(await readApprovedMarketingCompetitorHosts(prisma), {});
  assert.deepEqual(await readMarketingCompetitorsForGenerator(prisma), []);
  const audits = await prisma.adminAuditLog.findMany({ orderBy: { createdAt: "asc" } });
  assert.deepEqual(
    audits.map((row) => [row.action, row.targetId, row.actorUserId, (row.metadata as { systemActor?: string }).systemActor]),
    [
      ["marketing_competitor.proposed", "alpha", null, "marketing-generator"],
      ["marketing_competitor.proposed", "beta", null, "marketing-generator"],
    ],
  );

  // Proposing a known id again changes nothing, whatever it says now.
  await decide("alpha", "rejected");
  const again = await tx((client) =>
    proposeMarketingCompetitors(client, {
      generatorRunId: "run-2",
      candidates: [{ ...candidate("alpha", ["other.example"]), displayName: "Renamed" }, candidate("gamma")],
    }),
  );
  assert.deepEqual(again, { proposed: ["gamma"], alreadyKnown: ["alpha"] });
  const alpha = await prisma.marketingCompetitor.findUniqueOrThrow({ where: { id: "alpha" } });
  assert.equal(alpha.status, "rejected");
  assert.equal(alpha.displayName, "ALPHA");
  assert.deepEqual(alpha.officialHosts, ["alpha.example"]);
  assert.equal(alpha.proposedRunId, "run-1");
});

test("an approval makes exactly the approved name and hosts a source", async () => {
  await propose("alpha");
  await decide("alpha", "approved", { displayName: "Alpha AI", officialHosts: ["alpha.example", "www.alpha.example"] });
  const row = await prisma.marketingCompetitor.findUniqueOrThrow({ where: { id: "alpha" } });
  assert.equal(row.status, "approved");
  assert.equal(row.displayName, "Alpha AI");
  assert.ok(row.decidedAt);
  assert.deepEqual(await readApprovedMarketingCompetitorHosts(prisma), { alpha: ["alpha.example", "www.alpha.example"] });
  assert.deepEqual(await readMarketingCompetitorsForGenerator(prisma), [
    { competitorId: "alpha", displayName: "Alpha AI", officialHosts: ["alpha.example", "www.alpha.example"] },
  ]);
});

test("the database refuses a decision its audit row does not record", async () => {
  await propose("alpha", "beta");
  const approved = { displayName: "Alpha", officialHosts: ["alpha.example"] };
  // Another decision's action.
  await assert.rejects(
    decide("alpha", "approved", approved, { action: MARKETING_COMPETITOR_ACTIONS.rejected }),
    refusedBy("marketing_competitor_decision_not_a_person"),
  );
  // Another competitor.
  await assert.rejects(
    decide("alpha", "approved", approved, { targetId: "beta" }),
    refusedBy("marketing_competitor_decision_not_a_person"),
  );
  // Other hosts than the ones applied.
  await assert.rejects(
    decide("alpha", "approved", approved, { officialHosts: ["evil.example"] }),
    refusedBy("marketing_competitor_decision_not_a_person"),
  );
  // Another name.
  await assert.rejects(
    decide("alpha", "approved", approved, { displayName: "Not Alpha" }),
    refusedBy("marketing_competitor_decision_not_a_person"),
  );
  // A predecessor the row does not have.
  await assert.rejects(
    decide("alpha", "approved", approved, { previous: "some-other-audit" }),
    refusedBy("marketing_competitor_decision_not_a_person"),
  );
  // A system actor's audit row is not a person's decision.
  await assert.rejects(
    tx(async (client) => {
      const auditLogId = await writeSystemAuditLog({
        tx: client,
        systemActor: "marketing-generator",
        action: MARKETING_COMPETITOR_ACTIONS.proposed,
        targetType: "MarketingCompetitor",
        targetId: "alpha",
        summary: "Not a decision.",
        metadata: { generatorRunId: "run-1", officialHosts: ["alpha.example"] },
      });
      await decideMarketingCompetitor(client, {
        competitorId: "alpha",
        decision: "rejected",
        expectedDecisionAuditLogId: null,
        auditLogId,
      });
    }),
    refusedBy("marketing_competitor_decision_not_a_person"),
  );
  assert.equal((await prisma.marketingCompetitor.findUniqueOrThrow({ where: { id: "alpha" } })).status, "proposed");
});

test("a decision made against a stale screen is a conflict, not a change", async () => {
  await propose("alpha");
  await decide("alpha", "approved", { displayName: "Alpha", officialHosts: ["alpha.example"] });
  await assert.rejects(
    tx(async (client) => {
      const auditLogId = await humanAudit(client, "retired", "alpha", {});
      await decideMarketingCompetitor(client, {
        competitorId: "alpha",
        decision: "retired",
        expectedDecisionAuditLogId: null,
        auditLogId,
      });
    }),
    code("competitor_decision_conflict"),
  );
  // A competitor that does not exist is the same conflict: nothing moved.
  await assert.rejects(
    tx(async (client) => {
      const auditLogId = await humanAudit(client, "rejected", "missing", {});
      await decideMarketingCompetitor(client, {
        competitorId: "missing",
        decision: "rejected",
        expectedDecisionAuditLogId: null,
        auditLogId,
      });
    }),
    code("competitor_decision_conflict"),
  );
  await assert.rejects(
    tx((client) =>
      decideMarketingCompetitor(client, {
        competitorId: "alpha",
        decision: "approved",
        expectedDecisionAuditLogId: null,
        auditLogId: "x",
        officialHosts: ["alpha.example"],
      }),
    ),
    code("competitor_hosts_required"),
  );
});

test("a competitor moves only along the decisions a person can make", async () => {
  await propose("alpha", "beta");
  const approved = { displayName: "Alpha", officialHosts: ["alpha.example"] };
  // A proposal is not retired.
  await assert.rejects(decide("alpha", "retired"), code("competitor_transition_invalid"));
  await decide("alpha", "approved", approved);
  // An approval is not rejected.
  await assert.rejects(decide("alpha", "rejected"), code("competitor_transition_invalid"));
  await decide("alpha", "retired");
  assert.deepEqual(await readApprovedMarketingCompetitorHosts(prisma), {});
  await decide("alpha", "approved", approved);
  assert.deepEqual(Object.keys(await readApprovedMarketingCompetitorHosts(prisma)), ["alpha"]);
  // A rejection can be reversed by a person, never by a proposal.
  await decide("beta", "rejected");
  await decide("beta", "approved", { displayName: "Beta", officialHosts: ["beta.example"] });
  assert.equal((await prisma.marketingCompetitor.findUniqueOrThrow({ where: { id: "beta" } })).status, "approved");
});

test("a direct write cannot change what was proposed, move hosts without approval or delete a row", async () => {
  await propose("alpha");
  await assert.rejects(
    prisma.$executeRawUnsafe(`UPDATE "MarketingCompetitor" SET "rationale" = 'rewritten' WHERE "id" = 'alpha'`),
    refusedBy("marketing_competitor_proposal_is_immutable"),
  );
  await assert.rejects(
    prisma.$executeRawUnsafe(`UPDATE "MarketingCompetitor" SET "evidenceUrls" = ARRAY[]::TEXT[] WHERE "id" = 'alpha'`),
    refusedBy("marketing_competitor_proposal_is_immutable"),
  );
  // A rejection that also rewrites the hosts.
  const expected = await current("alpha");
  await assert.rejects(
    tx(async (client) => {
      const auditLogId = await humanAudit(client, "rejected", "alpha", { previous: expected });
      await client.$executeRawUnsafe(
        `UPDATE "MarketingCompetitor" SET "status" = 'rejected', "decisionAuditLogId" = $1, "officialHosts" = ARRAY['evil.example'] WHERE "id" = 'alpha'`,
        auditLogId,
      );
    }),
    refusedBy("marketing_competitor_hosts_change_only_on_approval"),
  );
  // A status change with no new decision.
  await assert.rejects(
    prisma.$executeRawUnsafe(`UPDATE "MarketingCompetitor" SET "status" = 'rejected' WHERE "id" = 'alpha'`),
    /marketing_competitor_decision_check|marketing_competitor_decision_not_a_person/u,
  );
  await assert.rejects(
    prisma.$executeRawUnsafe(`DELETE FROM "MarketingCompetitor" WHERE "id" = 'alpha'`),
    refusedBy("marketing_competitor_is_never_deleted"),
  );
});

test("only a proposal or a person's approval is born, and a host is stored the way it is compared", async () => {
  // A proposal that claims a decision.
  await assert.rejects(
    prisma.$executeRawUnsafe(
      `INSERT INTO "MarketingCompetitor" ("id", "displayName", "officialHosts", "status", "proposedBy", "evidenceUrls", "decisionAuditLogId", "decidedAt", "updatedAt")
       VALUES ('x', 'X', ARRAY['x.example'], 'proposed', 'seed', ARRAY[]::TEXT[], 'a', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ),
    /marketing_competitor_proposal_has_no_decision|MarketingCompetitor_decision_check/u,
  );
  // The generator cannot add an approved row.
  await assert.rejects(
    prisma.$executeRawUnsafe(
      `INSERT INTO "MarketingCompetitor" ("id", "displayName", "officialHosts", "status", "proposedBy", "proposedRunId", "evidenceUrls", "decisionAuditLogId", "decidedAt", "updatedAt")
       VALUES ('x', 'X', ARRAY['x.example'], 'approved', 'generator', 'run-1', ARRAY[]::TEXT[], 'a', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ),
    refusedBy("marketing_competitor_insert_not_proposed"),
  );
  for (const host of ["Upper.example", "https://x.example", "x.example/path", "localhost", "x.example."]) {
    await assert.rejects(
      prisma.$executeRawUnsafe(
        `INSERT INTO "MarketingCompetitor" ("id", "displayName", "officialHosts", "status", "proposedBy", "evidenceUrls", "updatedAt")
         VALUES ('x', 'X', ARRAY[$1], 'proposed', 'seed', ARRAY[]::TEXT[], CURRENT_TIMESTAMP)`,
        host,
      ),
      refusedBy("MarketingCompetitor_officialHosts_check"),
      host,
    );
  }

  // A person adds one A3 never proposed.
  await tx(async (client) => {
    const auditLogId = await humanAudit(client, "approved", "delta", {
      displayName: "Delta",
      officialHosts: ["delta.example"],
    });
    await createApprovedMarketingCompetitor(client, {
      competitorId: "delta",
      displayName: "Delta",
      officialHosts: ["delta.example"],
      auditLogId,
    });
  });
  assert.deepEqual(await readApprovedMarketingCompetitorHosts(prisma), { delta: ["delta.example"] });
  await assert.rejects(
    tx(async (client) => {
      const auditLogId = await humanAudit(client, "approved", "delta", {
        displayName: "Delta",
        officialHosts: ["delta.example"],
      });
      await createApprovedMarketingCompetitor(client, {
        competitorId: "delta",
        displayName: "Delta",
        officialHosts: ["delta.example"],
        auditLogId,
      });
    }),
    code("competitor_exists"),
  );
  // An addition whose audit row names other hosts.
  await assert.rejects(
    tx(async (client) => {
      const auditLogId = await humanAudit(client, "approved", "epsilon", {
        displayName: "Epsilon",
        officialHosts: ["epsilon.example"],
      });
      await createApprovedMarketingCompetitor(client, {
        competitorId: "epsilon",
        displayName: "Epsilon",
        officialHosts: ["evil.example"],
        auditLogId,
      });
    }),
    refusedBy("marketing_competitor_decision_not_a_person"),
  );
});
