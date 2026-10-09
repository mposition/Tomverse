import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";

import {
  AMUX_PROPOSED_SYSTEM_AUDIT_ACTORS,
  AMUX_V4_ANALYSIS_BUDGET_EXPIRE_ACTION,
  AMUX_V4_ANALYSIS_BUDGET_EXPIRE_SCOPE,
  AMUX_V4_ANALYSIS_BUDGET_EXPIRE_TARGET,
  AMUX_V4_ANALYSIS_BUDGET_RESERVE_ACTION,
  AMUX_V4_ANALYSIS_BUDGET_RESERVE_SCOPE,
  AMUX_V4_ANALYSIS_BUDGET_RESERVE_TARGET,
  AMUX_V4_ANALYSIS_BUDGET_SETTLE_ACTION,
  AMUX_V4_ANALYSIS_BUDGET_SETTLE_SCOPE,
  AMUX_V4_ANALYSIS_BUDGET_SETTLE_TARGET,
  AMUX_V4_ANALYSIS_OUTCOME_UNKNOWN_ACTION,
  AMUX_V4_ANALYSIS_OUTCOME_UNKNOWN_SCOPE,
  AMUX_V4_ANALYSIS_OUTCOME_UNKNOWN_TARGET,
  AMUX_V4_FIRST_DRAFT_SAVED_ACTION,
  AMUX_V4_FIRST_DRAFT_SAVED_SCOPE,
  AMUX_V4_FIRST_DRAFT_SAVED_TARGET,
  AMUX_V4_IDEA_AUTO_CANCEL_ACTION,
  AMUX_V4_IDEA_AUTO_CANCEL_SCOPE,
  AMUX_V4_IDEA_AUTO_CANCEL_TARGET,
  AMUX_V4_INITIAL_SOURCE_PLAN_ACTION,
  AMUX_V4_INITIAL_SOURCE_PLAN_SCOPE,
  AMUX_V4_INITIAL_SOURCE_PLAN_TARGET,
  AMUX_V4_UNIT_DECISION_TARGET,
  AMUX_V4_UNIT_HOUSEKEEPING_SCOPE,
  AMUX_V4_UNIT_INVALIDATE_ACTION,
  AMUX_V4_UNIT_UNKNOWN_ACTION,
  SYSTEM_AUDIT_ACTORS,
  SYSTEM_AUDIT_ACTOR_METADATA_KEY,
  auditRowActorKind,
  isSystemAuditActor,
  metadataClaimsSystemActor,
  systemAuditActionAllowed,
} from "../lib/adminAuditSystemActors.ts";
import {
  AMUX_V4_IDEA_AGENT_ID,
  AMUX_V4_IDEA_SOURCE_SYSTEM,
  AMUX_V4_IDEA_SYSTEM_ACTOR,
} from "../lib/amux/ideaIdentityCore.ts";

// The closed list of system actors and the reserved metadata key.
//
// Contract: docs/policy/marketing-automation.md §6. Several later checks ask
// "was this a human?" of a stored audit row -- a template approval, a resume
// into autonomous mode, a webhook verification signature -- so what counts as
// human and what counts as system is decided here, once.

const ROOT = resolve(import.meta.dirname, "..");

