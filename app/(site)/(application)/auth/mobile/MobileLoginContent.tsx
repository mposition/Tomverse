"use client";
import { useState } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import { mobileCopy } from "@/locales/mobile";

export function MobileLoginContent({ challenge, state }: { challenge: string; state: string }) {
  const { lang } = useLanguage(); const copy = mobileCopy[lang];
  const [pending, setPending] = useState(false); const [error, setError] = useState(false); const [callback, setCallback] = useState<string | null>(null);
  async function continueToApp() {
    if (pending) return;
    setPending(true); setError(false);
    try {
      const response = await fetch("/api/auth/mobile/login-grant", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ codeChallengeMethod: "S256", codeChallenge: challenge }), redirect: "error", cache: "no-store" });
      const body = await response.json();
      if (!response.ok || typeof body.grant !== "string") throw Error("GRANT_UNAVAILABLE");
      // Only a short-lived, single-use PKCE grant crosses this claimed HTTPS link.
      // Access and rotating credentials never enter a URL or this browser page.
      setCallback(`/auth/mobile/callback#${new URLSearchParams({ grant: body.grant, state })}`);
    } catch { setError(true); }
    finally { setPending(false); }
  }
  return <main className="mx-auto flex min-h-[70dvh] max-w-md flex-col justify-center gap-6 p-8">
    {/* eslint-disable-next-line @next/next/no-img-element -- Same public brand asset as the native bundle. */}
    <img src="/tomverse-logo.png" alt="Tomverse" width={80} height={80} className="rounded-2xl" />
    <h1 className="text-2xl font-semibold">{copy.signIn}</h1>
    {error && <p role="alert">{copy.error}</p>}
    {callback ? <a href={callback} className="rounded-xl bg-blue-600 px-5 py-3 text-center text-white">{copy.openApp} ↗</a>
      : <button disabled={pending} onClick={() => void continueToApp()} className="rounded-xl bg-blue-600 px-5 py-3 text-white disabled:opacity-50">{pending ? copy.loading : copy.signIn}</button>}
  </main>;
}
