"use client";

import Link from "next/link";
import { signOut } from "next-auth/react";
import { KeyRound, Loader2, LogIn, ShieldCheck } from "lucide-react";
import { useState } from "react";
import {
  adminReauthenticationSignInHref,
  type AdminReauthenticationReason,
} from "@/lib/adminReauthenticationCore";

/**
 * What each window's expiry actually means, in the operator's terms.
 *
 * One sentence covered both before, and it was the console-session one -- so
 * an operator who had just been refused a save was told their "administrator
 * authentication window" had expired while the console around them kept
 * working, which reads as a contradiction rather than an instruction. The
 * facts that are true either way (a refresh renews nothing, the app session
 * has to end, the original screen is where you come back to, and nothing
 * pending is replayed) are stated once, below, for both.
 */
const COPY: Record<
  AdminReauthenticationReason,
  { eyebrow: string; title: string; lead: string }
> = {
  "admin-session": {
    eyebrow: "Administrator session expired",
    title: "Administrator reauthentication required",
    lead: "Your normal Tomverse session is still active, but the shorter administrator session that opens the Admin Console has expired.",
  },
  "recent-auth": {
    eyebrow: "High-risk action needs a fresh sign-in",
    title: "Sign in again to make this change",
    lead: "Your Admin Console session is still valid. High-risk changes need a more recent sign-in than that, and this one is no longer recent enough, so the change was refused and nothing was saved.",
  },
};

export function AdminReauthenticationCard({
  callbackUrl,
  email,
  reason = "admin-session",
}: {
  callbackUrl: string;
  email: string | null;
  /** Which window expired; decided server-side, never from the browser. */
  reason?: AdminReauthenticationReason;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = COPY[reason];

  const reauthenticate = async () => {
    setSubmitting(true);
    setError(null);
    // The callback was normalized on the server before it reached this
    // component, so it is always a path under /admin.
    const signInUrl = adminReauthenticationSignInHref(callbackUrl, reason);
    try {
      await signOut({ callbackUrl: signInUrl });
    } catch {
      setSubmitting(false);
      setError("Could not end the current session. Please try again.");
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 px-4 py-12 text-white">
      <section
        data-testid="admin-reauthentication-card"
        data-reason={reason}
        className="w-full max-w-lg overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-900 shadow-2xl shadow-black/40"
      >
        <div className="border-b border-zinc-800 bg-gradient-to-br from-blue-500/15 via-zinc-900 to-zinc-900 px-7 py-8 sm:px-9">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-blue-400/20 bg-blue-500/15 text-blue-300">
            <KeyRound className="h-7 w-7" aria-hidden="true" />
          </div>
          <p className="mt-6 text-xs font-bold uppercase tracking-[0.2em] text-blue-300">
            {copy.eyebrow}
          </p>
          <h1 className="mt-3 text-3xl font-black tracking-tight">
            {copy.title}
          </h1>
          <p className="mt-4 text-sm leading-6 text-zinc-300">{copy.lead}</p>
        </div>

        <div className="space-y-6 px-7 py-7 sm:px-9">
          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm leading-6 text-amber-100">
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
              <div>
                <p>
                  A browser refresh cannot renew administrator authentication.
                  Sign out of the current app session completely, then sign in
                  again to continue securely.
                </p>
                <p className="mt-2">
                  You will come back to the Admin Console screen you started
                  from. Nothing you had not saved is carried over or re-sent --
                  review the change there and submit it again.
                </p>
              </div>
            </div>
          </div>

          {email ? (
            <p className="text-sm text-zinc-400">
              Current account: <span className="font-semibold text-zinc-200">{email}</span>
            </p>
          ) : null}

          {error ? (
            <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              {error}
            </p>
          ) : null}

          <button
            type="button"
            data-testid="admin-reauthentication-submit"
            onClick={() => void reauthenticate()}
            disabled={submitting}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-3.5 text-sm font-bold text-white transition hover:bg-blue-500 disabled:cursor-wait disabled:opacity-70"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <LogIn className="h-4 w-4" aria-hidden="true" />
            )}
            {submitting ? "Signing out…" : "Sign out and reauthenticate"}
          </button>

          <Link
            href="/"
            className="flex w-full items-center justify-center rounded-xl border border-zinc-700 px-5 py-3 text-sm font-semibold text-zinc-300 transition hover:border-zinc-600 hover:bg-zinc-800 hover:text-white"
          >
            Return to Tomverse
          </Link>
        </div>
      </section>
    </main>
  );
}
