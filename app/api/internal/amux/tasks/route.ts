export const dynamic = "force-dynamic";

import { z } from "zod";
import type { Prisma } from "@prisma/client";

import { apiSecurityResponse, readLimitedJson } from "@/lib/apiSecurity";
import { writeSystemAuditLog } from "@/lib/adminAudit";
import { openAmuxHumanEscalation } from "@/lib/amux/escalation";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { parseAmuxDeadline } from "@/lib/amux/planningCore";
import { prisma } from "@/lib/prisma";

const safeKey = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9._:-]+$/);
const safeRole = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_:-]+$/);
const classification = z
  .object({
    task_kind: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9_]+$/i),
    complexity: z.number().int().min(1).max(10),
    risk: z.number().int().min(1).max(3),
    files_expected: z
      .union([
        z.array(z.string().trim().min(1).max(500)).max(1_000),
        z.number().int().min(0).max(1_000),
        z.null(),
      ])
      .optional(),
  })
  .passthrough();

const taskSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    title: z.string().trim().min(1).max(500),
    description: z.string().max(50_000).nullable().optional(),
    kind: z.enum([
      "blocker",
      "escalation",
      "bug",
      "code",
      "ops",
      "investigation",
      "research",
      "chore",
      "doc",
      "unknown",
    ]),
    priority: z.enum(["p0", "p1", "p2", "p3"]),
    pinned: z.boolean().default(false),
    drag: z.number().int().min(0).max(8).default(0),
    classification,
    project_key: safeKey.nullable().optional(),
    team_key: safeKey.nullable().optional(),
    due: z.string().trim().min(1).max(120).nullable().optional(),
    effort_points: z.number().int().min(1).max(1_000_000).default(1),
    estimated_cost_microusd: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .nullable()
      .optional(),
    required_routing_role: safeRole.nullable().optional(),
    requires_human_review: z.boolean().default(false),
    review_specialty: safeRole.nullable().optional(),
    review_pr_number: z.number().int().min(1).max(1_000_000_000).nullable().optional(),
    dependencies: z
      .array(z.string().trim().min(1).max(120))
      .max(1_000)
      .default([]),
  })
  .strict()
  .superRefine((task, context) => {
    if (task.requires_human_review && !task.review_specialty) {
      context.addIssue({
        code: "custom",
        path: ["review_specialty"],
        message: "Human review tasks require an explicit specialty.",
      });
    }
    if (task.review_pr_number && !task.requires_human_review) {
      context.addIssue({
        code: "custom",
        path: ["review_pr_number"],
        message: "A review PR requires human review to be enabled.",
      });
    }
    if (!task.requires_human_review && task.review_specialty) {
      context.addIssue({
        code: "custom",
        path: ["review_specialty"],
        message: "Review specialty requires human review.",
      });
    }
  });

const requestSchema = z
  .object({ tasks: z.array(taskSchema).min(1).max(500) })
  .strict();

class AmuxTaskSnapshotConflictError extends Error {
  constructor() {
    super("An AMUX task changed while its planning snapshot was being synced.");
    this.name = "AmuxTaskSnapshotConflictError";
  }
}

