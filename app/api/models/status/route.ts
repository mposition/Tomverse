export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getPublicRuntimeModels } from "@/lib/modelRegistry";
import { getModelOverrideMap, resolveModelOverrideStatus } from "@/lib/modelOverrides";
import { getProviderHealthDashboard } from "@/lib/providerMonitoring";
import { getTrustedClientIp } from "@/lib/clientIp";
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

const fallbackModelStatus = (publicModels: Awaited<ReturnType<typeof getPublicRuntimeModels>>) => ({
  generatedAt: new Date().toISOString(),
  models: publicModels.map((model) => ({
    id: model.id,
    provider: model.provider,
    status:
      model.enabled && model.status === "enabled"
        ? ("available" as const)
        : ("unavailable" as const),
    fallbackModelIds: model.replacementModelId
      ? [model.replacementModelId]
      : [],
    recentFailureCount5m: 0,
    recentErrorCode: null,
  })),
});

export async function GET(req: Request) {
  try {
    const publicModels = await getPublicRuntimeModels();
    const subject = `public:${getTrustedClientIp(req)}`;
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
    const overrideMap = await getModelOverrideMap().catch(() => new Map());
    const modelIncidents = new Map(
      dashboard.providers.flatMap((provider) =>
        provider.modelIncidents.map((incident) => [incident.modelId, incident])
      )
    );

    const publicModelIds = new Set(publicModels.map((model) => model.id));
    const models = publicModels.map((model) => {
      const replacementModelId = model.replacementModelId;
      const provider = providerStatus.get(model.provider);
      const override = overrideMap.get(model.id);
      const incident = modelIncidents.get(model.id);
      const overrideStatus = resolveModelOverrideStatus(model, override);
      let status: "available" | "unavailable" =
        overrideStatus === "unavailable" ? "unavailable" : "available";
      if (status !== "unavailable" && incident && incident.failureCount5m >= 3) {
        status = "unavailable";
      } else if (status !== "unavailable" && provider?.status === "outage") {
        status = "unavailable";
      }

      return {
        id: model.id,
        provider: model.provider,
        status,
        fallbackModelIds:
          status === "unavailable"
            ? Array.from(
                new Set([
                  ...(replacementModelId
                    ? [replacementModelId]
                    : []),
                  ...(provider?.fallback.recommendedModelIds || []),
                ])
              ).filter((modelId) => publicModelIds.has(modelId))
            : [],
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
