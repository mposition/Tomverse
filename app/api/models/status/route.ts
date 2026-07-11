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

    const models = AVAILABLE_MODELS.map((model) => {
      const provider = providerStatus.get(model.provider);
      const status =
        !model.enabled || model.status !== "enabled"
          ? "unavailable"
          : provider?.status === "outage"
            ? "unavailable"
            : provider?.status === "limited"
              ? "limited"
              : "available";

      return {
        id: model.id,
        provider: model.provider,
        status,
        fallbackModelIds: provider?.fallback.recommendedModelIds || [],
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
