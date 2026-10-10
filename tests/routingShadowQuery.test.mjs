import assert from "node:assert/strict";
import test from "node:test";
import { routingShadowQuery } from "../lib/routingShadowQuery.ts";

const now = new Date("2026-10-10T00:00:00Z");
const identityArgs = ["--commit=" + "a".repeat(40),
  "--deployment=7ac2d5a6-f003-489c-8c00-5b50c18e6574", "--environment=staging"];

test("deployment-scoped reports exclude historical and other-deployment rows in SQL", () => {
  const query = routingShadowQuery(identityArgs, now);
  assert.equal(query.measurementScope, "recorded_application_identity");
  assert.equal(query.where.applicationCommitSha, "a".repeat(40));
  assert.equal(query.where.applicationDeploymentId, "7ac2d5a6-f003-489c-8c00-5b50c18e6574");
  assert.equal(query.where.applicationEnvironment, "staging");
  assert.equal(query.where.createdAt.lte.toISOString(), now.toISOString());
});

test("an unfiltered report never claims deployment binding", () => {
  assert.equal(routingShadowQuery([], now).identity, null);
  assert.equal(routingShadowQuery([], now).measurementScope, "historical_window_without_deployment_binding");
});

test("partial identities and future/reversed windows cannot produce a bound report", () => {
  for (const args of [identityArgs.slice(0, 2), ["--commit="],
    ["--until=2026-10-11T00:00:00Z"], ["--since=2026-10-10T00:00:00Z"],
    ["--since=invalid"], ["--limit=Infinity"], ["--days=abc"], ["--days=0"],
    ["--limit=-1"], ["--limit=1.5"], ["--commit", "a".repeat(40)],
    ["--commit " + "a".repeat(40)], ["--limit=1", "--limit=2"]]) {
    assert.throws(() => routingShadowQuery(args, now));
  }
});
