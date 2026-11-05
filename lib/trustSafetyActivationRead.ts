/**
 * The one read §6's seven checks are computed from
 * (docs/policy/trust-safety-compliance-agent.md §6).
 *
 * Both entry points that judge activation need the same four reads -- the
 * config row, every audit entry for this action and target, which of them
 * lacks a hash and the largest version among them, and the entry chained after
 * the newest one. E1 needs it to decide whether to observe; E2 needs it to
 * show the operator what the switch is. They share this function so the screen
 * cannot disagree with the round about whether the chain verifies.
 *
 * It reads and judges; it writes nothing. The caller supplies the transaction,
 * so the statements are charged against that kind's ceiling (§5.5) and the
 * four here are what `activation_read`'s `A` = 5 leaves after the arming
 * statement.
 */

import "server-only";

import type { Prisma } from "@prisma/client";

import {
  TRUST_SAFETY_ACTIVATION_ACTION,
  type ActivationAuditEntry,
  type ActivationInput,
  type ActivationState,
  deriveTrustSafetyActivation,
} from "@/lib/trustSafetyActivationCore";
import {
  type TrustSafetyIntegrityKeyEnv,
  verifyTrustSafetyAuditEntry,
} from "@/lib/trustSafetyAuditEntryVerify";
import { successorAfterEntry } from "@/lib/trustSafetyRoundCore";
import type { TrustSafetyTx } from "@/lib/trustSafetyTransaction";

/** The config row the checks are about, and the target entries bind to (§6). */
export const TRUST_SAFETY_CONFIG_ID = "singleton";
export const TRUST_SAFETY_CONFIG_TARGET_TYPE = "TrustSafetyObserverConfig";

/** The audit fields the digest is computed over, plus the stored hashes. */
const AUDIT_SELECT = {
  id: true,
  actorUserId: true,
  actorEmail: true,
  action: true,
  targetType: true,
  targetId: true,
  summary: true,
  metadata: true,
  ipAddress: true,
  userAgent: true,
  previousHash: true,
  entryHash: true,
  createdAt: true,
} as const;

type AuditRow = {
  id: string;
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  summary: string;
  metadata: Prisma.JsonValue | null;
  ipAddress: string | null;
  userAgent: string | null;
  previousHash: string | null;
  entryHash: string | null;
  createdAt: Date;
};

/** `metadata.toMode`, or null when the metadata does not carry a string there. */
const readToMode = (metadata: Prisma.JsonValue | null): string | null => {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = metadata.toMode;
  return typeof value === "string" ? value : null;
};

/** `metadata.version`, or null when it does not carry a whole number there. */
const readVersion = (metadata: Prisma.JsonValue | null): number | null => {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = metadata.version;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
};

const toActivationEntry = (
  row: AuditRow,
  env: TrustSafetyIntegrityKeyEnv,
): ActivationAuditEntry => ({
  id: row.id,
  toMode: readToMode(row.metadata),
  version: readVersion(row.metadata),
  entryHash: row.entryHash,
  hmacValid: verifyTrustSafetyAuditEntry({ row, env }),
});

/** The derived state, with the stored version the operator can see move. */
export type TrustSafetyActivationRead = {
  readonly activation: ActivationState;
  readonly version: number | null;
};

/**
 * Reads and derives the activation state inside the caller's transaction.
 *
 * Four statements: the config row, the entries, and -- only when the newest
 * entry carries a hash to chain from -- the successor. The whole entry set is
 * read because §6 asks for the largest version across it and whether any
 * entry lacks a hash, neither of which one row answers; the set grows only
 * when a person uses the switch.
 */
export const readTrustSafetyActivation = async ({
  tx,
  env,
  pingUrlPresent,
}: {
  readonly tx: TrustSafetyTx;
  readonly env: TrustSafetyIntegrityKeyEnv;
  readonly pingUrlPresent: boolean;
}): Promise<TrustSafetyActivationRead> => {
  const config = await tx.statement((client) =>
    client.trustSafetyObserverConfig.findUnique({
      where: { id: TRUST_SAFETY_CONFIG_ID },
      select: { mode: true, version: true },
    }),
  );

  const entries = (await tx.statement((client) =>
    client.adminAuditLog.findMany({
      where: {
        action: TRUST_SAFETY_ACTIVATION_ACTION,
        targetType: TRUST_SAFETY_CONFIG_TARGET_TYPE,
        targetId: TRUST_SAFETY_CONFIG_ID,
      },
      select: AUDIT_SELECT,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
  )) as AuditRow[];

  const newest = entries[0] ?? null;
  let unhashedEntryExists = false;
  let maxEntryVersion: number | null = null;
  for (const row of entries) {
    if (row.entryHash === null || row.entryHash === "") unhashedEntryExists = true;
    const version = readVersion(row.metadata);
    if (version !== null && (maxEntryVersion === null || version > maxEntryVersion)) {
      maxEntryVersion = version;
    }
  }

  // Check 7's successor is the next entry by position, whatever action wrote
  // it: the chain is the repository's, and a successor filtered by the link
  // being checked would miss a cut made by that next entry.
  let successor: ActivationInput["successor"] = null;
  if (newest !== null && newest.entryHash !== null && newest.entryHash !== "") {
    const row = (await tx.statement((client) =>
      client.adminAuditLog.findFirst({
        ...successorAfterEntry({ createdAt: newest.createdAt, id: newest.id }),
        select: AUDIT_SELECT,
      }),
    )) as AuditRow | null;
    if (row !== null) {
      successor = {
        previousHash: row.previousHash,
        hmacValid: verifyTrustSafetyAuditEntry({ row, env }),
      };
    }
  }

  return {
    activation: deriveTrustSafetyActivation({
      config,
      newestEntry: newest === null ? null : toActivationEntry(newest, env),
      unhashedEntryExists,
      maxEntryVersion,
      successor,
      pingUrlPresent,
    }),
    version: config?.version ?? null,
  };
};
