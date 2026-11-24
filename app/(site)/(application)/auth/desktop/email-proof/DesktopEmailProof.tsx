"use client";

import { useState } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import { TurnstileFormSlot } from "@/components/chat/TurnstileFormSlot";
import { useTurnstile } from "@/components/chat/useTurnstile";

export function DesktopEmailProof({ siteKey }: { siteKey?: string }) {
  const { t } = useLanguage();
  const proof = useTurnstile(true, "email_login_request", siteKey);
  const [working, setWorking] = useState(false);
  function finish(result: { token: string } | { cancel: string }) {
    const state = new URLSearchParams(location.hash.slice(1)).get("state");
    if (state && /^[a-f0-9-]{36}$/.test(state)) location.hash = new URLSearchParams({ state, ...result }).toString();
  }
  async function verify() {
    setWorking(true);
    try {
      const token = await proof.getToken();
      if (token) finish({ token });
      else finish({ cancel: "1" });
    } catch {
      // The form slot presents the failed verification and retry action.
    } finally { setWorking(false); }
  }

  return <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-white p-5 text-center text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
    <h1 className="text-lg font-semibold">{t("chat.guestVerificationTitle")}</h1>
    <button type="button" disabled={working} onClick={() => void verify()}
      className="rounded-lg bg-blue-600 px-4 py-2 text-white disabled:opacity-60">{t("auth.emailLoginVerifyButton")}</button>
    <TurnstileFormSlot containerRef={proof.containerRef} isChallengeVisible={proof.isChallengeVisible}
      failure={proof.failure} surface="emailLogin" onRetry={() => void verify()} />
    <button type="button" className="text-sm underline" onClick={() => { proof.cancel(); finish({ cancel: "1" }); }}>
      {t("common.cancel")}
    </button>
  </main>;
}
