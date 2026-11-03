import { useEffect, useRef, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import type { MobileLanguage } from "../../../locales/mobile";
import { mobileUpdatesCopy } from "../../../locales/mobileUpdates";
import { dismissAppUpdate, nativeAppUpdates, updateWasDismissed, type AppUpdates, type AppUpdateState } from "./appUpdates";

export function NativeAppUpdate({ language, paused, updates = nativeAppUpdates }: {
  language: MobileLanguage; paused: boolean; updates?: AppUpdates | null;
}) {
  const [snapshot, setSnapshot] = useState<AppUpdateState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    if (!updates) return;
    let active = true;
    mounted.current = true;
    const receive = (state: AppUpdateState) => { if (active) setSnapshot(state); };
    const check = () => { if (navigator.onLine) void updates.check().then(receive).catch(() => { /* Updates never block the app. */ }); };
    const foreground = () => { if (document.visibilityState === "visible") { setDismissed(null); check(); } };
    const listener = updates.addListener("stateChanged", receive);
    void listener.then(handle => { if (active) check(); else void handle.remove(); }).catch(check);
    window.addEventListener("online", check);
    document.addEventListener("visibilitychange", foreground);
    return () => {
      active = false; mounted.current = false;
      window.removeEventListener("online", check);
      document.removeEventListener("visibilitychange", foreground);
      void listener.then(handle => handle.remove()).catch(() => {});
    };
  }, [updates]);
  const later = () => {
    if (!snapshot) return;
    setDismissed(snapshot.versionCode);
    if (snapshot.state === "available") dismissAppUpdate(snapshot.versionCode);
    setSnapshot(null); setError(false);
  };
  if (!updates || paused || !snapshot || (snapshot.state !== "available" && snapshot.state !== "downloaded")
    || dismissed === snapshot.versionCode || (snapshot.state === "available" && updateWasDismissed(snapshot.versionCode))) return null;
  const copy = mobileUpdatesCopy[language];
  const ready = snapshot.state === "downloaded";
  return <aside className="app-update-banner" aria-label={ready ? copy.ready : copy.available}>
    <div role="status">{ready ? <RefreshCw size={18} aria-hidden="true" /> : <Download size={18} aria-hidden="true" />}<span>{error ? copy.retry : ready ? copy.ready : copy.available}</span></div>
    <div className="app-update-actions"><button type="button" className="app-update-later" disabled={busy} onClick={later}>{copy.later}</button><button type="button" className="app-update-accept" disabled={busy} onClick={() => {
      setBusy(true); setError(false);
      void (ready ? updates.complete() : updates.start().then(async ({ accepted }) => {
        if (!mounted.current) return;
        if (!accepted) { later(); return; }
        setSnapshot(await updates.check());
      })).catch(() => { if (mounted.current) setError(true); }).finally(() => { if (mounted.current) setBusy(false); });
    }}>{ready ? copy.restart : copy.update}</button></div>
  </aside>;
}
