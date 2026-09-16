export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";

import { authOptions } from "@/lib/auth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { getTrustedClientIp } from "@/lib/clientIp";
import { requestConsentConfirmation } from "@/lib/emailConsentConfirmation";
import { readPreferences, setPreference, withdrawAllMarketing } from "@/lib/emailPreferences";
import { EMAIL_PURPOSES, recordsConsent } from "@/lib/emailPreferenceCore";
import { jurisdictionForUser, setSelfDeclaredCountry } from "@/lib/emailJurisdiction";
import {
  isMarketingAllowedCountry,
  marketingOptInCountryDecision,
  marketingJurisdictionVerdict,
  needsCountryConfirmation,
} from "@/lib/emailJurisdictionCore";

/**
 * The preference centre's data.
 *
 * Contract: docs/policy/email-notifications.md §11.2.
 *
 * The country travels with the preferences rather than in a separate call
 * because they are one decision from the person's side: marketing needs a
 * confirmed jurisdiction before it will send (§6.3 rule 2), so a screen that
 * offered the toggles without the country would let somebody switch something
 * on and then quietly receive nothing.
 */

const updateSchema = z
  .object({
    purpose: z.enum(EMAIL_PURPOSES).optional(),
    enabled: z.boolean().optional(),
    withdrawAllMarketing: z.literal(true).optional(),
    country: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/)
      .transform((value) => value.toUpperCase())
      .optional(),
  })
  .strict();

const state = async (userId: string) => {
  const [preferences, jurisdiction] = await Promise.all([
    readPreferences(userId),
    jurisdictionForUser({ userId }),
  ]);
  return {
    preferences,
    country: {
      // What the person entered, not what was resolved: the field is theirs to
      // edit, and pre-filling it with an inference would turn a guess into a
      // declaration the moment they pressed save.
      selfDeclared: jurisdiction.selfDeclaredCountry,
      resolved: jurisdiction.countryCode,
      confidence: jurisdiction.confidence,
      conflicts: jurisdiction.conflicts,
      needsConfirmation: needsCountryConfirmation(jurisdiction),
      marketingSupported: jurisdiction.selfDeclaredCountry
        ? marketingOptInCountryDecision(jurisdiction.selfDeclaredCountry).allowed
        : jurisdiction.profileKey !== "ZZ" &&
          isMarketingAllowedCountry(jurisdiction.countryCode),
    },
  };
};

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    return NextResponse.json(await state(session.user.id), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const secured = apiSecurityResponse(error);
    if (secured) return secured;
    console.error("Email preference read failed:", error);
    return NextResponse.json({ error: "Failed to load." }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    const userId = session.user.id;
    const body = await readLimitedJson(req, 2_048, updateSchema);

    const isMarketingEnable =
      body.purpose !== undefined &&
      body.enabled === true &&
      recordsConsent(body.purpose);

    if (isMarketingEnable) {
      const countryDecision = marketingOptInCountryDecision(body.country);
      if (!countryDecision.allowed && countryDecision.reason === "country_required") {
        return NextResponse.json(
          {
            error: "Confirm a country before enabling marketing email.",
            code: "COUNTRY_REQUIRED",
          },
          { status: 400 }
        );
      }
      if (!countryDecision.allowed) {
        return NextResponse.json(
          {
            error: "Marketing email is not available for this country yet.",
            code: "COUNTRY_UNSUPPORTED",
          },
          { status: 409 }
        );
      }

      const now = new Date();
      const jurisdiction = await jurisdictionForUser({
        userId,
        countryConfirmation: {
          country: countryDecision.countryCode,
          confirmedAt: now,
        },
      });
      const verdict = marketingJurisdictionVerdict(jurisdiction);
      if (!verdict.allowed) {
        // The request's country passed the allowlist above, but the resolution
        // is what the send lane will use. Refusing here on the same verdict
        // keeps the toggle from being stored against a country that would
        // never receive anything.
        if (verdict.skipReason === "marketing_country_not_allowed") {
          return NextResponse.json(
            {
              error: "Marketing email is not available for this country yet.",
              code: "COUNTRY_UNSUPPORTED",
            },
            { status: 409 }
          );
        }
        return NextResponse.json(
          {
            error: "The country could not be confirmed.",
            code:
              verdict.skipReason === "jurisdiction_conflict"
                ? "COUNTRY_CONFLICT"
                : "COUNTRY_REQUIRED",
          },
          { status: 409 }
        );
      }

      // Switching a marketing purpose on is a request for a confirmation mail,
      // never the consent itself (docs/policy/email-double-opt-in.md §5). The
      // preference stays off until the link in that mail is used.
      //
      // Bounded per account: each request sends a message to the account's own
      // address, and a loop on this endpoint would be a way to fill somebody's
      // inbox with confirmation mail.
      await consumeApiRateLimit(
        req,
        `consent-confirmation:${userId}`,
        "consent-confirmation",
        { minute: 3, day: 10 }
      );
      const requested = await requestConsentConfirmation({
        userId,
        purpose: body.purpose!,
        capturedVia: "preference_center",
        confirmedCountry: countryDecision.countryCode,
        jurisdiction: jurisdiction.countryCode,
        jurisdictionSource: "self_declared",
        ip: (() => {
          const trusted = getTrustedClientIp(req);
          return trusted === "unknown" ? null : trusted;
        })(),
        userAgent: req.headers.get("user-agent"),
        now,
      });
      if (!requested.requested && requested.reason !== "already_confirmed") {
        // Off, or keys not deployed: the step that would make consent valid is
        // not available, so no consent is collected. Saying so is better than
        // storing a switch that silently never sends.
        return NextResponse.json(
          {
            error: "Email subscriptions cannot be confirmed right now.",
            code: "CONFIRMATION_UNAVAILABLE",
          },
          { status: 409 }
        );
      }
    } else if (body.withdrawAllMarketing) {
      await withdrawAllMarketing({
        userId,
        capturedVia: "preference_center",
        source: "preference_center",
        userAgent: req.headers.get("user-agent"),
      });
    } else {
      if (body.country) {
        await setSelfDeclaredCountry({ userId, country: body.country });
      }

      if (!body.purpose || typeof body.enabled !== "boolean") {
        return NextResponse.json(await state(userId), {
          headers: { "Cache-Control": "no-store" },
        });
      }

      const result = await setPreference({
        userId,
        purpose: body.purpose,
        enabled: body.enabled,
        capturedVia: "preference_center",
        source: "preference_center",
        userAgent: req.headers.get("user-agent"),
      });
      // `locked` is the one refusal worth naming: the client renders those
      // rows as unswitchable, so reaching here means the two disagree and a
      // generic error would hide that.
      // Switching on is refused while another suppression cause still stops
      // this mail (docs/policy/email-product-news-redesign-draft.md, section
      // 7.4). Said as itself: reading the state back would show the switch off
      // with no reason.
      if (!result.changed && result.reason === "suppressed") {
        return NextResponse.json(
          { error: "This address cannot receive this email.", code: "SUPPRESSED" },
          { status: 409 }
        );
      }
      if (!result.changed && result.reason === "locked") {
        return NextResponse.json(
          { error: "This notification cannot be turned off.", code: "LOCKED" },
          { status: 409 }
        );
      }
    }

    // The saved state, read back rather than echoed: a response built from the
    // request would report a save that a constraint refused.
    return NextResponse.json(await state(userId), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const secured = apiSecurityResponse(error);
    if (secured) return secured;
    console.error("Email preference update failed:", error);
    return NextResponse.json({ error: "Failed to save." }, { status: 500 });
  }
}
