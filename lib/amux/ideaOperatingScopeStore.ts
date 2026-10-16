import "server-only";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";
import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import {
  AMUX_OPERATING_SCOPE_ACTION, AMUX_OPERATING_SCOPE_POLICY_VERSION, AMUX_OPERATING_SCOPE_TARGET,
  normalizeAmuxOperatingScope, type AmuxOperatingScope,
} from "./ideaOperatingScopeCore.ts";

type Tx = Prisma.TransactionClient;
const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export class AmuxOperatingScopeError extends Error {
  constructor(readonly code: "forbidden" | "invalid_scope" | "revision_changed" |
    "request_already_seen" | "scope_unavailable") {
    super(code);
  }
}

export type AmuxOperatingScopeVersion = { version: number; scope: AmuxOperatingScope };

/**
 * The current scope, or null when the owner has never saved one (v19: intake is
 * then refused). A stored row that no longer passes the core check throws, so a
 * reader never falls back to an older or default scope.
 */
export async function readAmuxOperatingScope(tx: Tx): Promise<AmuxOperatingScopeVersion | null> {
  const latest = await tx.amuxIdeaOperatingScopeSetting.findFirst({ orderBy: { version: "desc" } });
  if (!latest) return null;
  const admitted = normalizeAmuxOperatingScope({ repositories: latest.repositories,
    model: { provider: latest.modelProvider, modelId: latest.modelId, reasoningEffort: latest.reasoningEffort } });
  if (!admitted.ok || JSON.stringify(admitted.scope.repositories) !== JSON.stringify(latest.repositories)) {
    throw new AmuxOperatingScopeError("scope_unavailable");
  }
  return { version: latest.version, scope: admitted.scope };
}

/**
 * Sole writer of AmuxIdeaOperatingScopeSetting. One owner save is one version and
 * one human audit row in the same transaction; the DB trigger re-checks both.
 */
export async function commitAmuxOperatingScope(tx: Tx, input: {
  session: Session; request: Request; id: string; expectedPreviousVersion: number;
  scope: unknown; ownerConfirmed: true;
}) {
  const actor = input.session.user?.id;
  if (!actor || !isAdminSession(input.session) || getAdminRole(input.session) !== "owner") {
    throw new AmuxOperatingScopeError("forbidden");
  }
  await assertRecentAdminAuthentication(input.session);
  const admitted = normalizeAmuxOperatingScope(input.scope);
  if (!admitted.ok || input.ownerConfirmed !== true || typeof input.id !== "string" ||
      !REQUEST_ID.test(input.id) || !Number.isSafeInteger(input.expectedPreviousVersion) ||
      input.expectedPreviousVersion < 0 || input.expectedPreviousVersion >= 2_147_483_647) {
    throw new AmuxOperatingScopeError("invalid_scope");
  }
  if (!adminAuditIntegrityKeys(process.env)[0]) throw new AmuxOperatingScopeError("scope_unavailable");
  await tx.$queryRaw`SELECT set_config('statement_timeout', '5000', true),
    set_config('idle_in_transaction_session_timeout', '10000', true)`;
  await takeAuditChainLock(tx);
  if (await tx.amuxIdeaOperatingScopeSetting.findUnique({ where: { id: input.id } })) {
    throw new AmuxOperatingScopeError("request_already_seen");
  }
  const current = await readAmuxOperatingScope(tx);
  const previousVersion = current?.version ?? 0;
  if (previousVersion !== input.expectedPreviousVersion) throw new AmuxOperatingScopeError("revision_changed");
  const version = previousVersion + 1;
  const { scope } = admitted;
  const auditId = await writeAdminAuditLog({ session: input.session, request: input.request,
    action: AMUX_OPERATING_SCOPE_ACTION, targetType: AMUX_OPERATING_SCOPE_TARGET, targetId: input.id,
    summary: "Owner saved the AMUX intake operating scope (repository allowlist and analysis model).",
    metadata: { version, previousVersion, repositories: scope.repositories,
      modelProvider: scope.model.provider, modelId: scope.model.modelId,
      reasoningEffort: scope.model.reasoningEffort, policyVersion: AMUX_OPERATING_SCOPE_POLICY_VERSION }, tx });
  await tx.amuxIdeaOperatingScopeSetting.create({ data: { id: input.id, version,
    repositories: scope.repositories, modelProvider: scope.model.provider, modelId: scope.model.modelId,
    reasoningEffort: scope.model.reasoningEffort, approvedByUserId: actor, approvalAuditLogId: auditId } });
  return { id: input.id, version, scope, auditId };
}
