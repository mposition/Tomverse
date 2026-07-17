export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { prisma } from "@/lib/prisma";
import { createModelRegistrySchema, registryInputToData, validateProviderConfiguration } from "@/lib/modelRegistryAdmin";
import { ensureModelRegistrySeeded, getRuntimeModels, registryRowToModel } from "@/lib/modelRegistry";
import type { AiModel } from "@/lib/models";

const adminModel = (model: Awaited<ReturnType<typeof getRuntimeModels>>[number]) => ({
  ...model,
  environment: validateProviderConfiguration(model),
});

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-model-registry-read", {
      minute: 60,
      day: 1500,
    });
    const models = await getRuntimeModels({ includeCatalogDeleted: true });
    return NextResponse.json({ models: models.map(adminModel) });
  } catch (error) {
    const response = apiSecurityResponse(error);
    if (response) return response;
    console.error("Failed to load model registry:", error);
    return NextResponse.json({ error: "Failed to load model registry." }, { status: 500 });
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
    await consumeApiRateLimit(req, session.user.id, "admin-model-registry-write", {
      minute: 20,
      day: 300,
    });
    const body = await readLimitedJson(req, 24 * 1024, createModelRegistrySchema);
    await ensureModelRegistrySeeded();
    if (body.replacementModelId) {
      const replacement = await prisma.modelRegistryEntry.findUnique({ where: { id: body.replacementModelId } });
      if (!replacement || replacement.catalogDeleted) {
        return NextResponse.json({ error: "Replacement model does not exist in the active registry." }, { status: 400 });
      }
    }
    const { id, ...fields } = body;
    const row = await prisma.modelRegistryEntry.create({
      data: {
        id,
        ...registryInputToData(fields, { id: session.user.id, email: session.user.email }),
      },
    });
    await writeAdminAuditLog({
      session,
      request: req,
      action: "model.registry.created",
      targetType: "Model",
      targetId: id,
      summary: `Created model registry entry ${id}.`,
      metadata: { provider: body.provider, apiModel: body.apiModel, minimumPlan: body.minimumPlan, creditWeight: body.creditWeight },
    });
    const model = registryRowToModel(row);
    return NextResponse.json({ model: adminModel(model) }, { status: 201 });
  } catch (error) {
    const response = apiSecurityResponse(error);
    if (response) return response;
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      return NextResponse.json({ error: "That model ID already exists." }, { status: 409 });
    }
    console.error("Failed to create model registry entry:", error);
    return NextResponse.json({ error: "Failed to create model." }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-model-registry-validate", {
      minute: 30,
      day: 500,
    });
    const body = await readLimitedJson(req, 24 * 1024, createModelRegistrySchema);
    const model: AiModel = {
      id: body.id,
      name: body.name,
      apiModel: body.apiModel,
      provider: body.provider,
      apiBaseUrl: body.apiBaseUrl,
      apiKeyEnvName: body.apiKeyEnvName,
      icon: body.icon,
      bestFor: body.bestFor,
      minimumPlan: body.minimumPlan,
      usageClass: body.usageClass,
      creditWeight: body.creditWeight,
      publiclyListed: body.publiclyListed,
      status: body.status,
      enabled: body.status === "enabled" || body.status === "limited",
      operationalReason: body.operationalReason || undefined,
      userVisibleNote: body.userVisibleNote || undefined,
      replacementModelId: body.replacementModelId || undefined,
      reasoning:
        body.reasoning && body.reasoning !== "none"
          ? body.reasoning
          : undefined,
      inputCapabilities:
        body.supportsImage || body.supportsNativePdf
          ? {
              image: body.supportsImage,
              nativePdf: body.supportsNativePdf,
              maxImages: body.maxImages || undefined,
              maxBase64ImagePayloadBytes:
                body.maxBase64ImagePayloadBytes || undefined,
            }
          : undefined,
    };
    return NextResponse.json({ validation: validateProviderConfiguration(model) });
  } catch (error) {
    const response = apiSecurityResponse(error);
    if (response) return response;
    console.error("Failed to validate model registry configuration:", error);
    return NextResponse.json({ error: "Model configuration is invalid." }, { status: 400 });
  }
}
