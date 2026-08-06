"use client";

import { signOut } from "next-auth/react";
import { Loader2, LogOut } from "lucide-react";
import { useState } from "react";

/**
 * Ends the current Tomverse session and returns to sign-in with the visitor's
 * original destination preserved.
 *
 * Why a button and not a `<Link href="/auth/signin">`: the sign-in page
 * forwards an already-authenticated visitor straight to `callbackUrl`, so a
 * plain link from a 404 that was *caused* by the current identity would bounce
 * back to the same 404. The session has to be gone before the sign-in page is
 * reached, which only a real sign-out can do.
 *
 * It is deliberately independent of `SessionProvider`: the not-found boundary
 * renders above the application layout that mounts one, and `signOut()` from
 * `next-auth/react` needs no context -- it fetches its own CSRF token.
 */
export function SignOutAndSwitchAccountButton({
  signInHref,
}: {
  /**
   * Already normalized by `accountSwitchSignInHref`. It is an internal,
   * relative path, so this component never composes a URL from request input
   * itself.
   */
  signInHref: string;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const switchAccount = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      // `redirect: false` so the destination is this component's own vetted
      // href rather than whatever the sign-out endpoint resolves, and so a
      // failure is observable here instead of ending as a navigation.
      await signOut({ redirect: false });
      // A full document load, not a router push: it drops every piece of
      // client state the previous identity left in memory. Nothing here
      // touches `localStorage`, which also holds the language preference and
      // guest conversations -- ending a session is not a reason to erase them.
      window.location.assign(signInHref);
    } catch {
      setSubmitting(false);
      setError("Could not end the current session. Please try again.");
    }
  };

  return (
    <div className="flex w-full flex-col items-center gap-3">
      <button
        type="button"
        data-testid="not-found-switch-account"
        onClick={() => void switchAccount()}
        disabled={submitting}
        aria-busy={submitting}
        aria-describedby={error ? "not-found-switch-account-error" : undefined}
        className="flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-blue-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-wait disabled:opacity-70"
      >
        {submitting ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <LogOut className="h-4 w-4" aria-hidden="true" />
        )}
        {submitting ? "Signing out…" : "Sign out and use another account"}
      </button>
      {error ? (
        <p
          id="not-found-switch-account-error"
          role="alert"
          className="max-w-md text-sm font-semibold text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
