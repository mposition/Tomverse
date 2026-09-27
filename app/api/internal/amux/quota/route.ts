export const dynamic = "force-dynamic";

import { z } from "zod";

import { apiSecurityResponse, readLimitedJson } from "@/lib/apiSecurity";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { getConfiguredAmuxWorkerCatalog } from "@/lib/amux/routing";
import { prisma } from "@/lib/prisma";

const schema = z
  .object({
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
    const catalog = getConfiguredAmuxWorkerCatalog();
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
    const observation = await prisma.amuxQuotaObservation.create({
      data: {
        worker: body.worker,
        provider: configured.provider,
        remainingBasisPoints: body.remaining_basis_points,
        confidenceBasisPoints: body.confidence_basis_points,
        exhausted: body.exhausted,
        source: body.source,
        observedAt,
        resetAt,
      },
      select: { id: true, createdAt: true },
    });
    return Response.json(
      {
        accepted: true,
        observation_id: observation.id,
        created_at: observation.createdAt,
      },
      { headers: { "Cache-Control": "no-store" } },
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
