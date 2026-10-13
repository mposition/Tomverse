export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { adminApprovalErrorResponse } from "@/lib/adminApproval";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import {
  AMUX_DB_BOUNDARIES,
  AmuxDbBoundaryError,
  withAmuxDbBoundary,
  withAmuxRouteBudget,
} from "@/lib/amux/dbBoundary";
import { readAmuxWorkerCapabilitiesForAdmin } from "@/lib/amux/workerCapabilityAdminRead";
import { amuxWorkerCapabilityWritesOpen } from "@/lib/amux/workerCapabilityCore";
import {
  AmuxWorkerCapabilityWriteError,
  recordAmuxWorkerCapabilityByOwner,
} from "@/lib/amux/workerCapabilityStore";

/**
 * AMUX worker capabilities (orchestration policy version 35, section 2).
 *
 * GET is each registered worker's recorded capability beside the import
 * proposal from the catalog variables, for any administrator. Reading is
 * never latched.
 *
 * POST is the owner recording one worker's capability, and nothing else. In
 * order, before the body is read: the owner role, R2a's code latch
 * (`AMUX_WORKER_CAPABILITY_WRITES_LATCH`, on since version 36's activation
 * record), and a recent step-up (a stale one answers 428). The store writes
 * the human audit `amux.worker.capability` and the event in one transaction.
 * A refusal by the ceiling rule answers 409 with its code and writes nothing;
 * an unknown outcome says so, and the caller reads back instead of sending
 * again (foundation principle 7).
 */

const noStoreHeaders = { "Cache-Control": "private, no-store, max-age=0" };

const withNoStore = (response: Response) => {
  response.headers.set("Cache-Control", noStoreHeaders["Cache-Control"]);
  return response;
};

const bodySchema = z
  .object({
    workerName: z.string().max(40),
    expectedRevision: z.number().int().min(0).max(1_000_000),
    capability: z
      .object({
        model: z.string().max(200).nullable(),
        routingTags: z.array(z.string().max(64)).max(64),
        toolCapabilities: z.array(z.string().max(80)).max(16),
        v22: z
          .object({
            model: z.string().max(200),
            roles: z.array(z.string().max(32)).max(4),
            tools: z.array(z.string().max(32)).max(2),
          })
          .strict()
          .nullable(),
      })
      .strict(),
  })
  .strict();

const notFound = () =>
  NextResponse.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });

export async function GET(request: Request) {
  return withAmuxRouteBudget(async () => {
    try {
      const session = await getServerSession(authOptions);
      if (!session?.user?.id || !isAdminSession(session)) return notFound();
      await consumeApiRateLimit(request, session.user.id, "admin-amux-worker-capability-read", {
        minute: 30,
        day: 600,
      });
      const view = await readAmuxWorkerCapabilitiesForAdmin();
      return NextResponse.json(view, { headers: noStoreHeaders });
    } catch (error) {
      const security = apiSecurityResponse(error);
      if (security) return withNoStore(security);
      console.error(
        JSON.stringify({
          subsystem: "amux",
          event: "worker_capability_read_failed",
          code: error instanceof AmuxDbBoundaryError ? error.code : null,
        }),
      );
      return NextResponse.json({ error: "capabilities_unavailable" }, { status: 503, headers: noStoreHeaders });
    }
  });
}

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
      await consumeApiRateLimit(request, session.user.id, "admin-amux-worker-capability-change", {
        minute: 30,
        day: 200,
      });
      const body = await readLimitedJson(request, 4 * 1_024, bodySchema);
      const event = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.workerCapabilityChange, (tx) =>
        recordAmuxWorkerCapabilityByOwner(tx, { session, request, ...body }),
      );
      return NextResponse.json(
        {
          workerName: event.workerName,
          revision: event.revision,
          action: "amux.worker.capability",
          eventId: event.eventId,
          sequence: event.sequence,
          createdAt: event.createdAt,
        },
        { headers: noStoreHeaders },
      );
    } catch (error) {
      const approvalResponse = adminApprovalErrorResponse(error);
      if (approvalResponse) return withNoStore(approvalResponse);
      if (error instanceof AmuxWorkerCapabilityWriteError) {
        if (error.code === "no_operator") return notFound();
        return NextResponse.json(
          { error: error.code },
          { status: error.code === "invalid_change" ? 400 : 409, headers: noStoreHeaders },
        );
      }
      const security = apiSecurityResponse(error);
      if (security) return withNoStore(security);
      const code = error instanceof AmuxDbBoundaryError ? error.code : null;
      console.error(JSON.stringify({ subsystem: "amux", event: "worker_capability_change_failed", code }));
      return NextResponse.json(
        { error: code === "AMUX_DB_OUTCOME_UNKNOWN" ? "outcome_unknown" : "capability_change_failed" },
        { status: 503, headers: noStoreHeaders },
      );
    }
  });
}
