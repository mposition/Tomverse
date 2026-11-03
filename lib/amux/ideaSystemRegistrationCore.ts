import { createHmac, timingSafeEqual } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { AMUX_V4_IDEA_SYSTEM_ACTOR,
  AMUX_V4_UNIT_DECISION_TARGET,
  AMUX_V19_SYSTEM_REGISTRATION_ACTION,
  AMUX_V19_SYSTEM_REGISTRATION_SCOPE,
  AMUX_V19_SYSTEM_REGISTRATION_TARGET,
  AMUX_V19_UNIT_REGISTRATION_SCOPE,
  SYSTEM_AUDIT_ACTOR_METADATA_KEY,
  auditRowActorKind } from
  "../adminAuditSystemActors.ts";
import type { AmuxDigestKey } from "./ideaCrypto.ts";

/**
 * Intake v19 autonomous registration: the owner approved it in chat on
 * 2026-10-21, after the first unattended staging analysis produced a plan.
 * This code latch is open; each environment still decides with the
 * dedicated switch below (set on staging, absent in production) and the
 * existing intake, analysis and budget switches, which this helper never
 * changes.
 */
export const AMUX_V19_SYSTEM_REGISTRATION_CODE_ENABLED = true;
export const AMUX_V19_SYSTEM_REGISTRATION_ENV =
  "TOMVERSE_AMUX_V19_SYSTEM_REGISTRATION";

export const AMUX_V19_SYSTEM_REGISTRATION_AUDIT_ACTOR =
  AMUX_V4_IDEA_SYSTEM_ACTOR;

export { AMUX_V19_SYSTEM_REGISTRATION_ACTION,
  AMUX_V19_SYSTEM_REGISTRATION_SCOPE,
  AMUX_V19_SYSTEM_REGISTRATION_TARGET };

export const AMUX_V19_UNIT_REGISTRATION_AUTHORITY = {
  kind: "system",
  systemActor: AMUX_V19_SYSTEM_REGISTRATION_AUDIT_ACTOR,
  bindingVersion: "amux-v19-system-registration-v1",
} as const;

export type AmuxV19UnitRegistrationAuthority =
  typeof AMUX_V19_UNIT_REGISTRATION_AUTHORITY;

const ID = /^[A-Za-z0-9:_-]{8,128}$/;
const DIGEST = /^[a-f0-9]{64}$/;

export function isAmuxV19UnitRegistrationAuthority(
  value: unknown,
): value is AmuxV19UnitRegistrationAuthority {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 3 &&
    record.kind === AMUX_V19_UNIT_REGISTRATION_AUTHORITY.kind &&
    record.systemActor === AMUX_V19_UNIT_REGISTRATION_AUTHORITY.systemActor &&
    record.bindingVersion === AMUX_V19_UNIT_REGISTRATION_AUTHORITY.bindingVersion;
}

/** A keyed authorization binding, never a browser or human-session receipt. */
export function deriveAmuxV19SystemRegistrationBinding(input: {
  ideaId: string;
  decisionId: string;
  actorUserId: string;
  key: AmuxDigestKey;
}): { digest: string; keyId: string } {
  if (![input.ideaId, input.decisionId, input.actorUserId].every((value) =>
    ID.test(value)) || !input.key.digestKeyId ||
      !Buffer.isBuffer(input.key.digestKey) || input.key.digestKey.length !== 32) {
    throw new Error("AMUX system registration binding unavailable");
  }
  return {
    digest: createHmac("sha256", input.key.digestKey)
      .update("amux-v19-system-registration-v1\0")
      .update(input.ideaId).update("\0")
      .update(input.decisionId).update("\0")
      .update(input.actorUserId).digest("hex"),
    keyId: input.key.digestKeyId,
  };
}

export function matchesAmuxV19SystemRegistrationBinding(
  expected: { digest: string; keyId: string },
  input: Parameters<typeof deriveAmuxV19SystemRegistrationBinding>[0],
): boolean {
  if (!DIGEST.test(expected.digest) || expected.keyId !== input.key.digestKeyId) {
    return false;
  }
  let actual: ReturnType<typeof deriveAmuxV19SystemRegistrationBinding>;
  try {
    actual = deriveAmuxV19SystemRegistrationBinding(input);
  } catch {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected.digest, "hex"),
    Buffer.from(actual.digest, "hex"));
}

