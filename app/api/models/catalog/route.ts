export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getRuntimeModels } from "@/lib/modelRegistry";
import { consumePublicReadBudget } from "@/lib/publicReadRateLimit";
import { readPublicSnapshot } from "@/lib/publicSnapshotCache";

/**
 * The public model list, minus the fields that describe how the server reaches
 * a provider.
 *
 * SEC-012. `ModelCatalogProvider` fetches this on every page load and it is
 * unauthenticated, so it used to be one `ensureModelRegistrySeeded()` plus one
 * full table read per page view -- and per request in a loop. It is the same
 * answer for every caller, so it is served from a short-lived shared snapshot
 * with an ETag; see `lib/publicSnapshotCache.ts`. The redaction happens inside
 * the loader, so what is cached is already the public shape and a future reader
 * cannot reach the private fields through it.
 */
const loadPublicCatalog = async () => {
  const models = await getRuntimeModels({ includeCatalogDeleted: true });
  return {
    models: models.map((model) => {
      const publicModel = { ...model };
      delete publicModel.apiBaseUrl;
      delete publicModel.apiKeyEnvName;
      delete publicModel.operationalReason;
      return publicModel;
    }),
  };
};

export async function GET(request: Request) {
  const budget = consumePublicReadBudget(request, "model-catalog");
  if (!budget.allowed) {
    return NextResponse.json(
      { error: "Too many requests." },
      {
        status: 429,
        headers: {
          "Retry-After": String(budget.retryAfter),
          "Cache-Control": "no-store",
        },
      }
    );
  }

  try {
    const { value: payload, etag } = await readPublicSnapshot(
      "model-catalog",
      loadPublicCatalog
    );
    const headers = {
      // Revalidate every time, but let the ETag answer with no body. Private,
      // not public: a disabled or degraded model must not stay visible in a
      // shared CDN cache after operations pulls it.
      "Cache-Control": "private, no-cache",
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
    };

    if (request.headers.get("if-none-match") === etag) {
      return new NextResponse(null, { status: 304, headers });
    }
    return NextResponse.json(payload, { headers });
  } catch (error) {
    console.error("Public model catalog error:", error);
    return NextResponse.json(
      { error: "Model catalog unavailable." },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
