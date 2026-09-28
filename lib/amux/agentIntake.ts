import "server-only";

import { createHmac } from "node:crypto";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import type { SystemAuditActor } from "@/lib/adminAuditSystemActors";
import {
  AMUX_DB_BOUNDARIES,
  amuxBoundaryWithAttachment,
  withAmuxDbBoundary,
  type AmuxAttachment,
} from "@/lib/amux/dbBoundary";

/**
 * The AMUX intake's agent registration source (docs/policy/amux-intake.md,
 * version 2, "에이전트 등록 원천"). A second writer, separate from the human
 * path's: it writes one `backlog` card and the agent's system audit entry in
 * one transaction, with the agent's own registration record attached. It uses
 * none of the human path's draft, approval, step-up or read-back of four.
 *
 * Its code latch ships false and is independent of the human path's; the
 * environment value, the latch and the agent's operating mode must all allow
 * it. Registration is not execution and not promotion: the card has no owner,
 * claim, attempt, delivery or route decision.
 */

export const AMUX_AGENT_INTAKE_POLICY_VERSION = 2;

/** Version 2 ships this false; turning it on is a separate approval. */
export const AMUX_AGENT_INTAKE_APPLY_CODE_LATCH = false;
export const AMUX_AGENT_INTAKE_APPLY_ENV = "TOMVERSE_AMUX_INTAKE_AGENT_APPLY";

/** The approved agents and their closed source systems. */
export const AMUX_AGENT_INTAKE_SOURCES = {
  "engineering-agent": [
    "engineering-product-backlog",
    "engineering-develop-ci",
    "engineering-dependabot-ci",
  ],
} as const;

export type AmuxAgentIntakeAgent = keyof typeof AMUX_AGENT_INTAKE_SOURCES;

export const amuxAgentIntakeApplyPermitted = (input: {
  codeLatch: boolean;
  envValue: string | undefined;
}): boolean => input.codeLatch === true && input.envValue === "enabled";

export const isAmuxAgentIntakeOpen = (env: Readonly<Record<string, string | undefined>> = process.env) =>
  amuxAgentIntakeApplyPermitted({
    codeLatch: AMUX_AGENT_INTAKE_APPLY_CODE_LATCH,
    envValue: env[AMUX_AGENT_INTAKE_APPLY_ENV],
  });

/**
 * The stored source key: the HMAC, in uppercase hex, of the source's canonical
 * identity. The identity itself is not stored. The secret is the intake's.
 */
export const amuxAgentIntakeSourceKey = (secret: string, canonicalIdentity: string): string | null => {
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) return null;
  if (typeof canonicalIdentity !== "string" || canonicalIdentity.length === 0) return null;
  return createHmac("sha256", secret).update(canonicalIdentity, "utf8").digest("hex").toUpperCase();
};

export type AmuxAgentIntakeCard = {
  agentId: AmuxAgentIntakeAgent;
  sourceSystem: string;
  sourceKey: string;
  sourceVersion: string;
  sourceDigest: string;
  title: string;
  priority: "p0" | "p1" | "p2" | "p3";
  proposalDigest: string;
  scannerVersion: string;
};

/** What an attachment sees: the card that now holds the registration. */
export type AmuxAgentIntakeFact = { cardId: string; created: boolean };