export function deriveAmuxV19RegistrationRefusalRequestId(input: {
  ideaId: string;
  draftUnitId: string;
  analysisPreviewId: string;
  refusalCode: string;
  key: AmuxDigestKey;
}): string {
  if (![input.ideaId, input.draftUnitId, input.analysisPreviewId,
    input.refusalCode].every((value) => ID.test(value)) ||
      !ID.test(input.key.digestKeyId) ||
      !Buffer.isBuffer(input.key.digestKey) || input.key.digestKey.length !== 32) {
    throw new Error("AMUX system refusal identity unavailable");
  }
  const bytes = createHmac("sha256", input.key.digestKey)
    .update("amux-v19-system-registration-refusal-v1\0")
    .update(input.ideaId).update("\0")
    .update(input.draftUnitId).update("\0")
    .update(input.analysisPreviewId).update("\0")
    .update(input.refusalCode).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function amuxV19SystemRegistrationEnabled(env: NodeJS.ProcessEnv): boolean {
  return AMUX_V19_SYSTEM_REGISTRATION_CODE_ENABLED &&
    env[AMUX_V19_SYSTEM_REGISTRATION_ENV] === "enabled" &&
    env.TOMVERSE_AMUX_SESSION_INTAKE === "enabled" &&
    env.TOMVERSE_AMUX_V4_ANALYSIS_QUEUE_READ === "enabled" &&
    env.TOMVERSE_AMUX_V4_ANALYSIS_RESULT_READ === "enabled" &&
    env.TOMVERSE_AMUX_V4_ANALYSIS_RESULT_WRITE === "enabled" &&
    env.TOMVERSE_AMUX_V4_ANALYSIS_BUDGET_RESERVE === "enabled" &&
    env.TOMVERSE_AMUX_V4_ANALYSIS_BUDGET_READ === "enabled" &&
    env.TOMVERSE_AMUX_V4_UNIT_WRITE === "enabled" &&
    env.TOMVERSE_AMUX_V4_PORTFOLIO_WRITE === "enabled";
}

export type AmuxUnitDecisionAuditRow = {
  action: string; targetType: string; targetId: string | null;
  actorUserId: string | null; actorEmail: string | null;
  ipAddress: string | null; userAgent: string | null;
  metadata: unknown; entryHash: string | null;
};

const jsonObject = (value: unknown) => value && typeof value === "object" &&
  !Array.isArray(value) ? value as Record<string, unknown> : null;

/**
 * Who may have written a unit decision's prepare or consume audit. An Admin
 * registration is the deciding owner's own row. An intake v19 registration
 * stays the scoped system registrar's row (intake v19 item 5), bound to the
 * receipt's system authority and to the idea's one plan registration audit
 * (owner decision 2026-10-27). A human row carrying a system marker, or a
 * system row outside the unit registration scope, is neither.
 */
export function amuxUnitDecisionAuditActorValid(input: {
  audit: AmuxUnitDecisionAuditRow;
  decision: { id: string; ideaId: string; actorUserId: string;
    confirmationSnapshot: unknown };
  planRegistrationAudit: AmuxUnitDecisionAuditRow | null;
}): boolean {
  const { audit, decision, planRegistrationAudit: plan } = input;
  const snapshot = jsonObject(decision.confirmationSnapshot);
  const kind = auditRowActorKind(audit);
  if (kind === "human") {
    return audit.actorUserId === decision.actorUserId &&
      (!snapshot || !Object.hasOwn(snapshot, "registrationAuthority"));
  }
  const metadata = jsonObject(audit.metadata);
  const planMetadata = plan ? jsonObject(plan.metadata) : null;
  return kind === "system" && !!snapshot &&
    (audit.action === "amux.v4.unit.prepare" ||
      audit.action === "amux.v4.unit.consume") &&
    audit.targetType === AMUX_V4_UNIT_DECISION_TARGET &&
    audit.targetId === decision.id &&
    metadata?.[SYSTEM_AUDIT_ACTOR_METADATA_KEY] ===
      AMUX_V19_SYSTEM_REGISTRATION_AUDIT_ACTOR &&
    metadata.actorScope === AMUX_V19_UNIT_REGISTRATION_SCOPE &&
    metadata.registrationAuthority === "system" &&
    metadata.ideaId === decision.ideaId &&
    isAmuxV19UnitRegistrationAuthority(snapshot.registrationAuthority) &&
    !!plan && !!plan.entryHash && auditRowActorKind(plan) === "system" &&
    plan.action === AMUX_V19_SYSTEM_REGISTRATION_ACTION &&
    plan.targetType === AMUX_V19_SYSTEM_REGISTRATION_TARGET &&
    plan.targetId === decision.ideaId &&
    planMetadata?.[SYSTEM_AUDIT_ACTOR_METADATA_KEY] ===
      AMUX_V19_SYSTEM_REGISTRATION_AUDIT_ACTOR &&
    planMetadata.actorScope === AMUX_V19_SYSTEM_REGISTRATION_SCOPE;
}

export const AMUX_UNIT_DECISION_AUDIT_SELECT = { action: true,
  targetType: true, targetId: true,
  actorUserId: true, actorEmail: true, ipAddress: true, userAgent: true,
  metadata: true, entryHash: true } as const;

/** The idea's one v19 plan registration audit, read only when a unit audit
 * is not a person's: an Admin registration never needs it. */
export async function readAmuxPlanRegistrationAuditFor(
  db: Pick<Prisma.TransactionClient, "amuxIdeaSubmission" | "adminAuditLog">,
  ideaId: string,
  unitAudit: { actorUserId: string | null } | null,
): Promise<AmuxUnitDecisionAuditRow | null> {
  if (!unitAudit || unitAudit.actorUserId !== null) return null;
  const idea = await db.amuxIdeaSubmission.findUnique({ where: { id: ideaId },
    select: { systemRegistrationAuditLogId: true } });
  return idea?.systemRegistrationAuditLogId ?
    db.adminAuditLog.findUnique({ where: {
      id: idea.systemRegistrationAuditLogId },
    select: AMUX_UNIT_DECISION_AUDIT_SELECT }) :
    null;
}

/** The ungated transaction primitive is exposed only to an isolated local DB
 * test. Production callers must use the default-off public service. */
export function amuxV19SystemRegistrationTestBoundary(
  env: NodeJS.ProcessEnv,
): boolean {
  if (env.NODE_ENV !== "test") return false;
  const testUrl = env.TEST_DATABASE_URL?.trim();
  if (!testUrl || env.DATABASE_URL !== testUrl ||
      (env.DIRECT_DATABASE_URL && env.DIRECT_DATABASE_URL !== testUrl)) {
    return false;
  }
  try {
    const url = new URL(testUrl);
    return ["postgres:", "postgresql:"].includes(url.protocol) &&
      ["127.0.0.1", "localhost"].includes(url.hostname) &&
      /^\/[A-Za-z0-9_-]+(?:[_-]test[0-9]*)$/i.test(url.pathname) &&
      url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}
