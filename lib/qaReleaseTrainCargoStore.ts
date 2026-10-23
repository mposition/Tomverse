import "server-only";

import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";
import type { QaReleaseTrainSelection } from "@/lib/qaReleaseTrainCargoCore";
import {
  QA_RELEASE_TRAIN_CARGO_ACTION,
  QA_RELEASE_TRAIN_CARGO_TARGET_ID,
  QA_RELEASE_TRAIN_CARGO_TARGET_TYPE,
  readQaReleaseTrainSelection,
} from "@/lib/qaReleaseTrainStore";

/**
 * The operator's pick for the next release train (lib/qaReleaseTrainCargoCore.ts),
 * an administrator action: its own module, so this file calls only the
 * administrator audit writer (the train's system rows stay in
 * lib/qaReleaseTrainStore.ts).
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
