export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";

import { authOptions } from "@/lib/auth";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { prisma } from "@/lib/prisma";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import {
  ADOPTION_USAGE_CLASSES,
  buildAdoptionDraft,
  registryIdFromApiModel,
} from "@/lib/modelAdoptionDraft";
import { modelProductSurface } from "@/lib/modelLifecycleTriage";
import { chatUserMaxInputTokens } from "@/lib/chatInputLimits";
import { getModelPricingProfile, resolveModelPricing } from "@/lib/modelPricing";
import { docParseFromStored, docSourcesFromStored } from "@/lib/providerModelDocsCore";
import { observedPairsOf } from "@/lib/modelLifecycleWorkItemCore";
import type { AiModel } from "@/lib/models";

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

    const requestUrl = new URL(req.url);
    const workItemId = requestUrl.searchParams.get("workItemId")?.trim();
    if (!workItemId) {
      return NextResponse.json({ error: "workItemId is required." }, { status: 400 });
    }
    // The registry id the operator currently has in the form, when it is no
    // longer the one this draft proposed.
    //
    // The proposed id comes from the provider's own identifier, and a model
    // whose price profile is registered under a different canonical id --
    // `claude-haiku-4-5` for an api model of `claude-haiku-4-5-20251001` -- only
    // matches once the operator corrects it. Without re-resolving, the panel
    // keeps the first answer: it tells them to type a price they are actually
    // inheriting, and refuses to save the inheritance.
    const requestedModelId = requestUrl.searchParams.get("modelId")?.trim() || null;
    // The (provider, api model) pair currently in the form, when the operator
    // has changed it. Every provider-dependent fact in the draft -- the scan's
    // observation, the documentation evidence, and the price and cap copied
    // from them -- belongs to one exact pair, so a draft for a different pair
    // has to be answered for that pair, not for the one the item was filed
    // under.
    const requestedProvider = requestUrl.searchParams.get("provider")?.trim() || null;
    const requestedApiModel = requestUrl.searchParams.get("apiModel")?.trim() || null;

    const workItem = await prisma.modelLifecycleWorkItem.findUnique({
      where: { id: workItemId },
      select: { id: true, provider: true, apiModel: true, action: true, status: true, evidence: true },
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

    // Only a pair the scan actually saw has an observation or evidence worth
    // reading. Any other pair gets a draft with nothing provider-dependent
    // filled in -- and the adoption preflight refuses to save it anyway.
    const pair =
      requestedProvider && requestedApiModel
        ? { provider: requestedProvider, apiModel: requestedApiModel }
        : { provider: workItem.provider, apiModel: workItem.apiModel };
    const pairObserved = observedPairsOf(workItem).some(
      (sighting) => sighting.provider === pair.provider && sighting.apiModel === pair.apiModel
    );
    const [observation, taken, docRow] = await Promise.all([
      pairObserved
        ? prisma.providerModelCatalogEntry.findUnique({
            where: { provider_apiModel: pair },
            select: { displayName: true, metadata: true },
          })
        : null,
      prisma.modelRegistryEntry.findMany({ select: { id: true } }),
      // What the daily documentation read found for the same exact pair. Read,
      // never fetched here: the form must not depend on a documentation host
      // answering while somebody has it open.
      pairObserved
        ? prisma.providerModelDocEvidence.findUnique({
            where: { provider_apiModel: pair },
            select: {
              status: true,
              parserVersion: true,
              fields: true,
              problems: true,
              sources: true,
              fetchedAt: true,
            },
          })
        : null,
    ]);
    // A row whose sources are not the shape this code writes is not evidence:
    // the operator could not open what the numbers came from.
    const docSources = docRow ? docSourcesFromStored(docRow.sources) : null;

    const metadata =
      observation?.metadata &&
      typeof observation.metadata === "object" &&
      !Array.isArray(observation.metadata)
        ? (observation.metadata as Record<string, unknown>)
        : null;

    const proposedId = registryIdFromApiModel(pair.apiModel, taken.map((row) => row.id));
    // What the price is being judged for: the id in the form if the operator has
    // changed it, the proposed one otherwise.
    const pricedModelId = requestedModelId || proposedId;
    // A profile covers this adoption only when it is for this exact pair. The
    // runtime resolves a profile by registry id alone, so a profile under the
    // id for another provider or api model is not an inheritance, it is a
    // mismatch the save refuses.
    const profileFor = (id: string) => {
      const profile = getModelPricingProfile(id);
      if (!profile) return { covers: false, other: null };
      const covers = profile.provider === pair.provider && profile.apiModelId === pair.apiModel;
      return {
        covers,
        other: covers ? null : { provider: profile.provider, apiModelId: profile.apiModelId },
      };
    };
    const pricedProfile = profileFor(pricedModelId);
    const draft = buildAdoptionDraft({
      provider: pair.provider,
      apiModel: pair.apiModel,
      hasPricingProfile: pricedProfile.covers,
      profileForOtherPair: pricedProfile.other,
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
              effortLevels:
                typeof metadata.effortLevels === "string"
                  ? metadata.effortLevels
                  : null,
              pdfInput: typeof metadata.pdfInput === "boolean" ? metadata.pdfInput : null,
            }
          : null,
      },
      // Every id, including soft-deleted rows: the unique key does not care
      // about `catalogDeleted`, so a suggestion that collides with a retired
      // model is a 409 the operator meets after filling the whole form in.
      takenIds: taken.map((row) => row.id),
      worstCaseInputTokens: chatUserMaxInputTokens(),
      registryModelId: pricedModelId,
      docEvidence:
        docRow && docSources
          ? {
              parse: docParseFromStored(docRow),
              sources: docSources,
              fetchedAt: docRow.fetchedAt,
            }
          : null,
    });

    const draftModelId = requestedModelId || draft.fields.id;
    return NextResponse.json({
      // What the two token columns resolve to at request time if they are left
      // empty, for every sale class the operator might pick. Resolved by the
      // same function a live request uses -- profile, per-model environment
      // override, then the class fallback -- so the greyed-in value the panel
      // shows is the value the model will actually run with, and nothing here
      // restates that chain for it to drift from.
      effectiveTokenLimits: {
        modelId: draftModelId,
        byClass: Object.fromEntries(
          ADOPTION_USAGE_CLASSES.map((usageClass) => {
            const base = {
              id: draftModelId,
              apiModel: pair.apiModel,
              provider: pair.provider as AiModel["provider"],
              usageClass,
            };
            const resolved = resolveModelPricing(base);
            // The reservation before the resolver clamps it to the cap. The
            // clamp is against whatever cap is in force, and the operator may
            // be about to type a different one: a reservation already cut to
            // the default cap cannot be un-cut in the panel, so a per-model
            // override of 8,192 under a default cap of 4,096 would be shown as
            // 4,096 and saved as 8,192. Resolved through the same function with
            // the cap lifted out of the way, so the chain is still not restated.
            const uncapped = resolveModelPricing({
              ...base,
              maxOutputTokens: Number.MAX_SAFE_INTEGER,
            });
            return [
              usageClass,
              {
                maxOutputTokens: resolved.maxOutputTokens,
                reservationBeforeCap: uncapped.reservationOutputTokens,
              },
            ];
          })
        ),
      },
      workItem: { id: workItem.id, status: workItem.status },
      // The prompt size this deployment actually accepts, so the panel's credit
      // floor prices the worst turn this installation can be sent rather than
      // the one the module assumes.
      worstCaseInputTokens: chatUserMaxInputTokens(),
      // What this model would bill at with its price columns left null, when a
      // profile already covers it. The panel computes the same floor the save
      // will be judged by; without this it reads empty price fields as "no
      // price" and refuses to save an adoption the server would accept.
      profilePrice: profileFor(draftModelId).covers
        ? (() => {
            const resolved = resolveModelPricing(
              {
                id: draftModelId,
                apiModel: pair.apiModel,
                provider: pair.provider as AiModel["provider"],
                // The class is still the operator's to choose; it only selects
                // a fallback here, and a profile exists or this branch is not
                // reached.
                usageClass: "premium",
              },
              { estimatedPromptTokens: chatUserMaxInputTokens() }
            );
            return {
              // Which id this price belongs to. The registry id is editable and
              // the save resolves the profile from whatever id is submitted, so
              // a price resolved for the proposed one must not keep standing in
              // for a different one.
              modelId: draftModelId,
              inputUsdPerMillionTokens: resolved.inputUsdPerMillionTokens,
              outputUsdPerMillionTokens: resolved.outputUsdPerMillionTokens,
              maxOutputTokens: resolved.maxOutputTokens,
            };
          })()
        : null,
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
