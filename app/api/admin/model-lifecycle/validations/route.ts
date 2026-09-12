export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import { authOptions } from "@/lib/auth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { prisma } from "@/lib/prisma";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { remainingValidations } from "@/lib/modelAdoptionDraft";

/**
 * Ticking off a validation an item owes.
 *
 * This exists because writing the list finally gave it teeth. Until adoption
 * started recording `pricing`, `access` and `staging`, the column was written
 * by nothing, every item carried an empty list, and the rollout gate that reads
 * it therefore refused nothing. Filling it in without also providing a way to
 * empty it turned the same gate into a wall: an adopted model could never be
 * rolled out, by anyone, ever.
 *
 * A transition of its own rather than a field on the transition endpoint:
 * satisfying a validation is not a state change, it happens between states, and
 * it is the thing the operator does *while* an item sits in `validation_pending`.
 *
 * The event row is the point. A validation that can be cleared without a trace
 * is a gate somebody can walk through quietly, which is the shape of the
 * problem this queue was built to end.
 */
const clearSchema = z.object({
  workItemId: z.string().trim().min(1).max(60),
  /** The names being marked satisfied, from the item's own pending list. */
  completed: z.array(z.string().trim().min(1).max(40)).min(1).max(10),
  note: z.string().trim().min(1).max(1_000),
});

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    const actorEmail = session.user.email;
    if (!actorEmail) {
      // Same rule as every other move in this queue: a record with no person
      // behind it is not a record.
      return NextResponse.json({ error: "ACTOR_REQUIRED" }, { status: 400 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-model-lifecycle-validations", {
      minute: 20,
      day: 300,
    });

    const parsed = await readLimitedJson(req, 8 * 1024, clearSchema);

    const result = await prisma.$transaction(async (tx) => {
      // Locked before it is read, the way every transition in this queue is.
      // Two administrators clearing two different validations at once would
      // otherwise each read the same three-item list, each write their own
      // two-item remainder, and the second write would restore the validation
      // the first had just satisfied -- with both events in the history saying
      // it was done.
      const locked = await tx.$queryRaw<
        Array<{ id: string; status: string; pendingValidations: Prisma.JsonValue | null }>
      >(Prisma.sql`
        SELECT "id", "status", "pendingValidations"
        FROM "ModelLifecycleWorkItem"
        WHERE "id" = ${parsed.workItemId}
        FOR UPDATE
      `);
      const item = locked[0] ?? null;
      if (!item) return { ok: false as const, status: 404, message: "No such work item." };

      const outcome = remainingValidations(item.pendingValidations, parsed.completed);
      if (outcome.unknown.length) {
        return {
          ok: false as const,
          status: 409,
          message: `This item does not owe ${outcome.unknown.join(", ")}. It owes ${outcome.before.join(", ") || "nothing"}.`,
        };
      }

      await tx.modelLifecycleWorkItem.update({
        where: { id: item.id },
        data: { pendingValidations: outcome.remaining },
      });
      await tx.modelLifecycleWorkItemEvent.create({
        data: {
          workItemId: item.id,
          occurredAt: new Date(),
          actorEmail,
          // The item did not move; it is the same state on both sides, and the
          // note carries what actually happened. Recorded rather than silent
          // because a validation nobody can see being satisfied is a gate that
          // was never really there.
          fromStatus: item.status,
          toStatus: item.status,
          note: `Validation satisfied: ${parsed.completed.join(", ")}. ${parsed.note}`,
        },
      });
      return { ok: true as const, remaining: outcome.remaining };
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.message }, { status: result.status });
    }

    await writeAdminAuditLog({
      session,
      request: req,
      action: "model.lifecycle.validation_cleared",
      targetType: "ModelLifecycleWorkItem",
      targetId: parsed.workItemId,
      summary: `Marked ${parsed.completed.join(", ")} satisfied on work item ${parsed.workItemId}.`,
      metadata: { completed: parsed.completed, remaining: result.remaining },
    });

    return NextResponse.json({ pendingValidations: result.remaining });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    throw error;
  }
}
