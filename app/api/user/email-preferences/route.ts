export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";

import { authOptions } from "@/lib/auth";
import { apiSecurityResponse, readLimitedJson } from "@/lib/apiSecurity";
import { readPreferences, setPreference, withdrawAllMarketing } from "@/lib/emailPreferences";
import { EMAIL_PURPOSES } from "@/lib/emailPreferenceCore";
import { jurisdictionForUser, setSelfDeclaredCountry } from "@/lib/emailJurisdiction";
import { needsCountryConfirmation } from "@/lib/emailJurisdictionCore";

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
    country: z.string().trim().length(2).optional(),
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

    if (body.country) {
      await setSelfDeclaredCountry({ userId, country: body.country });
    }

    if (body.withdrawAllMarketing) {
      await withdrawAllMarketing({
        userId,
        capturedVia: "preference_center",
        source: "preference_center",
        userAgent: req.headers.get("user-agent"),
      });
    } else if (body.purpose && typeof body.enabled === "boolean") {
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
