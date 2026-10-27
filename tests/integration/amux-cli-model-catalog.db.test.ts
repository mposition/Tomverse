import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import type { Session } from "next-auth";

import {
  readAmuxCliModelCatalogForAdmin,
  recordAmuxCliModelLinkByOwner,
  recordAmuxCliModelRefresh,
} from "@/lib/amux/cliModelCatalogStore";
import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { prisma } from "@/lib/prisma";

// The worker CLIs' model catalog (owner decision 2026-10-27) against
// PostgreSQL through the migration history
// (20261027100000_amux_cli_models_and_worker_cli), in the agents lane: what the
// host refresh records, a link bound to its audit row and never changed, the
// closed CLI list and name grammar, and the newest link winning. The store's
// own statements are counted in tests/amuxCliModelCatalogStore.test.mjs.

const requireDedicatedAmuxTestDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  const runtimeRaw = process.env.DATABASE_URL?.trim();
  if (!testRaw) throw new Error("TEST_DATABASE_URL is required");
  if (runtimeRaw !== testRaw) {
    throw new Error("REFUSE: DATABASE_URL must equal TEST_DATABASE_URL for this DB test");
  }
  const url = new URL(testRaw);
  const schemaName = url.searchParams.get("schema");
  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const usesDedicatedAmuxSchema = schemaName === "tomverse_amux_test";
  const usesCanonicalCiDatabase =
    databaseName === "tomverse_test" &&
    (schemaName === null || schemaName === "public") &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (!usesDedicatedAmuxSchema && !usesCanonicalCiDatabase) {
    throw new Error("REFUSE: AMUX DB tests require the dedicated AMUX schema or the local canonical test database");
  }
};
requireDedicatedAmuxTestDatabase();

const owner = (): Session =>
  ({ user: { id: `cli-model-owner-${randomUUID()}`, email: "owner@example.test" }, expires: "2099-01-01T00:00:00.000Z" }) as Session;

const refresh = (cli: string, names: string[]) =>
  withAmuxDbBoundary(AMUX_DB_BOUNDARIES.cliModelRefresh, (tx) =>
    recordAmuxCliModelRefresh(tx, { cli: cli as "cursor", models: names.map((cliModel) => ({ cliModel, displayName: null })) }));
const link = (session: Session, cliModel: string, pricedModelId: string | null) =>
  withAmuxDbBoundary(AMUX_DB_BOUNDARIES.cliModelLinkChange, (tx) =>
    recordAmuxCliModelLinkByOwner(tx, { session, cli: "cursor", cliModel, pricedModelId }));
const read = () => withAmuxDbBoundary(AMUX_DB_BOUNDARIES.cliModelCatalogRead, (tx) => readAmuxCliModelCatalogForAdmin(tx));

const rejectsWith = async (promise: Promise<unknown>, pattern: RegExp) => {
  await assert.rejects(promise, (error: unknown) => {
    assert.match(String((error as { message?: string })?.message ?? error), pattern);
    return true;
  });
};

const PRICED = `cli-model-test-${randomUUID().slice(0, 8)}`;

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE "AmuxCliModelLinkEvent", "AmuxCliModel" RESTART IDENTITY`);
});
after(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE "AmuxCliModelLinkEvent", "AmuxCliModel" RESTART IDENTITY`);
  await prisma.modelRegistryEntry.deleteMany({ where: { id: PRICED } });
  await prisma.$disconnect();
});

const ensurePricedModel = () =>
  prisma.modelRegistryEntry.upsert({
    where: { id: PRICED },
    update: {},
    create: {
      id: PRICED, name: "CLI model test", apiModel: PRICED, provider: "anthropic",
      apiBaseUrl: "https://api.anthropic.com", apiKeyEnvName: "ANTHROPIC_API_KEY",
      minimumPlan: "Pro", usageClass: "standard", creditWeight: 1,
      inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15,
    },
  });

