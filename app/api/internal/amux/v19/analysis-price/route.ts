export const dynamic = "force-dynamic";

import { z } from "zod";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { AMUX_V4_ANALYSIS_AGENT_SECRET_ENV } from
  "@/lib/amux/ideaAnalysisQueueCore";
import { AMUX_V19_MAX_LAUNCHER_SECRET_ENV,
  isAmuxV19MaxLauncherAuthorized } from
  "@/lib/amux/ideaSessionMaxLauncherAuth";
import { readAmuxV19MaxPriceSelection } from
  "@/lib/amux/ideaSessionMaxPriceSelectionRead";
import { prisma } from "@/lib/prisma";

const READ_ENV = "TOMVERSE_AMUX_V19_SESSION_MAX_PRICE_READ";
const identity = z.object({ reservationId: z.string().uuid(),
  ideaId: z.string().uuid() }).strict();

/** Only the fixed Max launcher can discover the current audited price ID for
 * an exact queued reservation. This is a read hint, not claim permission. */
export async function GET(request: Request): Promise<Response> {
  if (!isAmuxV19MaxLauncherAuthorized(request,
    process.env[AMUX_V19_MAX_LAUNCHER_SECRET_ENV],
    process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV],
    process.env.TOMVERSE_AMUX_SYNC_SECRET)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  if (process.env[READ_ENV] !== "enabled") {
    return amuxJsonNoStore({ available: false,
      reason: "session_max_price_read_disabled" }, 409);
  }
  const url = new URL(request.url);
  if ([...url.searchParams.keys()].length !== 2 ||
      url.searchParams.getAll("reservationId").length !== 1 ||
      url.searchParams.getAll("ideaId").length !== 1) {
    return amuxJsonNoStore({ error: "Invalid request." }, 400);
  }
  const parsed = identity.safeParse({
    reservationId: url.searchParams.get("reservationId"),
    ideaId: url.searchParams.get("ideaId"),
  });
  if (!parsed.success) return amuxJsonNoStore({ error: "Invalid request." }, 400);
  try {
    const selection = await prisma.$transaction((tx) =>
      readAmuxV19MaxPriceSelection(tx, parsed.data),
    { maxWait: 5_000, timeout: 15_000 });
    return selection.kind === "ready"
      ? amuxJsonNoStore(selection)
      : amuxJsonNoStore(selection, 409);
  } catch {
    return amuxJsonNoStore({ error: "unavailable" }, 503);
  }
}
