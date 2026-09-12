export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { invalidatePublicSnapshot } from "@/lib/publicSnapshotCache";
import { prisma } from "@/lib/prisma";
import { createModelRegistrySchema, registryInputToData, validateProviderConfiguration } from "@/lib/modelRegistryAdmin";
import {
  ensureModelRegistrySeeded,
  getModelRegistrySecurityFindings,
  getRuntimeModels,
  registryRowToModel,
} from "@/lib/modelRegistry";
import { Prisma } from "@prisma/client";
import { adoptionTransitionPath } from "@/lib/modelLifecycleWorkItemCore";
import { transitionWorkItems } from "@/lib/modelLifecycleWorkItems";
import {
  ADOPTION_PENDING_VALIDATIONS,
  adoptionPreflightRefusal,
} from "@/lib/modelAdoptionDraft";
import { PROMPT_CACHE_WRITE_5M_PRICE_MULTIPLIER } from "@/lib/modelPricing";
import type { AiModel } from "@/lib/models";

const adminModel = (model: Awaited<ReturnType<typeof getRuntimeModels>>[number]) => ({
  ...model,
  environment: validateProviderConfiguration(model),
});

/**
 * A queue transition the state machine refused, raised so the surrounding
 * transaction rolls the registry row back with it.
 *
 * Adoption is one act. A model created while its work item stayed undecided is
 * the half-applied state the queue was built to make impossible, so a refusal
 * has to undo the create rather than be reported beside it.
 */
class AdoptionRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdoptionRefused";
  }
}

const WORK_ITEM_ADOPTION_SELECT = {
  id: true,
  status: true,
  action: true,
  provider: true,
  apiModel: true,
  modelId: true,
  evidence: true,
} as const;

/** Every provider a scan has seen serving this model, from the item's sightings. */
const observedProvidersOf = (
  workItem: { provider: string; evidence: Prisma.JsonValue | null } | null
) => {
  if (!workItem) return [];
  const evidence =
    workItem.evidence && typeof workItem.evidence === "object" && !Array.isArray(workItem.evidence)
      ? (workItem.evidence as Record<string, unknown>)
      : null;
  const observedVia = Array.isArray(evidence?.observedVia) ? evidence.observedVia : [];
  const providers = observedVia
    .map((entry) =>
      entry && typeof entry === "object" && typeof (entry as { provider?: unknown }).provider === "string"
        ? ((entry as { provider: string }).provider)
        : null
    )
    .filter((provider): provider is string => Boolean(provider));
  return providers.length ? providers : [workItem.provider];
};

/**
 * Everything the adoption rules need, read from the database in one place.
 *
 * Gathered here so the preflight before the transaction and the one inside it
 * ask exactly the same question of exactly the same shape. The two diverging is
 * how a check passes at the door and fails at the till.
 */
const readAdoptionContext = async (
  workItemId: string,
  body: Parameters<typeof adoptionPreflightRefusal>[0]["body"],
  workItemOverride?: {
    id: string;
    status: string;
    action: string;
    provider: string;
    apiModel: string;
    modelId: string | null;
    evidence: Prisma.JsonValue | null;
  } | null
): Promise<Parameters<typeof adoptionPreflightRefusal>[0]> => {
  const workItem =
    workItemOverride !== undefined
      ? workItemOverride
      : await prisma.modelLifecycleWorkItem.findUnique({
          where: { id: workItemId },
          select: WORK_ITEM_ADOPTION_SELECT,
        });
  const providerPairRegistered = workItem
    ? Boolean(
        await prisma.modelRegistryEntry.findFirst({
          where: { provider: body.provider, apiModel: body.apiModel, catalogDeleted: false },
          select: { id: true },
        })
      )
    : false;
  return {
    workItem,
    body,
    observedProviders: observedProvidersOf(workItem),
    providerPairRegistered,
    // The limit the runtime actually enforces, not the one this module would
    // assume. A deployment that raised it is shown a floor that covers it.
    worstCaseInputTokens: chatUserMaxInputTokens(),
    inputPriceMultiplier:
      body.provider === "anthropic" ? PROMPT_CACHE_WRITE_5M_PRICE_MULTIPLIER : 1,
  };
};

/**
 * The largest prompt this deployment accepts.
 *
 * Read here rather than imported from the chat budget, which computes it inside
 * a per-request function alongside the guest limit. The default matches that
 * code and the derivation comment in `lib/chatCostGuardrails.ts`.
 */
