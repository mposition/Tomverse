import "server-only";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { prisma } from "@/lib/prisma";
import { inspectAmuxIdeaInput } from "./ideaInputCore.ts";
import {
  amuxLegacyCardCloseRefusal, amuxLegacyCardIdeaText, amuxLegacyCardKind,
  type AmuxLegacyCardCloseRefusal, type AmuxLegacyCardFacts, type AmuxLegacyCardKind,
} from "./legacyCardCore.ts";
import { amuxDatabaseDiagnosticCode } from "./readFailureCore.ts";

/**
 * The owner's two actions on a card the owner can only remake -- a legacy
 * WORKBOARD card or a pre-v22 Task (legacyCardCore.ts):
 * remake it as a new owner idea, and close it. Closing archives the card --
 * `archivedAt` and `revision` change, the status and every ledger stay -- and
 * resolves its open escalations, so it leaves the board and the owner queue.
 * One person's audit entry through the administrator writer, in the same
 * transaction. Undo: `archivedAt = NULL` on the card.
 */

export class AmuxLegacyCardOwnerError extends Error {
  constructor(readonly code: "forbidden" | "busy") {
    super(code);
    this.name = "AmuxLegacyCardOwnerError";
  }
}

const LEGACY_CARD_ID = /^[A-Za-z0-9_-]{1,64}$/;

type CardFacts = AmuxLegacyCardFacts & {
  id: string; displayKey: string | null; revision: number; archivedAt: Date | null;
  activeDelivery: boolean; liveAttempt: boolean;
};

/**
 * The facts a close is judged on, in one statement; `lock` takes the card row
 * without waiting. The last attempt is ordered as lockRecoveryTask orders it.
 */
async function readCardFacts(client: Prisma.TransactionClient | typeof prisma, taskId: string, lock: boolean) {
  const rows = lock ? await client.$queryRaw<CardFacts[]>`
      SELECT w."id", w."displayKey", w."sourceSystem", w."cardType", w."status", w."revision",
        w."archivedAt", w."v22ReceiptId"::text AS "v22ReceiptId", w."taskRole", w."executionGrade",
        EXISTS (SELECT 1 FROM "AmuxWorkDelivery" d WHERE d."taskId" = w."id"
          AND d."status" IN ('queued', 'leased')) AS "activeDelivery",
        EXISTS (SELECT 1 FROM "AmuxExecutionAttempt" a WHERE a."taskId" = w."id"
          AND a."endedAt" IS NULL) AS "liveAttempt",
        (SELECT json_build_object('endedAt', a."endedAt", 'outcome', a."outcome", 'reason', a."reason")
          FROM "AmuxExecutionAttempt" a WHERE a."taskId" = w."id"
          ORDER BY a."taskRevision" DESC, a."startedAt" DESC, a."id" DESC LIMIT 1) AS "lastAttempt"
      FROM "AmuxWorkItem" w WHERE w."id" = ${taskId}
      FOR UPDATE OF w NOWAIT` :
    await client.$queryRaw<CardFacts[]>`
      SELECT w."id", w."displayKey", w."sourceSystem", w."cardType", w."status", w."revision",
        w."archivedAt", w."v22ReceiptId"::text AS "v22ReceiptId", w."taskRole", w."executionGrade",
        EXISTS (SELECT 1 FROM "AmuxWorkDelivery" d WHERE d."taskId" = w."id"
          AND d."status" IN ('queued', 'leased')) AS "activeDelivery",
        EXISTS (SELECT 1 FROM "AmuxExecutionAttempt" a WHERE a."taskId" = w."id"
          AND a."endedAt" IS NULL) AS "liveAttempt",
        (SELECT json_build_object('endedAt', a."endedAt", 'outcome', a."outcome", 'reason', a."reason")
          FROM "AmuxExecutionAttempt" a WHERE a."taskId" = w."id"
          ORDER BY a."taskRevision" DESC, a."startedAt" DESC, a."id" DESC LIMIT 1) AS "lastAttempt"
      FROM "AmuxWorkItem" w WHERE w."id" = ${taskId}`;
  return rows[0] ?? null;
}

export type AmuxLegacyCardView = {
  /** Which kind of card the owner can only remake (legacyCardCore.ts). */
  kind: AmuxLegacyCardKind;
  /** Null when it can be closed now. */
  closeRefusal: Exclude<AmuxLegacyCardCloseRefusal, "not_legacy" | "changed"> | null;
  /** The idea a recreate would save, or why it would refuse. */
  idea: { state: "ready"; title: string; text: string; truncated: boolean } |
    { state: "refused"; code: string };
};

/**
 * What the card detail shows for a card the owner can only remake: its kind,
 * whether it closes now, and the idea a recreate would save, checked by the
 * same input gate the save uses. `body` and `brief` are the card's readable
 * assigned work (a v4 Task's decrypted body). Null for any other card. Read only.
 */