test("the system actor list is closed and changes only by review", () => {
  // The policy names the publisher (docs/policy/marketing-automation.md §4);
  // retention and guard are the S1 plan's other two writers. This pins the
  // reviewed list, not a quotation of the policy.
  // amux-auto-promoter: orchestration policy version 15, "자동 승격 개정".
  assert.deepEqual([...SYSTEM_AUDIT_ACTORS], [
    "marketing-publisher",
    "marketing-retention",
    "marketing-guard",
    // S2e: the staging shadow receiver. On the guard's line in the source so
    // the sealed Prompt Refiner closure's positions do not move.
    "marketing-webhook",
    "prompt-refiner-shadow-runner",
    "tomverse-amux-orchestrator",
    "amux-auto-promoter",
    "amux-v22-auto-admit",
    "amux-v22-worker-claim",
    "amux-v4-intake",
    "engineering-agent-runner",
    "engineering-agent-publisher",
    "engineering-agent-retention",
    "engineering-agent-observer",
    "engineering-agent-registrar",
    // docs/policy/qa-release-agent.md section 5: the digest intake route.
    "qa-release-intake",
    // docs/policy/qa-release-agent.md section 5: the merge lane's own attempts and latches.
    "qa-release-merge-lane",
    // The shared AgentDigestItem body expiry and meta purge, for every agent
    // (docs/policy/qa-release-agent.md section 4).
    "agent-digest-retention",
    // The product-research agent's two actions and no more
    // (docs/policy/product-research-agent.md §5): a slot recorded, and rows
    // removed once past the retention period. Neither is a person, and this
    // agent has nothing to approve because it decides nothing.
    "product-research-observer",
    "product-research-retention",
    // docs/policy/billing-finance-ops.md §1.1: the stage W digest intake route.
    "billing-finance-ops-intake",
    // docs/policy/amux-decision-maker.md §10: the routing route and one actor
    // per DM instance. A DM writes proposals, never approvals (§1).
    "amux-decision-router",
    "amux-decision-maker-openai",
    "amux-decision-maker-anthropic",
    // docs/policy/sre-ops.md §3-10: the sre-ops store's transitions and retention.
    "ops-observer",
  ]);
  assert.equal(SYSTEM_AUDIT_ACTOR_METADATA_KEY, "systemActor");
  assert.equal(isSystemAuditActor("marketing-guard"), true);
  assert.equal(isSystemAuditActor("Marketing-Guard"), false);
  assert.equal(isSystemAuditActor("tomverse-amux-orchestrator"), true);
  assert.equal(isSystemAuditActor("amux-auto-promoter"), true);
  assert.equal(isSystemAuditActor("amux-v22-auto-admit"), true);
  // Only explicitly scoped v4 actions use the intake identity. The
  // remaining candidate actors have no audit-writer authority.
  assert.deepEqual([...AMUX_PROPOSED_SYSTEM_AUDIT_ACTORS], [
    "amux-intake-supervisor",
    "amux-intake-retention",
    "amux-portfolio-scorer",
  ]);
  assert.equal(systemAuditActionAllowed("amux-v22-auto-admit",
    "amux.v22.auto_promotion.consumed", "AmuxV22PromotionReceipt"), true);
  assert.equal(systemAuditActionAllowed("amux-v22-auto-admit",
    "amux.v22.auto_promotion.outcome_unknown", "AmuxV22PromotionUnknown"), true);
  assert.equal(systemAuditActionAllowed("amux-v22-auto-admit",
    "amux.auto_promotion.halted", "AmuxRecommendationAutoHalt"), true);
  assert.equal(systemAuditActionAllowed("amux-v22-auto-admit",
    "amux.claim.assigned", "AmuxWorkItem"), false);
  assert.equal(AMUX_V4_IDEA_SOURCE_SYSTEM, "admin-idea-v4");
  assert.equal(AMUX_V4_IDEA_AGENT_ID, "amux-intake");
  assert.equal(isSystemAuditActor(AMUX_V4_IDEA_SYSTEM_ACTOR), true);
  assert.equal(systemAuditActionAllowed(AMUX_V4_IDEA_SYSTEM_ACTOR,
    AMUX_V4_UNIT_UNKNOWN_ACTION, AMUX_V4_UNIT_DECISION_TARGET), true);
  assert.equal(systemAuditActionAllowed(AMUX_V4_IDEA_SYSTEM_ACTOR,
    AMUX_V4_UNIT_INVALIDATE_ACTION, "AmuxWorkItem"), false);
  assert.equal(auditRowActorKind(row({
    action: AMUX_V4_UNIT_UNKNOWN_ACTION,
    targetType: AMUX_V4_UNIT_DECISION_TARGET,
    metadata: { systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
      actorScope: AMUX_V4_UNIT_HOUSEKEEPING_SCOPE },
  })), "system");
  assert.equal(auditRowActorKind(row({
    action: AMUX_V4_INITIAL_SOURCE_PLAN_ACTION,
    targetType: AMUX_V4_INITIAL_SOURCE_PLAN_TARGET,
    metadata: { systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
      actorScope: AMUX_V4_INITIAL_SOURCE_PLAN_SCOPE },
  })), "system");
  assert.equal(systemAuditActionAllowed(AMUX_V4_IDEA_SYSTEM_ACTOR,
    AMUX_V4_INITIAL_SOURCE_PLAN_ACTION, AMUX_V4_INITIAL_SOURCE_PLAN_TARGET), true);
  assert.equal(systemAuditActionAllowed(AMUX_V4_IDEA_SYSTEM_ACTOR,
    AMUX_V4_ANALYSIS_BUDGET_RESERVE_ACTION,
    AMUX_V4_ANALYSIS_BUDGET_RESERVE_TARGET), true);
  assert.equal(auditRowActorKind(row({
    action: AMUX_V4_ANALYSIS_BUDGET_RESERVE_ACTION,
    targetType: AMUX_V4_ANALYSIS_BUDGET_RESERVE_TARGET,
    metadata: { systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
      actorScope: AMUX_V4_ANALYSIS_BUDGET_RESERVE_SCOPE },
  })), "system");
  assert.equal(systemAuditActionAllowed(AMUX_V4_IDEA_SYSTEM_ACTOR,
    AMUX_V4_ANALYSIS_BUDGET_EXPIRE_ACTION,
    AMUX_V4_ANALYSIS_BUDGET_EXPIRE_TARGET), true);
  assert.equal(auditRowActorKind(row({
    action: AMUX_V4_ANALYSIS_BUDGET_EXPIRE_ACTION,
    targetType: AMUX_V4_ANALYSIS_BUDGET_EXPIRE_TARGET,
    metadata: { systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
      actorScope: AMUX_V4_ANALYSIS_BUDGET_EXPIRE_SCOPE },
  })), "system");
  assert.equal(auditRowActorKind(row({
    action: AMUX_V4_ANALYSIS_BUDGET_EXPIRE_ACTION,
    targetType: AMUX_V4_ANALYSIS_BUDGET_EXPIRE_TARGET,
    metadata: { systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
      actorScope: AMUX_V4_ANALYSIS_BUDGET_RESERVE_SCOPE },
  })), "unknown");
  assert.equal(systemAuditActionAllowed(AMUX_V4_IDEA_SYSTEM_ACTOR,
    AMUX_V4_ANALYSIS_BUDGET_SETTLE_ACTION,
    AMUX_V4_ANALYSIS_BUDGET_SETTLE_TARGET), true);
  assert.equal(auditRowActorKind(row({
    action: AMUX_V4_ANALYSIS_BUDGET_SETTLE_ACTION,
    targetType: AMUX_V4_ANALYSIS_BUDGET_SETTLE_TARGET,
    metadata: { systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
      actorScope: AMUX_V4_ANALYSIS_BUDGET_SETTLE_SCOPE },
  })), "system");
  assert.equal(auditRowActorKind(row({
    action: AMUX_V4_ANALYSIS_BUDGET_SETTLE_ACTION,
    targetType: AMUX_V4_ANALYSIS_BUDGET_SETTLE_TARGET,
    metadata: { systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
      actorScope: AMUX_V4_ANALYSIS_BUDGET_EXPIRE_SCOPE },
  })), "unknown");
  assert.equal(systemAuditActionAllowed(AMUX_V4_IDEA_SYSTEM_ACTOR,
    AMUX_V4_ANALYSIS_OUTCOME_UNKNOWN_ACTION,
    AMUX_V4_ANALYSIS_OUTCOME_UNKNOWN_TARGET), true);
  assert.equal(auditRowActorKind(row({
    action: AMUX_V4_ANALYSIS_OUTCOME_UNKNOWN_ACTION,
    targetType: AMUX_V4_ANALYSIS_OUTCOME_UNKNOWN_TARGET,
    metadata: { systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
      actorScope: AMUX_V4_ANALYSIS_OUTCOME_UNKNOWN_SCOPE },
  })), "system");
  assert.equal(auditRowActorKind(row({
    action: AMUX_V4_ANALYSIS_OUTCOME_UNKNOWN_ACTION,
    targetType: AMUX_V4_ANALYSIS_OUTCOME_UNKNOWN_TARGET,
    metadata: { systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
      actorScope: AMUX_V4_ANALYSIS_BUDGET_SETTLE_SCOPE },
  })), "unknown");
  assert.equal(systemAuditActionAllowed(AMUX_V4_IDEA_SYSTEM_ACTOR,
    AMUX_V4_FIRST_DRAFT_SAVED_ACTION, AMUX_V4_FIRST_DRAFT_SAVED_TARGET), true);
  assert.equal(auditRowActorKind(row({
    action: AMUX_V4_FIRST_DRAFT_SAVED_ACTION,
    targetType: AMUX_V4_FIRST_DRAFT_SAVED_TARGET,
    metadata: { systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
      actorScope: AMUX_V4_FIRST_DRAFT_SAVED_SCOPE },
  })), "system");
  assert.equal(systemAuditActionAllowed(AMUX_V4_IDEA_SYSTEM_ACTOR,
    AMUX_V4_IDEA_AUTO_CANCEL_ACTION, AMUX_V4_IDEA_AUTO_CANCEL_TARGET), true);
  assert.equal(auditRowActorKind(row({
    action: AMUX_V4_IDEA_AUTO_CANCEL_ACTION,
    targetType: AMUX_V4_IDEA_AUTO_CANCEL_TARGET,
    metadata: { systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
      actorScope: AMUX_V4_IDEA_AUTO_CANCEL_SCOPE },
  })), "system");
  assert.equal(auditRowActorKind(row({
    action: AMUX_V4_IDEA_AUTO_CANCEL_ACTION,
    targetType: AMUX_V4_IDEA_AUTO_CANCEL_TARGET,
    metadata: { systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
      actorScope: AMUX_V4_ANALYSIS_BUDGET_EXPIRE_SCOPE },
  })), "unknown");
  assert.equal(auditRowActorKind(row({
    action: AMUX_V4_ANALYSIS_BUDGET_RESERVE_ACTION,
    targetType: AMUX_V4_ANALYSIS_BUDGET_RESERVE_TARGET,
    metadata: { systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR,
      actorScope: AMUX_V4_INITIAL_SOURCE_PLAN_SCOPE },
  })), "unknown");
  assert.equal(systemAuditActionAllowed(AMUX_V4_IDEA_SYSTEM_ACTOR,
    "AMUX_V4_CARD_REGISTERED", AMUX_V4_INITIAL_SOURCE_PLAN_TARGET), false);
  assert.equal(systemAuditActionAllowed(AMUX_V4_IDEA_SYSTEM_ACTOR,
    AMUX_V4_INITIAL_SOURCE_PLAN_ACTION, "AmuxWorkItem"), false);
  assert.equal(auditRowActorKind(row({
    action: AMUX_V4_INITIAL_SOURCE_PLAN_ACTION,
    targetType: AMUX_V4_INITIAL_SOURCE_PLAN_TARGET,
    metadata: { systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR },
  })), "unknown", "legacy marker-only rows must not be retroactively classified");
  for (const proposed of AMUX_PROPOSED_SYSTEM_AUDIT_ACTORS) {
    assert.equal(new Set<string>(SYSTEM_AUDIT_ACTORS).has(proposed), false);
    assert.equal(isSystemAuditActor(proposed), false);
    assert.equal(auditRowActorKind(row({ metadata: { systemActor: proposed } })), "unknown");
  }
  assert.equal(isSystemAuditActor("Tomverse-AMUX-Orchestrator"), false);
  // The column marker is not an audit actor name.
  assert.equal(isSystemAuditActor("system:amux-auto-promoter"), false);
  assert.equal(isSystemAuditActor(undefined), false);
});

