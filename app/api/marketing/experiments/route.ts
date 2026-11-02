export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveAnalyticsConsentPolicy } from "@/lib/analyticsConsentPolicy";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { getAnonymousClientKey } from "@/lib/clientIp";
import { isE2EDatabaseDisabled } from "@/lib/e2eTestMode";
import {
  EXPERIMENT_LOCALES,
  experimentVariantIdSchema,
} from "@/lib/marketingExperimentContract";
import {
  experimentAnalyticsActive,
  experimentCookieMaxAgeSeconds,
  pickExperimentArm,
} from "@/lib/marketingExperimentCore";
import {
  e2eForcedRoll,
  incrementExperimentCounter,
  readActiveMarketingExperiment,
} from "@/lib/marketingExperimentState";
import {
  EXPERIMENT_CONTROL_ARM,
  EXPERIMENT_COOKIE_NAME,
  formatExperimentCookie,
  parseExperimentCookie,
} from "@/lib/marketingRoutes";
import { analyticsCountryFromHeaders } from "@/lib/productAnalyticsServer";
import { randomInt } from "node:crypto";

/**
 * Landing experiment assignment and counting (policy 9.1).
 *
 * One route, three actions, all behind the same two gates: analytics is on for
 * this visitor (the consent provider's own rule, evaluated here against the
 * server's view of the country) and an experiment is active. When either is
 * false the answer is `off` and the assignment cookie is deleted, so the next
 * document load is the default copy and nothing was measured.
 *
 *  - assign:     no cookie yet. Rolls once, sets the cookie. The visitor is not
 *                counted on this page view, because the copy they saw was the
 *                default whichever arm they drew -- counting only the control
 *                here would favour it.
 *  - exposure:   a landing page was shown. Counted only if the arm the page
 *                rendered is the arm in the cookie.
 *  - conversion: the primary call to action was clicked on such a page.
 *
 * The counters are page-session counts (the browser dedupes per session), not
 * unique visitors, and the report says so.
 */

const bodySchema = z
  .object({
    action: z.enum(["assign", "exposure", "conversion"]),
    consent: z.enum(["accepted", "declined", "unset"]),
    locale: z.enum(EXPERIMENT_LOCALES),
    renderedArm: experimentVariantIdSchema.optional(),
    /** The browser has already counted this session's exposure. */
    record: z.boolean().optional(),
  })
  .strict();

const makeResponder = (request: Request) => (
  body: Record<string, unknown>,
  init: { clearCookie?: boolean; setCookie?: { value: string; maxAge: number } } = {}
) => {
  const response = NextResponse.json(body, {
    headers: { "Cache-Control": "private, no-store" },
  });
  // Secure only where the visitor actually reached us over https (directly or
  // through the proxy chain): a Secure cookie set on plain http is dropped by
  // some browsers, and the local servers are plain http.
  const secure =
    request.headers.get("x-forwarded-proto") === "https" ||
    new URL(request.url).protocol === "https:";
  if (init.setCookie) {
    response.cookies.set({
      name: EXPERIMENT_COOKIE_NAME,
      value: init.setCookie.value,
      path: "/",
      maxAge: init.setCookie.maxAge,
      sameSite: "lax",
      secure,
      // The page reads it to know whether this load can be counted.
      httpOnly: false,
    });
  } else if (init.clearCookie) {
    response.cookies.set({
      name: EXPERIMENT_COOKIE_NAME,
      value: "",
      path: "/",
      maxAge: 0,
      sameSite: "lax",
      secure,
    });
  }
  return response;
};

// The state could not be read. That is not "the experiment ended": the cookie
// stays, so a visitor is not re-rolled into the other arm once storage
// recovers, and nothing is counted meanwhile. 503 is what the beacon reads as
// "show the default copy"; a failed count is a 500 and does not.
const unreadable = () =>
  NextResponse.json(
    { status: "error" },
    { status: 503, headers: { "Cache-Control": "private, no-store" } }
  );

