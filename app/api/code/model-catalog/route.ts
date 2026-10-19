export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { latestCodingSnapshot } from "@/lib/modelCatalog";
import { snapshotIsCurrent } from "@/lib/modelCatalogCore";

// The coding catalogue the Code client reads in managed or hybrid mode
// (TomverseCode product-strategy 17.6-2): an immutable snapshot with version,
// contentHash and coverageUntil. Being listed here is not permission to call a
// model -- the server re-decides plan access on every managed call.
//
// `?version=N` returns `{ unchanged: true }` when N is still the newest, so a
// client polling on start-up downloads the rows only when they changed.

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    }
    await consumeApiRateLimit(req, session.user.id, "code-model-catalog", { minute: 30, day: 2_000 });

    const snapshot = await latestCodingSnapshot();
    if (!snapshot) {
      return NextResponse.json({ error: "catalog_not_published" }, { status: 404 });
    }
    // Past coverage nothing in it can be priced: fail closed rather than serve stale prices.
    if (!snapshotIsCurrent(snapshot.coverageUntil, new Date())) {
      return NextResponse.json({ error: "catalog_stale", version: snapshot.version }, { status: 503 });
    }
    const known = Number(new URL(req.url).searchParams.get("version"));
    if (Number.isInteger(known) && known === snapshot.version) {
      return NextResponse.json({ unchanged: true, version: snapshot.version });
    }
    return NextResponse.json(
      {
        version: snapshot.version,
        contentHash: snapshot.contentHash,
        coverageUntil: snapshot.coverageUntil.toISOString(),
        publishedAt: snapshot.publishedAt.toISOString(),
        models: snapshot.models,
      },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (error) {
    return apiSecurityResponse(error) ?? NextResponse.json({ error: "Catalog read failed." }, { status: 500 });
  }
}
