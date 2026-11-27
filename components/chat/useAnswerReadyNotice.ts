"use client";

import { useEffect, useRef } from "react";
import { useLanguage } from "@/components/LanguageProvider";
import {
  currentNotificationPermission,
  readAnswerNotificationEnabled,
  shouldNotifyAnswerReady,
  showAnswerReadyNotification,
} from "@/lib/answerNotification";
import { chatTurnToolsCopy } from "@/locales/chatTurnTools";

/**
 * Shows a browser notification when this list's answer finishes while the tab
 * is hidden, if the person turned that on in Settings (browser-local switch,
 * permission asked there, not here). It fires on the transition from
 * generating to finished, so opening an old conversation never notifies.
 */
export function useAnswerReadyNotice(
  isSending: boolean,
  lastMessage: { role: string; status?: string; content: string } | undefined
) {
  const { lang } = useLanguage();
  const wasSendingRef = useRef(isSending);
  const lastMessageRef = useRef(lastMessage);
  useEffect(() => {
    lastMessageRef.current = lastMessage;
  });

  useEffect(() => {
    const wasSending = wasSendingRef.current;
    wasSendingRef.current = isSending;
    if (!wasSending || isSending) return;
    const notify = shouldNotifyAnswerReady({
      enabled: readAnswerNotificationEnabled(),
      permission: currentNotificationPermission(),
      documentHidden: document.visibilityState === "hidden",
      wasSending,
      isSending,
      lastAnswer: lastMessageRef.current,
    });
    if (notify) {
      const copy = chatTurnToolsCopy[lang];
      showAnswerReadyNotification({ title: copy.notificationTitle, body: copy.notificationBody });
    }
  }, [isSending, lang]);
}
