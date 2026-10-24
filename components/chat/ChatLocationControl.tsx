"use client";

import { useLayoutEffect, useSyncExternalStore } from "react";
import { Loader2, MapPin, X } from "lucide-react";
import { CHAT_LOCATION_OFF } from "@tomverse/chat-core";
import { chatLocationSession } from "@/lib/chatLocationClient";
import { useLanguage } from "@/components/LanguageProvider";

export const ChatLocationControl = ({ identityKey, compact = false, enableDisabled = false }: {
  identityKey: string | null;
  compact?: boolean;
  enableDisabled?: boolean;
}) => {
  const { t } = useLanguage();
  const state = useSyncExternalStore(chatLocationSession.subscribe,
    chatLocationSession.getSnapshot, () => CHAT_LOCATION_OFF);
  useLayoutEffect(() => { chatLocationSession.setIdentity(identityKey); }, [identityKey]);
  const enabled = chatLocationSession.isEnabled(identityKey);
  const status = state.error ? t(`chat.locationError${state.error}`)
    : state.pending ? t("chat.locationReading") : t("chat.locationDisclosure");

  if (compact) {
    if (!enabled && !state.pending && !state.error) return null;
    return <div className="flex items-center gap-2 px-3 pt-2 text-xs text-zinc-600 dark:text-zinc-300" data-testid="chat-location-status">
      {state.pending ? <Loader2 aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin" /> : <MapPin aria-hidden="true" className="h-4 w-4 shrink-0" />}
      <span role="status" className="min-w-0 flex-1">{state.error || state.pending ? status : t("chat.locationActive")}</span>
      <button type="button" onClick={chatLocationSession.disable} aria-label={t("chat.locationDisable")}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800" data-testid="chat-location-disable"><X aria-hidden="true" className="h-4 w-4" /></button>
    </div>;
  }
  return <button type="button" role="switch" aria-checked={enabled}
    aria-labelledby="chat-location-label" aria-describedby="chat-location-description"
    disabled={!identityKey || (enableDisabled && !enabled && !state.pending)} data-testid="tools-location-row"
    onClick={() => { if (enabled || state.pending) chatLocationSession.disable(); else void chatLocationSession.enable(identityKey); }}
    className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-zinc-100 disabled:opacity-40 dark:hover:bg-zinc-800">
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"><MapPin aria-hidden="true" className="h-5 w-5" /></span>
    <span className="flex min-w-0 flex-1 flex-col">
      <span id="chat-location-label" className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{t("chat.locationLabel")}</span>
      <span id="chat-location-description" role="status" className="text-xs text-zinc-500">{status}</span>
    </span>
    <span aria-hidden="true" className="text-xs text-zinc-500">{state.pending ? <Loader2 className="h-4 w-4 animate-spin" /> : enabled ? t("chat.locationOn") : t("chat.locationOff")}</span>
  </button>;
};
