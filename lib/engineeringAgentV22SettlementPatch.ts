import "server-only";

import { readAmuxV22TaskPatchEvidence } from
  "@/lib/amux/v22TaskResultStore";
import { prisma } from "@/lib/prisma";

/** Decrypt outside the short settlement transaction. The settlement writer
 * rechecks every binding and uses this body only after its exact usage receipt
 * has passed; a failed key-store read cannot silently discard a patch. */
type PatchMeta = { taskId: string; baseSha: string;
  bodyPurgedAt: Date | null } | null;
type Ports = {
  readMeta: (attemptId: string) => Promise<PatchMeta>;
  readEvidence: typeof readAmuxV22TaskPatchEvidence;
};
const livePorts: Ports = {
  readMeta: (attemptId) => prisma.amuxV22TaskPatch.findUnique({
    where: { attemptId }, select: { taskId: true, baseSha: true,
      bodyPurgedAt: true },
  }),
  readEvidence: readAmuxV22TaskPatchEvidence,
};

export async function loadEngineeringAgentV22SettlementPatch(
  attemptId: string, ports: Ports = livePorts) {
  const row = await ports.readMeta(attemptId);
  if (!row) return null;
  if (row.bodyPurgedAt) throw new Error("v22_patch_purged_before_settlement");
  const patch = await ports.readEvidence(attemptId, row.taskId);
  if (!patch || patch.baseSha !== row.baseSha)
    throw new Error("v22_patch_unavailable_before_settlement");
  return { taskId: row.taskId, ...patch };
}
