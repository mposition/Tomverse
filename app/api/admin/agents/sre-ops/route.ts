/**
 * The owner's read of the sre-ops chain (docs/policy/sre-ops.md §8): the head
 * and the trust verdict the genesis screen shows and a genesis request names
 * back. Reading takes an administrator only -- like the other agent records,
 * seeing why nothing ran must not be refused for a stale sign-in. No keys, no
 * audit metadata; `no-store`.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";

import { isAdminSession } from "@/lib/adminAuth";
import { authOptions } from "@/lib/auth";
import { readOpsObserverAdminView } from "@/lib/opsObserverStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET() {
  const session = await getServerSession(authOptions);
  // A non-administrator is told nothing about what is here.
  if (!session?.user?.id || !isAdminSession(session)) {
    return NextResponse.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
  }
  try {
    return NextResponse.json({ ok: true, view: await readOpsObserverAdminView() }, { headers: NO_STORE });
  } catch (error) {
    const e = error as { name?: unknown; code?: unknown };
    console.error(JSON.stringify({
      event: "ops_observer_admin_read_failed",
      errorName: typeof e?.name === "string" ? e.name : null,
      errorCode: typeof e?.code === "string" ? e.code : null,
    }));
    return NextResponse.json({ error: "Something went wrong." }, { status: 500, headers: NO_STORE });
  }
}
