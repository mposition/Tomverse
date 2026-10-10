import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { prisma } from "@/lib/prisma";
import { buildRoutingShadowDecision, recordRoutingShadowRun } from "@/lib/routingShadow";
import { routingShadowQuery } from "@/lib/routingShadowQuery";
import { buildTaskProfile } from "@/lib/taskProfileCore";

const environment = { TOMVERSE_ROUTER_SHADOW_ENABLED: "true", APP_ENV: "staging",
  RAILWAY_GIT_COMMIT_SHA: "a".repeat(40),
  RAILWAY_DEPLOYMENT_ID: "7ac2d5a6-f003-489c-8c00-5b50c18e6574" };
const input = () => ({ traceId: randomUUID(), subjectKey: "provenance-db-fixture",
  plan: "Free" as const, profile: buildTaskProfile({ text: "A test fixture." }),
  userSelectedModelId: "gpt-5-6-luna", estimatedInputTokens: 20, reservedInputTokens: 30,
  requestOutputCapTokens: 100, models: [], searchBackendReadiness: {} });
const reset = () => prisma.$executeRawUnsafe('TRUNCATE TABLE "RoutingRun" RESTART IDENTITY CASCADE');
beforeEach(reset);
after(async () => { await reset(); await prisma.$disconnect(); });

test("shadow recording persists provenance and the scoped report excludes other writers", async () => {
  const target = input();
  assert.deepEqual(await recordRoutingShadowRun(target, environment), { recorded: true });
  assert.deepEqual(await recordRoutingShadowRun(input(), { ...environment,
    RAILWAY_DEPLOYMENT_ID: "7ac2d5a6-f003-489c-8c00-5b50c18e6575" }), { recorded: true });
  assert.deepEqual(await recordRoutingShadowRun(input(), { ...environment,
    RAILWAY_GIT_COMMIT_SHA: undefined }), { recorded: true });
  const scope = routingShadowQuery(["--commit=" + environment.RAILWAY_GIT_COMMIT_SHA,
    "--deployment=" + environment.RAILWAY_DEPLOYMENT_ID, "--environment=staging"]);
  const rows = await prisma.routingRun.findMany({ where: scope.where });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].traceId, target.traceId);
  assert.equal(rows[0].applicationEnvironment, "staging");
  const unbound = await prisma.routingRun.count({ where: { applicationCommitSha: null } });
  assert.equal(unbound, 1);
});

test("PostgreSQL refuses incomplete or malformed provenance on insert", async () => {
  const invalidIdentities = [
    {
      applicationCommitSha: "a".repeat(40),
      applicationDeploymentId: null,
      applicationEnvironment: null,
    },
    {
      applicationCommitSha: "not-a-full-commit-sha",
      applicationDeploymentId: environment.RAILWAY_DEPLOYMENT_ID,
      applicationEnvironment: "staging",
    },
    {
      applicationCommitSha: environment.RAILWAY_GIT_COMMIT_SHA,
      applicationDeploymentId: "not-a-deployment-uuid",
      applicationEnvironment: "staging",
    },
    {
      applicationCommitSha: environment.RAILWAY_GIT_COMMIT_SHA,
      applicationDeploymentId: environment.RAILWAY_DEPLOYMENT_ID,
      applicationEnvironment: "preview",
    },
  ];

  for (const identity of invalidIdentities) {
    await assert.rejects(
      prisma.routingRun.create({
        data: { ...buildRoutingShadowDecision(input()), ...identity },
      }),
      /RoutingRun_application_identity_complete_check/
    );
  }
});
