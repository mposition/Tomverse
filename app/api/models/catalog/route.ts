export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getRuntimeModels } from "@/lib/modelRegistry";
import { toPublicCatalogModel } from "@/lib/publicModelCatalog";

// Unauthenticated on purpose: guests pick models before signing in, and a
// shared conversation is read by people with no account. Both need to resolve
// a model id to a name and icon, including a retired one -- which is why every
// row is returned and the client filters with isPubliclySelectableModel rather
// than the server pre-filtering to the selectable set.
//
// What keeps that safe is the response shape. toPublicCatalogModel is an
// explicit allowlist; see lib/publicModelCatalog.ts for what is excluded and
// why. Administrators get the full registry row from /api/admin/models.
export async function GET() {
  try {
    const models = await getRuntimeModels({ includeCatalogDeleted: true });
    return NextResponse.json(
      { models: models.map(toPublicCatalogModel) },
      {
        headers: {
          // A cache directive, not access control -- the allowlist above is
          // what makes this body safe to serve.
          "Cache-Control": "private, no-store, max-age=0",
          "X-Content-Type-Options": "nosniff",
        },
      }
    );
  } catch (error) {
    console.error("Public model catalog error:", error);
    return NextResponse.json({ error: "Model catalog unavailable." }, { status: 503 });
  }
}
