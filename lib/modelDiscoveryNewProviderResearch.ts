/**
 * Weekly new-provider research for the model discovery queue. One
 * search-capable model call per product (Chat, Image, Code) proposes providers
 * Tomverse is not connected to whose models rival what that product serves;
 * lib/modelDiscoveryNewProviderResearchCore.ts checks the answer and the
 * accepted proposals are filed as `add` items in the existing queue, where an
 * operator reads them on /admin/models?tab=discovery and excludes or acts.
 *
 * Off unless MODEL_DISCOVERY_RESEARCH_LLM_MODEL_ID names an enabled runtime
 * model of the Perplexity provider (the existing search adapter), so
 * configuring it is the owner's decision to spend. Runs from the daily
 * catalogue check, at most once per Brisbane ISO week: the week is claimed in
 * AppSetting before any call, so a failed or repeated run that week does not
 * call again. A fourth call (2026-11-14) asks for image models of providers
 * Tomverse is already connected to, which their model-list APIs never return.
 * At most four calls a week, `maxRetries: 0`, bounded output, token
 * counts logged and never content. Agent spending, not user credits: nothing
 * here touches a credit or a Chat budget.
 */
import "server-only";

import { generateText, jsonSchema, Output } from "ai";
import type { JSONSchema7 } from "@ai-sdk/provider";

import { getActiveAiModel } from "@/lib/activeAiModel";
import { listImageModels } from "@/lib/imageModelRegistry";
import { loadCodingCatalog } from "@/lib/modelCatalog";
import { OFFICIAL_SOURCE_HOSTS, isOfficialSourceUrl } from "@/lib/modelCatalogCore";
import {
  CONNECTED_IMAGE_RESEARCH_SYSTEM,
  NEW_PROVIDER_RESEARCH_PRODUCTS,
  NEW_PROVIDER_RESEARCH_SCHEMA,
  NEW_PROVIDER_RESEARCH_SYSTEM,
  acceptConnectedImageCandidates,
  acceptNewProviderCandidates,
  connectedImageResearchPrompt,
  brisbaneIsoWeek,
  newProviderResearchPrompt,
  type AcceptedNewProviderCandidate,
  type NewProviderResearchProduct,
  type NewProviderResearchRejection,
} from "@/lib/modelDiscoveryNewProviderResearchCore";
import { recordNewProviderResearchWorkItems } from "@/lib/modelLifecycleWorkItems";
import { getEnabledRuntimeModel, getRuntimeModels } from "@/lib/modelRegistry";
import { AI_PROVIDERS } from "@/lib/modelRegistryShared";
import { prisma } from "@/lib/prisma";
import { RUNTIME_IMAGE_PROVIDERS } from "@/lib/runtimeImageProviders";

export const MODEL_DISCOVERY_RESEARCH_LLM_MODEL_ENV = "MODEL_DISCOVERY_RESEARCH_LLM_MODEL_ID";
export const NEW_PROVIDER_RESEARCH_WEEK_SETTING_KEY = "modelDiscovery.newProviderResearchWeek";
const MAX_OUTPUT_TOKENS = 2_500;
/** All three calls run in parallel with the catalogue scan, inside the route's 180 s. */
const TIMEOUT_MS = 100_000;

export type NewProviderResearchSummary =
  | { status: "off" | "already_ran_this_week" }
  | {
      status: "ran";
      week: string;
      modelId: string;
      products: Array<{
        product: NewProviderResearchProduct;
        ok: boolean;
        proposed: number;
        accepted: number;
        rejected: NewProviderResearchRejection[];
      }>;
      connectedImage: {
        ok: boolean;
        proposed: number;
        accepted: number;
        rejected: NewProviderResearchRejection[];
      };
      created: Array<{ provider: string; apiModel: string; product: NewProviderResearchProduct }>;
    };

/** The configured search model, or null when the research is off. */
const researchModelFromEnv = async (env: Readonly<Record<string, string | undefined>>) => {
  const modelId = env[MODEL_DISCOVERY_RESEARCH_LLM_MODEL_ENV]?.trim();
  if (!modelId) return null;
  const model = await getEnabledRuntimeModel(modelId);
  // Only a model that searches the web as it answers: anything else would
  // cite pages it never read.
  if (!model || model.provider !== "perplexity") {
    console.warn(JSON.stringify({ event: "model_discovery_research_model_unavailable" }));
    return null;
  }
  return model;
};

/**
 * Claims this week before anything is spent. True only for the one run that
 * moved the stored week forward; a concurrent or later run of the same week
 * gets false.
 */
const claimWeek = async (week: string): Promise<boolean> => {
  const moved = await prisma.appSetting.updateMany({
    where: { key: NEW_PROVIDER_RESEARCH_WEEK_SETTING_KEY, NOT: { value: week } },
    data: { value: week },
  });
  if (moved.count === 1) return true;
  try {
    await prisma.appSetting.create({ data: { key: NEW_PROVIDER_RESEARCH_WEEK_SETTING_KEY, value: week } });
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") return false;
    throw error;
  }
};

