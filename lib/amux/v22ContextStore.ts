import "server-only";

import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { AMUX_V22_CONCLUSION_ENV, amuxV22ConclusionMode,
  buildAmuxV22PriorConclusionSection } from "@/lib/amux/v22ConclusionCore";
import { AMUX_V22_CONTEXT_FILES } from "@/lib/amux/v22LocalCliFlowCore";
import { openAmuxV22ResumeContext, readAmuxV22ResumeRows } from
  "@/lib/amux/v22OwnerQuestionService";
import { openAmuxV22PriorConclusions, readAmuxV22PriorConclusionRows } from
  "@/lib/amux/v22PriorConclusionService";
import { readAmuxV22TransferBinding } from "@/lib/amux/v22TransferStore";
import type { AmuxV22ContextPartName } from "@/lib/amux/v22ContextPartsCore";

/**
 * A chunked context file as the delivery would put it in the prompt
 * (docs/policy/amux-v22-result-transfer.md 10.1, owner direction 2026-11-19).
 * Nothing is stored: each chunk request rebuilds the file from its source rows
 * under the same conditions `pullAmuxWorkDelivery` used, and the box checks
 * the whole against the sha256 the pull named. Rows are read inside the DB
 * boundary and opened (decrypted) outside it, the split the delivery uses.
 */
export type AmuxV22ContextPartRead =
  | { kind: "binding_mismatch" }
  | { kind: "absent" }
  | { kind: "text"; text: string };

export async function readAmuxV22ContextPart(input: {
  attemptId: string;
  worker: string;
  name: AmuxV22ContextPartName;
}): Promise<AmuxV22ContextPartRead> {
  const conclusionMode = amuxV22ConclusionMode(process.env[AMUX_V22_CONCLUSION_ENV]);
  const read = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.v22ContextRead, async (tx) => {
    const binding = await readAmuxV22TransferBinding(tx, input.attemptId, input.worker);
    if (!binding) return null;
    if (input.name === AMUX_V22_CONTEXT_FILES.priorPatch)
      return { kind: "resume" as const,
        rows: await readAmuxV22ResumeRows(tx, binding.taskId) };
    // The conclusions go only where the delivery reads them (mode off: never).
    return { kind: "prior" as const, rows: conclusionMode === "off" ? null :
      await readAmuxV22PriorConclusionRows(tx, binding.taskId) };
  });
  if (!read) return { kind: "binding_mismatch" };
  if (read.kind === "resume") {
    if (!read.rows) return { kind: "absent" };
    const resume = await openAmuxV22ResumeContext(read.rows);
    return resume.previousPatch ? { kind: "text", text: resume.previousPatch } :
      { kind: "absent" };
  }
  if (!read.rows) return { kind: "absent" };
  // A body purged at 90 days, or one that cannot be opened, leaves its entry
  // out, as it does in the delivery.
  const entries = await openAmuxV22PriorConclusions(read.rows).catch(() => []);
  const section = entries.length > 0 ?
    buildAmuxV22PriorConclusionSection({ entries, budgetBytes: null }) : null;
  return section ? { kind: "text", text: section.section } : { kind: "absent" };
}
