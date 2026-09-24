export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  runWithAdminApproval,
  adminApprovalErrorResponse,
} from "@/lib/adminApproval";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { lockAmuxResourcePolicies } from "@/lib/amux/resourcePolicy";
import { prisma } from "@/lib/prisma";

const key = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9._:-]+$/);
const policySchema = z
  .object({
    scope: z.enum(["project", "team"]),
    key,
    display_name: z.string().trim().min(1).max(160),
    active: z.boolean(),
    wip_limit: z.number().int().min(1).max(10_000).nullable(),
    capacity_points: z.number().int().min(1).max(1_000_000).nullable(),
    cost_budget_microusd: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    budget_window_starts_at: z.string().datetime({ offset: true }).nullable(),
    budget_window_ends_at: z.string().datetime({ offset: true }).nullable(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict()
  .superRefine((value, context) => {
    const windowValues = [
      value.cost_budget_microusd,
      value.budget_window_starts_at,
      value.budget_window_ends_at,
    ];
    if (
      windowValues.some((item) => item === null) &&
      !windowValues.every((item) => item === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Cost budget and both window bounds must be set together.",
      });
    }
    if (
      value.budget_window_starts_at &&
      value.budget_window_ends_at &&
      Date.parse(value.budget_window_starts_at) >=
        Date.parse(value.budget_window_ends_at)
    ) {
      context.addIssue({
        code: "custom",
        message: "Budget window must increase.",
      });
    }
  });

class AmuxBudgetWindowConflictError extends Error {
  constructor() {
    super(
      "The proposed budget window overlaps ledger evidence from a different window.",
    );
    this.name = "AmuxBudgetWindowConflictError";
  }
}

const sessionFor = async () => {
  const session = await getServerSession(authOptions);
  return session?.user?.id && isAdminSession(session) ? session : null;
};

export async function GET(request: Request) {
  try {
    const session = await sessionFor();
    if (!session)
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    await consumeApiRateLimit(
      request,
      session.user.id,
      "admin-amux-resources-read",
      {
        minute: 30,
        day: 800,
      },
    );
    const policies = await prisma.amuxResourcePolicy.findMany({
      orderBy: [{ scope: "asc" }, { key: "asc" }],
    });
    const resources = await Promise.all(
      policies.map(async (policy) => {
        const keyWhere =
          policy.scope === "project"
            ? { projectKey: policy.key }
            : { teamKey: policy.key };
        const [wip, capacity, cost] = await Promise.all([
          prisma.amuxWorkItem.count({
            where: {
              ...keyWhere,
              archivedAt: null,
              OR: [
                { status: "doing" },
                { status: "todo", owner: { not: null } },
              ],
            },
          }),
          prisma.amuxWorkItem.aggregate({
            where: {
              ...keyWhere,
              archivedAt: null,
              OR: [
                { status: "doing" },
                { status: "todo", owner: { not: null } },
              ],
            },
            _sum: { effortPoints: true },
          }),
          policy.budgetWindowStartsAt && policy.budgetWindowEndsAt
            ? prisma.amuxCostLedgerEntry.aggregate({
                where: {
                  scope: policy.scope,
                  resourceKey: policy.key,
                  budgetWindowStartsAt: policy.budgetWindowStartsAt,
                  budgetWindowEndsAt: policy.budgetWindowEndsAt,
                },
                _sum: { amountMicrousd: true },
              })
            : null,
        ]);
        return {
          ...policy,
          costBudgetMicrousd: policy.costBudgetMicrousd?.toString() ?? null,
          usage: {
            wip,
            capacity_points: capacity._sum.effortPoints ?? 0,
            cost_microusd: cost?._sum.amountMicrousd?.toString() ?? "0",
          },
        };
      }),
    );
    return NextResponse.json(
      { resources },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    return NextResponse.json(
      { error: "Failed to load AMUX resources." },
      { status: 500 },
    );
  }
}

export async function PUT(request: Request) {
  try {
    const session = await sessionFor();
    if (!session)
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    await consumeApiRateLimit(
      request,
      session.user.id,
      "admin-amux-resources-write",
      {
        minute: 12,
        day: 100,
      },
    );
    const body = await readLimitedJson(request, 8 * 1_024, policySchema);
    const result = await runWithAdminApproval(
      {
        session,
        request,
        action: "amux.resource_policy.update",
        targetType: "AmuxResourcePolicy",
        targetId: `${body.scope}:${body.key}`,
        payload: body,
        reason: body.reason,
      },
      (approval) =>
        prisma.$transaction(async (tx) => {
          const [previousPolicy] = await lockAmuxResourcePolicies(tx, [
            { scope: body.scope, key: body.key },
          ]);
          const budgetWindowStartsAt = body.budget_window_starts_at
            ? new Date(body.budget_window_starts_at)
            : null;
          const budgetWindowEndsAt = body.budget_window_ends_at
            ? new Date(body.budget_window_ends_at)
            : null;
          if (budgetWindowStartsAt && budgetWindowEndsAt) {
            const conflictingEvidence =
              await tx.amuxCostLedgerEntry.findFirst({
                where: {
                  scope: body.scope,
                  resourceKey: body.key,
                  budgetWindowStartsAt: { lt: budgetWindowEndsAt },
                  budgetWindowEndsAt: { gt: budgetWindowStartsAt },
                  NOT: {
                    budgetWindowStartsAt,
                    budgetWindowEndsAt,
                  },
                },
                select: { id: true },
              });
            if (conflictingEvidence) {
              throw new AmuxBudgetWindowConflictError();
            }
          }
          const policy = await tx.amuxResourcePolicy.upsert({
            where: { scope_key: { scope: body.scope, key: body.key } },
            create: {
              scope: body.scope,
              key: body.key,
              displayName: body.display_name,
              active: body.active,
              wipLimit: body.wip_limit,
              capacityPoints: body.capacity_points,
              costBudgetMicrousd:
                body.cost_budget_microusd === null
                  ? null
                  : BigInt(body.cost_budget_microusd),
              budgetWindowStartsAt,
              budgetWindowEndsAt,
              updatedById: session.user.id,
              updatedByEmail: session.user.email ?? null,
            },
            update: {
              displayName: body.display_name,
              active: body.active,
              wipLimit: body.wip_limit,
              capacityPoints: body.capacity_points,
              costBudgetMicrousd:
                body.cost_budget_microusd === null
                  ? null
                  : BigInt(body.cost_budget_microusd),
              budgetWindowStartsAt,
              budgetWindowEndsAt,
              updatedById: session.user.id,
              updatedByEmail: session.user.email ?? null,
            },
          });
          await writeAdminAuditLog({
            session,
            request,
            action: "amux.resource_policy.updated",
            targetType: "AmuxResourcePolicy",
            targetId: `${body.scope}:${body.key}`,
            summary: `Updated AMUX ${body.scope} policy ${body.key}.`,
            metadata: {
              approval_id: approval.approvalId,
              authorization_audit_log_id: approval.authorizationAuditLogId,
              previous: previousPolicy
                ? {
                    active: previousPolicy.active,
                    wip_limit: previousPolicy.wipLimit,
                    capacity_points: previousPolicy.capacityPoints,
                    cost_budget_microusd:
                      previousPolicy.costBudgetMicrousd?.toString() ?? null,
                    budget_window_starts_at:
                      previousPolicy.budgetWindowStartsAt?.toISOString() ??
                      null,
                    budget_window_ends_at:
                      previousPolicy.budgetWindowEndsAt?.toISOString() ?? null,
                  }
                : null,
              active: body.active,
              wip_limit: body.wip_limit,
              capacity_points: body.capacity_points,
              cost_budget_microusd:
                body.cost_budget_microusd?.toString() ?? null,
              budget_window_starts_at: body.budget_window_starts_at,
              budget_window_ends_at: body.budget_window_ends_at,
              reason: body.reason,
            },
            tx,
          });
          return {
            scope: policy.scope,
            key: policy.key,
            updated_at: policy.updatedAt,
          };
        }),
    );
    return NextResponse.json({ success: true, resource: result });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    const approvalResponse = adminApprovalErrorResponse(error);
    if (approvalResponse) return approvalResponse;
    if (error instanceof AmuxBudgetWindowConflictError) {
      return NextResponse.json(
        {
          error: error.message,
          code: "AMUX_BUDGET_WINDOW_CONFLICT",
        },
        { status: 409 },
      );
    }
    console.error("Failed to update AMUX resource policy:", error);
    return NextResponse.json(
      { error: "Failed to update AMUX resource policy." },
      { status: 500 },
    );
  }
}