const SOURCE_KEY = /^[A-F0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^[!-~]{1,128}$/;

/**
 * Writes the card, or finds the one this source identity already made. The
 * same identity with the same digest is the same card (`created: false`); a
 * different digest is a conflict and writes nothing. The attached work -- the
 * agent's registration record -- runs in the same transaction either way, and
 * decides for itself what an existing card means for it.
 *
 * Two proposals of one identity are serialized on that identity before the
 * card is looked up, so the second finds the first's card instead of meeting
 * the unique index -- a definite answer, never an error that reads as unknown.
 */
export async function registerAmuxAgentIntakeCard(
  input: { card: AmuxAgentIntakeCard; actor: SystemAuditActor },
  attachment?: AmuxAttachment<AmuxAgentIntakeFact>,
): Promise<{ registered: true; cardId: string; created: boolean } | { registered: false; reason: "conflict" }> {
  const { card } = input;
  const allowed = AMUX_AGENT_INTAKE_SOURCES[card.agentId] as readonly string[] | undefined;
  if (
    allowed === undefined ||
    !allowed.includes(card.sourceSystem) ||
    !SOURCE_KEY.test(card.sourceKey) ||
    !VERSION.test(card.sourceVersion) ||
    !SHA256.test(card.sourceDigest) ||
    !SHA256.test(card.proposalDigest) ||
    card.title.length === 0
  ) {
    throw new Error("AMUX agent intake card is invalid");
  }
  return withAmuxDbBoundary(
    amuxBoundaryWithAttachment(AMUX_DB_BOUNDARIES.agentIntake, attachment),
    async (tx, context) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`amux-agent-intake:${card.sourceSystem}:${card.sourceKey}`}))`;
      const existing = await tx.amuxWorkItem.findUnique({
        where: { sourceSystem_sourceKey: { sourceSystem: card.sourceSystem, sourceKey: card.sourceKey } },
        select: { id: true, sourceDigest: true },
      });
      let cardId: string;
      let created: boolean;
      if (existing) {
        if (existing.sourceDigest !== card.sourceDigest) return { registered: false as const, reason: "conflict" as const };
        cardId = existing.id;
        created = false;
      } else {
        const row = await tx.amuxWorkItem.create({
          data: {
            title: card.title,
            description: null,
            status: "backlog",
            kind: "unknown",
            priority: card.priority,
            owner: null,
            claimedAt: null,
            pinned: false,
            drag: 0,
            revision: 0,
            sourceSystem: card.sourceSystem,
            sourceKey: card.sourceKey,
            sourceVersion: card.sourceVersion,
            sourceDigest: card.sourceDigest,
            sourceSnapshot: {
              agentId: card.agentId,
              policyVersion: AMUX_AGENT_INTAKE_POLICY_VERSION,
              proposalDigest: card.proposalDigest,
              priority: card.priority,
            },
            executionBrief: null,
            executionBriefDigest: null,
          },
          select: { id: true },
        });
        cardId = row.id;
        created = true;
        await writeSystemAuditLog({
          systemActor: input.actor,
          action: "amux.intake.agent_registered",
          targetType: "AmuxWorkItem",
          targetId: cardId,
          summary: "Registered an AMUX backlog card from an agent registration source.",
          metadata: {
            agent_id: card.agentId,
            source_system: card.sourceSystem,
            source_digest: card.sourceDigest,
            proposal_digest: card.proposalDigest,
            policy_version: AMUX_AGENT_INTAKE_POLICY_VERSION,
            scanner_version: card.scannerVersion,
            card_count: 1,
          },
          tx,
        });
      }
      if (attachment) {
        // The audit chain's lock before any row the attachment locks, on the
        // path that found an existing card and wrote no entry too.
        await takeAuditChainLock(context.attachedTransaction);
        await attachment.work(context.attachedTransaction, { cardId, created }, { dbNow: context.dbNow });
      }
      return { registered: true as const, cardId, created };
    },
  );
}

/**
 * The public way in: refused before any transaction while the latch or the
 * environment value says no. `registerAmuxAgentIntakeCard` is the commit
 * itself, which the DB tests call directly, as the reconciliation tests do.
 */
export async function applyAmuxAgentIntakeCard(
  input: { card: AmuxAgentIntakeCard; actor: SystemAuditActor },
  attachment?: AmuxAttachment<AmuxAgentIntakeFact>,
) {
  if (!isAmuxAgentIntakeOpen()) return { registered: false as const, reason: "apply_disabled" as const };
  return registerAmuxAgentIntakeCard(input, attachment);
}

/**
 * The read-back after an unclear commit (intake version 2): the card, the
 * agent's registration record and the audit entry, each by the same digest.
 * All three is success, none is `absent`, anything between is `partial`. It
 * writes nothing and is never followed by an automatic retry.
 */
export async function readAmuxAgentIntakeCard(
  db: Pick<import("@prisma/client").PrismaClient, "amuxWorkItem" | "adminAuditLog">,
  input: { sourceSystem: string; sourceKey: string; sourceDigest: string },
): Promise<{ cardId: string | null; auditFound: boolean }> {
  const card = await db.amuxWorkItem.findUnique({
    where: { sourceSystem_sourceKey: { sourceSystem: input.sourceSystem, sourceKey: input.sourceKey } },
    select: { id: true, sourceDigest: true },
  });
  if (!card || card.sourceDigest !== input.sourceDigest) return { cardId: null, auditFound: false };
  const audit = await db.adminAuditLog.findFirst({
    where: { action: "amux.intake.agent_registered", targetType: "AmuxWorkItem", targetId: card.id },
    select: { id: true },
  });
  return { cardId: card.id, auditFound: audit !== null };
}
