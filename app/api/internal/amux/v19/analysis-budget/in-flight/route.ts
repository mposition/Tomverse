export const dynamic = "force-dynamic";

import { z } from "zod";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { AMUX_V4_ANALYSIS_AGENT_SECRET_ENV } from
  "@/lib/amux/ideaAnalysisQueueCore";
import { AMUX_V19_MAX_LAUNCHER_SECRET_ENV,
  isAmuxV19MaxLauncherAuthorized } from
  "@/lib/amux/ideaSessionMaxLauncherAuth";
import { listAmuxSessionInFlightShadowClaims } from
  "@/lib/amux/ideaSessionAnalysisBudgetClaimService";
import { prisma } from "@/lib/prisma";

const beforeSchema = z.string().datetime();

/** Read-only. The Max launcher asks which of its subscription claims were
 * written before `before` and are still in flight, so a marker that names no
 * claim (a runner from before 2026-11-16) can be reconciled: each identity is
 * then reported outcome unknown through the existing unknown route, which
 * closes a subscription claim at zero. The answer is identities only. A
 * `before` that is malformed or in the future is refused. */
export async function GET(request: Request): Promise<Response> {
  if (!isAmuxV19MaxLauncherAuthorized(request,
    process.env[AMUX_V19_MAX_LAUNCHER_SECRET_ENV],
    process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV],
    process.env.TOMVERSE_AMUX_SYNC_SECRET)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  const url = new URL(request.url);
  const names = [...url.searchParams.keys()];
  const parsed = beforeSchema.safeParse(url.searchParams.get("before"));
  if (names.length !== 1 || names[0] !== "before" ||
      url.searchParams.getAll("before").length !== 1 || !parsed.success) {
    return amuxJsonNoStore({ error: "Invalid request." }, 400);
  }
  const before = new Date(parsed.data);
  if (!Number.isFinite(before.getTime()) || before.getTime() > Date.now()) {
    return amuxJsonNoStore({ error: "Invalid request." }, 400);
  }
  try {
    const claims = await prisma.$transaction((tx) =>
      listAmuxSessionInFlightShadowClaims(tx, { before }),
    { maxWait: 5_000, timeout: 10_000 });
    return amuxJsonNoStore({ claims });
  } catch {
    return amuxJsonNoStore({ error: "outcome_unknown" }, 503);
  }
}