test("a refresh lists what the CLI offers now and unlists the rest, keeping first-seen", async () => {
  await refresh("cursor", ["claude-opus-5-5-high", "composer-2.5"]);
  const first = await prisma.amuxCliModel.findUnique({ where: { cli_cliModel: { cli: "cursor", cliModel: "composer-2.5" } } });
  await refresh("cursor", ["claude-opus-5-5-high"]);
  const rows = await prisma.amuxCliModel.findMany({ where: { cli: "cursor" }, orderBy: { cliModel: "asc" } });
  assert.deepEqual(rows.map((row) => [row.cliModel, row.listed]), [["claude-opus-5-5-high", true], ["composer-2.5", false]]);
  assert.equal(rows[1]!.firstSeenAt.getTime(), first!.firstSeenAt.getTime());
  // Another CLI's list is its own.
  await refresh("copilot", ["kimi-k3"]);
  assert.equal(await prisma.amuxCliModel.count({ where: { cli: "cursor", listed: true } }), 1);
  // The closed CLI list and the name grammar are the database's too.
  await rejectsWith(prisma.$executeRaw`INSERT INTO "AmuxCliModel" ("id", "cli", "cliModel") VALUES (${randomUUID()}, 'devin', 'x')`, /AmuxCliModel_cli_check/);
  await rejectsWith(prisma.$executeRaw`INSERT INTO "AmuxCliModel" ("id", "cli", "cliModel") VALUES (${randomUUID()}, 'cursor', 'a:b')`, /AmuxCliModel_cli_model_check/);
});

test("a link carries its audit row, the newest wins, and none is ever changed or removed", async () => {
  await ensurePricedModel();
  const session = owner();
  const linked = await link(session, "claude-opus-5-5-high", PRICED);
  const audit = await prisma.adminAuditLog.findUnique({ where: { id: linked.auditLogId } });
  assert.equal(audit?.action, "amux.cli_model.link");
  await link(session, "claude-opus-5-5-high", null);
  const view = await read();
  assert.deepEqual(view.entries.find((entry) => entry.cliModel === "claude-opus-5-5-high")?.link, { pricedModelId: null });
  // Linking to what it already is, or to a model Admin › Models lacks, writes nothing.
  await rejectsWith(link(session, "claude-opus-5-5-high", null), /no_change/);
  await rejectsWith(link(session, "claude-opus-5-5-high", "no-such-model"), /model_not_found/);
  assert.equal(await prisma.amuxCliModelLinkEvent.count(), 2);
  await rejectsWith(prisma.$executeRaw`UPDATE "AmuxCliModelLinkEvent" SET "pricedModelId" = NULL`, /AMUX_CLI_MODEL_LINK_IMMUTABLE/);
  await rejectsWith(prisma.$executeRaw`DELETE FROM "AmuxCliModelLinkEvent"`, /AMUX_CLI_MODEL_LINK_IMMUTABLE/);
  // A link needs an audit row that exists.
  await rejectsWith(prisma.$executeRaw`
    INSERT INTO "AmuxCliModelLinkEvent" ("id", "cli", "cliModel", "pricedModelId", "actorUserId", "auditLogId")
    VALUES (${randomUUID()}, 'cursor', 'x', NULL, 'someone', ${randomUUID()})`, /AmuxCliModelLinkEvent_auditLogId_fkey/);
});

test("the cost catalog's one statement reads the registry and the newest links as JSON", async () => {
  await ensurePricedModel();
  const session = owner();
  await link(session, "composer-2.5", PRICED);
  const [row] = await prisma.$queryRaw<Array<{ rows: Array<Record<string, unknown>>; links: Array<Record<string, unknown>> }>>`
    SELECT
      COALESCE((SELECT pg_catalog.json_agg(entry) FROM "ModelRegistryEntry" entry
        WHERE NOT entry."catalogDeleted"), '[]'::json) AS "rows",
      COALESCE((SELECT pg_catalog.json_agg(link) FROM (
        SELECT DISTINCT ON ("cli", "cliModel") "cli", "cliModel", "pricedModelId"
        FROM "AmuxCliModelLinkEvent"
        ORDER BY "cli", "cliModel", "sequence" DESC) link), '[]'::json) AS "links"
  `;
  assert.deepEqual(row!.links, [{ cli: "cursor", cliModel: "composer-2.5", pricedModelId: PRICED }]);
  const priced = row!.rows.find((entry) => entry.id === PRICED)!;
  // Every column the registry reader uses arrives with its JSON type.
  assert.equal(priced.apiModel, PRICED);
  assert.equal(priced.inputUsdPerMillionTokens, 3);
  assert.equal(priced.enabled, true);
});
