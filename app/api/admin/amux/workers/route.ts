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
import { readAmuxWorkerRegistryForAdmin } from "@/lib/amux/workerRegistryAdminRead";
import { amuxWorkerRegistryWritesOpen } from "@/lib/amux/workerRegistryCore";
import {
  AmuxWorkerRegistryWriteError,
  recordAmuxWorkerRegistryChangeByOwner,
} from "@/lib/amux/workerRegistryStore";

/**
 * The AMUX worker registry (orchestration policy version 31, section 3).
 *
 * GET is the registry and each worker's desired and effective state, for any
 * administrator. Reading is never latched.
 *
 * POST is the owner recording one worker's desired state and role ceiling,
 * and nothing else. In order, before the body is read: the owner role, the
 * stage's code latch (`AMUX_WORKER_REGISTRY_WRITES_LATCH`, off until the
 * operator's R1 activation record -- section 8), and a recent step-up (a stale
 * one answers 428 through `adminApprovalErrorResponse`). The store writes the
 * human audit (`amux.worker.register` or `amux.worker.change`) and the event
 * in one transaction inside the AMUX DB boundary. A refusal by the change rule
 * answers 409 with its code and writes nothing; when the transaction's outcome
 * is unknown the answer says so, and the caller reads the registry back
 * instead of sending the change again (foundation principle 7).
 *
 * Each handler runs inside the AMUX route budget from its first line.
 */

const noStoreHeaders = { "Cache-Control": "private, no-store, max-age=0" };

const withNoStore = (response: Response) => {
  response.headers.set("Cache-Control", noStoreHeaders["Cache-Control"]);
  return response;
};

const bodySchema = z
  .object({
    workerName: z.string().max(40),
    // The CLI the worker runs, chosen by the owner (owner decision 2026-10-27).
    providerClass: z.string().max(16),
    roleCeiling: z.string().max(32),
    desiredState: z.string().max(32),
    expectedRevision: z.number().int().min(0).max(1_000_000),
  })
  .strict();

const notFound = () =>
  NextResponse.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });

export async function GET(request: Request) {
  return withAmuxRouteBudget(async () => {
    try {
      const session = await getServerSession(authOptions);
      if (!session?.user?.id || !isAdminSession(session)) return notFound();
      await consumeApiRateLimit(request, session.user.id, "admin-amux-worker-registry-read", {
        minute: 30,
        day: 600,
      });
      const view = await readAmuxWorkerRegistryForAdmin();
      return NextResponse.json(view, { headers: noStoreHeaders });
    } catch (error) {
      const security = apiSecurityResponse(error);
      if (security) return withNoStore(security);
      console.error(
        JSON.stringify({
          subsystem: "amux",
          event: "worker_registry_read_failed",
          code: error instanceof AmuxDbBoundaryError ? error.code : null,
        }),
      );
      return NextResponse.json(
        { error: "registry_unavailable" },
        { status: 503, headers: noStoreHeaders },
      );
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
      if (!amuxWorkerRegistryWritesOpen()) {
        return NextResponse.json(
          { error: "registry_writes_off" },
          { status: 409, headers: noStoreHeaders },
        );
      }
      await assertRecentAdminAuthentication(session);
      await consumeApiRateLimit(request, session.user.id, "admin-amux-worker-registry-change", {
        minute: 30,
        day: 200,
      });
      const body = await readLimitedJson(request, 512, bodySchema);
      const event = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.workerRegistryChange, (tx) =>
        recordAmuxWorkerRegistryChangeByOwner(tx, { session, request, ...body }),
      );
      return NextResponse.json(
        {
          workerName: event.workerName,
          revision: event.revision,
          action: event.action,
          eventId: event.eventId,
          sequence: event.sequence,
          createdAt: event.createdAt,
        },
        { headers: noStoreHeaders },
      );
    } catch (error) {
      const approvalResponse = adminApprovalErrorResponse(error);
      if (approvalResponse) return withNoStore(approvalResponse);
      if (error instanceof AmuxWorkerRegistryWriteError) {
        if (error.code === "no_operator") return notFound();
        return NextResponse.json(
          { error: error.code },
          { status: error.code === "invalid_change" ? 400 : 409, headers: noStoreHeaders },
        );
      }
      const security = apiSecurityResponse(error);
      if (security) return withNoStore(security);
      const code = error instanceof AmuxDbBoundaryError ? error.code : null;
      console.error(JSON.stringify({ subsystem: "amux", event: "worker_registry_change_failed", code }));
      // Rolled back unless the outcome is unknown; then only a read says which.
      return NextResponse.json(
        { error: code === "AMUX_DB_OUTCOME_UNKNOWN" ? "outcome_unknown" : "registry_change_failed" },
        { status: 503, headers: noStoreHeaders },
      );
    }
  });
}
