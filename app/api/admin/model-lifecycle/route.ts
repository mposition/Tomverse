export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";

import { authOptions } from "@/lib/auth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import {
  WORK_ITEM_DECISIONS,
  WORK_ITEM_STATUSES,
} from "@/lib/modelLifecycleWorkItemCore";
import {
  listOpenWorkItems,
  transitionWorkItem,
} from "@/lib/modelLifecycleWorkItems";

/**
 * The model lifecycle queue: read it, and move one item.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md §9, §15.
 *
 * This endpoint is the answer to ML-02. Discovery has always written its
 * findings down -- `ProviderModelCatalogEntry` has held them since July -- and
 * until now nothing in the tree read that table except the monitor that wrote
 * it. A finding nobody can look up is a finding that survives exactly as long
 * as the one email that named it.
 *
 * No approval gate here, deliberately. Two-person approval is for acts that are
 * hard to undo -- lifting a suppression, activating a jurisdiction policy --
 * and triaging a queue is neither: the transition rules refuse the dangerous
 * shapes outright (no approval without a recorded reason, no rollout with
 * validations outstanding, no close that skips a notice somebody is owed), and
 * every move is written to an append-only history with the person's name on it.
 * What this changes is a decision *about* a model, never the model itself; the
 * registry write that follows keeps its own guards.
 */

const transitionSchema = z.object({
  workItemId: z.string().trim().min(1).max(60),
  to: z.enum(WORK_ITEM_STATUSES),
  note: z.string().trim().max(1_000).optional(),
  decision: z
    .object({
      decision: z.enum(WORK_ITEM_DECISIONS),
      reason: z.string().trim().min(1).max(1_000),
    })
    .optional(),
});

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-model-lifecycle-read", {
      minute: 30,
      day: 500,
    });

    const items = await listOpenWorkItems({ limit: 200 });
    return NextResponse.json({
      items: items.map((item) => ({
        ...item,
        dueAt: item.dueAt?.toISOString() ?? null,
        firstSeenAt: item.firstSeenAt.toISOString(),
      })),
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    throw error;
  }
}

export async function PATCH(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    // The same role the registry entry declares (`writeRoles: owner, ops`).
    // Deciding a model should be added and adding it are one job, and split
    // permissions would let somebody queue work they cannot finish.
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    await consumeApiRateLimit(
      req,
      session.user.id,
      "admin-model-lifecycle-write",
      { minute: 20, day: 300 }
    );

    const parsed = await readLimitedJson(req, 8 * 1024, transitionSchema);

    const actorEmail = session.user.email;
    if (!actorEmail) {
      // The state machine refuses an actorless transition anyway; refusing here
      // gives the caller the reason rather than a generic failure.
      return NextResponse.json({ error: "ACTOR_REQUIRED" }, { status: 400 });
    }

    const result = await transitionWorkItem({
      workItemId: parsed.workItemId,
      to: parsed.to,
      actorEmail,
      note: parsed.note,
      decision: parsed.decision,
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.refusal.code, message: result.refusal.message },
        { status: result.refusal.code === "not_found" ? 404 : 409 }
      );
    }

    await writeAdminAuditLog({
      session,
      action: "model_lifecycle.transition",
      targetType: "ModelLifecycleWorkItem",
      targetId: parsed.workItemId,
      summary: `Model lifecycle item moved to ${parsed.to}`,
      metadata: {
        to: parsed.to,
        ...(parsed.decision ? { decision: parsed.decision.decision } : {}),
      },
    });

    return NextResponse.json({ status: result.status });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    throw error;
  }
}
