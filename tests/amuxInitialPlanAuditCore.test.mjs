import assert from "node:assert/strict";
import test from "node:test";

import { matchesInitialPlanSystemAudit } from "../lib/amux/ideaInitialPlanAuditCore.ts";
import { AMUX_V4_IDEA_SYSTEM_ACTOR } from "../lib/adminAuditSystemActors.ts";

test("initial plan readback accepts only its own system audit metadata", () => {
  const valid = { systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR, manifestDigest: "digest" };
  assert.equal(matchesInitialPlanSystemAudit(valid, "digest"), true);
  assert.equal(matchesInitialPlanSystemAudit({ ...valid, manifestDigest: "other" }, "digest"), false);
  assert.equal(matchesInitialPlanSystemAudit({ ...valid, systemActor: "owner" }, "digest"), false);
  assert.equal(matchesInitialPlanSystemAudit([valid], "digest"), false);
});
