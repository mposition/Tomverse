export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { agentOfficeCliMonitorCredential } from "@/lib/agentOfficeCliMonitor";
import { apiSecurityResponse, readLimitedJson } from "@/lib/apiSecurity";
import { parseAmuxCliModelRefresh } from "@/lib/amux/cliModelCatalogCore";
import { recordAmuxCliModelRefresh } from "@/lib/amux/cliModelCatalogStore";
import {
  AMUX_DB_BOUNDARIES,
  AmuxDbBoundaryError,
  withAmuxDbBoundary,
  withAmuxRouteBudget,
} from "@/lib/amux/dbBoundary";

/**
 * What one worker CLI lists now, from the AMUX host (owner decision
 * 2026-10-27; scripts/amux-cli-models-refresh.mjs). It uses the CLI monitor's
 * telemetry credential: a refresh only says which names a CLI offers, and
 * prices, assigns or runs nothing. A name's price is the owner's link or its
 * exact Admin › Models entry, never something this route writes.
 */

const noStore = { "Cache-Control": "no-store" };

function authorized(request: Request): boolean {
  const credential = agentOfficeCliMonitorCredential();
  const provided = request.headers.get("authorization") ?? "";
  const digest = createHash("sha256").update(provided.startsWith("Bearer ") ? provided.slice(7) : "").digest();
  const expected = credential === null ? null : Buffer.from(credential, "hex");
  return expected !== null && expected.length === digest.length && timingSafeEqual(digest, expected);
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401, headers: noStore });
  return withAmuxRouteBudget(async () => {
    try {
      // The shape is checked by the core's parser, which also bounds each name.
      const body = await readLimitedJson(request, 128 * 1_024, z.unknown());
      const refresh = parseAmuxCliModelRefresh(body);
      if (refresh === null) return Response.json({ error: "invalid_refresh" }, { status: 400, headers: noStore });
      const result = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.cliModelRefresh, (tx) =>
        recordAmuxCliModelRefresh(tx, refresh),
      );
      return Response.json({ cli: refresh.cli, ...result }, { headers: noStore });
    } catch (error) {
      const security = apiSecurityResponse(error);
      if (security) { security.headers.set("Cache-Control", "no-store"); return security; }
      const code = error instanceof AmuxDbBoundaryError ? error.code : null;
      console.error(JSON.stringify({ subsystem: "amux", event: "cli_model_refresh_failed", code }));
      return Response.json({ error: "refresh_failed" }, { status: 503, headers: noStore });
    }
  });
}
