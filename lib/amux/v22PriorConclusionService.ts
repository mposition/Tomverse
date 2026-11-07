import "server-only";

import type { Prisma } from "@prisma/client";

import { amuxV22ConclusionSha256, amuxV22HandoffNotesFor,
  parseAmuxV22Conclusion, type AmuxV22PriorConclusionEntry } from
  "@/lib/amux/v22ConclusionCore";
import { openAmuxV22TaskResultRow } from "@/lib/amux/v22TaskResultStore";

/**
 * The conclusions a delivery carries from the Tasks its Task depends on (owner
 * decision 2026-11-07). Rows are read inside the delivery's key-read boundary,
 * bodies opened outside it, the same split the owner-question resume uses.
 * Only a prerequisite that is done and terminal counts, and only its newest
 * result whose recorded conclusion digest matches the text opened now.
 */

/** Prisma calls `readAmuxV22PriorConclusionRows` makes, for its caller's boundary. */
export const AMUX_V22_PRIOR_CONCLUSION_ROWS_PRISMA_CALLS = 3;
/** Prerequisites read per delivery; the section bound decides how many fit. */
export const AMUX_V22_PRIOR_CONCLUSION_MAX_DEPENDENCIES = 8;

const SEALED = { ideaId: true, ciphertext: true, keyId: true, keyVersion: true,
  digest: true, digestKeyId: true, bodyPurgedAt: true } as const;

export async function readAmuxV22PriorConclusionRows(tx: Prisma.TransactionClient,
  taskId: string) {
  const self = await tx.amuxWorkItem.findUnique({ where: { id: taskId },
    select: { id: true, displayKey: true } });
  if (!self) return null;
  const links = await tx.amuxWorkDependency.findMany({ where: { taskId },
    orderBy: { dependencyId: "asc" }, take: 32,
    select: { dependency: { select: { id: true, displayKey: true, status: true,
      sourceSystem: true, v4TerminalAt: true } } } });
  const done = links.map((link) => link.dependency).filter((item) =>
    item.status === "done" && item.v4TerminalAt !== null &&
    item.sourceSystem === "admin-idea-v4")
    .slice(0, AMUX_V22_PRIOR_CONCLUSION_MAX_DEPENDENCIES);
  if (done.length === 0) return null;
  // The newest result of each prerequisite first, whatever it holds: when
  // that run gave no conclusion, an earlier run's conclusion is not revived.
  const results = await tx.amuxV22TaskResult.findMany({
    where: { taskId: { in: done.map((item) => item.id) } },
    orderBy: [{ createdAt: "desc" }, { attemptId: "desc" }],
    select: { ...SEALED, attemptId: true, taskId: true, sourceSha256: true,
      conclusionSha256: true },
  });
  const rows = done.flatMap((item) => {
    const row = results.find((result) => result.taskId === item.id);
    return row && row.conclusionSha256 ? [{ label: item.displayKey ?? item.id, row }] : [];
  });
  return rows.length > 0 ? { taskId, self, rows } : null;
}

/** Opens the rows outside the DB transaction. A purged body, one that cannot
 * be opened, or a text whose conclusion no longer matches its recorded digest
 * is left out; the others still go. */
export async function openAmuxV22PriorConclusions(
  rows: NonNullable<Awaited<ReturnType<typeof readAmuxV22PriorConclusionRows>>>):
  Promise<AmuxV22PriorConclusionEntry[]> {
  const entries: AmuxV22PriorConclusionEntry[] = [];
  for (const { label, row } of rows.rows) {
    let text: string | null = null;
    try { text = await openAmuxV22TaskResultRow(row.attemptId, row); }
    catch { continue; }
    const conclusion = text ? parseAmuxV22Conclusion(text) : null;
    if (!conclusion || amuxV22ConclusionSha256(conclusion) !== row.conclusionSha256)
      continue;
    entries.push({ label, findings: conclusion.findings,
      note: amuxV22HandoffNotesFor(conclusion, rows.self) });
  }
  return entries;
}
