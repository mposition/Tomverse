"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import { mobileCompletionCopy } from "../../locales/mobileCompletion";
import { bindOfflineChatDraftOwner, readOfflineChatDraft, OFFLINE_DRAFT_KEY } from "../../lib/chatOfflineDraft";

const subscribeNetwork = (listener: () => void) => { window.addEventListener("online", listener); window.addEventListener("offline", listener); return () => { window.removeEventListener("online", listener); window.removeEventListener("offline", listener); }; };
const subscribeMounted = () => () => undefined;
export function ChatPwaControls({ onRestore, ownerKey, language = "en" }: { onRestore: (text: string) => void; ownerKey: string | null; language?: string }) {
  const copy = mobileCompletionCopy(language);
  useEffect(() => { bindOfflineChatDraftOwner(ownerKey); }, [ownerKey]);
  const mounted = useSyncExternalStore(subscribeMounted, () => true, () => false);
  const offline = useSyncExternalStore(subscribeNetwork, () => !navigator.onLine, () => false);
  const [draftDismissed, dismissDraft] = useState(false);
  let draft = "";
  if (mounted && !draftDismissed) { try { draft = readOfflineChatDraft(ownerKey); } catch { /* Optional recovery. */ } }
  useEffect(() => {
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/chat-sw.js", { scope: "/", updateViaCache: "none" }).catch(() => undefined);
  }, []);
  if (!offline && !draft) return null;
  return <aside className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-200 bg-white px-3 py-1 text-xs dark:border-zinc-800 dark:bg-zinc-950" aria-label="Tomverse app">
    {offline && <span role="status">{copy.offline}</span>}
    {draft && <button type="button" className="min-h-11 underline" onClick={() => { onRestore(draft); dismissDraft(true); try { sessionStorage.removeItem(OFFLINE_DRAFT_KEY); } catch { /* The composer already owns the text. */ } }}>{copy.restoreDraft}</button>}
  </aside>;
}
