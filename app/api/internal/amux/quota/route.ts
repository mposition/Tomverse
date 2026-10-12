export const dynamic = "force-dynamic";

import { z } from "zod";
import { randomUUID } from "node:crypto";

import { apiSecurityResponse, readLimitedJson } from "@/lib/apiSecurity";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { getConfiguredAmuxV22WorkerCatalog } from "@/lib/amux/routing";
import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_SYSTEM_AUDIT_ACTOR } from "@/lib/adminAuditSystemActors";
import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";

const schema = z
  .object({
    observation_id: z.string().uuid().optional(),
    worker: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z0-9._:-]+$/),
    provider: z.string().trim().min(1).max(80),
    remaining_basis_points: z.number().int().min(0).max(10_000),
    confidence_basis_points: z.number().int().min(0).max(10_000),
    exhausted: z.boolean().default(false),
    source: z.enum(["provider_api", "wrapper"]),
    observed_at: z.string().datetime({ offset: true }),
    reset_at: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = await readLimitedJson(request, 4 * 1_024, schema);
    const catalog = getConfiguredAmuxV22WorkerCatalog();
    const configured = catalog?.find(
      (worker) => worker.worker_name === body.worker,
    );
    if (
      !configured ||
      configured.provider !== body.provider.trim().toLowerCase()
    ) {
      return Response.json(
        { accepted: false, reason: "worker_provider_mismatch" },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    const observedAt = new Date(body.observed_at);
    const resetAt = body.reset_at ? new Date(body.reset_at) : null;
    if (resetAt && resetAt <= observedAt) {
      return Response.json(
        { error: "reset_at must be after observed_at." },
        { status: 400 },
      );
    }
    const id = body.observation_id ?? randomUUID();
    const lockKey = `amux-quota:${id}`;
    const result = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.quotaObservationWrite,
      async (tx, context) => {
        await takeAuditChainLock(tx);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
        const existing = await tx.amuxQuotaObservation.findUnique({ where: { id } });
        if (existing) {
          const identical = existing.worker === body.worker && existing.provider === configured.provider &&
            existing.remainingBasisPoints === body.remaining_basis_points &&
            existing.confidenceBasisPoints === body.confidence_basis_points &&
            existing.exhausted === body.exhausted && existing.source === body.source &&
            existing.observedAt.getTime() === observedAt.getTime() &&
            (existing.resetAt?.getTime() ?? null) === (resetAt?.getTime() ?? null);
          return identical ? { accepted: true, observation_id: id, created_at: existing.createdAt }
            : { accepted: false, reason: "observation_conflict" };
        }
        const age = context.dbNow.getTime() - observedAt.getTime();
        if (age < -300_000 || age > 900_000) return { accepted: false, reason: "observation_not_fresh" };
        const observation = await tx.amuxQuotaObservation.create({ data: {
        id,
        worker: body.worker,
        provider: configured.provider,
        remainingBasisPoints: body.remaining_basis_points,
        confidenceBasisPoints: body.confidence_basis_points,
        exhausted: body.exhausted,
        source: body.source,
        observedAt,
        resetAt,
        }, select: { id: true, createdAt: true } });
        await writeSystemAuditLog({ tx, systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
          action: "amux.quota.observed", targetType: "AmuxQuotaObservation", targetId: id,
          summary: "Recorded a worker quota observation.",
          metadata: { worker: body.worker, provider: configured.provider,
            source: body.source, observedAt: observedAt.toISOString() } });
        return { accepted: true, observation_id: observation.id, created_at: observation.createdAt };
      });
    return Response.json(
      result,
      { status: result.accepted ? 200 : 409, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    return Response.json(
      { error: "AMUX quota telemetry is unavailable." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

/** Exact lookup only: a lost telemetry reply is not permission to repost. */
export async function GET(request: Request) {
  if (!isAmuxSyncAuthorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const id = new URL(request.url).searchParams.get("observation_id");
  if (!z.string().uuid().safeParse(id).success) return Response.json({ error: "Invalid request." }, { status: 400 });
  try {
    const row = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.quotaObservationRead,
      tx => tx.amuxQuotaObservation.findUnique({ where: { id: id! } }));
    return Response.json({ found: row !== null, ...(row ? { observation: {
      observation_id: row.id, worker: row.worker, provider: row.provider,
      remaining_basis_points: row.remainingBasisPoints, confidence_basis_points: row.confidenceBasisPoints,
      exhausted: row.exhausted, source: row.source, observed_at: row.observedAt.toISOString(),
      reset_at: row.resetAt?.toISOString() ?? null,
    } } : {}) }, { headers: { "Cache-Control": "no-store" } });
  } catch { return Response.json({ error: "Quota lookup unavailable." }, { status: 503 }); }
}
