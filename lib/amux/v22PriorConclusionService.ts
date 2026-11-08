import "server-only";

import type { Prisma } from "@prisma/client";

import { amuxV22ConclusionSha256, amuxV22HandoffNotesFor, amuxV22PriorLabel,
  parseAmuxV22Conclusion, type AmuxV22PriorConclusionEntry } from
  "@/lib/amux/v22ConclusionCore";
import { openAmuxV22TaskResultRow } from "@/lib/amux/v22TaskResultStore";
import { amuxV22TaskWritesPatch } from "@/lib/amux/v22WorkerClaimCore";

/**
 * The conclusions a delivery carries from the Tasks its Task depends on (owner
 * decision 2026-11-07). Rows are read inside the delivery's key-read boundary,
 * bodies opened outside it, the same split the owner-question resume uses.
 * Only a prerequisite that is done and terminal counts, and only its newest
 * result. A result with a recorded conclusion goes as that conclusion, which
 * must match the text opened now. A read-only prerequisite (investigate,
 * verify, design, review) whose newest result has no conclusion line goes as
 * that result's text instead, so a report finished without the line still
 * reaches the Task that waits on it (AMUX-AUTOFILE-006, 2026-11-08).
 */

/** Prisma calls `readAmuxV22PriorConclusionRows` makes, for its caller's boundary. */
export const AMUX_V22_PRIOR_CONCLUSION_ROWS_PRISMA_CALLS = 3;
/** Prerequisites read per delivery; the section bound decides how many fit. */
export const AMUX_V22_PRIOR_CONCLUSION_MAX_DEPENDENCIES = 8;

const SEALED = { ideaId: true, ciphertext: true, keyId: true, keyVersion: true,
  digest: true, digestKeyId: true, bodyPurgedAt: true } as const;
// The brief names sibling cards by the draft unit's local reference; the card
// keeps it only through the decision that registered it.
const LOCAL_REF = { amuxV4RegisteredDecisions: { take: 1,
  select: { draftUnit: { select: { localRef: true } } } } } as const;

const localRefOf = (item: { amuxV4RegisteredDecisions?:
  Array<{ draftUnit: { localRef: string | null } | null }> }) =>
  item.amuxV4RegisteredDecisions?.[0]?.draftUnit?.localRef ?? null;

export async function readAmuxV22PriorConclusionRows(tx: Prisma.TransactionClient,
  taskId: string) {
  const found = await tx.amuxWorkItem.findUnique({ where: { id: taskId },
    select: { id: true, displayKey: true, ...LOCAL_REF } });
  if (!found) return null;
  const self = { id: found.id, displayKey: found.displayKey,
    localRef: localRefOf(found) };
  const links = await tx.amuxWorkDependency.findMany({ where: { taskId },
    orderBy: { dependencyId: "asc" }, take: 32,
    select: { dependency: { select: { id: true, displayKey: true, status: true,
      sourceSystem: true, v4TerminalAt: true, taskRole: true, ...LOCAL_REF } } } });
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
    if (!row) return [];
    const label = amuxV22PriorLabel(item, localRefOf(item));
    if (row.conclusionSha256) return [{ label, row, source: "conclusion" as const }];
    // A patch-writing Task's result describes a pull request, not a report.
    return amuxV22TaskWritesPatch(item.taskRole) ? [] :
      [{ label, row, source: "result" as const }];
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
  for (const { label, row, source } of rows.rows) {
    let text: string | null = null;
    try { text = await openAmuxV22TaskResultRow(row.attemptId, row); }
    catch { continue; }
    if (!text) continue;
    if (source === "result") {
      const body = text.trim();
      if (body.length > 0) entries.push({ label, findings: body, note: null, source });
      continue;
    }
    const conclusion = parseAmuxV22Conclusion(text);
    if (!conclusion || amuxV22ConclusionSha256(conclusion) !== row.conclusionSha256)
      continue;
    entries.push({ label, findings: conclusion.findings,
      note: amuxV22HandoffNotesFor(conclusion, rows.self) });
  }
  return entries;
}
