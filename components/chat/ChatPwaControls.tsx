"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };
const subscribeNetwork = (listener: () => void) => { window.addEventListener("online", listener); window.addEventListener("offline", listener); return () => { window.removeEventListener("online", listener); window.removeEventListener("offline", listener); }; };
const subscribeMounted = () => () => undefined;
export function ChatPwaControls({ onRestore }: { onRestore: (text: string) => void }) {
  const [install, setInstall] = useState<InstallPrompt | null>(null);
  const mounted = useSyncExternalStore(subscribeMounted, () => true, () => false);
  const offline = useSyncExternalStore(subscribeNetwork, () => !navigator.onLine, () => false);
  const [draftDismissed, dismissDraft] = useState(false);
  const [installed, setInstalled] = useState(false);
  const ios = mounted && !installed && /iPhone|iPad|iPod/.test(navigator.userAgent) && !matchMedia("(display-mode: standalone)").matches;
  let draft = "";
  if (mounted && !draftDismissed) { try { draft = sessionStorage.getItem("tomverse-offline-draft") || ""; } catch { /* Optional recovery. */ } }
  const [instructions, setInstructions] = useState(false);
  useEffect(() => {
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/chat-sw.js", { scope: "/", updateViaCache: "none" }).catch(() => undefined);
    const prompt = (event: Event) => { event.preventDefault(); setInstall(event as InstallPrompt); };
    const installed = () => { setInstall(null); setInstalled(true); };
    window.addEventListener("beforeinstallprompt", prompt); window.addEventListener("appinstalled", installed);
    return () => { window.removeEventListener("beforeinstallprompt", prompt); window.removeEventListener("appinstalled", installed); };
  }, []);
  if (!install && !ios && !offline && !draft) return null;
  return <aside className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-200 bg-white px-3 py-1 text-xs dark:border-zinc-800 dark:bg-zinc-950" aria-label="Tomverse app">
    {offline && <span role="status">You are offline. Keep your draft here until you reconnect.</span>}
    {(install || ios) && <button type="button" className="min-h-11 underline" onClick={() => {
      if (!install) { setInstructions((value) => !value); return; }
      void Promise.resolve().then(() => install.prompt()).then(() => install.userChoice).then(() => setInstall(null)).catch(() => setInstall(null));
    }}>Install Tomverse</button>}
    {instructions && <span>In Safari, open Share and choose Add to Home Screen.</span>}
    {draft && <button type="button" className="min-h-11 underline" onClick={() => { onRestore(draft); dismissDraft(true); try { sessionStorage.removeItem("tomverse-offline-draft"); } catch { /* The composer already owns the text. */ } }}>Restore offline draft</button>}
  </aside>;
}
