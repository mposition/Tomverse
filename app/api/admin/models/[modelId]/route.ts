export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import type { Session } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  adminApprovalErrorResponse,
  runWithAdminApproval,
} from "@/lib/adminApproval";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { invalidatePublicSnapshot } from "@/lib/publicSnapshotCache";
import { prisma } from "@/lib/prisma";
import {
  modelRegistryWriteFreshness,
  registryInputToData,
  updateModelRegistrySchema,
  validateProviderConfiguration,
} from "@/lib/modelRegistryAdmin";
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

    /**
     * Refuse a write based on a row that has moved since it was read.
     *
     * This handler writes the whole submitted body, so a save made from a
     * panel opened ten minutes ago silently reverts everything written in
     * between. The other writer is not usually a second operator -- it is
     * `STATIC_CATALOG_RECONCILIATION_MODEL_IDS`, which writes `maxOutputTokens`
     * and `creditWeight` onto existing rows. AGENTS.md records what that costs:
     * a fossilised output cap is not a stale label, it is a ceiling on every
     * answer the model gives, and `claude-sonnet-5` was found capped at 4,096
     * against a profile of 128,000 on 2026-08-23. Reverting the fix that
     * removed such a cap is exactly the write this refuses.
     *
     * `readAt` is the instant the server stamped on the list the panel is
     * showing, echoed back as a query parameter -- the body schema is
     * `.strict()` and the timestamp is not part of the model. Absent, nothing
     * is checked: a caller that never read the row cannot be stale, and the
     * older clients that predate this parameter keep working.
     */
    const readAt = new URL(req.url).searchParams.get("readAt");
    if (readAt) {
      const current = await prisma.modelRegistryEntry.findUnique({
        where: { id: modelId },
        select: { updatedAt: true },
      });
      const freshness = modelRegistryWriteFreshness({
        readAt,
        updatedAt: current ? current.updatedAt : null,
      });
      if (freshness.verdict === "unreadable") {
        return NextResponse.json(
          { error: "readAt is not a timestamp.", code: "MODEL_REGISTRY_READ_AT_INVALID" },
          { status: 400 }
        );
      }
      if (freshness.verdict === "stale") {
        return NextResponse.json(
          {
            error:
              "This model was changed after the form was loaded, so saving would overwrite that change. Reload the registry and re-apply the edit.",
            code: "MODEL_REGISTRY_STALE_READ",
            changedAt: freshness.changedAt.toISOString(),
          },
          { status: 409 }
        );
      }
    }
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
    if (body.status !== "disabled") {
      await writeAdminAuditLog({
        session,
        request: req,
        action: "model.registry.update_started",
        targetType: "Model",
        targetId: modelId,
        summary: `Started model registry update for ${modelId}.`,
        metadata: { provider: body.provider, status: body.status },
      });
    }
    const updateModel = () =>
      prisma.modelRegistryEntry.update({
        where: { id: modelId },
        data: registryInputToData(body, actor(session)),
      });
    const row =
      body.status === "disabled"
        ? await runWithAdminApproval(
            {
              session,
              request: req,
              action: "model.disable",
              targetType: "Model",
              targetId: modelId,
              payload: body,
              reason: body.operationalReason || `Disable model ${modelId}.`,
            },
            updateModel
          )
        : await updateModel();
    await writeAdminAuditLog({
      session,
      request: req,
      action: "model.registry.updated",
      targetType: "Model",
      targetId: modelId,
      summary: `Updated model registry entry ${modelId}.`,
      metadata: { provider: body.provider, apiModel: body.apiModel, status: body.status, creditWeight: body.creditWeight },
    });
    // SEC-012. `/api/models/catalog` answers from a shared snapshot, so a
    // registry write has to drop it or the change is invisible until the TTL
    // lapses.
    invalidatePublicSnapshot("model-catalog");
    const model = registryRowToModel(row);
    return NextResponse.json({
      model: { ...model, environment: validateProviderConfiguration(model) },
      // Otherwise the operator's own successful save would make their next one
      // stale, and the guard would refuse a conflict with themselves.
      readAt: row.updatedAt.toISOString(),
    });
  } catch (error) {
    const approvalResponse = adminApprovalErrorResponse(error);
    if (approvalResponse) return approvalResponse;
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
    const row = await runWithAdminApproval(
      {
        session,
        request: req,
        action: "model.archive",
        targetType: "Model",
        targetId: modelId,
        payload: { catalogDeleted: true },
        reason: `Remove model ${modelId} from the active catalogue.`,
      },
      () =>
        prisma.modelRegistryEntry.update({
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
        })
    );
    await writeAdminAuditLog({
      session,
      request: req,
      action: "model.registry.archived",
      targetType: "Model",
      targetId: modelId,
      summary: `Removed model ${modelId} from the active catalogue while preserving historical resolution.`,
    });
    invalidatePublicSnapshot("model-catalog");
    return NextResponse.json({ model: registryRowToModel(row) });
  } catch (error) {
    const approvalResponse = adminApprovalErrorResponse(error);
    if (approvalResponse) return approvalResponse;
    const response = apiSecurityResponse(error);
    if (response) return response;
    if (error && typeof error === "object" && "code" in error && error.code === "P2025") {
      return NextResponse.json({ error: "Model not found." }, { status: 404 });
    }
    console.error("Failed to archive model registry entry:", error);
    return NextResponse.json({ error: "Failed to remove model from catalogue." }, { status: 500 });
  }
}