export async function PUT(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = await readLimitedJson(
      request,
      2 * 1_024 * 1_024,
      requestSchema,
    );
    if (new Set(body.tasks.map((task) => task.id)).size !== body.tasks.length) {
      return Response.json({ error: "Duplicate task id." }, { status: 400 });
    }
    const incomingIds = new Set(body.tasks.map((task) => task.id));
    for (const task of body.tasks) {
      if (task.dependencies.includes(task.id)) {
        return Response.json(
          { error: `Task ${task.id} depends on itself.` },
          { status: 400 },
        );
      }
      if (
        task.dependencies.some((dependency) => !incomingIds.has(dependency))
      ) {
        return Response.json(
          {
            error: `Task ${task.id} references a dependency outside this snapshot.`,
          },
          { status: 400 },
        );
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      let created = 0;
      let updated = 0;
      const busy: string[] = [];
      const deadlineProblems: Array<{
        id: string;
        state: string;
        raw: string | null;
      }> = [];
      for (const task of body.tasks) {
        const current = await tx.amuxWorkItem.findUnique({
          where: { id: task.id },
          select: { status: true, owner: true, revision: true },
        });
        // Claimed Todo is already consuming the original resource's WIP slot.
        // Re-keying it here would evade the resource lock taken at claim time.
        if (current && (current.status === "doing" || current.owner !== null)) {
          busy.push(task.id);
          continue;
        }
        const deadline = parseAmuxDeadline({
          classificationDueAt: task.due,
          title: task.title,
          description: task.description,
        });
        const dueData =
          deadline.state === "parsed"
            ? {
                dueAt: new Date(deadline.due_at),
                duePrecision: deadline.precision,
                dueSource: deadline.source,
                dueParseState: "valid",
                dueRaw: deadline.raw,
              }
            : deadline.state === "invalid" || deadline.state === "ambiguous"
              ? {
                  dueAt: null,
                  duePrecision: null,
                  dueSource: deadline.source,
                  dueParseState: deadline.state,
                  dueRaw: deadline.raw,
                }
              : {
                  dueAt: null,
                  duePrecision: null,
                  dueSource: null,
                  dueParseState: "none",
                  dueRaw: null,
                };
        if (
          deadline.state === "invalid" ||
          deadline.state === "ambiguous"
        ) {
          deadlineProblems.push({
            id: task.id,
            state: deadline.state,
            raw: deadline.raw,
          });
        }
        const blocksDispatchForDeadline =
          (deadline.state === "invalid" || deadline.state === "ambiguous") &&
          (!current || current.status === "todo");
        const data = {
          title: task.title,
          description: task.description ?? null,
          kind: task.kind,
          priority: task.priority,
          pinned: task.pinned,
          drag: task.drag,
          classification: JSON.parse(
            JSON.stringify(task.classification),
          ) as Prisma.InputJsonValue,
          projectKey: task.project_key ?? null,
          teamKey: task.team_key ?? null,
          ...dueData,
          effortPoints: task.effort_points,
          estimatedCostMicrousd:
            task.estimated_cost_microusd === null ||
            task.estimated_cost_microusd === undefined
              ? null
              : BigInt(task.estimated_cost_microusd),
          requiredRoutingRole: task.required_routing_role ?? null,
          requiresHumanReview: task.requires_human_review,
          reviewSpecialty: task.review_specialty ?? null,
          reviewPrNumber: task.review_pr_number ?? null,
          ...(blocksDispatchForDeadline
            ? { status: "blocked", owner: null, claimedAt: null }
            : {}),
        };
        if (current) {
          const changed = await tx.amuxWorkItem.updateMany({
            where: {
              id: task.id,
              status: current.status,
              owner: null,
              revision: current.revision,
            },
            data: { ...data, revision: { increment: 1 } },
          });
          if (changed.count !== 1) {
            throw new AmuxTaskSnapshotConflictError();
          }
          updated += 1;
        } else {
          await tx.amuxWorkItem.create({ data: { id: task.id, ...data } });
          created += 1;
        }
        if (blocksDispatchForDeadline) {
          await openAmuxHumanEscalation(tx, {
            taskId: task.id,
            specialty: "planning-review",
            reason: `Canonical deadline parsing requires human correction (${deadline.state}).`,
            openedBy: "system:amux-task-sync",
          });
        }
      }

      const mutable = body.tasks.filter((task) => !busy.includes(task.id));
      await tx.amuxWorkDependency.deleteMany({
        where: { taskId: { in: mutable.map((task) => task.id) } },
      });
      const edges = mutable.flatMap((task) =>
        task.dependencies.map((dependencyId) => ({
          taskId: task.id,
          dependencyId,
        })),
      );
      if (edges.length > 0)
        await tx.amuxWorkDependency.createMany({ data: edges });
      await writeSystemAuditLog({
        systemActor: "tomverse-amux-orchestrator",
        action: "amux.task_snapshot.synced",
        targetType: "AmuxWorkItem",
        targetId: "snapshot",
        summary: "Synchronized an authenticated AMUX task snapshot.",
        metadata: {
          submitted: body.tasks.length,
          created,
          updated,
          busy_skipped: busy,
          deadline_problems: deadlineProblems,
        },
        tx,
      });
      return { created, updated, busy, deadline_problems: deadlineProblems };
    });

    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AmuxTaskSnapshotConflictError) {
      return Response.json(
        { error: error.message, code: "AMUX_TASK_SNAPSHOT_CONFLICT" },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    return Response.json(
      { error: "AMUX task sync is unavailable." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
