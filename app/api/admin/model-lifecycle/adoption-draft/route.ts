export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";

import { authOptions } from "@/lib/auth";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { prisma } from "@/lib/prisma";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { buildAdoptionDraft } from "@/lib/modelAdoptionDraft";
import { modelProductSurface } from "@/lib/modelLifecycleTriage";

/**
 * The registry form, prefilled from what this morning's scan already knows
 * about a queued model.
 *
 * Read-only and side-effect free: it proposes, and the operator's save is what
 * decides anything. Kept apart from the queue's own GET because that response
 * is a list served to a browser on every panel load, and a draft is one item's
 * worth of detail that only matters when somebody clicks adopt.
 *
 * The observation row is read by (provider, apiModel) -- the exact pair the
 * work item was filed under -- rather than by the collapsed family, because
 * what goes into the registry is the identifier a request will actually carry.
 */
export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-model-adoption-draft", {
      minute: 30,
      day: 500,
    });

    const workItemId = new URL(req.url).searchParams.get("workItemId")?.trim();
    if (!workItemId) {
      return NextResponse.json({ error: "workItemId is required." }, { status: 400 });
    }

    const workItem = await prisma.modelLifecycleWorkItem.findUnique({
      where: { id: workItemId },
      select: { id: true, provider: true, apiModel: true, action: true, status: true },
    });
    if (!workItem) {
      return NextResponse.json({ error: "No such work item." }, { status: 404 });
    }
    // A retirement item is about a model the registry already serves. Offering
    // to create it would propose a duplicate of the row somebody is deciding
    // whether to switch off.
    if (workItem.action !== "add") {
      return NextResponse.json(
        { error: "Only a discovered model can be adopted into the registry." },
        { status: 409 }
      );
    }
    // The same boundary the create enforces, answered before a form is opened:
    // image generation models have their own ledger, and this registry's
    // `supportsImage` means image input.
    if (modelProductSurface(workItem.apiModel) !== "chat") {
      return NextResponse.json(
        {
          error:
            "Only chat models are adopted into this registry. Image generation models belong to the Image Studio ledger.",
        },
        { status: 409 }
      );
    }

    const [observation, taken] = await Promise.all([
      prisma.providerModelCatalogEntry.findUnique({
        where: {
          provider_apiModel: {
            provider: workItem.provider,
            apiModel: workItem.apiModel,
          },
        },
        select: { displayName: true, metadata: true },
      }),
      prisma.modelRegistryEntry.findMany({ select: { id: true } }),
    ]);

    const metadata =
      observation?.metadata &&
      typeof observation.metadata === "object" &&
      !Array.isArray(observation.metadata)
        ? (observation.metadata as Record<string, unknown>)
        : null;

    const draft = buildAdoptionDraft({
      provider: workItem.provider,
      apiModel: workItem.apiModel,
      observation: {
        displayName: observation?.displayName ?? null,
        metadata: metadata
          ? {
              contextLength:
                typeof metadata.contextLength === "number" ? metadata.contextLength : null,
              inputTokenLimit:
                typeof metadata.inputTokenLimit === "number" ? metadata.inputTokenLimit : null,
              outputTokenLimit:
                typeof metadata.outputTokenLimit === "number" ? metadata.outputTokenLimit : null,
              vision: typeof metadata.vision === "boolean" ? metadata.vision : null,
              thinking: typeof metadata.thinking === "boolean" ? metadata.thinking : null,
            }
          : null,
      },
      // Every id, including soft-deleted rows: the unique key does not care
      // about `catalogDeleted`, so a suggestion that collides with a retired
      // model is a 409 the operator meets after filling the whole form in.
      takenIds: taken.map((row) => row.id),
    });

    return NextResponse.json({
      workItem: { id: workItem.id, status: workItem.status },
      // Said out loud rather than left to the panel: the scan proves the
      // provider lists this model, and nothing more than that.
      observed: Boolean(observation),
      ...draft,
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    throw error;
  }
}
