"use client";

import { useEffect } from "react";
import { ANALYTICS_CONSENT_STORAGE_KEY } from "@/lib/productAnalyticsShared";
import {
  EXPERIMENT_CONTROL_ARM,
  EXPERIMENT_COOKIE_NAME,
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
// language, and never longer: one given to a visitor who had not yet decided
// says nothing about the visitor who has, one given for a language the
// experiment does not cover says nothing about the next page, and one given
// before an experiment started says nothing about the one that starts after.
const PROBE_OFF_KEY = "tomverse_experiment_off_v1";
const PROBE_OFF_TTL_MS = 10 * 60 * 1000;
const RELOAD_KEY = "tomverse_experiment_reload_v1";

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
};

const probeIsOff = (key: string) => {
  const stored = Number(session.get(key));
  return Number.isFinite(stored) && stored > 0 && Date.now() - stored < PROBE_OFF_TTL_MS;
};

const leaveVariant = (renderedArm: string) => {
  if (renderedArm === EXPERIMENT_CONTROL_ARM) return;
  // Once per session: a cookie the route could not delete must not loop.
  if (session.get(RELOAD_KEY)) return;
  session.set(RELOAD_KEY, "1");
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
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null) as Promise<{ status?: string; arm?: string } | null>;

    // A visitor can decline while a request is in flight, and the answer's
    // Set-Cookie is applied when it arrives -- after the decline deleted the
    // cookie. So every answer is followed by a look at the consent as it is now.
    const withdrawn = () => {
      if (readConsent() !== "declined") return false;
      clearCookie();
      leaveVariant(renderedArm);
      return true;
    };

    const run = async () => {
      const cookieValue = readCookie();
      const consent = readConsent();
      const probeKey = `${PROBE_OFF_KEY}_${consent}_${locale}`;
      if (consent === "declined") {
        if (cookieValue) {
          clearCookie();
          leaveVariant(renderedArm);
        }
        return;
      }
      if (!cookieValue && probeIsOff(probeKey)) return;

      if (!cookieValue) {
        const assigned = await post("assign");
        if (withdrawn()) return;
        // Only a definite "off" is remembered; a failed request is retried.
        if (assigned?.status === "off") session.set(probeKey, String(Date.now()));
        return;
      }

      const assignment = parseExperimentCookie(cookieValue);
      const alreadyCounted = assignment
        ? session.get(`tomverse_experiment_exposed_${assignment.experimentId}`)
        : null;
      const result = await post("exposure", { record: !alreadyCounted });
      if (cancelled) return;
      if (withdrawn()) return;
      if (!result || result.status === "error") return;
      if (result.status === "off") {
        session.set(probeKey, String(Date.now()));
        clearCookie();
        leaveVariant(renderedArm);
        return;
      }
      if (result.status !== "recorded" || !assignment) return;

      session.set(`tomverse_experiment_exposed_${assignment.experimentId}`, "1");
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
        // Remembered once the server has it, so a click lost to a bad
        // connection is counted by the next one instead of never.
        converting = true;
        void post("conversion").then((answer) => {
          converting = false;
          if (answer?.status === "recorded") session.set(conversionKey, "1");
        });
      };
      document.addEventListener("click", onClick, true);
    };

    void run();
    return () => {
      cancelled = true;
      if (onClick) document.removeEventListener("click", onClick, true);
    };
  }, [renderedArm, locale]);

  return null;
}
