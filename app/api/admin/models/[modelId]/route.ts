export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import type { Session } from "next-auth";
import { authOptions } from "@/lib/auth";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { prisma } from "@/lib/prisma";
import { updateModelRegistrySchema, registryInputToData, validateProviderConfiguration } from "@/lib/modelRegistryAdmin";
import { ensureModelRegistrySeeded, registryRowToModel } from "@/lib/modelRegistry";
import { APP_DEFAULTS } from "@/lib/appDefaults";

type ModelRouteContext = { params: Promise<{ modelId: string }> };

const actor = (session: Session | null) => ({
  id: session?.user?.id,
  email: session?.user?.email,
});

export async function PATCH(
  req: Request,
  context: ModelRouteContext
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-model-registry-write", { minute: 20, day: 300 });
    const { modelId } = await context.params;
    const body = await readLimitedJson(req, 24 * 1024, updateModelRegistrySchema);
    await ensureModelRegistrySeeded();
    if (
      modelId === APP_DEFAULTS.defaultModelId &&
      (body.status !== "enabled" || body.minimumPlan !== "Guest")
    ) {
      return NextResponse.json(
        { error: "The application fallback model must remain enabled and Guest-accessible." },
        { status: 409 }
      );
    }
    const guestDefault = await prisma.appSetting.findUnique({
      where: { key: "guestDefaultModelId" },
      select: { value: true },
    });
    if (
      guestDefault?.value === modelId &&
      (body.status !== "enabled" ||
        body.minimumPlan !== "Guest" ||
        body.usageClass !== "standard")
    ) {
      return NextResponse.json(
        { error: "Change the Guest default model in Platform Settings before disabling or restricting this model." },
        { status: 409 }
      );
    }
    if (body.replacementModelId) {
      if (body.replacementModelId === modelId) {
        return NextResponse.json({ error: "A model cannot replace itself." }, { status: 400 });
      }
      const replacement = await prisma.modelRegistryEntry.findUnique({ where: { id: body.replacementModelId } });
      if (!replacement || replacement.catalogDeleted) {
        return NextResponse.json({ error: "Replacement model does not exist in the active registry." }, { status: 400 });
      }
    }
    const row = await prisma.modelRegistryEntry.update({
      where: { id: modelId },
      data: registryInputToData(body, actor(session)),
    });
    await writeAdminAuditLog({
      session,
      request: req,
      action: "model.registry.updated",
      targetType: "Model",
      targetId: modelId,
      summary: `Updated model registry entry ${modelId}.`,
      metadata: { provider: body.provider, apiModel: body.apiModel, status: body.status, creditWeight: body.creditWeight },
    });
    const model = registryRowToModel(row);
    return NextResponse.json({ model: { ...model, environment: validateProviderConfiguration(model) } });
  } catch (error) {
    const response = apiSecurityResponse(error);
    if (response) return response;
    if (error && typeof error === "object" && "code" in error && error.code === "P2025") {
      return NextResponse.json({ error: "Model not found." }, { status: 404 });
    }
    console.error("Failed to update model registry entry:", error);
    return NextResponse.json({ error: "Failed to update model." }, { status: 500 });
  }
}

export async function DELETE(
  req: Request,
  context: ModelRouteContext
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-model-registry-delete", { minute: 10, day: 100 });
    const { modelId } = await context.params;
    await ensureModelRegistrySeeded();
    if (modelId === APP_DEFAULTS.defaultModelId) {
      return NextResponse.json(
        { error: "The application fallback model cannot be removed from the catalogue." },
        { status: 409 }
      );
    }
    const guestDefault = await prisma.appSetting.findUnique({
      where: { key: "guestDefaultModelId" },
      select: { value: true },
    });
    if (guestDefault?.value === modelId) {
      return NextResponse.json(
        { error: "Change the Guest default model in Platform Settings before removing this model." },
        { status: 409 }
      );
    }
    const row = await prisma.modelRegistryEntry.update({
      where: { id: modelId },
      data: {
        catalogDeleted: true,
        publiclyListed: false,
        enabled: false,
        status: "disabled",
        operationalReason: "Removed from the active catalogue.",
        userVisibleNote: null,
        updatedById: session.user.id,
        updatedByEmail: session.user.email || null,
      },
    });
    await writeAdminAuditLog({
      session,
      request: req,
      action: "model.registry.archived",
      targetType: "Model",
      targetId: modelId,
      summary: `Removed model ${modelId} from the active catalogue while preserving historical resolution.`,
    });
    return NextResponse.json({ model: registryRowToModel(row) });
  } catch (error) {
    const response = apiSecurityResponse(error);
    if (response) return response;
    if (error && typeof error === "object" && "code" in error && error.code === "P2025") {
      return NextResponse.json({ error: "Model not found." }, { status: 404 });
    }
    console.error("Failed to archive model registry entry:", error);
    return NextResponse.json({ error: "Failed to remove model from catalogue." }, { status: 500 });
  }
}
