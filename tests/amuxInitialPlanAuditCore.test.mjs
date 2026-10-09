import assert from "node:assert/strict";
import test from "node:test";

import { matchesInitialPlanSystemAudit } from "../lib/amux/ideaInitialPlanAuditCore.ts";
import {
  AMUX_V4_IDEA_SYSTEM_ACTOR,
  AMUX_V4_INITIAL_SOURCE_PLAN_ACTION,
  AMUX_V4_INITIAL_SOURCE_PLAN_SCOPE,
  AMUX_V4_INITIAL_SOURCE_PLAN_TARGET,
} from "../lib/adminAuditSystemActors.ts";

test("initial plan readback accepts only a classified scoped system audit", () => {
  const valid = {
    action: AMUX_V4_INITIAL_SOURCE_PLAN_ACTION,
    targetType: AMUX_V4_INITIAL_SOURCE_PLAN_TARGET,
    actorUserId: null, actorEmail: null, ipAddress: null, userAgent: null,
    metadata: { systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
      actorScope: AMUX_V4_INITIAL_SOURCE_PLAN_SCOPE, manifestDigest: "digest" },
  };
  assert.equal(matchesInitialPlanSystemAudit(valid, "digest"), true);
  assert.equal(matchesInitialPlanSystemAudit({ ...valid,
    metadata: { ...valid.metadata, manifestDigest: "other" } }, "digest"), false);
  assert.equal(matchesInitialPlanSystemAudit({ ...valid,
    metadata: { ...valid.metadata, systemActor: "owner" } }, "digest"), false);
  assert.equal(matchesInitialPlanSystemAudit({ ...valid,
    metadata: { ...valid.metadata, actorScope: "other" } }, "digest"), false);
  assert.equal(matchesInitialPlanSystemAudit({ ...valid, actorEmail: "owner@example.test" }, "digest"), false);
  assert.equal(matchesInitialPlanSystemAudit({ ...valid, metadata: [valid.metadata] }, "digest"), false);
});