export async function readAmuxLegacyCardView(card: {
  id: string; revision: number; displayKey: string | null; sourceSystem: string | null;
  body: string | null; brief: string | null;
}): Promise<AmuxLegacyCardView | null> {
  if (card.sourceSystem !== "admin-idea-v4" && card.sourceSystem !== "tomverse_private_workboard") return null;
  const facts = await readCardFacts(prisma, card.id, false);
  const kind = facts ? amuxLegacyCardKind(facts) : null;
  if (!facts || !kind) return null;
  const refusal = amuxLegacyCardCloseRefusal(facts, card.revision);
  return { kind,
    closeRefusal: refusal === "not_legacy" || refusal === "changed" ? null : refusal,
    idea: legacyIdea({ id: card.id, displayKey: card.displayKey, description: card.body,
      executionBrief: card.brief, kind, taskRole: facts.taskRole }) };
}

/** The idea text of a card and the input gate's verdict on it. */
function legacyIdea(card: Parameters<typeof amuxLegacyCardIdeaText>[0]): AmuxLegacyCardView["idea"] {
  const built = amuxLegacyCardIdeaText(card);
  if (!built.ok) return { state: "refused", code: built.code };
  const inspected = inspectAmuxIdeaInput(JSON.stringify({ version: 1, idea: built.text,
    repositories: [], pullRequests: [] }));
  if (!inspected.ok) return { state: "refused", code: inspected.code };
  return { state: "ready", title: built.title, text: built.text, truncated: built.truncated };
}

export type AmuxLegacyCardCloseResult =
  | { outcome: "closed"; archivedAt: string; escalationsResolved: number; auditId: string }
  | { outcome: "not_found" }
  | { outcome: "refused"; reason: AmuxLegacyCardCloseRefusal };

/** Owner role and recent re-authentication, before anything is read. */
export async function assertAmuxLegacyCardOwner(session: Session) {
  if (!session.user?.id || !isAdminSession(session) || getAdminRole(session) !== "owner")
    throw new AmuxLegacyCardOwnerError("forbidden");
  await assertRecentAdminAuthentication(session);
}

/**
 * Closes one legacy card: the audit chain lock first, the card row without
 * waiting (a worker's writers lock the card and then the chain, so waiting
 * here would deadlock with them), the judgment again under the lock, then the
 * archive, the escalations and the audit entry. `ideaId` names the idea a
 * recreate saved for it.
 */
export async function closeAmuxLegacyCardForOwner(input: {
  session: Session; request: Request; taskId: string; revision: number; ideaId: string | null;
}): Promise<AmuxLegacyCardCloseResult> {
  await assertAmuxLegacyCardOwner(input.session);
  if (!LEGACY_CARD_ID.test(input.taskId)) return { outcome: "not_found" };
  const actorUserId = input.session.user!.id!;
  return prisma.$transaction(async (tx) => {
    const clock = await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT set_config('statement_timeout', '5000', true),
             set_config('idle_in_transaction_session_timeout', '10000', true),
             date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC') AS "now"`;
    await takeAuditChainLock(tx);
    const now = clock[0]?.now;
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("clock_unavailable");
    const card = await readCardFacts(tx, input.taskId, true);
    if (!card) return { outcome: "not_found" as const };
    const refusal = amuxLegacyCardCloseRefusal(card, input.revision);
    if (refusal) return { outcome: "refused" as const, reason: refusal };
    const moved = await tx.amuxWorkItem.updateMany({
      where: { id: card.id, revision: card.revision, archivedAt: null },
      data: { archivedAt: now, revision: { increment: 1 } },
    });
    if (moved.count !== 1) return { outcome: "refused" as const, reason: "changed" as const };
    const kind = amuxLegacyCardKind(card)!;
    const label = kind === "workboard" ? "a legacy WORKBOARD card" : "a pre-v22 Task with no recovery path";
    const resolution = input.ideaId ?
      `Closed as ${label}; recreated as AMUX idea ${input.ideaId}.` :
      `Closed as ${label} by the owner.`;
    const resolved = await tx.amuxHumanEscalation.updateMany({
      where: { taskId: card.id, status: { in: ["open", "acknowledged"] } },
      data: { status: "resolved", resolutionOutcome: "block", resolution,
        resolvedById: actorUserId, resolvedByEmail: input.session.user?.email ?? null, resolvedAt: now },
    });
    const archivedAt = now.toISOString();
    const auditId = await writeAdminAuditLog({ tx, session: input.session, request: input.request,
      action: "amux.legacy_card.closed", targetType: "AmuxWorkItem", targetId: card.id,
      summary: input.ideaId ? `Closed ${label} after recreating it as a new AMUX idea.` : `Closed ${label}.`,
      metadata: { kind, displayKey: card.displayKey, status: card.status, revision: card.revision,
        archivedAt, escalationsResolved: resolved.count,
        ...(input.ideaId ? { recreatedIdeaId: input.ideaId } : {}) } });
    return { outcome: "closed" as const, archivedAt, escalationsResolved: resolved.count, auditId };
  }, { maxWait: 5_000, timeout: 15_000 }).catch((error: unknown) => {
    if (amuxDatabaseDiagnosticCode(error) === "55P03") throw new AmuxLegacyCardOwnerError("busy");
    throw error;
  });
}
