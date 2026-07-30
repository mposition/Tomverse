export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getPublicRuntimeModels } from "@/lib/modelRegistry";
import { resolveModelRuntimeAvailability } from "@/lib/modelAvailability";
import { getProviderHealthDashboard } from "@/lib/providerMonitoring";
import { getAnonymousClientKey } from "@/lib/clientIp";
import { selectFallbackCandidates } from "@/lib/providerFallbackCandidates";
import { isE2EDatabaseDisabled } from "@/lib/e2eTestMode";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
} from "@/lib/apiSecurity";

const cacheHeaders = {
  "Cache-Control": "public, max-age=60, stale-while-revalidate=120",
};

const isTransientStatusDbError = (error: unknown) => {
  const code = typeof error === "object" && error && "code" in error
    ? (error as { code?: unknown }).code
    : null;
  return (
    code === "P2028" ||
    (error instanceof Error &&
      error.message.includes("Unable to start a transaction"))
  );
};

// Without a health dashboard there is no evidence about the provider either
// way, so every model reports `providerStatus: "unknown"` rather than an
// unearned "operational". The model's own registry lifecycle is still
// authoritative for its availability.
const fallbackModelStatus = (publicModels: Awaited<ReturnType<typeof getPublicRuntimeModels>>) => ({
  generatedAt: new Date().toISOString(),
  models: publicModels.map((model) => ({
    id: model.id,
    provider: model.provider,
    status: resolveModelRuntimeAvailability(model),
    providerStatus: "unknown" as const,
    providerStatusReason: "Provider health data is unavailable.",
    fallbackModelIds: model.replacementModelId
      ? [model.replacementModelId]
      : [],
    // RECON-OPS-001: with no dashboard there is no evidence about the
    // replacement either, so it is offered as unverified rather than as a
    // safe swap.
    fallbackHealth: "unknown" as const,
    recentFailureCount5m: 0,
    recentErrorCode: null,
  })),
});

export async function GET(req: Request) {
  try {
    const publicModels = await getPublicRuntimeModels();
    if (isE2EDatabaseDisabled()) {
      return NextResponse.json(fallbackModelStatus(publicModels), {
        headers: cacheHeaders,
      });
    }
    const subject = `public:${getAnonymousClientKey(req)}`;
    try {
      await consumeApiRateLimit(req, subject, "public-model-status", {
        minute: 30,
        day: 1_000,
      });
    } catch (error) {
      const securityResponse = apiSecurityResponse(error);
      if (securityResponse) return securityResponse;
      if (!isTransientStatusDbError(error)) throw error;
      console.warn("Public model status rate limit skipped after transient DB error.");
    }

    const dashboard = await getProviderHealthDashboard().catch((error) => {
      console.warn("Public model status using fallback after provider health error:", error);
      return null;
    });
    if (!dashboard) {
      return NextResponse.json(fallbackModelStatus(publicModels), {
        headers: {
          "Cache-Control": "public, max-age=30, stale-while-revalidate=120",
        },
      });
    }
    const providerStatus = new Map(
      dashboard.providers.map((provider) => [provider.provider, provider])
    );
    const modelIncidents = new Map(
      dashboard.providers.flatMap((provider) =>
        provider.modelIncidents.map((incident) => [incident.modelId, incident])
      )
    );

    const publicModelIds = new Set(publicModels.map((model) => model.id));

    const resolveStatus = (model: (typeof publicModels)[number]) => {
      const provider = providerStatus.get(model.provider);
      const incident = modelIncidents.get(model.id);
      let status: "available" | "limited" | "unavailable" =
        resolveModelRuntimeAvailability(model);
      if (status !== "unavailable" && incident && incident.failureCount5m >= 3) {
        status = "unavailable";
      } else if (status !== "unavailable") {
        // Derived from the same public projection /status renders, rather
        // than from the internal health enum. Reading `provider.status`
        // here was why a provider shown as "Incident" on /status could still
        // report every one of its models "available" in the same second:
        // the two surfaces were answering from different evidence models.
        //
        //   incident -> unavailable (blocked, offer a replacement)
        //   degraded -> limited     (usable, but warned)
        //   unknown  -> unchanged   (neutral; absence of evidence is not
        //                            evidence of failure, and the caller is
        //                            told so via providerStatus)
        if (provider?.publicStatus === "incident") {
          status = "unavailable";
        } else if (provider?.publicStatus === "degraded") {
          status = "limited";
        }
      }
      return status;
    };

    // RECON-OPS-001: every model's status is resolved once up front so the
    // replacement candidates below can be judged against the same snapshot
    // this response reports, instead of against the static registry alone.
    const modelStatuses = new Map(
      publicModels.map((model) => [model.id, resolveStatus(model)] as const)
    );

    const models = publicModels.map((model) => {
      const provider = providerStatus.get(model.provider);
      const status = modelStatuses.get(model.id) ?? "available";
      const { fallbackModelIds, fallbackHealth } =
        status === "unavailable"
          ? selectFallbackCandidates({
              replacementModelId: model.replacementModelId,
              recommendedModelIds: provider?.fallback.recommendedModelIds,
              isPublicModel: (modelId) => publicModelIds.has(modelId),
              statusOf: (modelId) => modelStatuses.get(modelId),
            })
          : { fallbackModelIds: [] as string[], fallbackHealth: "none" as const };

      return {
        id: model.id,
        provider: model.provider,
        status,
        providerStatus: provider?.publicStatus ?? "unknown",
        providerStatusReason: provider?.publicStatusReasonText ?? null,
        fallbackModelIds,
        fallbackHealth,
      };
    });

    return NextResponse.json(
      { generatedAt: dashboard.generatedAt, models },
      { headers: cacheHeaders }
    );
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to load public model status:", error);
    return NextResponse.json(
      { error: "Failed to load model status." },
      { status: 500 }
    );
  }
}