test("only a top-level key of an object claims the marker", () => {
  assert.equal(metadataClaimsSystemActor({ systemActor: "x" }), true);
  assert.equal(metadataClaimsSystemActor({ systemActor: undefined }), true);
  assert.equal(metadataClaimsSystemActor({ nested: { systemActor: "x" } }), false);
  assert.equal(metadataClaimsSystemActor(["systemActor"]), false);
  assert.equal(metadataClaimsSystemActor(null), false);
  assert.equal(metadataClaimsSystemActor("systemActor"), false);
  // An inherited property is not the row's own claim.
  assert.equal(
    metadataClaimsSystemActor(Object.create({ systemActor: "x" })),
    false
  );
});

const row = (overrides: Record<string, unknown>) => ({
  actorUserId: null,
  actorEmail: null,
  ipAddress: null,
  userAgent: null,
  metadata: null,
  ...overrides,
});

test("a stored row is human, system, or unknown -- never guessed", () => {
  assert.equal(
    auditRowActorKind(row({ actorUserId: "admin-1", actorEmail: "a@example.test" })),
    "human"
  );
  assert.equal(
    auditRowActorKind(row({ metadata: { systemActor: "marketing-publisher" } })),
    "system"
  );
  // Neither an actor nor a marker.
  assert.equal(auditRowActorKind(row({})), "unknown");
  // A marker beside session fields cannot come from either writer.
  assert.equal(
    auditRowActorKind(
      row({ actorUserId: "admin-1", metadata: { systemActor: "marketing-publisher" } })
    ),
    "unknown"
  );
  assert.equal(
    auditRowActorKind(
      row({ ipAddress: "203.0.113.7", metadata: { systemActor: "marketing-publisher" } })
    ),
    "unknown"
  );
  // A marker naming an actor that is not listed.
  assert.equal(
    auditRowActorKind(row({ metadata: { systemActor: "marketing-intern" } })),
    "unknown"
  );
});

