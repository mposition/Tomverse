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
  OPERATOR_REASON_MAX_LENGTH,
  WORK_ITEM_DECISIONS,
  WORK_ITEM_EXCLUSION_REASONS,
  WORK_ITEM_STATUSES,
  analysisFingerprint,
  workItemDecisionTarget,
} from "@/lib/modelLifecycleWorkItemCore";
import {
  MAX_BULK_WORK_ITEM_TRANSITIONS,
  EXCLUDABLE_WORK_ITEM_STATUSES,
  listModelDiscoveryQueue,
  queueFamilies,
  queueStatusSetUnchanged,
  transitionWorkItem,
  transitionWorkItems,
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

const transitionFields = {
  to: z.enum(WORK_ITEM_STATUSES),
  decision: z
    .object({
      decision: z.enum(WORK_ITEM_DECISIONS),
      reason: z.string().trim().min(1).max(1_000),
    })
    .optional(),
} as const;

const singleTransitionSchema = z.object({
  workItemId: z.string().trim().min(1).max(60),
  ...transitionFields,
  note: z.string().trim().max(1_000).optional(),
});

const bulkTransitionSchema = z.object({
  workItemIds: z
    .array(z.string().trim().min(1).max(60))
    .min(1)
    .max(MAX_BULK_WORK_ITEM_TRANSITIONS),
  ...transitionFields,
  // One shared reason keeps bulk review auditable without asking the operator
  // to type the same explanation once per row.
  note: z.string().trim().min(1).max(1_000),
});

const workItemIdsField = z
  .array(z.string().trim().min(1).max(60))
  .min(1)
  .max(MAX_BULK_WORK_ITEM_TRANSITIONS);

/**
 * The two operator decisions the discovery queue offers besides adoption.
 *
 * Their own shapes rather than a `to` with a note, because each carries a
 * structured record the history keeps apart: the chosen reason, the operator's
 * own words, and -- added here, never read from the request -- the analysis
 * the queue was showing.
 */
/**
 * An exclusion is made per family: the operator reads one row -- the family's
 * representative -- and decides for every member.
 *
 * `shownAnalysisFingerprint` is the fingerprint of the sentence that row
 * showed. It is compared, not recorded: the server records its own computation
 * of the representative's analysis, on every member's event, and refuses when
 * the two differ -- a scan that moved the evidence between the list loading and
 * the click would otherwise record a sentence the operator never saw.
 *
 * `workItemIds` must be exactly the family's undecided members as the server
 * reads them now -- not a subset, not another family's items. An exclusion is a
 * decision about a family; accepting part of one would leave the rest in the
 * queue under a decision recorded as made.
 */
const excludeSchema = z.object({
  decision: z.literal("exclude"),
  reasonCode: z.enum(WORK_ITEM_EXCLUSION_REASONS),
  operatorReason: z.string().trim().max(OPERATOR_REASON_MAX_LENGTH).optional(),
  families: z
    .array(
      z.object({
        representativeId: z.string().trim().min(1).max(60),
        workItemIds: workItemIdsField,
        shownAnalysisFingerprint: z.string().regex(/^[0-9a-f]{16}$/),
      })
    )
    .min(1)
    .max(MAX_BULK_WORK_ITEM_TRANSITIONS),
});

/** A reopen is per family too: every excluded member returns, or none does. */
const reopenSchema = z.object({
  decision: z.literal("reopen"),
  operatorReason: z.string().trim().min(1).max(OPERATOR_REASON_MAX_LENGTH),
  families: z
    .array(
      z.object({
        representativeId: z.string().trim().min(1).max(60),
        workItemIds: workItemIdsField,
      })
    )
    .min(1)
    .max(MAX_BULK_WORK_ITEM_TRANSITIONS),
});

const transitionSchema = z.union([
  excludeSchema,
  reopenSchema,
  bulkTransitionSchema,
  singleTransitionSchema,
]);

/**
 * Moves the generic transition shape may not make.
 *
 * Closing an item, reopening one and approving one are decisions with a
 * record; accepting them as a bare `to` would write an exclusion with no
 * reason code, or an approval the adoption record never follows -- the
 * adoption walk starts past `approved` once an item is there. Approval
 * happens by adopting (POST /api/admin/models with a work item).
 */
const DECISION_ONLY_TARGETS = new Set(["closed_no_action", "discovered", "approved"]);

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

    const view =
      new URL(req.url).searchParams.get("view") === "excluded" ? "excluded" : "open";
    const queue = await listModelDiscoveryQueue({ limit: 1_000, view });
    return NextResponse.json({
      ...queue,
      view,
      items: queue.items.map((item) => ({
        ...item,
        dueAt: item.dueAt?.toISOString() ?? null,
        firstSeenAt: item.firstSeenAt.toISOString(),
        exclusion: item.exclusion
          ? { ...item.exclusion, excludedAt: item.exclusion.excludedAt.toISOString() }
          : null,
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

    const parsed = await readLimitedJson(req, 64 * 1024, transitionSchema);

    const actorEmail = session.user.email;
    if (!actorEmail) {
      // The state machine refuses an actorless transition anyway; refusing here
      // gives the caller the reason rather than a generic failure.
      return NextResponse.json({ error: "ACTOR_REQUIRED" }, { status: 400 });
    }

    if ("decision" in parsed && typeof parsed.decision === "string") {
      const decided = parsed;
      const to = workItemDecisionTarget(decided.decision);
      const workItemIds = decided.families.flatMap((family) => family.workItemIds);
      if (workItemIds.length > MAX_BULK_WORK_ITEM_TRANSITIONS) {
        return NextResponse.json(
          {
            error: "too_many",
            message: `At most ${MAX_BULK_WORK_ITEM_TRANSITIONS} work items may be changed at once.`,
          },
          { status: 400 }
        );
      }
      // Read before the transaction: this is what the queue shows, computed
      // from the same evidence the panel was given. Reopening has nothing to
      // snapshot -- the reason is the operator's, and the analysis they will
      // act on is the one the reopened row shows next.
      // Both decisions are about whole families as the server reads them now.
      // For an exclusion the representative's analysis must also be the one
      // the operator read; a reopen acts on no analysis.
      const checkedStatuses =
        decided.decision === "exclude"
          ? [...EXCLUDABLE_WORK_ITEM_STATUSES]
          : (["closed_no_action"] as const);
      const queue = await queueFamilies(
        decided.decision === "exclude" ? "excludable" : "excluded"
      );
      if (!queue.complete) {
        return NextResponse.json(
          {
            error: "QUEUE_TOO_LARGE",
            message:
              "There are more items than one read holds, so family membership cannot be confirmed.",
          },
          { status: 503 }
        );
      }
      const checkedIds = new Set(queue.items.keys());
      const membersByFamily = new Map<string, string[]>();
      for (const [id, item] of queue.items) {
        const members = membersByFamily.get(item.familyKey);
        if (members) members.push(id);
        else membersByFamily.set(item.familyKey, [id]);
      }
      const analysisSnapshots =
        decided.decision === "exclude" ? new Map<string, string>() : undefined;
      const stale: string[] = [];
      for (const family of decided.families) {
        const representative = queue.items.get(family.representativeId);
        const members = representative
          ? (membersByFamily.get(representative.familyKey) ?? [])
          : [];
        const submitted = new Set(family.workItemIds);
        const coherent =
          representative !== undefined &&
          submitted.size === family.workItemIds.length &&
          submitted.size === members.length &&
          members.every((id) => submitted.has(id));
        if (!coherent) {
          return NextResponse.json(
            {
              error: "FAMILY_MISMATCH",
              message:
                "The family's members changed since this list loaded. Reload and decide again.",
            },
            { status: 409 }
          );
        }
        if (decided.decision === "exclude") {
          if (
            analysisFingerprint(representative.analysisKo) !==
            (family as { shownAnalysisFingerprint: string }).shownAnalysisFingerprint
          ) {
            stale.push(family.representativeId);
            continue;
          }
          for (const id of family.workItemIds) {
            analysisSnapshots!.set(id, representative.analysisKo);
          }
        }
      }
      if (stale.length > 0) {
        return NextResponse.json(
          {
            error: "ANALYSIS_CHANGED",
            message: "The analysis changed since this list loaded. Reload and decide again.",
            workItemIds: stale,
          },
          { status: 409 }
        );
      }

      const outcome = await prisma.$transaction(async (tx) => {
        if (!(await queueStatusSetUnchanged(tx, checkedStatuses, checkedIds))) {
          return {
            ok: false as const,
            refusal: {
              code: "FAMILY_MISMATCH",
              message:
                "The family's members changed since this list loaded. Reload and decide again.",
            },
          };
        }
        const transition = await transitionWorkItems(
          {
            workItemIds,
            to,
            actorEmail,
            eventDecision: {
              decision: decided.decision,
              reasonCode: decided.decision === "exclude" ? decided.reasonCode : null,
              operatorReason: decided.operatorReason ?? null,
              analysisSnapshots,
            },
          },
          { tx }
        );
        if (!transition.ok) return transition;
        await writeAdminAuditLog({
          session,
          request: req,
          action:
            decided.decision === "exclude"
              ? "model_lifecycle.exclude"
              : "model_lifecycle.reopen",
          targetType: "ModelLifecycleWorkItemBatch",
          targetId: null,
          summary:
            decided.decision === "exclude"
              ? `${workItemIds.length} model lifecycle items excluded`
              : `${workItemIds.length} excluded model lifecycle items reopened`,
          metadata: {
            to,
            count: workItemIds.length,
            workItemIds,
            ...(decided.decision === "exclude" ? { reasonCode: decided.reasonCode } : {}),
          },
          tx,
        });
        return transition;
      });
      if (!outcome.ok) {
        return NextResponse.json(
          { error: outcome.refusal.code, message: outcome.refusal.message },
          { status: outcome.refusal.code === "not_found" ? 404 : 409 }
        );
      }
      return NextResponse.json({ status: outcome.status, updated: outcome.updated });
    }

    const generic = parsed as
      | z.infer<typeof bulkTransitionSchema>
      | z.infer<typeof singleTransitionSchema>;
    if (DECISION_ONLY_TARGETS.has(generic.to)) {
      return NextResponse.json(
        {
          error: "DECISION_REQUIRED",
          message: "Excluding and reopening are recorded as decisions, not bare transitions.",
        },
        { status: 400 }
      );
    }

    const isBulk = "workItemIds" in generic;
    const workItemIds = isBulk ? generic.workItemIds : [generic.workItemId];
    const result = await prisma.$transaction(async (tx) => {
      const transition = isBulk
        ? await transitionWorkItems(
            {
              workItemIds,
              to: generic.to,
              actorEmail,
              note: generic.note,
              decision: generic.decision,
            },
            { tx }
          )
        : await transitionWorkItem(
            {
              workItemId: generic.workItemId,
              to: generic.to,
              actorEmail,
              note: generic.note,
              decision: generic.decision,
            },
            { tx }
          );

      if (!transition.ok) return transition;

      await writeAdminAuditLog({
        session,
        request: req,
        action: isBulk
          ? "model_lifecycle.bulk_transition"
          : "model_lifecycle.transition",
        targetType: isBulk
          ? "ModelLifecycleWorkItemBatch"
          : "ModelLifecycleWorkItem",
        targetId: isBulk ? null : workItemIds[0],
        summary: isBulk
          ? `${workItemIds.length} model lifecycle items moved to ${generic.to}`
          : `Model lifecycle item moved to ${generic.to}`,
        metadata: {
          to: generic.to,
          count: workItemIds.length,
          workItemIds,
          ...(generic.decision ? { decision: generic.decision.decision } : {}),
        },
        tx,
      });
      return transition;
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.refusal.code, message: result.refusal.message },
        { status: result.refusal.code === "not_found" ? 404 : 409 }
      );
    }

    return NextResponse.json({
      status: result.status,
      updated: "updated" in result ? result.updated : 1,
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    throw error;
  }
}
