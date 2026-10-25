"use client";
import { useEffect, useRef, useState } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import { mobileCopy } from "@/locales/mobile";

export function MobileLoginContent({ challenge, state }: { challenge: string; state: string }) {
  const { lang } = useLanguage(); const copy = mobileCopy[lang];
  const [error, setError] = useState(false);
  const attempt = useRef<{ key: string; result: Promise<string> } | null>(null);
  useEffect(() => {
    let active = true;
    const key = `${challenge}:${state}`;
    if (attempt.current?.key !== key) attempt.current = { key, result: (async () => {
      const response = await fetch("/api/auth/mobile/login-grant", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ codeChallengeMethod: "S256", codeChallenge: challenge }), redirect: "error", cache: "no-store" });
      const body = await response.json();
      if (!response.ok || typeof body.grant !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.grant)) throw Error("GRANT_UNAVAILABLE");
      // Only a short-lived, single-use PKCE grant crosses this claimed HTTPS link.
      // Access and rotating credentials never enter a URL or this browser page.
      return `/auth/mobile/callback#${new URLSearchParams({ grant: body.grant, state })}`;
    })() };
    // StrictMode can replay the effect. Share its single-use POST, but only the
    // active effect may navigate; an unmounted or superseded request cannot.
    void attempt.current.result.then((callback) => { if (active) location.replace(callback); })
      .catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [challenge, state]);
  return <main className="mx-auto flex min-h-[70dvh] max-w-md flex-col justify-center gap-6 p-8">
    {/* eslint-disable-next-line @next/next/no-img-element -- Same public brand asset as the native bundle. */}
    <img src="/tomverse-logo.png" alt="Tomverse" width={80} height={80} className="rounded-2xl" />
    <h1 className="text-2xl font-semibold">{copy.signIn}</h1>
    {error ? <p role="alert">{copy.error}</p> : <p role="status">{copy.loading}</p>}
  </main>;
}
