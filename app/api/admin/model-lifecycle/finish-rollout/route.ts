export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
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
import {
  MAX_BULK_WORK_ITEM_TRANSITIONS,
  finishServedRollouts,
  listModelDiscoveryQueue,
} from "@/lib/modelLifecycleWorkItems";

/**
 * "Rollout complete" for adopted models that are already live.
 *
 * Adoption leaves an item at `validation_pending`, and the discovery queue had
 * no way to walk it on, so live models sat in the queue reading as "a later
 * version is served" -- themselves. This closes them in one step, by a person,
 * with the same events the three separate moves would write. Only items the
 * queue itself marks `rolloutFinishable` are accepted.
 */
const finishSchema = z.object({
  workItemIds: z
    .array(z.string().trim().min(1).max(60))
    .min(1)
    .max(MAX_BULK_WORK_ITEM_TRANSITIONS),
  note: z.string().trim().min(1).max(1_000),
});

class RolloutRefused extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    const actorEmail = session.user.email;
    if (!actorEmail) {
      return NextResponse.json({ error: "ACTOR_REQUIRED" }, { status: 400 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-model-lifecycle-write", {
      minute: 20,
      day: 300,
    });

    const parsed = await readLimitedJson(req, 16 * 1024, finishSchema);
    const workItemIds = Array.from(new Set(parsed.workItemIds));

    // The queue's own reading, not the request's claim: each item must be an
    // adopted `add` that the registry already serves.
    const queue = await listModelDiscoveryQueue({ workItemIds });
    const finishable = new Set(
      queue.items.filter((item) => item.rolloutFinishable).map((item) => item.id)
    );
    const refused = workItemIds.filter((id) => !finishable.has(id));
    if (refused.length > 0) {
      return NextResponse.json(
        {
          error: "NOT_FINISHABLE",
          message: "Only adopted items whose model is already served can be closed here.",
          workItemIds: refused,
        },
        { status: 409 }
      );
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const finished = await finishServedRollouts(tx, {
          workItemIds,
          actorEmail,
          note: parsed.note,
        });
        // Thrown, not returned: the validations ticked before the refusal
        // must roll back with it.
        if (!finished.ok) {
          throw new RolloutRefused(finished.refusal.code, finished.refusal.message);
        }
        await writeAdminAuditLog({
          session,
          request: req,
          action: "model_lifecycle.finish_rollout",
          targetType: "ModelLifecycleWorkItemBatch",
          targetId: null,
          summary: `${workItemIds.length} adopted model lifecycle items closed as rolled out`,
          metadata: {
            count: workItemIds.length,
            workItemIds,
            completed: finished.completed,
            awaitingNotice: finished.awaitingNotice,
          },
          tx,
        });
        return finished;
      });
      return NextResponse.json({
        completed: result.completed,
        awaitingNotice: result.awaitingNotice,
      });
    } catch (error) {
      if (error instanceof RolloutRefused) {
        return NextResponse.json({ error: error.code, message: error.message }, { status: 409 });
      }
      throw error;
    }
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    throw error;
  }
}
