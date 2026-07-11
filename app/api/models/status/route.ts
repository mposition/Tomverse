export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { AVAILABLE_MODELS } from "@/lib/models";
import { getProviderHealthDashboard } from "@/lib/providerMonitoring";
import { getTrustedClientIp } from "@/lib/clientIp";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
} from "@/lib/apiSecurity";

export async function GET(req: Request) {
  try {
    const subject = `public:${getTrustedClientIp(req)}`;
    await consumeApiRateLimit(req, subject, "public-model-status", {
      minute: 30,
      day: 1_000,
    });

    const dashboard = await getProviderHealthDashboard();
    const providerStatus = new Map(
      dashboard.providers.map((provider) => [provider.provider, provider])
    );
    const modelIncidents = new Map(
      dashboard.providers.flatMap((provider) =>
        provider.modelIncidents.map((incident) => [incident.modelId, incident])
      )
    );

    const models = AVAILABLE_MODELS.map((model) => {
      const provider = providerStatus.get(model.provider);
      const incident = modelIncidents.get(model.id);
      let status: "available" | "limited" | "unavailable" = "available";
      if (!model.enabled || model.status !== "enabled") {
        status = "unavailable";
      } else if (incident && incident.failureCount5m >= 3) {
        status = "unavailable";
      } else if (incident) {
        status = "limited";
      } else if (provider?.status === "outage") {
        status = "unavailable";
      } else if (provider?.status === "limited") {
        status = "limited";
      }

      return {
        id: model.id,
        provider: model.provider,
        status,
        fallbackModelIds: provider?.fallback.recommendedModelIds || [],
        recentFailureCount5m: incident?.failureCount5m || 0,
        recentErrorCode: incident?.recentErrorCode || null,
      };
    });

    return NextResponse.json(
      { generatedAt: dashboard.generatedAt, models },
      {
        headers: {
          "Cache-Control": "public, max-age=60, stale-while-revalidate=120",
        },
      }
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
