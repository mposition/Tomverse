"use client";

import Link from "next/link";
import { signOut } from "next-auth/react";
import { KeyRound, Loader2, LogIn, ShieldCheck } from "lucide-react";
import { useState } from "react";

export function AdminReauthenticationCard({
  callbackUrl,
  email,
}: {
  callbackUrl: string;
  email: string | null;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reauthenticate = async () => {
    setSubmitting(true);
    setError(null);
    const signInUrl = `/auth/signin?callbackUrl=${encodeURIComponent(
      callbackUrl
    )}&reason=admin-session-expired`;
    try {
      await signOut({ callbackUrl: signInUrl });
    } catch {
      setSubmitting(false);
      setError("Could not end the current session. Please try again.");
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 px-4 py-12 text-white">
      <section className="w-full max-w-lg overflow-hidden rounded-3xl border border-zinc-800 bg-zinc-900 shadow-2xl shadow-black/40">
        <div className="border-b border-zinc-800 bg-gradient-to-br from-blue-500/15 via-zinc-900 to-zinc-900 px-7 py-8 sm:px-9">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-blue-400/20 bg-blue-500/15 text-blue-300">
            <KeyRound className="h-7 w-7" aria-hidden="true" />
          </div>
          <p className="mt-6 text-xs font-black uppercase tracking-[0.2em] text-blue-300">
            Tomverse Admin Console
          </p>
          <h1 className="mt-3 text-3xl font-black tracking-tight">
            Administrator reauthentication required
          </h1>
          <p className="mt-4 text-sm leading-6 text-zinc-300">
            Your normal Tomverse session is still active, but the shorter
            administrator authentication window has expired.
          </p>
        </div>

        <div className="space-y-6 px-7 py-7 sm:px-9">
          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm leading-6 text-amber-100">
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
              <p>
                A browser refresh cannot renew administrator authentication.
                Sign out completely, then sign in again to continue securely.
              </p>
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
