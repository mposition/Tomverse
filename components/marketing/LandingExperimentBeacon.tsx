"use client";

import { useEffect } from "react";
import { LANDING_EXPERIMENT_LOCALES } from "@/components/marketing/landingExperimentBundles";
import { ANALYTICS_CONSENT_STORAGE_KEY } from "@/lib/productAnalyticsShared";
import {
  EXPERIMENT_CONTROL_ARM,
  EXPERIMENT_COOKIE_NAME,
  EXPERIMENT_HOLD_COOKIE_NAME,
  EXPERIMENT_HOLD_SECONDS,
  parseExperimentCookie,
} from "@/lib/marketingRoutes";

/**
 * The browser half of a landing experiment (policy 9.1).
 *
 * It renders nothing and sits on every home page, the default one and each
 * variant. It never decides anything itself: it reports what the page
 * rendered and what the visitor consented to, and the route answers. The three
 * outcomes that matter:
 *
 *  - no cookie: ask the route to assign. Nothing is counted on this view, the
 *    copy shown was the default whichever arm was drawn.
 *  - a cookie: ask the route to validate it and, when the arm this page
 *    rendered is the arm in the cookie, count one exposure per browser session.
 *    A click on the primary call to action is counted once per session too.
 *  - `off` (experiment stopped, consent withdrawn, switch off): the route has
 *    deleted the cookie. A variant page reloads once so the visitor lands on
 *    the default copy instead of staying on a variant.
 *
 * Consent is read from the same storage key the consent provider writes. A
 * visitor who declined never calls the route at all; the cookie is deleted
 * here and a variant page reloads.
 */

type Props = {
  /** `control` on the default page, the variant id on a variant page. */
  renderedArm: string;
  locale: string;
};

// An answer of "off" is remembered for a short while, per consent state and per
// language: one given to a visitor who had not yet decided says nothing about
// the visitor who has, and one given for a language the experiment does not
// cover says nothing about the next page. It does not know which experiment it
// was about, so one that starts inside the window is missed by this tab until
// the window closes -- at most ten minutes, which is why it is that short.
const PROBE_OFF_KEY = "tomverse_experiment_off_v1";
const PROBE_OFF_TTL_MS = 10 * 60 * 1000;
const RELOAD_KEY = "tomverse_experiment_reload_v1";
const HOLD_RELOAD_KEY = "tomverse_experiment_hold_reload_v1";

const readConsent = (): "accepted" | "declined" | "unset" => {
  try {
    const stored = window.localStorage.getItem(ANALYTICS_CONSENT_STORAGE_KEY);
    return stored === "accepted" || stored === "declined" ? stored : "unset";
  } catch {
    return "unset";
  }
};

