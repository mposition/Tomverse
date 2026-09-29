export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";

import { authOptions } from "@/lib/auth";
import { getTrustedClientIp } from "@/lib/clientIp";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import {
  consentNoticeForViewer,
  recordConsentNoticeAction,
} from "@/lib/inProductConsentNoticeSurface";

/**
 * The in-product consent notice for the signed-in account (S8, draft section
 * 5.4). GET says whether it is offered and in which approved wording; POST
 * records what the screen did -- `shown` when it rendered, `object` when the
 * refusal was used, `accept` when "Yes" was used, which requests the
 * confirmations the approved wording promises. Nothing here is consent until
 * each confirmation link is used.
 */

const bodySchema = z
  .object({
    action: z.enum(["shown", "object", "accept"]),
    language: z.string().trim().max(8).optional(),
    copyVersion: z.string().trim().min(1).max(32),
  })
  .strict();

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers: NO_STORE });
    }
    return NextResponse.json(await consentNoticeForViewer(session.user.id), { headers: NO_STORE });
  } catch (error) {
    console.error("Consent notice read failed:", error);
    return NextResponse.json({ offered: false }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers: NO_STORE });
    }
    await consumeApiRateLimit(req, session.user.id, "consent-notice", { minute: 10, day: 50 });
    const body = await readLimitedJson(req, 1_024, bodySchema);
    const result = await recordConsentNoticeAction({
      userId: session.user.id,
      action: body.action,
      language: body.language ?? null,
      copyVersion: body.copyVersion,
      ip: (() => {
        const trusted = getTrustedClientIp(req);
        return trusted === "unknown" ? null : trusted;
      })(),
      userAgent: req.headers.get("user-agent"),
    });
    return NextResponse.json(result, {
      status: result.recorded
        ? 200
        : result.reason === "unknown_version"
          ? 400
          : result.reason === "confirmation_unavailable"
            ? 503
            : 409,
      headers: NO_STORE,
    });
  } catch (error) {
    const secured = apiSecurityResponse(error);
    if (secured) return secured;
    console.error("Consent notice record failed:", error);
    return NextResponse.json({ recorded: false, reason: "failed" }, { status: 500, headers: NO_STORE });
  }
}
