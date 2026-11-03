import { useState } from "react";
import { MapPin } from "lucide-react";
import { mobileCopy, type MobileLanguage } from "../../../locales/mobile";
import { mobileChatCopy } from "../../../locales/mobileChat";
import { mobileLocationConsentCopy } from "../../../locales/mobileLocationConsent";
import { nativeLocationConsent } from "./chatLocation";
import { Sheet } from "./Sheet";

export function NativeLocationOnboarding({ language, consent = nativeLocationConsent }: {
  language: MobileLanguage; consent?: typeof nativeLocationConsent;
}) {
  const [open, setOpen] = useState(() => consent.needsPrompt());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const copy = mobileLocationConsentCopy[language];
  const skip = () => { if (!busy) { consent.skip(); setOpen(false); } };
  if (!open) return null;
  return <Sheet title={copy.title} closeLabel={mobileCopy[language].close} onClose={skip} className="location-onboarding">
    <div className="location-onboarding-copy"><MapPin size={30} aria-hidden="true" /><p>{copy.description}</p><p className="field-hint">{copy.control}</p></div>
    {error && <p role="status" className="notice">{error}</p>}
    <div className="sheet-footer"><button type="button" className="primary" disabled={busy} onClick={() => {
      setBusy(true); setError("");
      void consent.accept().then(() => setOpen(false)).catch(error => setError(mobileChatCopy(language)[error instanceof Error && error.message === "denied" ? "denied" : "unavailable"])).finally(() => setBusy(false));
    }}>{busy ? mobileCopy[language].loading : copy.allow}</button><button type="button" disabled={busy} onClick={skip}>{copy.later}</button></div>
  </Sheet>;
}
