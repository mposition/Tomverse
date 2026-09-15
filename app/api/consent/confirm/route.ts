export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";

import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedText,
} from "@/lib/apiSecurity";
import { getAnonymousClientKey } from "@/lib/clientIp";
import { confirmConsent } from "@/lib/emailConsentConfirmation";

/**
 * Applying a marketing consent confirmation, without a login.
 *
 * Contract: docs/policy/email-double-opt-in.md §3 rule 4, §5 steps 4-5.
 *
 * There is no `GET` here, and that matters more than it does for unsubscribe:
 * mail scanners and link previewers fetch URLs unprompted, and a `GET` that
 * confirmed would let a security appliance *create* a consent the person never
 * gave. The link opens a page with one button; this handles the button.
 *
 * No login, for the same reason the unsubscribe page has none: the mail is
 * often opened on a device that is not signed in, and the token already names
 * the account, the purpose, the request and the mailbox it was sent to.
 */

const MAX_BODY_BYTES = 4 * 1024;

const answer = (body: Record<string, unknown>, status = 200) =>
  NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });

export async function POST(req: Request) {
  try {
    await consumeApiRateLimit(
      req,
      `consent-confirm:${getAnonymousClientKey(req)}`,
      "consent-confirm",
      { minute: 20, day: 200 }
    );
  } catch (error) {
    const limited = apiSecurityResponse(error);
    if (limited) return limited;
    throw error;
  }

  const raw = await readLimitedText(req, MAX_BODY_BYTES).catch(() => "");
  const token = raw ? new URLSearchParams(raw).get("t") ?? "" : "";
  if (!token) return answer({ error: "Invalid link.", code: "INVALID" }, 400);

  const result = await confirmConsent({
    token,
    userAgent: req.headers.get("user-agent"),
  });

  if (result.confirmed) {
    return answer({ ok: true, purpose: result.purpose });
  }

  if (result.reason === "keys_missing") {
    return answer({ error: "Confirmation is not configured.", code: "UNAVAILABLE" }, 503);
  }
  if (result.tokenReason && !result.tokenReason.valid && result.tokenReason.reason === "unknown_key") {
    // Somebody dropped a key version and every pending link of that vintage is
    // now dead. Not the recipient's error, so it is loud.
    console.error(
      JSON.stringify({ event: "consent_key_missing", at: new Date().toISOString() })
    );
  }
  // Expired is told apart because its remedy differs: ask again from the
  // settings screen. Everything else is one answer, so this cannot become an
  // oracle for which tokens are real.
  return answer(
    {
      error: result.reason === "expired" ? "This link has expired." : "Invalid link.",
      code: result.reason === "expired" ? "EXPIRED" : "INVALID",
    },
    400
  );
}
