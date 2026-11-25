/* eslint-disable @next/next/no-img-element -- Vite bundles the Electron login assets. */
import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, Mail, X } from "lucide-react";
import { isValidLoginEmail, MAX_LOGIN_EMAIL_LENGTH } from "../../../../lib/emailValidation";
import { desktopControlsCopy } from "../../../../locales/desktopControls";
import { desktopLoginCopy } from "../../../../locales/desktopLogin";
import logo from "../../../../public/tomverse-logo.png";
import apple from "../../../../public/auth/apple.svg?no-inline";
import google from "./google-account.svg?no-inline";
import type { DesktopEmailResult, DesktopLoginEmail, DesktopLoginState, LoginApi } from "../login-contract";

declare global { interface Window { loginHost: LoginApi } }

const providers = [
  { id: "apple", name: "Apple", icon: <img className="login-apple" width="18" height="18" src={apple} alt="" /> },
  { id: "google", name: "Google", icon: <img width="18" height="18" src={google} alt="" /> },
  { id: "azure-ad", name: "Microsoft", icon: <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true">
    <rect x="1" y="1" width="9" height="9" fill="#f25022" /><rect x="11" y="1" width="9" height="9" fill="#7fba00" />
    <rect x="1" y="11" width="9" height="9" fill="#00a4ef" /><rect x="11" y="11" width="9" height="9" fill="#ffb900" />
  </svg> },
] as const;

export function Login() {
  const [state, setState] = useState<DesktopLoginState>();
  const [step, setStep] = useState<"methods" | "address" | "code">("methods");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [quitting, setQuitting] = useState(false);
  const [failure, setFailure] = useState<Extract<DesktopEmailResult, { ok: false }>["status"]>();
  const [retryAfter, setRetryAfter] = useState(0);
  const language = state?.language ?? "en";
  const copy = desktopLoginCopy[language];
  const controls = desktopControlsCopy[language];
  const waiting = state?.account.stage === "waiting";
  const normalizedEmail = email.trim();
  const canSend = !busy && !quitting && !retryAfter && isValidLoginEmail(normalizedEmail);

  useEffect(() => {
    const unsubscribe = window.loginHost.subscribe(setState);
    void window.loginHost.state().then(setState, () => setFailure("failed"));
    return unsubscribe;
  }, []);
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);
  useEffect(() => {
    if (!retryAfter) return;
    const timer = setTimeout(() => setRetryAfter(0), retryAfter * 1_000);
    return () => clearTimeout(timer);
  }, [retryAfter]);

  async function submit(input: DesktopLoginEmail) {
    setBusy(true);
    setFailure(undefined);
    try {
      const result = await window.loginHost.email(input);
      if (!result.ok) {
        setFailure(result.status);
        setRetryAfter(result.retryAfter ?? 0);
      } else if (input.action === "request") {
        setCode("");
        setStep("code");
      }
    } catch { setFailure("failed"); }
    finally { setBusy(false); }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step === "address" && canSend) void submit({ action: "request", email: normalizedEmail });
    if (step === "code" && !busy && !quitting && /^\d{6}$/.test(code)) void submit({ action: "verify", email: normalizedEmail, code });
  }

  async function chooseProvider(provider: Parameters<LoginApi["provider"]>[0]) {
    setBusy(true);
    setFailure(undefined);
    try { await window.loginHost.provider(provider); }
    catch { setFailure("failed"); }
    finally { setBusy(false); }
  }

  function quit() {
    setQuitting(true);
    void window.loginHost.quit().catch(() => { setQuitting(false); setFailure("failed"); });
  }

  const status = failure ? copy[failure] : state?.account.stage === "failed" && step === "methods" ? copy.failed : null;
  return <main className="desktop-login">
    <section className={`login-card login-card--${step}`} aria-labelledby="desktop-login-title">
      <div className="login-drag" aria-hidden="true" />
      <button className="icon login-quit" type="button" aria-label={copy.quit} title={copy.quit}
        aria-busy={quitting} disabled={quitting} onClick={quit}><X size={20} aria-hidden="true" /></button>
      {step !== "methods" && <button className="login-back" type="button" disabled={busy || quitting} onClick={() => {
        setFailure(undefined); setCode(""); setStep(step === "code" ? "address" : "methods");
      }}><ArrowLeft size={15} aria-hidden="true" />{step === "code" ? copy.changeEmail : copy.methods}</button>}
      <img className="logo login-logo" src={logo} width={step === "methods" ? 56 : 40} height={step === "methods" ? 56 : 40} alt="" />
      <h1 id="desktop-login-title">{step === "methods" ? "Tomverse Desktop" : step === "address" ? copy.emailTitle : copy.codeTitle}</h1>
      <p className="login-intro">{step === "methods" ? copy.intro : step === "address" ? copy.emailHint : copy.codeHint.replace("{email}", () => normalizedEmail)}</p>
      {step === "methods" ? waiting ? <div className="login-actions">
        <p className="login-intro" role="status">{controls.continueSignin}</p>
        <button type="button" className="soft" disabled={quitting} onClick={() => void window.loginHost.cancel()}>{controls.cancelSignin}</button>
      </div> : <div className="login-actions">
        {providers.map(({ id, name, icon }) => <button className="login-option" type="button" key={id} disabled={!state || busy || quitting}
          onClick={() => void chooseProvider(id)}>
          {icon}{copy.provider.replace("{provider}", name)}
        </button>)}
        <button className="primary login-option login-email-option" type="button" disabled={busy || quitting}
          onClick={() => { setFailure(undefined); setStep("address"); }}>
          <Mail size={18} aria-hidden="true" />{copy.email}
        </button>
        <p className="login-provider-note">{copy.providerNote}</p>
      </div> : <form className="login-form" onSubmit={onSubmit}>
        {step === "address" ? <label>{copy.address}
          <input type="email" inputMode="email" autoComplete="email" maxLength={MAX_LOGIN_EMAIL_LENGTH} required disabled={busy} autoFocus
            value={email} onChange={(event) => { setEmail(event.currentTarget.value); setFailure(undefined); }} />
        </label> : <label>{copy.code}
          <input className="login-code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required disabled={busy} autoFocus
            value={code} onChange={(event) => { setCode(event.currentTarget.value.replace(/\D/g, "")); setFailure(undefined); }} />
        </label>}
        <button type="submit" className="primary" disabled={step === "address" ? !canSend : busy || quitting || code.length !== 6}>
          {busy ? copy.working : step === "address" ? copy.send : copy.verify}
        </button>
        {step === "code" && <button type="button" className="login-resend" disabled={!canSend}
          onClick={() => void submit({ action: "request", email: normalizedEmail })}>{copy.resend}</button>}
      </form>}
      {quitting && <p className="login-status" role="status">{copy.working}</p>}
      {status && <p className="login-status" role="alert">{status}</p>}
    </section>
  </main>;
}
