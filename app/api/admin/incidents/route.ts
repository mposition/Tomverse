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
import { AVAILABLE_MODELS, type AiProvider } from "@/lib/models";
import { PROVIDER_DISPLAY_NAMES } from "@/lib/providerMonitoring";
import { prisma } from "@/lib/prisma";

const providers = Object.keys(PROVIDER_DISPLAY_NAMES) as [AiProvider, ...AiProvider[]];
const modelIds: ReadonlySet<string> = new Set<string>(
  AVAILABLE_MODELS.map((model) => model.id)
);

const createIncidentSchema = z
  .object({
    provider: z.enum(providers).optional(),
    modelId: z
      .string()
      .trim()
      .max(120)
      .optional()
      .refine((value) => !value || modelIds.has(value), {
        message: "Unknown model.",
      }),
    status: z.enum(["limited", "disabled"]),
    title: z.string().trim().min(3).max(120),
    message: z.string().trim().max(500).optional(),
    fallbackModelIds: z
      .array(
        z.string().trim().refine((value) => modelIds.has(value), {
          message: "Unknown fallback model.",
        })
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
    const targetModels = body.modelId
      ? AVAILABLE_MODELS.filter((model) => model.id === body.modelId)
      : AVAILABLE_MODELS.filter((model) => model.provider === body.provider);

    const incident = await prisma.$transaction(async (tx) => {
      const created = await tx.adminProviderIncident.create({
        data: {
          provider: body.provider || null,
          modelId: body.modelId || null,
          status: body.status,
          title: body.title,
          message: body.message?.trim() || null,
          fallbackModelIds: JSON.stringify(body.fallbackModelIds || []),
          createdById: session.user.id,
          createdByEmail: session.user.email || null,
        },
      });

      for (const model of targetModels) {
        await tx.modelOverride.upsert({
          where: { modelId: model.id },
          create: {
            modelId: model.id,
            status: body.status,
            reason: incidentOverrideReason(created.id, body.title),
            visibleNote: incidentOverrideNote(body.status, body.message || null),
            updatedById: session.user.id,
            updatedByEmail: session.user.email || null,
          },
          update: {
            status: body.status,
            reason: incidentOverrideReason(created.id, body.title),
            visibleNote: incidentOverrideNote(body.status, body.message || null),
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
      await tx.modelOverride.deleteMany({
        where: {
          reason: { startsWith: `[incident:${incident.id}]` },
        },
      });
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