const walk = (directory: string): string[] =>
  readdirSync(directory).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx|mjs|js)$/.test(name) ? [path] : [];
  });

test("no administrator audit call site names the reserved key", () => {
  // The administrator writer began refusing `metadata.systemActor` in the same
  // change that introduced the system writer. That refusal throws, so a caller
  // already passing the key would have started failing its action. None did
  // when this was written (a repository search found the word only in the two
  // audit modules); this keeps every file that calls the administrator writer
  // free of it, so a future caller that needs both has to come through review.
  // It reads source text only: metadata built at runtime (a parsed body, a
  // result object) is covered by the writer's own refusal, not by this scan.
  const allowed = new Set(["lib/adminAudit.ts", "lib/adminAuditSystemActors.ts"]);
  const callSites = ["app", "lib", "components", "scripts", "packages"]
    .flatMap((top) => walk(resolve(ROOT, top)))
    .map((path) => relative(ROOT, path).split("\\").join("/"))
    .filter((path) => !allowed.has(path))
    .map((path) => ({ path, source: readFileSync(resolve(ROOT, path), "utf8") }))
    .filter(({ source }) => source.includes("writeAdminAuditLog("));
  assert.ok(callSites.length > 50, "the scan must actually reach the call sites");
  assert.deepEqual(
    callSites
      .filter(({ source }) => source.includes(SYSTEM_AUDIT_ACTOR_METADATA_KEY))
      .map(({ path }) => path),
    []
  );
});
