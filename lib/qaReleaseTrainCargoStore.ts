import "server-only";

import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";
import { QaReleaseOperatorControlRefusedError } from "@/lib/qaReleaseOperatorControlStore";
import { qaReleaseTrainHiddenUpdate, type QaReleaseTrainEmergency, type QaReleaseTrainSelection } from "@/lib/qaReleaseTrainCargoCore";
import {
  QA_RELEASE_TRAIN_CARGO_ACTION,
  QA_RELEASE_TRAIN_CARGO_TARGET_ID,
  QA_RELEASE_TRAIN_CARGO_TARGET_TYPE,
  QA_RELEASE_TRAIN_EMERGENCY_ACTION,
  QA_RELEASE_TRAIN_EMERGENCY_TARGET_ID,
  QA_RELEASE_TRAIN_EMERGENCY_TARGET_TYPE,
  QA_RELEASE_TRAIN_HIDDEN_ACTION,
  QA_RELEASE_TRAIN_HIDDEN_TARGET_ID,
  readQaReleaseTrainEmergency,
  readQaReleaseTrainHidden,
  readQaReleaseTrainSelection,
} from "@/lib/qaReleaseTrainStore";

/**
 * The operator's pick for the next release train (lib/qaReleaseTrainCargoCore.ts)
 * and an emergency train request, administrator actions: their own module, so
 * this file calls only the administrator audit writer (the train's system
 * rows stay in lib/qaReleaseTrainStore.ts).
 */

/** Saves the operator's pick for the next train, audited in the same transaction. */
export async function saveQaReleaseTrainSelection(actor: { session: Session; request: Request }, numbers: number[]): Promise<QaReleaseTrainSelection> {
  await prisma.$transaction(
    async (tx) => {
      await takeAuditChainLock(tx);
      await writeAdminAuditLog({
        ...actor,
        tx,
        action: QA_RELEASE_TRAIN_CARGO_ACTION,
        targetType: QA_RELEASE_TRAIN_CARGO_TARGET_TYPE,
        targetId: QA_RELEASE_TRAIN_CARGO_TARGET_ID,
        summary: numbers.length === 0 ? "Cleared the next release train's cargo." : `Picked ${numbers.map((n) => `#${n}`).join(", ")} for the next release train.`,
        metadata: { numbers },
      });
    },
    { maxWait: 5_000, timeout: 15_000 },
  );
  return readQaReleaseTrainSelection();
}

/**
 * Requests an emergency train (owner request 2026-10-25), or withdraws a
 * pending one with no numbers, audited in the same transaction. The reason
 * stays in this row; the train's public pull request never carries it.
 *
 * `pendingId` is the request the operator saw pending (null for none). It is
 * read again under the audit chain lock and must still be the one pending,
 * so a page left open cannot withdraw a request the train has since taken,
 * or replace or withdraw another operator's newer one; it is refused
 * (`emergency_changed`) and the page reads again.
 */
export async function saveQaReleaseTrainEmergency(
  actor: { session: Session; request: Request },
  input: { numbers: number[]; reason: string; pendingId: string | null },
): Promise<QaReleaseTrainEmergency> {
  await prisma.$transaction(
    async (tx) => {
      await takeAuditChainLock(tx);
      const current = await readQaReleaseTrainEmergency(tx);
      if ((current.pending?.id ?? null) !== input.pendingId) throw new QaReleaseOperatorControlRefusedError("emergency_changed");
      // Nothing pending to withdraw: no row, so the last departure stays named.
      if (input.numbers.length === 0 && current.pending === null) return;
      await writeAdminAuditLog({
        ...actor,
        tx,
        action: QA_RELEASE_TRAIN_EMERGENCY_ACTION,
        targetType: QA_RELEASE_TRAIN_EMERGENCY_TARGET_TYPE,
        targetId: QA_RELEASE_TRAIN_EMERGENCY_TARGET_ID,
        summary:
          input.numbers.length === 0
            ? "Withdrew the pending emergency release train."
            : `Requested an emergency release train with ${input.numbers.map((n) => `#${n}`).join(", ")}.`,
        metadata: { numbers: input.numbers, reason: input.reason },
      });
    },
    { maxWait: 5_000, timeout: 15_000 },
  );
  return readQaReleaseTrainEmergency();
}

/**
 * Hides one candidate from the next train's list, or shows it again (owner
 * request 2026-10-27), audited in the same transaction. Read and written
 * under the audit chain lock, so two operators' clicks never drop each
 * other's. Display only: the train never reads it.
 */
export async function saveQaReleaseTrainHidden(
  actor: { session: Session; request: Request },
  /** Several at once (owner, 2026-10-29): hiding what the verdicts say needs no release. */
  number: number | readonly number[],
  hidden: boolean,
): Promise<number[]> {
  const changed = typeof number === "number" ? [number] : [...new Set(number)];
  // The summary names up to ten; the metadata keeps every number.
  const label =
    changed.length > 10 ? `${changed.length} candidates (${changed.slice(0, 10).map((n) => `#${n}`).join(", ")}, …)` : changed.map((n) => `#${n}`).join(", ");
  return prisma.$transaction(
    async (tx) => {
      await takeAuditChainLock(tx);
      let numbers = await readQaReleaseTrainHidden(tx);
      for (const one of changed) numbers = qaReleaseTrainHiddenUpdate(numbers, one, hidden);
      await writeAdminAuditLog({
        ...actor,
        tx,
        action: QA_RELEASE_TRAIN_HIDDEN_ACTION,
        targetType: QA_RELEASE_TRAIN_CARGO_TARGET_TYPE,
        targetId: QA_RELEASE_TRAIN_HIDDEN_TARGET_ID,
        summary: hidden ? `Hid ${label} from the next release train's list.` : `Showed ${label} again in the next release train's list.`,
        metadata: typeof number === "number" ? { number, hidden, numbers } : { changed, hidden, numbers },
      });
      return numbers;
    },
    { maxWait: 5_000, timeout: 15_000 },
  );
}
