export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";

import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedText,
} from "@/lib/apiSecurity";
import { getAnonymousClientKey } from "@/lib/clientIp";
import { setPreference, withdrawAllMarketing } from "@/lib/emailPreferences";
import { readUnsubscribeKeyring, readUnsubscribeToken } from "@/lib/unsubscribeToken";

/**
 * Unsubscribing, without a login.
 *
 * Contract: docs/policy/email-notifications.md §11.3, §11.4.
 *
 * The Australian rule is explicit that unsubscribing must not require an
 * account or a sign-in, and CAN-SPAM allows at most a reply or a single page
 * visit. So this endpoint authenticates the *token*, not the person -- which is
 * safe only because the token can do exactly one thing: turn one purpose off
 * for one subject. It cannot enable anything and cannot reach anyone else.
 *
 * There is no `GET` here on purpose. Mail clients and link scanners prefetch
 * URLs, and a `GET` that unsubscribes would fire the moment a security appliance
 * previewed the message -- unsubscribing people who never clicked. The link in
 * the email goes to a page that shows a button; this handles the button, and
 * the RFC 8058 one-click header, which is a `POST` for the same reason.
 */

const MAX_BODY_BYTES = 4 * 1024;

const answer = (body: Record<string, unknown>, status = 200) =>
  NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });

/**
 * The origin bound, charged only to requests that are not a valid token.
 *
 * Contract: docs/policy/email-notifications.md §11.3. Invalid tokens are the
 * only thing worth throttling by origin -- guessing and replaying garbage --
 * so they carry the original 20/minute, 200/day. Returns the 429 to send, or
 * null to carry on to the ordinary refusal.
 */
const limitInvalid = async (req: Request) => {
  try {
    await consumeApiRateLimit(
      req,
      `unsubscribe:${getAnonymousClientKey(req)}`,
      "unsubscribe",
      { minute: 20, day: 200 }
    );
    return null;
  } catch (error) {
    const limited = apiSecurityResponse(error);
    if (limited) return limited;
    throw error;
  }
};

export async function POST(req: Request) {
  const keyring = readUnsubscribeKeyring(process.env);
  if (!keyring) {
    return answer({ error: "Unsubscribe is not configured." }, 503);
  }

  const url = new URL(req.url);
  let token = url.searchParams.get("t") ?? "";
  let all = url.searchParams.get("all") === "1";

  const raw = await readLimitedText(req, MAX_BODY_BYTES).catch(() => "");
  if (raw) {
    // RFC 8058 one-click sends `List-Unsubscribe=One-Click` as a form body, and
    // our own confirmation page posts a form too. Neither is JSON.
    const form = new URLSearchParams(raw);
    token = form.get("t") || token;
    if (form.get("all") === "1") all = true;
  }

  if (!token) {
    const limited = await limitInvalid(req);
    return limited ?? answer({ error: "Invalid link." }, 400);
  }

  // Opened before any rate limit, because the limit depends on the answer.
  // Decryption is local and cheap -- no database -- so doing it first costs
  // nothing an attacker could amplify.
  const read = readUnsubscribeToken(token, keyring);
  if (!read.valid) {
    if (read.reason === "unknown_key") {
      // Not a user error: somebody dropped a key version and every link of that
      // vintage is now dead. The recipient's remaining option is the spam
      // button, so this is loud.
      console.error(
        JSON.stringify({
          event: "unsubscribe_key_missing",
          at: new Date().toISOString(),
        })
      );
    }
    // Logged before the limit, so a flood of dead links still says why.
    const limited = await limitInvalid(req);
    if (limited) return limited;
    // One answer for every failure. Distinguishing them would turn this into an
    // oracle for which tokens are real.
    return answer({ error: "Invalid link." }, 400);
  }

  const { userId, purpose, deliveryId } = read.payload;

  // A valid token can only switch something off, so a valid request is
  // processed rather than turned away by its origin: one corporate NAT or one
  // mailbox provider's one-click fetcher carries many recipients, and a 429 on
  // a real unsubscribe leaves the recipient the spam button. The bound that
  // remains is per subject, so replaying one token is still not a free loop.
  try {
    await consumeApiRateLimit(
      req,
      `unsubscribe-subject:${userId}:${all ? "*" : purpose}`,
      "unsubscribe-valid",
      { minute: 30, day: 300 },
      { skipIpBucket: true }
    );
  } catch (error) {
    const limited = apiSecurityResponse(error);
    if (limited) return limited;
    throw error;
  }

  const common = {
    userId,
    capturedVia: "unsubscribe_page" as const,
    source: "unsubscribe_link" as const,
    deliveryId: deliveryId ?? null,
    userAgent: req.headers.get("user-agent"),
  };

  if (all) {
    await withdrawAllMarketing({ ...common, source: "unsubscribe_link" });
    return answer({ ok: true, scope: "all" });
  }

  const result = await setPreference({ ...common, purpose, enabled: false, viaToken: true });

  // `already_set` is a success from the recipient's point of view: they asked
  // not to receive this and they will not. Reporting it as a failure would send
  // somebody who clicked twice looking for a problem that does not exist.
  if (!result.changed && result.reason !== "already_set") {
    return answer({ error: "Invalid link." }, 400);
  }
  return answer({ ok: true, scope: "purpose", purpose });
}