const readCookie = () => {
  const entry = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${EXPERIMENT_COOKIE_NAME}=`));
  return entry ? entry.slice(EXPERIMENT_COOKIE_NAME.length + 1) : null;
};

const clearCookie = () => {
  document.cookie = `${EXPERIMENT_COOKIE_NAME}=; Max-Age=0; Path=/; SameSite=Lax`;
  document.cookie = `${EXPERIMENT_HOLD_COOKIE_NAME}=; Max-Age=0; Path=/; SameSite=Lax`;
};

const session = {
  get: (key: string) => {
    try {
      return window.sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string) => {
    try {
      window.sessionStorage.setItem(key, value);
    } catch {
      // Without session storage the browser simply counts more than once.
    }
  },
  remove: (key: string) => {
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      // Nothing was stored, so nothing needs removing.
    }
  },
};

const probeIsOff = (key: string) => {
  const stored = Number(session.get(key));
  return Number.isFinite(stored) && stored > 0 && Date.now() - stored < PROBE_OFF_TTL_MS;
};

const leaveVariant = (renderedArm: string, experimentId: string | null) => {
  if (renderedArm === EXPERIMENT_CONTROL_ARM) return;
  // Once per assignment: a cookie the route could not delete must not loop, and
  // a tab that already left one experiment must still be able to leave the next.
  const key = `${RELOAD_KEY}_${experimentId ?? "unknown"}`;
  if (session.get(key)) return;
  session.set(key, "1");
  window.location.reload();
};

// The experiment state could not be read while a variant is showing. Policy 9.1
// answers a failed read with the default copy, and the assignment cookie must
// stay (a visitor is not re-rolled once storage recovers), so the cookie is
// left alone and a short hold cookie tells the proxy to serve the default page.
// One reload per hold window: the hold outlives it, so no loop is possible.
const holdVariant = (renderedArm: string) => {
  if (renderedArm === EXPERIMENT_CONTROL_ARM) return;
  document.cookie = `${EXPERIMENT_HOLD_COOKIE_NAME}=1; Max-Age=${EXPERIMENT_HOLD_SECONDS}; Path=/; SameSite=Lax`;
  const stored = Number(session.get(HOLD_RELOAD_KEY));
  if (
    Number.isFinite(stored) &&
    stored > 0 &&
    Date.now() - stored < EXPERIMENT_HOLD_SECONDS * 1000
  ) {
    return;
  }
  session.set(HOLD_RELOAD_KEY, String(Date.now()));
  window.location.reload();
};

export function LandingExperimentBeacon({ renderedArm, locale }: Props) {
  useEffect(() => {
    let cancelled = false;
    let onClick: ((event: MouseEvent) => void) | null = null;

    const post = (
      action: "assign" | "exposure" | "conversion",
      extra: { record?: boolean } = {}
    ) =>
      fetch("/api/marketing/experiments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        keepalive: action === "conversion",
        body: JSON.stringify({
          action,
          consent: readConsent(),
          locale,
          renderedArm,
          ...extra,
        }),
      })
        // A refusal the server wrote (unreadable state, a failed count, a rate
        // limit) is a definite "not counted" and says so; only a request that
        // got no answer at all is unknown, and is null.
        .then((response) =>
          response.ok ? response.json() : { status: "error", http: response.status }
        )
        .catch(() => null) as Promise<{
        status?: string;
        arm?: string;
        http?: number;
      } | null>;

    // A visitor can decline while a request is in flight, and the answer's
    // Set-Cookie is applied when it arrives -- after the decline deleted the
    // cookie. So every answer is followed by a look at the consent as it is now.
    const withdrawn = (experimentId: string | null) => {
      if (readConsent() !== "declined") return false;
      clearCookie();
      leaveVariant(renderedArm, experimentId);
      return true;
    };

    const run = async () => {
      // A language no experiment can cover has nothing to assign or measure,
      // and the route would refuse it: stay silent.
      if (!(LANDING_EXPERIMENT_LOCALES as readonly string[]).includes(locale)) return;
      const cookieValue = readCookie();
      const consent = readConsent();
      const probeKey = `${PROBE_OFF_KEY}_${consent}_${locale}`;
      if (consent === "declined") {
        if (cookieValue) {
          clearCookie();
          leaveVariant(renderedArm, parseExperimentCookie(cookieValue)?.experimentId ?? null);
        }
        return;
      }
      if (!cookieValue && probeIsOff(probeKey)) return;

      if (!cookieValue) {
        const assigned = await post("assign");
        if (withdrawn(null)) return;
        // Only a definite "off" is remembered; a failed request is retried.
        if (assigned?.status === "off") session.set(probeKey, String(Date.now()));
        return;
      }

      const assignment = parseExperimentCookie(cookieValue);
      const experimentId = assignment?.experimentId ?? null;

      // Only a page that can be measured is measured: it shows the arm the
      // visitor was assigned, in a language the assignment was registered for.
      // Anything else still asks the route to validate the cookie, but sets no
      // listener and no flag -- a click there is not a conversion, and a flag
      // for it would swallow the one that is, on the next measurable page.
      const measurable =
        assignment !== null &&
        assignment.arm === renderedArm &&
        assignment.locales.includes(locale);

      // The click listener goes up before the exposure request goes out. The
      // answer can take as long as a database read, and a visitor who clicks
      // the call to action in that time is gone from this page before it
      // arrives. The route validates the cookie and the rendered arm itself,
      // so nothing needs the exposure to have been confirmed first.
      if (assignment && measurable) {
        const conversionKey = `tomverse_experiment_converted_${assignment.experimentId}`;
        let converting = false;
        onClick = (event) => {
          const target = event.target;
          if (
            !(target instanceof Element) ||
            !target.closest("#landing-hero-primary") ||
            converting ||
            session.get(conversionKey)
          ) {
            return;
          }
          // Remembered when the request goes out, and taken back only for an
          // answer that says it was not counted. The call to action leaves
          // this document: the request is kept alive and the server counts
          // it, but the promise in this document is rejected as it unloads,
          // which is indistinguishable here from a request that got no answer.
          // Treating that as a failure would let the next visit's click count
          // a second time, in one arm more than the other. A click lost to a
          // bad connection is the smaller error, and it is said to be one:
          // the figures are page sessions counted in the browser.
          converting = true;
          session.set(conversionKey, "1");
          void post("conversion").then((answer) => {
            converting = false;
            // Taken back only for an answer that says it was not counted.
            if (answer?.status === "error") session.remove(conversionKey);
          });
        };
        document.addEventListener("click", onClick, true);
      }
      const detachClick = () => {
        if (onClick) document.removeEventListener("click", onClick, true);
        onClick = null;
      };

      // The same rule for the exposure: remembered when it is sent, so a page
      // that goes away with the request in flight does not count again on the
      // next view. Taken back only when an answer arrives and says the visit
      // was not counted; no answer proves nothing, as above.
      const exposedKey =
        assignment && measurable
          ? `tomverse_experiment_exposed_${assignment.experimentId}`
          : null;
      const alreadyCounted = exposedKey ? session.get(exposedKey) : null;
      if (exposedKey && !alreadyCounted) session.set(exposedKey, "1");
      const retract = () => {
        if (exposedKey && !alreadyCounted) session.remove(exposedKey);
      };
      const result = await post("exposure", { record: measurable && !alreadyCounted });
      if (cancelled) return;
      if (withdrawn(experimentId)) {
        retract();
        detachClick();
        return;
      }
      if (!result) return;
      if (result.status === "error") {
        retract();
        if (result.http === 503) {
          detachClick();
          holdVariant(renderedArm);
        }
        return;
      }
      if (result.status === "off") {
        retract();
        detachClick();
        // No memo here: this "off" may only mean the cookie was stale, and the
        // visitor is owed a fresh assignment on the next view if an experiment
        // is running. The next view's assign answer is what gets remembered.
        clearCookie();
        leaveVariant(renderedArm, experimentId);
        return;
      }
      if (result.status !== "recorded" || !assignment) {
        retract();
        detachClick();
      }
    };

    void run();
    return () => {
      cancelled = true;
      if (onClick) document.removeEventListener("click", onClick, true);
    };
  }, [renderedArm, locale]);

  return null;
}
