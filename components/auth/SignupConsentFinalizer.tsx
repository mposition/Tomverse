"use client";

import { useSession } from "next-auth/react";
import { useEffect, useRef } from "react";

import {
  finalizeStoredSignupConsent,
  recordJurisdictionEstimateOnce,
} from "@/components/auth/signupConsentClient";

/**
 * After sign-in, hands the sign-up screen's stored choice to the server and
 * records the IP-estimated country for an account that has none (S4, draft
 * section 5.2 and 5.3 item 6). Renders nothing.
 *
 * Only when the collection gate is on, which the server decides and passes in:
 * off, the page makes neither request.
 */
export function SignupConsentFinalizer({ enabled }: { enabled: boolean }) {
  const { status } = useSession();
  const ran = useRef(false);
  useEffect(() => {
    if (!enabled || status !== "authenticated" || ran.current) return;
    ran.current = true;
    // A landing that consumed a sign-up choice has just recorded the estimate
    // the screen was rendered under; the per-session estimate is for existing
    // accounts, and running it here would overwrite that one at once. A choice
    // refused or rolled back recorded nothing, so the estimate still runs.
    void finalizeStoredSignupConsent().then((consumed) =>
      consumed ? undefined : recordJurisdictionEstimateOnce()
    );
  }, [enabled, status]);
  return null;
}
