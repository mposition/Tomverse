export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { adminApprovalErrorResponse } from "@/lib/adminApproval";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { AMUX_CLI_MODEL_LINK_AUDIT_ACTION } from "@/lib/amux/cliModelCatalogCore";
import { AmuxCliModelLinkWriteError, recordAmuxCliModelLinkByOwner } from "@/lib/amux/cliModelCatalogStore";
import {
  AMUX_DB_BOUNDARIES,
  AmuxDbBoundaryError,
  withAmuxDbBoundary,
  withAmuxRouteBudget,
} from "@/lib/amux/dbBoundary";
import { amuxWorkerCapabilityWritesOpen } from "@/lib/amux/workerCapabilityCore";

/**
 * The owner links one CLI model name to the Admin › Models entry that prices
 * it, or holds it (owner decision 2026-10-27). The catalog itself is read with
 * the worker capabilities (GET /api/admin/amux/workers/capabilities).
 *
 * In order, before the body is read: the owner role, the capability writes
 * latch (a link decides what a worker's model costs, as a capability does),
 * and a recent step-up. The store writes the human audit
 * `amux.cli_model.link` and the event in one transaction. A refusal answers
 * 409 with its code and writes nothing; an unknown outcome says so, and the
 * caller reads back instead of sending again.
 */

const noStoreHeaders = { "Cache-Control": "private, no-store, max-age=0" };

const withNoStore = (response: Response) => {
  response.headers.set("Cache-Control", noStoreHeaders["Cache-Control"]);
  return response;
};

const bodySchema = z
  .object({
    cli: z.string().max(16),
    cliModel: z.string().max(160),
    pricedModelId: z.string().max(160).nullable(),
  })
  .strict();

const notFound = () =>
  NextResponse.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });

export async function POST(request: Request) {
  return withAmuxRouteBudget(async () => {
    try {
      const session = await getServerSession(authOptions);
      if (!session?.user?.id || !isAdminSession(session)) return notFound();
      if (getAdminRole(session) !== "owner") {
        return NextResponse.json({ error: "Forbidden." }, { status: 403, headers: noStoreHeaders });
      }
      if (!amuxWorkerCapabilityWritesOpen()) {
        return NextResponse.json({ error: "capability_writes_off" }, { status: 409, headers: noStoreHeaders });
      }
      await assertRecentAdminAuthentication(session);
      await consumeApiRateLimit(request, session.user.id, "admin-amux-cli-model-link", {
        minute: 30,
        day: 200,
      });
      const body = await readLimitedJson(request, 1_024, bodySchema);
      const event = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.cliModelLinkChange, (tx) =>
        recordAmuxCliModelLinkByOwner(tx, { session, request, ...body }),
      );
      return NextResponse.json(
        {
          action: AMUX_CLI_MODEL_LINK_AUDIT_ACTION,
          eventId: event.eventId,
          cli: event.cli,
          cliModel: event.cliModel,
          pricedModelId: event.pricedModelId,
        },
        { headers: noStoreHeaders },
      );
    } catch (error) {
      const approvalResponse = adminApprovalErrorResponse(error);
      if (approvalResponse) return withNoStore(approvalResponse);
      if (error instanceof AmuxCliModelLinkWriteError) {
        if (error.code === "no_operator") return notFound();
        return NextResponse.json(
          { error: error.code },
          { status: error.code === "invalid_change" ? 400 : 409, headers: noStoreHeaders },
        );
      }
      const security = apiSecurityResponse(error);
      if (security) return withNoStore(security);
      const code = error instanceof AmuxDbBoundaryError ? error.code : null;
      console.error(JSON.stringify({ subsystem: "amux", event: "cli_model_link_change_failed", code }));
      return NextResponse.json(
        { error: code === "AMUX_DB_OUTCOME_UNKNOWN" ? "outcome_unknown" : "cli_model_link_failed" },
        { status: 503, headers: noStoreHeaders },
      );
    }
  });
}
