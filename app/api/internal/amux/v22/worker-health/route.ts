export const dynamic = "force-dynamic";

import { z } from "zod";

import { apiSecurityResponse, readLimitedJson } from "@/lib/apiSecurity";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { AMUX_LIFECYCLE_ROUTE_BUDGET_MS, withAmuxRouteBudget } from "@/lib/amux/dbBoundary";
import { amuxInternalErrorResponse, amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { readAmuxAssignmentCatalogs } from "@/lib/amux/workerAssignmentCatalog";
import { AMUX_WORKER_HEALTH_SOURCES } from "@/lib/amux/workerHealthCore";
import { recordAmuxWorkerHealthSignals } from "@/lib/amux/workerHealthStore";
import { prisma } from "@/lib/prisma";

/**
 * The box health signals a worker's bridge forwards (owner decision
 * 2026-11-15): the Claude login keepalive's `login_required` and
 * `relogin_soon`, the sign-in stage's failure. Codes and times only. A
 * diagnostic write: the bridge never halts on its answer, and nothing here
 * changes a claim, a cost or a sign-in.
 */
const schema = z.object({
  worker: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._:-]+$/),
  signals: z.array(z.object({
    source: z.enum(AMUX_WORKER_HEALTH_SOURCES),
    signal: z.string().regex(/^[a-z0-9_]{1,64}$/),
    observed_at: z.string().datetime({ offset: true }),
    expires_at: z.string().datetime({ offset: true }).nullable().optional(),
  }).strict()).min(1).max(8),
}).strict();

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request))
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  return withAmuxRouteBudget(async () => {
    try {
      const body = await readLimitedJson(request, 4 * 1_024, schema);
      // A membership check only; it opens no transaction of its own.
      const { v22 } = await readAmuxAssignmentCatalogs(prisma);
      if (!v22?.some((worker) => worker.worker_name === body.worker))
        return amuxJsonNoStore({ recorded: 0, reason: "worker_unknown" }, 409);
      const now = new Date();
      // A signal from the future or older than a day describes nothing now.
      const signals = body.signals.map((item) => ({ source: item.source, signal: item.signal,
        observedAt: new Date(item.observed_at),
        expiresAt: item.expires_at ? new Date(item.expires_at) : null }))
        .filter((item) => item.observedAt.getTime() <= now.getTime() + 300_000 &&
          now.getTime() - item.observedAt.getTime() <= 24 * 60 * 60_000);
      const result = await recordAmuxWorkerHealthSignals(body.worker, signals, now);
      return amuxJsonNoStore({ recorded: result.recorded }, 200);
    } catch (error) {
      const securityResponse = apiSecurityResponse(error);
      if (securityResponse) return securityResponse;
      return amuxInternalErrorResponse("v22_worker_health", error);
    }
  }, AMUX_LIFECYCLE_ROUTE_BUDGET_MS);
}
