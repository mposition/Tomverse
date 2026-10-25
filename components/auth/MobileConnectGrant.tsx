"use client";

import { useEffect, useState } from "react";
import { mobileChatCopy } from "@/locales/mobileChat";
import { useLanguage } from "@/components/LanguageProvider";

export const MobileConnectGrant = ({ challenge }: { challenge: string }) => {
  const { lang } = useLanguage();
  const copy = mobileChatCopy(lang);
  const [grant, setGrant] = useState("");
  const [expiresAt, setExpiresAt] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setTimeout(() => { setGrant(""); setExpiresAt(0); setError(copy.expired); }, Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [expiresAt, copy.expired]);
  const create = async () => {
    if (pending) return;
    setPending(true); setError(""); setGrant("");
    try {
      const response = await fetch("/api/auth/mobile/login-grant", {
        method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ codeChallengeMethod: "S256", codeChallenge: challenge }),
      });
      if (!response.ok) throw new Error("grant refused");
      const result = await response.json() as { grant?: unknown; expiresIn?: unknown };
      if (typeof result.grant !== "string" || typeof result.expiresIn !== "number") throw new Error("invalid grant");
      setGrant(result.grant); setExpiresAt(Date.now() + Math.min(result.expiresIn, 60) * 1_000);
    } catch { setError(copy.createError); }
    finally { setPending(false); }
  };
  return <main className="mx-auto max-w-xl p-6">
    <h1 className="mb-4 text-2xl font-semibold">{copy.grantTitle}</h1>
    <p className="mb-6">{copy.grantNote}</p>
    <button type="button" disabled={pending} onClick={() => { void create(); }} className="min-h-11 rounded-xl bg-blue-600 px-5 py-2 text-white disabled:opacity-50" data-testid="mobile-create-code">{copy.createCode}</button>
    {grant && <div className="mt-6 space-y-3" role="status">
      <label htmlFor="mobile-pairing-code">{copy.code}</label>
      <input id="mobile-pairing-code" readOnly value={grant} autoComplete="off" spellCheck={false} onFocus={(event) => event.target.select()} className="w-full rounded-lg border p-3 font-mono" />
      <p>{copy.codeNote}</p>
    </div>}
    {error && <p className="mt-4" role="alert">{error}</p>}
  </main>;
};
