"use client";

import { useEffect, useRef, useState } from "react";
import { HardDrive } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import {
  desktopDriveLink, driveAbandonRequest, driveCallbackUrl, driveCipher, driveEncode, driveKeyPair, driveProof,
} from "@/lib/desktopDrivePickerContract";
import { loadGoogleDrivePicker, type GooglePickerConfig } from "@/lib/googleDrivePickerClient";

export function DrivePickerPage({ config }: { config: GooglePickerConfig }) {
  const { t } = useLanguage();
  const [link, setLink] = useState<ReturnType<typeof desktopDriveLink.safeParse> | null>(null);
  const [picker, setPicker] = useState<Awaited<ReturnType<typeof loadGoogleDrivePicker>>>();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const fragment = useRef<string>(undefined);
  const settled = useRef(false);
  useEffect(() => {
    fragment.current ??= window.location.hash.slice(1);
    const parsed = desktopDriveLink.safeParse(Object.fromEntries(new URLSearchParams(fragment.current)));
    setLink(parsed);
    if (!parsed.success) return;
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    let active = true;
    void loadGoogleDrivePicker().then((select) => { if (active) setPicker(() => select); },
      () => { if (active) setError(true); });
    return () => { active = false; };
  }, []);

  const target = link?.success ? link.data : null;
  function callback() {
    if (!target) throw new Error("Google Drive selection expired.");
    return driveCallbackUrl(target);
  }

  // Closing this window without choosing tells Desktop to stop waiting. Best effort: the policy admits this one loopback request
  // (lib/csp.ts), but a browser that asks permission before a site reaches this computer may refuse it, so the Cancel button
  // in Desktop and its own time limit end the wait too. Leaving through the callback below (a choice or Cancel) must not send it twice.
  const port = target?.port;
  const state = target?.state;
  useEffect(() => {
    if (port === undefined || state === undefined) return;
    const abandon = () => {
      if (settled.current) return;
      settled.current = true;
      const { url, init } = driveAbandonRequest({ port, state });
      try { void fetch(url, init).catch(() => {}); } catch { /* the window is closing; nothing more to do */ }
    };
    window.addEventListener("pagehide", abandon);
    return () => window.removeEventListener("pagehide", abandon);
  }, [port, state]);

  function leave(url: URL) {
    settled.current = true;
    window.location.replace(url.href);
  }

  async function select() {
    if (!picker || !target || busy) return;
    setBusy(true);
    setError(false);
    try {
      const selection = await picker(config, target.slots);
      const url = callback();
      if (selection) {
        const pair = await driveKeyPair();
        const cipher = await driveCipher(pair.privateKey, target.key);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const data = new TextEncoder().encode(JSON.stringify(selection));
        const payload = await crypto.subtle.encrypt(driveProof(target.state, iv), cipher, data);
        url.searchParams.set("key", pair.key);
        url.searchParams.set("iv", driveEncode(iv));
        url.searchParams.set("payload", driveEncode(new Uint8Array(payload)));
      }
      leave(url);
    } catch {
      setError(true);
      setBusy(false);
    }
  }

  return <main className="mx-auto mt-16 w-[min(90vw,420px)] rounded-2xl border border-zinc-300 p-6 dark:border-zinc-700">
    <h1 className="flex items-center gap-3 text-xl font-semibold"><HardDrive size={22} />Google Drive</h1>
    <p className="mt-2 text-sm text-zinc-500">{t("chat.googleDriveDescription")}</p>
    {(error || (link && !link.success)) && <p role="alert" className="mt-3 text-sm">{t("chat.googleDriveError")}</p>}
    <div className="mt-6 flex flex-wrap gap-2">
      <button type="button" className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50"
        disabled={!picker || !target || busy} onClick={() => void select()}>{t("chat.attachGoogleDrive")}</button>
      {target && <button type="button" className="rounded-lg border border-zinc-400 px-4 py-2 text-sm"
        onClick={() => leave(callback())}>{t("auth.cancel")}</button>}
    </div>
  </main>;
}
