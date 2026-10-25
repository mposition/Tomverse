import { useEffect, useState } from "react";
import type { ChatTransport } from "./chatTransport";
import { mobileCompletionCopy } from "../../../locales/mobileCompletion";
import type { MobileLanguage } from "../../../locales/mobile";
import { NativeBillingPanel } from "./NativeBillingPanel";
import { storeBillingDeletionNotice } from "../../../locales/storeBilling";

export function AccountScreen({ transport, language, onReauthenticate, onDeleted }: {
  transport: ChatTransport; language: MobileLanguage; onReauthenticate: () => void; onDeleted: () => void;
}) {
  const copy = mobileCompletionCopy(language);
  const [account, setAccount] = useState<Awaited<ReturnType<ChatTransport["account"]>> | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [reauthenticate, setReauthenticate] = useState(false);
  const [message, setMessage] = useState("");
  const [billingOpen, setBillingOpen] = useState(false);
  useEffect(() => { let active = true; void transport.account().then((value) => { if (active) setAccount(value); }).catch(() => { if (active) setMessage(copy.uncertain); }); return () => { active = false; }; }, [transport, copy.uncertain]);
  async function perform(action: "export" | "delete") {
    if (busy || uncertain || !account?.actionsEnabled) return;
    setBusy(true); setMessage("");
    try {
      if (action === "export") { await transport.exportAccount(); setMessage(copy.exportSaved); }
      else { await transport.deleteAccount(confirmation); await transport.signOut().catch(() => undefined); onDeleted(); }
    } catch (error) {
      if ((error as { code?: string }).code === "FILE_SAVE_CANCELLED") return;
      if ((error as { status?: number }).status === 428) { setReauthenticate(true); setMessage(copy.reauthenticate); }
      else { setMessage(copy.uncertain); setUncertain(true); }
    } finally { setBusy(false); }
  }
  if (billingOpen) return <NativeBillingPanel onClose={() => setBillingOpen(false)} />;
  return <section className="account-data">
    <p>{account?.email}</p>
    {import.meta.env.VITE_NATIVE_BILLING_ENABLED === "true" && <button onClick={() => setBillingOpen(true)}>Plans & credits</button>}
    {account && !account.actionsEnabled && <p role="status">{copy.accountUnavailable}</p>}
    {message && <p role="status">{message}</p>}
    {uncertain && <button disabled={busy} onClick={() => {
      setBusy(true);
      void transport.account().then((current) => {
        if (current.id !== account?.id) { onReauthenticate(); return; }
        setAccount(current); setConfirmation(""); setUncertain(false); setMessage(copy.accountChecked);
      }).catch(() => setMessage(copy.uncertain)).finally(() => setBusy(false));
    }}>{copy.checkAccount}</button>}
    {reauthenticate && <button onClick={onReauthenticate}>{copy.reauthenticateAction}</button>}
    <button disabled={busy || uncertain || !account?.actionsEnabled} onClick={() => void perform("export")}>{busy ? copy.busy : copy.export}</button>
    <h2>{copy.delete}</h2><p>{copy.deleteDetail}</p>
    <p>{storeBillingDeletionNotice(language)}</p>
    <label>{copy.confirmation}<input value={confirmation} autoComplete="off" disabled={busy || uncertain} onChange={(event) => setConfirmation(event.target.value)} /></label>
    <button className="danger" disabled={busy || uncertain || !account?.actionsEnabled || confirmation !== "DELETE MY ACCOUNT"} onClick={() => void perform("delete")}>{copy.delete}</button>
  </section>;
}
