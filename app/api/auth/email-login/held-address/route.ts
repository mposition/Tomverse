export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";

import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { getAnonymousClientKey } from "@/lib/clientIp";
import { heldSignupAddressForLink } from "@/lib/emailLogin";

/**
 * The address a held sign-in link was sent to, for the link page's sign-up
 * step (docs/policy/email-product-news-redesign-draft.md section 5.2a).
 *
 * The page holds only the link token, and the consent choice it is about to
 * store is bound to an address. Answering needs that token and a live sign-up
 * hold, which exists only after the same token proved the address and found no
 * account -- so the answer goes to the person the link was already mailed to.
 */

const bodySchema = z.object({ linkToken: z.string().trim().min(1).max(256) }).strict();

export async function POST(req: Request) {
  try {
    await consumeApiRateLimit(
      req,
      `email-login-held-address:${getAnonymousClientKey(req)}`,
      "email-login-held-address",
      { minute: 10, day: 100 }
    );
    const body = await readLimitedJson(req, 512, bodySchema);
    const email = await heldSignupAddressForLink(body.linkToken);
    if (!email) {
      return NextResponse.json({ ok: false }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ ok: true, email }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const secured = apiSecurityResponse(error);
    if (secured) return secured;
    console.error("Held sign-up address failed:", error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
