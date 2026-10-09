import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AMUX_V4_INITIAL_PLAN_READBACK_CODE_ENABLED,
  AMUX_V4_INITIAL_PLAN_WRITE_CODE_ENABLED,
  initialPlanReadbackPermitted,
  initialPlanWritePermitted,
  inspectInitialPlanRequest,
} from "../lib/amux/ideaInitialSourcePlanCore.ts";

const ideaId = "c3f7daea-9647-4a7f-9330-92caa0cb4b53";

test("initial source-plan gates require their dedicated environment values", () => {
  assert.equal(AMUX_V4_INITIAL_PLAN_WRITE_CODE_ENABLED, true);
  assert.equal(AMUX_V4_INITIAL_PLAN_READBACK_CODE_ENABLED, true);
  assert.equal(initialPlanWritePermitted(undefined), false);
  assert.equal(initialPlanReadbackPermitted(undefined), false);
  assert.equal(initialPlanWritePermitted("enabled"), true);
  assert.equal(initialPlanReadbackPermitted("enabled"), true);
});

test("initial source-plan accepts only one bounded owned idea identity", () => {
  assert.deepEqual(inspectInitialPlanRequest(JSON.stringify({ version: 1, ideaId })),
    { ok: true, ideaId });
  for (const body of [
    "not json", "[]", JSON.stringify({ version: 2, ideaId }),
    JSON.stringify({ version: 1, ideaId, transferAuthorized: true }),
    JSON.stringify({ version: 1, ideaId: "not-a-uuid" }),
  ]) assert.deepEqual(inspectInitialPlanRequest(body), { ok: false, code: "schema_rejected" });
  assert.deepEqual(inspectInitialPlanRequest(" ".repeat(257)),
    { ok: false, code: "too_large" });
});

test("writer and read-back have independent route gates and no model call", () => {
  const route = readFileSync(new URL("../app/api/admin/amux/ideas/initial-source-plan/route.ts", import.meta.url), "utf8");
  const access = readFileSync(new URL("../lib/amux/ideaInitialSourcePlanAccess.ts", import.meta.url), "utf8");
  assert.match(route, /!initialPlanWritePermitted\(process\.env\[AMUX_V4_INITIAL_PLAN_WRITE_ENV\]\)/);
  assert.match(route, /!initialPlanReadbackPermitted\(process\.env\[AMUX_V4_INITIAL_PLAN_READBACK_ENV\]\)/);
  assert.match(route, /readInitialIdeaSourcePlan\(session, ideaId\)/);
  assert.match(route, /consumeApiRateLimit/);
  assert.match(route, /assertRecentAdminAuthentication/);
  assert.doesNotMatch(route, /\b(?:streamText|generateText|fetch)\s*\(/);
  assert.match(access, /await writeAdminAuditLog\(\{/);
  assert.match(access, /tx, session: input\.session, request: input\.request/);
});
