export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import type { AiProvider } from "@/lib/models";
import { getRuntimeModels } from "@/lib/modelRegistry";
import { PROVIDER_DISPLAY_NAMES } from "@/lib/providerMonitoring";
import { prisma } from "@/lib/prisma";

const providers = Object.keys(PROVIDER_DISPLAY_NAMES) as [AiProvider, ...AiProvider[]];
const createIncidentSchema = z
  .object({
    provider: z.enum(providers).optional(),
    modelId: z
      .string()
      .trim()
      .max(120)
      .optional(),
    status: z.enum(["limited", "disabled"]),
    title: z.string().trim().min(3).max(120),
    message: z.string().trim().max(500).optional(),
    fallbackModelIds: z
      .array(
        z.string().trim().min(1).max(120)
      )
      .max(5)
      .optional(),
  })
  .strict()
  .refine((value) => value.provider || value.modelId, {
    message: "Provider or model is required.",
  });

const updateIncidentSchema = z
  .object({
    incidentId: z.string().trim().min(1).max(120),
    action: z.enum(["resolve"]),
  })
  .strict();

const incidentOverrideReason = (incidentId: string, title: string) =>
  `[incident:${incidentId}] ${title}`.slice(0, 500);

const incidentOverrideNote = (status: string, message: string | null) =>
  (message || (status === "disabled" ? "This model is temporarily unavailable." : "This model is temporarily limited.")).slice(0, 500);

const previousModelStatesSchema = z.array(
  z.object({
    id: z.string(),
    status: z.enum(["enabled", "limited", "disabled", "coming-soon"]),
    enabled: z.boolean(),
    operationalReason: z.string().nullable(),
    userVisibleNote: z.string().nullable(),
  })
);

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-incidents-read", {
      minute: 40,
      day: 800,
    });

    const incidents = await prisma.adminProviderIncident.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return NextResponse.json({ incidents });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to load admin incidents:", error);
    return NextResponse.json(
      { error: "Failed to load incidents." },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-incidents-write", {
      minute: 12,
      day: 100,
    });

    const body = await readLimitedJson(req, 6 * 1024, createIncidentSchema);
    const runtimeModels = await getRuntimeModels();
    const modelIds = new Set(runtimeModels.map((model) => model.id));
    if (body.modelId && !modelIds.has(body.modelId)) {
      return NextResponse.json({ error: "Unknown model." }, { status: 400 });
    }
    if ((body.fallbackModelIds || []).some((modelId) => !modelIds.has(modelId))) {
      return NextResponse.json({ error: "Unknown fallback model." }, { status: 400 });
    }
    const targetModels = body.modelId
      ? runtimeModels.filter((model) => model.id === body.modelId)
      : runtimeModels.filter((model) => model.provider === body.provider);

    const incident = await prisma.$transaction(async (tx) => {
      const created = await tx.adminProviderIncident.create({
        data: {
          provider: body.provider || null,
          modelId: body.modelId || null,
          status: body.status,
          title: body.title,
          message: body.message?.trim() || null,
          fallbackModelIds: JSON.stringify(body.fallbackModelIds || []),
          previousModelStates: targetModels.map((model) => ({
            id: model.id,
            status: model.status,
            enabled: model.enabled,
            operationalReason: model.operationalReason || null,
            userVisibleNote: model.userVisibleNote || null,
          })),
          createdById: session.user.id,
          createdByEmail: session.user.email || null,
        },
      });

      for (const model of targetModels) {
        await tx.modelRegistryEntry.update({
          where: { id: model.id },
          data: {
            status: body.status,
            enabled: body.status === "limited",
            operationalReason: incidentOverrideReason(created.id, body.title),
            userVisibleNote: incidentOverrideNote(body.status, body.message || null),
            updatedById: session.user.id,
            updatedByEmail: session.user.email || null,
          },
        });
      }

      return created;
    });

    await writeAdminAuditLog({
      session,
      request: req,
      action: "incident.created",
      targetType: body.modelId ? "Model" : "Provider",
      targetId: body.modelId || body.provider || null,
      summary: `Created ${body.status} incident: ${body.title}.`,
      metadata: {
        incidentId: incident.id,
        provider: body.provider || null,
        modelId: body.modelId || null,
        affectedModels: targetModels.map((model) => model.id),
      },
    });

    return NextResponse.json({ success: true, incident });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to create admin incident:", error);
    return NextResponse.json(
      { error: "Failed to create incident." },
      { status: 500 }
    );
  }
}

export async function PATCH(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-incidents-write", {
      minute: 12,
      day: 100,
    });

    const body = await readLimitedJson(req, 2 * 1024, updateIncidentSchema);
    const incident = await prisma.adminProviderIncident.findUnique({
      where: { id: body.incidentId },
    });
    if (!incident) {
      return NextResponse.json({ error: "Incident not found." }, { status: 404 });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const resolved = await tx.adminProviderIncident.update({
        where: { id: incident.id },
        data: {
          status: "resolved",
          resolvedAt: new Date(),
          resolvedById: session.user.id,
          resolvedByEmail: session.user.email || null,
        },
      });
      const previousStates = previousModelStatesSchema.safeParse(
        incident.previousModelStates
      );
      if (previousStates.success) {
        for (const state of previousStates.data) {
          await tx.modelRegistryEntry.updateMany({
            where: {
              id: state.id,
              operationalReason: { startsWith: `[incident:${incident.id}]` },
            },
            data: {
              status: state.status,
              enabled: state.enabled,
              operationalReason: state.operationalReason,
              userVisibleNote: state.userVisibleNote,
              updatedById: session.user.id,
              updatedByEmail: session.user.email || null,
            },
          });
        }
      }
      return resolved;
    });

    await writeAdminAuditLog({
      session,
      request: req,
      action: "incident.resolved",
      targetType: incident.modelId ? "Model" : "Provider",
      targetId: incident.modelId || incident.provider,
      summary: `Resolved incident: ${incident.title}.`,
      metadata: {
        incidentId: incident.id,
        provider: incident.provider,
        modelId: incident.modelId,
      },
    });

    return NextResponse.json({ success: true, incident: updated });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to resolve admin incident:", error);
    return NextResponse.json(
      { error: "Failed to resolve incident." },
      { status: 500 }
    );
  }
}
