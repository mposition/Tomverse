import { useState } from "react";
import { desktopAccountDataCopy } from "../../../../locales/desktopAccountData";
import { AccountDataResultLine, runAccountData } from "./AccountDataSettings";
import { AccountSettingRow, dictionaries, ReadStatus, useSettingsRead, type Common } from "./settings-shared";

const loadLoginMethods = () => window.desktop.accountSettings<"loginMethods">({ action: "loginMethods" });
const providers: Record<string, string> = { apple: "Apple", google: "Google", "azure-ad": "Microsoft" };

type Method = "google" | "azure-ad" | "email";

/** How the account signs in: add the email method (code), remove a method (ends every session). */
export function LoginMethods({ language }: Common) {
  const state = useSettingsRead(loadLoginMethods);
  const copy = dictionaries[language].auth;
  const words = desktopAccountDataCopy[language];
  const [armed, setArmed] = useState<Method>();
  const [stage, setStage] = useState<"idle" | "code">("idle");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [refusal, setRefusal] = useState<Awaited<ReturnType<typeof runAccountData>>>();
  if (!state.data) return <ReadStatus language={language} failed={state.failed} retry={state.reload} />;
  const { methods, canRemove } = state.data;
  const run = async (input: Parameters<typeof runAccountData>[0]) => {
    setBusy(true); setNotice(undefined); setRefusal(undefined);
    try {
      const result = await runAccountData(input);
      setRefusal(result);
      return result;
    } catch {
      const result = { status: "failed" as const };
      setRefusal(result);
      return result;
    } finally {
      setBusy(false);
    }
  };
  const specific = refusal?.status === "blocked" ? copy.removeLoginMethodBlocked
    : refusal?.status === "failed" && refusal.code === "EMAIL_CODE_INVALID" ? copy.emailLoginInvalidCode
    : refusal?.status === "failed" && refusal.code === "EMAIL_CODE_LOCKED" ? copy.emailLoginLocked : undefined;
  const emailAddress = methods.find(method => method.type === "email")?.address;
  return <section data-testid="native-account-login-methods">
    <h3>{copy.manageLoginMethods}</h3>
    <p>{copy.manageLoginMethodsDescription}</p>
    {methods.map(method => {
      const key = (method.type === "email" ? "email" : method.provider) as Method;
      const enabled = method.type === "email" ? method.enabled : method.linked;
      return <AccountSettingRow key={key} label={method.type === "email" ? copy.emailLoginEmailInputLabel : providers[method.provider] ?? method.provider}
        description={method.type === "email" ? method.address : undefined}>
        <span>{enabled ? "✓" : "—"}</span>
        {enabled && canRemove !== false && <button type="button" className="soft" disabled={busy}
          data-testid={"native-login-remove-" + key} onClick={() => {
            if (armed !== key) { setArmed(key); return; }
            void run({ action: "removeLoginMethod", method: key }).then(result => {
              setArmed(undefined);
              if (result.status === "deleted") setNotice(copy.removeLoginMethodSuccess);
            });
          }}>{armed === key ? copy.confirmRemoveLoginMethodButton : copy.removeLoginMethod}</button>}
        {method.type === "email" && !method.enabled && stage === "idle" && <button type="button" className="soft" disabled={busy}
          data-testid="native-login-add-email" onClick={() => void run({ action: "requestEmailLogin" }).then(result => {
            if (result.status === "ready") setStage("code");
          })}>{copy.addLoginMethod}</button>}
      </AccountSettingRow>;
    })}
    {stage === "code" && <form className="account-settings-form" data-testid="native-login-email-code" onSubmit={event => {
      event.preventDefault();
      if (busy || !/^\d{6}$/.test(code)) return;
      void run({ action: "verifyEmailLogin", code }).then(result => {
        if (result.status === "saved") { setStage("idle"); setCode(""); setNotice(copy.addEmailLoginSuccess); state.reload(); }
      });
    }}>
      <p>{copy.emailLoginCodeSentBody.replace("{email}", emailAddress ?? "")}</p>
      <label>{copy.emailLoginCodeInputLabel}<input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} disabled={busy}
        onChange={event => setCode(event.currentTarget.value.replace(/\D/g, ""))} /></label>
      <div className="account-settings-actions">
        <button type="button" className="soft" disabled={busy} onClick={() => { setStage("idle"); setCode(""); setRefusal(undefined); }}>{copy.cancel}</button>
        <button type="submit" className="primary" disabled={busy || code.length !== 6}>{copy.emailLoginVerifyButton}</button>
      </div>
    </form>}
    {methods.some(method => method.type === "oauth" && !method.linked) && <p>{words.oauthLinkUnavailable}</p>}
    {notice && <p role="status">{notice}</p>}
    {specific ? <p className="notice" role="alert">{specific}</p> : <AccountDataResultLine language={language} status={refusal?.status} />}
  </section>;
}