const chatUserMaxInputTokens = () => {
  const configured = Number.parseInt(process.env.CHAT_USER_MAX_INPUT_TOKENS ?? "", 10);
  return Number.isInteger(configured) && configured > 0 ? configured : 128_000;
};

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
    const [models, securityFindings] = await Promise.all([
      getRuntimeModels({ includeCatalogDeleted: true }),
      getModelRegistrySecurityFindings(),
    ]);
    return NextResponse.json({
      models: models.map(adminModel),
      securityFindings,
    });
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

    // Adoption: this create is answering a discovered-model work item, and the
    // queue has to learn about it in the same breath. Two writes with a gap
    // between them is how the registry ends up holding a model the queue still
    // lists as undecided -- which is the state this whole pipeline exists to
    // end. The work item id arrives as a query parameter so the body stays the
    // strict registry contract every other caller sends.
    const url = new URL(req.url);
    const workItemId = url.searchParams.get("workItemId")?.trim() || null;
    // Why the operator is adopting, in their words. The state machine records a
    // reason on the `approved` hop and that record is the only thing a later
    // reader has: the registry row can be edited afterwards, and the event
    // history holds no snapshot of the form. A sentence composed by this route
    // would repeat what was done and answer nothing.
    const adoptionReason = url.searchParams.get("reason")?.trim() || "";
    if (workItemId && adoptionReason.length < 4) {
      return NextResponse.json(
        { error: "An adoption needs the reason it is being made." },
        { status: 400 }
      );
    }

    const adoptionContext = workItemId ? await readAdoptionContext(workItemId, body) : null;
    const adoptionRefusal = adoptionContext
      ? adoptionPreflightRefusal(adoptionContext)
      : null;
    if (adoptionRefusal) {
      return NextResponse.json({ error: adoptionRefusal.message }, { status: adoptionRefusal.status });
    }

    await writeAdminAuditLog({
      session,
      request: req,
      action: "model.registry.create_started",
      targetType: "Model",
      targetId: id,
      summary: `Started model registry creation for ${id}.`,
      metadata: { provider: body.provider, status: body.status, workItemId },
    });
    let adoptedTo: string | null = null;
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.modelRegistryEntry.create({
        data: {
          id,
          ...registryInputToData(fields, { id: session.user.id, email: session.user.email }),
        },
      });
      if (!workItemId) return created;

      // Read again inside the transaction. The preflight above answers the
      // operator quickly; this is the read that decides, and it is the one that
      // cannot be overtaken by a second adoption of the same item between the
      // check and the write.
      const locked = await tx.$queryRaw<
        Array<{
          id: string;
          status: string;
          action: string;
          provider: string;
          apiModel: string;
          modelId: string | null;
          evidence: Prisma.JsonValue | null;
        }>
      >(Prisma.sql`
        SELECT "id", "status", "action", "provider", "apiModel", "modelId", "evidence"
        FROM "ModelLifecycleWorkItem"
        WHERE "id" = ${workItemId}
        FOR UPDATE
      `);
      const workItem = locked[0] ?? null;
      const refusal = adoptionPreflightRefusal(
        await readAdoptionContext(workItemId, body, workItem)
      );
      if (refusal) throw new AdoptionRefused(refusal.message);

      const path =
        adoptionTransitionPath(
          workItem!.status as Parameters<typeof adoptionTransitionPath>[0]
        ) ?? [];
      for (const to of path) {
        const result = await transitionWorkItems(
          {
            workItemIds: [workItemId],
            to,
            actorEmail: session.user.email ?? session.user.id,
            note: `Adopted into the registry as ${id}. ${adoptionReason}`,
            ...(to === "approved"
              ? { decision: { decision: "approve" as const, reason: adoptionReason } }
              : {}),
          },
          { tx }
        );
        if (!result.ok) throw new AdoptionRefused(result.refusal.message);
      }
      adoptedTo = path.at(-1) ?? workItem!.status;
      await tx.modelLifecycleWorkItem.update({
        where: { id: workItemId },
        data: {
          modelId: id,
          // What the item still owes before it may ship. Written here because
          // `validation_pending` is only a claim without it: the rollout gate
          // reads this list, and an item that arrives with it empty walks
          // straight through the check that exists to hold it.
          pendingValidations: ADOPTION_PENDING_VALIDATIONS,
        },
      });
      return created;
    });
    await writeAdminAuditLog({
      session,
      request: req,
      action: "model.registry.created",
      targetType: "Model",
      targetId: id,
      summary: workItemId
        ? `Created model registry entry ${id} by adopting work item ${workItemId}.`
        : `Created model registry entry ${id}.`,
      metadata: {
        provider: body.provider,
        apiModel: body.apiModel,
        minimumPlan: body.minimumPlan,
        creditWeight: body.creditWeight,
        ...(workItemId
          ? {
              workItemId,
              workItemStatus: adoptedTo,
              adoptionReason,
              pendingValidations: ADOPTION_PENDING_VALIDATIONS,
            }
          : {}),
      },
    });
    // SEC-012. `/api/models/catalog` answers from a shared snapshot, so a
    // registry write has to drop it or the console shows the model it just
    // created as absent until the TTL lapses.
    invalidatePublicSnapshot("model-catalog");
    const model = registryRowToModel(row);
    return NextResponse.json({ model: adminModel(model) }, { status: 201 });
  } catch (error) {
    const response = apiSecurityResponse(error);
    if (response) return response;
    if (error instanceof AdoptionRefused) {
      // The registry row went back with it. Reporting the queue's own words
      // rather than a generic failure: the refusal names which rule stopped it.
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
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
      apiBaseUrl: undefined,
      apiKeyEnvName: undefined,
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
