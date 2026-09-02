export const dynamic = "force-dynamic";

/**
 * The browser half of a first mobile sign-in (design D14.1).
 *
 * Authenticated by the ordinary cookie session, because that is exactly what it
 * is for: a person who is already signed in here hands their app one sixty-
 * second, single-use, client-bound grant. It is deliberately **not** in
 * `EXEMPT_MUTATION_PATHS` -- this is a browser request with an Origin, the
 * cookie is an ambient credential, and CSRF applies to it in full.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";

import { mobileAuthReady } from "@/lib/mobileAccessToken";
import { apiSecurityResponse, readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { isPkceChallenge, issueMobileLoginGrant } from "@/lib/mobileLoginGrant";

const requestSchema = z
  .object({
    // S256 only. Accepting "plain" would make the binding a value the
    // intercepting party already has.
    codeChallengeMethod: z.literal("S256"),
    codeChallenge: z.string().refine(isPkceChallenge),
  })
  .strict();

export async function POST(request: Request) {
  try {
    if (!mobileAuthReady()) {
      return NextResponse.json({ ok: false, code: "NOT_AVAILABLE" }, { status: 503 });
    }
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ ok: false, code: "UNAUTHORIZED" }, { status: 401 });
    }

    const body = await readLimitedJson(request, 1_024, requestSchema);
    const grant = await issueMobileLoginGrant({
      userId,
      codeChallenge: body.codeChallenge,
    });
    return NextResponse.json({ ok: true, ...grant });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Mobile login grant failed:", error);
    return NextResponse.json({ ok: false, code: "GRANT_FAILED" }, { status: 500 });
  }
}