export async function POST(request: Request) {
  const respond = makeResponder(request);
  try {
    const body = await readLimitedJson(request, 2 * 1024, bodySchema);

    const policy = resolveAnalyticsConsentPolicy(
      analyticsCountryFromHeaders(request.headers),
      process.env.ANALYTICS_DEFAULT_ENABLED_COUNTRIES
    );
    if (!experimentAnalyticsActive(body.consent, policy.mode)) {
      return respond({ status: "off" }, { clearCookie: true });
    }

    if (!isE2EDatabaseDisabled()) {
      try {
        await consumeApiRateLimit(
          request,
          `anonymous:${getAnonymousClientKey(request)}`,
          "marketing-experiment",
          { minute: 60, day: 2_000 }
        );
      } catch (error) {
        // A refusal (rate limit, origin) is the security layer's answer. Anything
        // else is the same database the state is read from being down, which is
        // an unreadable state like the one below: the beacon puts the default
        // copy on a variant page for it.
        if (apiSecurityResponse(error)) throw error;
        return unreadable();
      }
    }

    // No `now` passed: the read answers for the present and may be served from
    // its short per-instance cache, which a named time would bypass.
    const now = new Date();
    const read = await readActiveMarketingExperiment({ headers: request.headers });
    if (!read.ok) return unreadable();
    if (!read.active) {
      return respond({ status: "off" }, { clearCookie: true });
    }
    const { config } = read;
    const localeCovered = config.locales.includes(body.locale);

    const cookieHeader = request.headers.get("cookie") ?? "";
    const cookieValue = cookieHeader
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${EXPERIMENT_COOKIE_NAME}=`))
      ?.slice(EXPERIMENT_COOKIE_NAME.length + 1);
    const current = parseExperimentCookie(cookieValue);
    const currentIsValid =
      current !== null &&
      current.experimentId === config.experimentId &&
      current.bundleId === config.bundleId &&
      (current.arm === EXPERIMENT_CONTROL_ARM || current.arm === config.variantId) &&
      // The languages in the cookie are the registered ones, exactly.
      [...current.locales].sort().join(",") === [...config.locales].sort().join(",");

    if (body.action === "assign") {
      // A valid assignment is kept whatever language this page is in: the same
      // visitor may open a covered language next and must keep their arm. It is
      // exposure and conversion that stay out of an uncovered language, below.
      if (currentIsValid) {
        return respond({ status: "assigned", arm: current.arm });
      }
      if (!localeCovered) {
        // Nothing to draw for a language the variant has no copy in; a cookie
        // that does not belong to this experiment is dropped as usual.
        return respond({ status: "off" }, { clearCookie: cookieValue !== undefined });
      }
      const arm = pickExperimentArm(
        config,
        e2eForcedRoll(request.headers) ?? randomInt(0, 1_000_000) / 1_000_000
      );
      return respond(
        { status: "assigned", arm },
        {
          setCookie: {
            value: formatExperimentCookie({
              experimentId: config.experimentId,
              bundleId: config.bundleId,
              arm,
              locales: [...config.locales],
            }),
            maxAge: experimentCookieMaxAgeSeconds(config, now),
          },
        }
      );
    }

    // exposure / conversion
    if (!currentIsValid) {
      // A cookie from another experiment or a forged one: drop it, count nothing.
      return respond({ status: "off" }, { clearCookie: true });
    }
    // A valid assignment viewed in a language the experiment does not cover is
    // not a measurement, and not a reason to delete the assignment either: the
    // same visitor may come back to a covered language and must keep their arm.
    if (!localeCovered || body.renderedArm !== current.arm) {
      return respond({ status: "ignored", arm: current.arm });
    }
    if (body.action === "conversion" || body.record !== false) {
      await incrementExperimentCounter(config, current.arm, body.action);
    }
    return respond({ status: "recorded", arm: current.arm });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    // A failed count must never break a landing page: the beacon ignores it.
    return NextResponse.json(
      { status: "error" },
      { status: 500, headers: { "Cache-Control": "private, no-store" } }
    );
  }
}
