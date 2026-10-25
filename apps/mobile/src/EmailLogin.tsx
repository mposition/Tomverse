import { useEffect, useRef, useState } from "react";
import { mobileLoginCopy, mobileLoginError } from "../../../locales/mobileLogin";
import { mobileCopy, type MobileLanguage } from "../../../locales/mobile";
import type { ChatTransport } from "./chatTransport";
import { Sheet } from "./Sheet";

export function EmailLogin({ transport, language, onClose, onComplete }: {
  transport: ChatTransport; language: MobileLanguage; onClose: () => void; onComplete: () => Promise<void>;
}) {
  const copy = mobileLoginCopy[language];
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const active = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { if (!cooldown) return; const timer = setTimeout(() => setCooldown(cooldown - 1), 1000); return () => clearTimeout(timer); }, [cooldown]);
  async function submit(verify: boolean | "browser") {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      if (verify === "browser") {
        await transport.signIn();
        if (active.current) await onComplete();
      } else if (verify) {
        await transport.verifyEmailCode!(email.trim(), code);
        if (active.current) await onComplete();
      } else {
        await transport.requestEmailCode!(email.trim(), language);
        if (active.current) { setSent(true); setCode(""); setCooldown(60); }
      }
    } catch (failure) {
      if (active.current) { setError(mobileLoginError(failure, language, verify === "browser" ? "browser" : verify ? "verify" : "request")); setCode(""); }
    } finally { inFlight.current = false; if (active.current) setBusy(false); }
  }
  return <Sheet title={copy.title} closeLabel={mobileCopy[language].close} onClose={() => { if (!inFlight.current) onClose(); }}>
    <form className="email-login" onSubmit={(event) => { event.preventDefault(); void submit(sent); }} aria-busy={busy}>
      <p>{sent ? copy.sent : copy.intro}</p>
      <label>{copy.email}<input type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} required maxLength={254} value={email} readOnly={sent} disabled={busy} onChange={(event) => setEmail(event.target.value)} /></label>
      {sent && <label>{copy.code}<input className="email-code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required maxLength={6} value={code} disabled={busy} onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, ""))} /></label>}
      {error && <p role="alert" className="login-error">{error}</p>}
      <button className="primary" type="submit" disabled={busy || (sent && code.length !== 6)}>{busy ? mobileCopy[language].loading : sent ? copy.verify : copy.send}</button>
      {sent && <div className="login-actions"><button type="button" disabled={busy} onClick={() => { setSent(false); setCode(""); setError(""); }}>{copy.change}</button><button type="button" disabled={busy || cooldown > 0} onClick={() => void submit(false)}>{copy.resend}{cooldown > 0 && ` (${cooldown})`}</button></div>}
      <button type="button" disabled={busy} onClick={() => void submit("browser")}>{copy.otherSignIn}</button>
    </form>
  </Sheet>;
}
