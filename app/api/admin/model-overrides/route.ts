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
import { getRuntimeModel, getRuntimeModels } from "@/lib/modelRegistry";
import { getModelOverrides } from "@/lib/modelOverrides";
import { prisma } from "@/lib/prisma";

const updateModelOverrideSchema = z
  .object({
    modelId: z.string().trim().min(1).max(120),
    status: z.enum(["available", "limited", "disabled", "coming-soon"]),
    reason: z.string().trim().max(500).optional(),
    visibleNote: z.string().trim().max(500).optional(),
  })
  .strict();

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-model-overrides-read", {
      minute: 40,
      day: 800,
    });

    return NextResponse.json({
      models: await getRuntimeModels({ includeCatalogDeleted: true }),
      overrides: await getModelOverrides(),
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to load model overrides:", error);
    return NextResponse.json(
      { error: "Failed to load model overrides." },
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

    await consumeApiRateLimit(req, session.user.id, "admin-model-overrides-write", {
      minute: 20,
      day: 300,
    });

    const body = await readLimitedJson(req, 4 * 1024, updateModelOverrideSchema);
    const model = await getRuntimeModel(body.modelId);
    if (!model || model.catalogDeleted) {
      return NextResponse.json({ error: "Unknown model." }, { status: 400 });
    }
    const reason = body.reason?.trim() || null;
    const visibleNote = body.visibleNote?.trim() || null;

    if (body.status === "available" && !reason && !visibleNote) {
      await prisma.modelOverride.deleteMany({
        where: { modelId: body.modelId },
      });
    } else {
      await prisma.modelOverride.upsert({
        where: { modelId: body.modelId },
        create: {
          modelId: body.modelId,
          status: body.status,
          reason,
          visibleNote,
          updatedById: session.user.id,
          updatedByEmail: session.user.email || null,
        },
        update: {
          status: body.status,
          reason,
          visibleNote,
          updatedById: session.user.id,
          updatedByEmail: session.user.email || null,
        },
      });
    }

    await writeAdminAuditLog({
      session,
      request: req,
      action: "model.override.updated",
      targetType: "Model",
      targetId: body.modelId,
      summary: `Set model ${body.modelId} to ${body.status}.`,
      metadata: {
        status: body.status,
        reason,
        visibleNote,
      },
    });

    return NextResponse.json({
      success: true,
      overrides: await getModelOverrides(),
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to update model override:", error);
    return NextResponse.json(
      { error: "Failed to update model override." },
      { status: 500 }
    );
  }
}