const researchInputs = async () => {
  const [runtimeModels, codingCatalog, catalogueEntries, workItems] = await Promise.all([
    getRuntimeModels(),
    loadCodingCatalog().catch(() => []),
    prisma.providerModelCatalogEntry.findMany({ select: { provider: true, apiModel: true } }),
    prisma.modelLifecycleWorkItem.findMany({ select: { apiModel: true } }),
  ]);
  const imageModels = listImageModels();
  const servedChat = runtimeModels.filter((model) => model.enabled && !model.catalogDeleted);
  const servedImage = imageModels.filter((model) => model.disabledReason === null);
  const servedCode = codingCatalog.flatMap((entry) => (entry.enabled && entry.profile ? [entry.profile] : []));
  const connectedProviders = Array.from(
    new Set<string>([
      ...AI_PROVIDERS,
      ...RUNTIME_IMAGE_PROVIDERS,
      ...runtimeModels.map((model) => model.provider),
      ...imageModels.map((model) => model.provider),
      ...codingCatalog.flatMap((entry) => (entry.profile ? [entry.profile.provider] : [])),
      ...catalogueEntries.map((entry) => entry.provider),
    ])
  ).sort();
  const knownApiModels = [
    ...runtimeModels.map((model) => model.apiModel),
    ...imageModels.map((model) => model.apiModelId),
    ...codingCatalog.flatMap((entry) => [entry.modelId, ...(entry.profile ? [entry.profile.apiModelId] : [])]),
    ...catalogueEntries.map((entry) => entry.apiModel),
    ...workItems.map((item) => item.apiModel),
  ];
  const currentModels: Record<NewProviderResearchProduct, string[]> = {
    chat: servedChat.map((model) => model.name),
    image: servedImage.map((model) => model.name),
    code: servedCode.map((profile) => profile.name),
  };
  // Connected providers whose official documentation hosts are known: the
  // connected-image answer is accepted only when cited there.
  const imageResearchProviders = connectedProviders.filter((provider) =>
    Object.hasOwn(OFFICIAL_SOURCE_HOSTS, provider)
  );
  return { connectedProviders, knownApiModels, currentModels, imageResearchProviders };
};

export async function runNewProviderModelResearch(
  now: Date = new Date(),
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<NewProviderResearchSummary> {
  const model = await researchModelFromEnv(env);
  if (!model) return { status: "off" };
  const week = brisbaneIsoWeek(now);
  if (!(await claimWeek(week))) return { status: "already_ran_this_week" };

  const inputs = await researchInputs();
  const today = now.toISOString().slice(0, 10);
  const ask = async (label: string, system: string, prompt: string) => {
    const generated = await generateText({
      model: getActiveAiModel(model),
      system,
      prompt,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      output: Output.object({
        schema: jsonSchema(NEW_PROVIDER_RESEARCH_SCHEMA as unknown as JSONSchema7),
        name: "new_provider_research",
      }),
      providerOptions: { openai: { strictJsonSchema: true } },
    });
    const usage = generated.usage as { inputTokens?: number; outputTokens?: number } | undefined;
    console.info(
      JSON.stringify({
        event: "model_discovery_research_llm_call",
        product: label,
        modelId: model.id,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
      })
    );
    return generated.output as { candidates?: unknown[] } | undefined;
  };
  const connectedImageRun = (async () => {
    try {
      const answer = await ask(
        "connected_image",
        CONNECTED_IMAGE_RESEARCH_SYSTEM,
        connectedImageResearchPrompt({
          providers: inputs.imageResearchProviders,
          currentImageModels: inputs.currentModels.image,
          knownApiModels: inputs.knownApiModels,
          today,
        })
      );
      const checked = acceptConnectedImageCandidates({
        answer,
        connectedProviders: inputs.imageResearchProviders,
        knownApiModels: inputs.knownApiModels,
        isOfficial: isOfficialSourceUrl,
      });
      return { ok: true, proposed: answer?.candidates?.length ?? 0, ...checked };
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "model_discovery_research_llm_failed",
          product: "connected_image",
          modelId: model.id,
          error: error instanceof Error ? error.name : "unknown",
        })
      );
      return { ok: false, proposed: 0, accepted: [] as AcceptedNewProviderCandidate[], rejected: [] };
    }
  })();
  const results = await Promise.all(
    NEW_PROVIDER_RESEARCH_PRODUCTS.map(async (product) => {
      try {
        const answer = await ask(
          product,
          NEW_PROVIDER_RESEARCH_SYSTEM,
          newProviderResearchPrompt({
            product,
            currentModels: inputs.currentModels[product],
            connectedProviders: inputs.connectedProviders,
            today,
          })
        );
        const checked = acceptNewProviderCandidates({
          product,
          answer,
          connectedProviders: inputs.connectedProviders,
          knownApiModels: inputs.knownApiModels,
        });
        return { product, ok: true, proposed: answer?.candidates?.length ?? 0, ...checked };
      } catch (error) {
        // Not retried: the call may have been billed. Next week's run tries again.
        console.error(
          JSON.stringify({
            event: "model_discovery_research_llm_failed",
            product,
            modelId: model.id,
            error: error instanceof Error ? error.name : "unknown",
          })
        );
        return { product, ok: false, proposed: 0, accepted: [] as AcceptedNewProviderCandidate[], rejected: [] };
      }
    })
  );

  const connectedImage = await connectedImageRun;
  // Products are researched separately, so two answers can name one model.
  const accepted: AcceptedNewProviderCandidate[] = [];
  for (const candidate of [...results.flatMap((result) => result.accepted), ...connectedImage.accepted]) {
    if (!accepted.some((other) => other.apiModelId.toLowerCase() === candidate.apiModelId.toLowerCase())) {
      accepted.push(candidate);
    }
  }
  const created = await recordNewProviderResearchWorkItems({ candidates: accepted, modelId: model.id, now });
  return {
    status: "ran",
    week,
    modelId: model.id,
    products: results.map((result) => ({
      product: result.product,
      ok: result.ok,
      proposed: result.proposed,
      accepted: result.accepted.length,
      rejected: result.rejected,
    })),
    connectedImage: {
      ok: connectedImage.ok,
      proposed: connectedImage.proposed,
      accepted: connectedImage.accepted.length,
      rejected: connectedImage.rejected,
    },
    created,
  };
}
