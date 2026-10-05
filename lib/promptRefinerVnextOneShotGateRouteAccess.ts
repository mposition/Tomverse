import "server-only";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from
  "@/lib/adminReauthentication";
import { consumeApiRateLimit } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

const headers = { "Cache-Control": "private, no-store, max-age=0" };

export async function promptRefinerVnextOneShotGateOwner(
  request: Request, mutation: boolean,
  action: "gate" | "disposition",
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminSession(session)) {
    return { response: NextResponse.json({ error: "Not found." },
      { status: 404, headers }) } as const;
  }
  if (getAdminRole(session) !== "owner") {
    return { response: NextResponse.json({ error: "Forbidden." },
      { status: 403, headers }) } as const;
  }
  try {
    await assertRecentAdminAuthentication(session);
  } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return { response: NextResponse.json({ code: "ADMIN_REAUTHENTICATION_REQUIRED" },
        { status: 428, headers }) } as const;
    }
    throw error;
  }
  if (mutation && !hasValidMutationOrigin(request)) {
    return { response: NextResponse.json({ error: "Forbidden." },
      { status: 403, headers }) } as const;
  }
  await consumeApiRateLimit(request, session.user.id,
    `admin-prompt-refiner-vnext-one-shot-${action}-${mutation ? "write" : "read"}`,
    mutation ? { minute: 1, day: 3 } : { minute: 3, day: 30 });
  return { session } as const;
}
