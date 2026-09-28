export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { isAdminSession } from "@/lib/adminAuth";
import { readAmuxCardBySourceKey } from "@/lib/amux/cardRead";
import { parseAmuxCardSourceKey } from "@/lib/amux/cardReadCore";
import { authOptions } from "@/lib/auth";

const noStoreHeaders = { "Cache-Control": "private, no-store, max-age=0" };

const json = (body: object, status = 200) =>
  NextResponse.json(body, { status, headers: noStoreHeaders });

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return json({ error: "Not found." }, 404);
    }

    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some((key) => key !== "sourceKey")) {
      return json({ error: "Invalid source key." }, 400);
    }
    const rawKeys = params.getAll("sourceKey");
    const sourceKey = rawKeys.length === 1 ? parseAmuxCardSourceKey(rawKeys[0]!) : null;
    if (!sourceKey) return json({ error: "Invalid source key." }, 400);

    const result = await readAmuxCardBySourceKey(sourceKey);
    if (result.kind === "missing") return json({ error: "Not found." }, 404);
    if (result.kind === "ambiguous") {
      return json({ error: "Source key is ambiguous." }, 409);
    }
    if (result.kind === "invalid_provenance") {
      return json({ error: "Canonical source metadata is unavailable." }, 409);
    }
    return json({ card: result.card });
  } catch {
    return json({ error: "Failed to load AMUX card." }, 500);
  }
}
