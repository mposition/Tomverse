export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getRuntimeModels } from "@/lib/modelRegistry";
import { toPublicCatalogModel } from "@/lib/publicModelCatalog";
import { consumePublicReadBudget } from "@/lib/publicReadRateLimit";
import { readPublicSnapshot } from "@/lib/publicSnapshotCache";

// Unauthenticated on purpose: guests pick models before signing in, and a
// shared conversation is read by people with no account. Both need to resolve
// a model id to a name and icon, including a retired one -- which is why every
// row is returned and the client filters with isPubliclySelectableModel rather
// than the server pre-filtering to the selectable set.
//
// What keeps that safe is the response shape. toPublicCatalogModel is an
// explicit allowlist; see lib/publicModelCatalog.ts for what is excluded and
// why. Administrators get the full registry row from /api/admin/models.
//
// SEC-012. `ModelCatalogProvider` fetches this on every page load, so it used
// to be one `ensureModelRegistrySeeded()` plus one full table read per page
// view -- and per request in a loop, from an unauthenticated caller. The answer
// is the same for every caller, so it is served from a short-lived shared
// snapshot with an ETag; see `lib/publicSnapshotCache.ts`. The allowlist runs
// inside the loader, so what is cached is already the public shape and a future
// reader of the snapshot cannot reach the excluded fields through it.
const loadPublicCatalog = async () => {
  const models = await getRuntimeModels({ includeCatalogDeleted: true });
  return { models: models.map(toPublicCatalogModel) };
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
      // A cache directive, not access control -- the allowlist above is what
      // makes this body safe to serve. Revalidate every time, but let the ETag
      // answer with no body. Private, not public: a disabled or degraded model
      // must not stay visible in a shared CDN cache after operations pulls it.
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
