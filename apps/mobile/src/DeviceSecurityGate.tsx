import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ChatTransport } from "./chatTransport";
import type { DeviceSecurity } from "./authBridgeContract";
import { mobileParityCopy } from "../../../locales/mobileParity";
import { mobileCopy, mobileLanguages, type MobileLanguage } from "../../../locales/mobile";
import { clearNativeDrafts } from "./useDeviceDraft";

/** Native access-token issuance enforces this lock independently of the UI. */
export function DeviceSecurityGate({ transport, children }: { transport: ChatTransport; children: ReactNode }) {
  const language = (mobileLanguages.includes(localStorage.getItem("tomverse-language") as MobileLanguage) ? localStorage.getItem("tomverse-language") : "en") as MobileLanguage;
  const copy = mobileParityCopy(language);
  const [security, setSecurity] = useState<DeviceSecurity | null>(transport.deviceSecurity ? null : { available: false, enabled: false, locked: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [opened, setOpened] = useState(!transport.deviceSecurity);
  const [contentKey, setContentKey] = useState(0);
  const backgroundTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const check = useCallback(async () => {
    try {
      const value = await transport.deviceSecurity?.() ?? { available: false, enabled: false, locked: false };
      setSecurity(value); setError(false);
      if (!value.locked) { setOpened(true); window.dispatchEvent(new Event("tomverse-device-unlocked")); }
    }
    catch { setError(true); }
  }, [transport]);
  useEffect(() => { queueMicrotask(() => void check()); const changed = () => void check(); window.addEventListener("tomverse-device-security-changed", changed); return () => window.removeEventListener("tomverse-device-security-changed", changed); }, [check]);
  useEffect(() => {
    const visibility = () => {
      if (backgroundTimer.current) clearTimeout(backgroundTimer.current);
      if (document.hidden && security?.enabled) backgroundTimer.current = setTimeout(() => setSecurity(current => current && ({ ...current, locked: true })), 30_000);
      if (!document.hidden) void check();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => { document.removeEventListener("visibilitychange", visibility); if (backgroundTimer.current) clearTimeout(backgroundTimer.current); };
  }, [security?.enabled, check]);
  const locked = !security || security.locked || error;
  return <><div key={contentKey} hidden={locked} inert={locked}>{opened && children}</div>{locked && <main className="device-lock-screen"><h1>Tomverse</h1><p>{security ? copy.locked : mobileCopy[language].loading}</p><p>{error ? copy.deviceCancelled : copy.unlockHint}</p>
    <button className="primary" disabled={busy} onClick={() => {
      setBusy(true); setError(false);
      const unlocking = security?.locked ? transport.unlockDevice?.(copy.unlockHint) ?? Promise.reject(Error("DEVICE_SECURITY_UNAVAILABLE")) : Promise.resolve();
      void unlocking.then(check).catch(() => setError(true)).finally(() => setBusy(false));
    }}>{busy ? mobileCopy[language].loading : security?.locked ? copy.unlock : copy.retry}</button>
    {(security?.locked || error) && <button disabled={busy} onClick={() => {
      setBusy(true); void transport.signOut().finally(() => { clearNativeDrafts(); localStorage.removeItem("tomverse-native-last-chat"); setContentKey(value => value + 1); void check(); setBusy(false); }).catch(() => setError(true));
    }}>{mobileCopy[language].signOut}</button>}
  </main>}</>;
}
