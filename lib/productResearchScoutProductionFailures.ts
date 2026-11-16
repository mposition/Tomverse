import "server-only";

import { prisma } from "@/lib/prisma";

/**
 * What real users' turns failed with lately, for the Scout's journey planner
 * (docs/policy/product-research-agent.md §14).
 *
 * The planner used to choose only from its fixed families, so it never went near
 * what was actually breaking: on 2026-11-16 every GPT 6 Luna stream ended empty
 * and a conversation's files hit the request's text limit, and neither was in any
 * family. The server already records each failure it observes, with a code: the
 * provider error rows and the trace evidence rows. This reads them back as counts
 * per code and model, and the planner is asked to reproduce the most frequent one.
 *
 * Content-free by construction: codes, model ids, phases and counts. No message
 * text, no user id, no trace id reaches the model.
 */
export const PRODUCTION_FAILURE_WINDOW_HOURS = 48;
export const PRODUCTION_FAILURE_LINES_MAX = 8;

type FailureRow = { code: string; modelId: string | null; phase: string | null; count: number };

/** One line per failure class, most frequent first. Pure, so the format is testable. */
export function productionFailureLines(rows: readonly FailureRow[], max = PRODUCTION_FAILURE_LINES_MAX): string[] {
  const merged = new Map<string, FailureRow>();
  for (const row of rows) {
    const key = `${row.code}|${row.modelId ?? ""}|${row.phase ?? ""}`;
    const existing = merged.get(key);
    merged.set(key, existing ? { ...existing, count: existing.count + row.count } : { ...row });
  }
  return [...merged.values()]
    .filter((row) => row.count > 0 && /^[A-Za-z0-9_.:-]{1,120}$/.test(row.code))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
    .slice(0, max)
    .map((row) => {
      const model = row.modelId && /^[A-Za-z0-9_.:-]{1,80}$/.test(row.modelId) ? ` on ${row.modelId}` : "";
      const phase = row.phase && /^[a-z_]{1,40}$/.test(row.phase) ? ` (${row.phase})` : "";
      return `${row.code}${model}${phase}: ${row.count} in the last ${PRODUCTION_FAILURE_WINDOW_HOURS} hours`;
    });
}

/** The lines for the planner; an empty list when nothing failed or the read fails. */
export async function readProductionFailures(now = new Date()): Promise<string[]> {
  const since = new Date(now.getTime() - PRODUCTION_FAILURE_WINDOW_HOURS * 3_600_000);
  try {
    const [provider, evidence] = await Promise.all([
      prisma.providerErrorEvent.groupBy({
        by: ["diagnosticCode", "modelId", "phase"],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      }),
      prisma.traceErrorEvidence.groupBy({
        by: ["errorCode", "modelId", "phase"],
        where: { occurredAt: { gte: since }, routeClass: "chat" },
        _count: { _all: true },
      }),
    ]);
    return productionFailureLines([
      ...provider.map((row) => ({ code: row.diagnosticCode, modelId: row.modelId, phase: row.phase, count: row._count._all })),
      ...evidence
        .filter((row) => row.errorCode)
        .map((row) => ({ code: row.errorCode as string, modelId: row.modelId, phase: row.phase, count: row._count._all })),
    ]);
  } catch {
    // The planner still plans without them; a failed read never blocks the journey.
    return [];
  }
}
