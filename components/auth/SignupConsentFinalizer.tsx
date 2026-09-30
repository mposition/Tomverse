"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { useEffect, useRef, useState } from "react";

import { useLanguage } from "@/components/LanguageProvider";
import {
  finalizeStoredSignupConsent,
  recordJurisdictionEstimateOnce,
} from "@/components/auth/signupConsentClient";

/**
 * After sign-in, hands the sign-up screen's stored choice to the server and
 * records the IP-estimated country for an account that has none (S4, draft
 * section 5.2 and 5.3 item 6).
 *
 * Only when the collection gate is on, which the server decides and passes in:
 * off, the page makes neither request.
 *
 * Renders one thing, once: when the sign-up screen was used to sign into an
 * account that already existed, the choice ticked there is not applied
 * (section 5.2), and section 5.2a says the landing tells the person so and
 * where to change it instead of dropping it silently.
 */
export function SignupConsentFinalizer({ enabled }: { enabled: boolean }) {
  const { status } = useSession();
  const { t } = useLanguage();
  const ran = useRef(false);
  const [existingAccount, setExistingAccount] = useState(false);
  useEffect(() => {
    if (!enabled || status !== "authenticated" || ran.current) return;
    ran.current = true;
    // A landing that consumed a sign-up choice has just recorded the estimate
    // the screen was rendered under; the per-session estimate is for existing
    // accounts, and running it here would overwrite that one at once. A choice
    // refused or rolled back recorded nothing, so the estimate still runs.
    void finalizeStoredSignupConsent().then((outcome) => {
      if (outcome.existingAccount) setExistingAccount(true);
      return outcome.consumed ? undefined : recordJurisdictionEstimateOnce();
    });
  }, [enabled, status]);

  if (!existingAccount) return null;
  return (
    <div
      role="status"
      data-testid="signup-existing-account-notice"
      className="fixed inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 mx-auto flex max-w-md items-start gap-3 rounded-2xl border border-zinc-200 bg-white p-4 text-sm leading-6 text-zinc-700 shadow-xl dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
    >
      <p className="flex-1">
        {t("auth.existingAccountSignedIn")}{" "}
        <Link
          href="/settings/notifications"
          className="font-semibold text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
        >
          {t("auth.existingAccountSettingsLink")}
        </Link>
      </p>
      <button
        type="button"
        onClick={() => setExistingAccount(false)}
        className="-m-2 inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl text-sm font-semibold text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
      >
        {t("auth.existingAccountDismiss")}
      </button>
    </div>
  );
}
