"use client";

import { useSyncExternalStore } from "react";
import { BellRing } from "lucide-react";
import { useLanguage } from "@/components/LanguageProvider";
import {
  currentNotificationPermission,
  notificationsSupported,
  readAnswerNotificationEnabled,
  writeAnswerNotificationEnabled,
} from "@/lib/answerNotification";
import { chatTurnToolsCopy } from "@/locales/chatTurnTools";

const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
};
const snapshot = () =>
  `${readAnswerNotificationEnabled() ? "on" : "off"}|${currentNotificationPermission()}`;
const serverSnapshot = () => "off|unsupported";

/**
 * The switch for "tell me when an answer is ready" (Settings, Preferences).
 * The browser's permission prompt appears only when the switch is turned on,
 * and the choice is kept in this browser (lib/answerNotification.ts).
 */
export function AnswerNotificationSetting() {
  const { lang } = useLanguage();
  const copy = chatTurnToolsCopy[lang];
  const [state, permission] = useSyncExternalStore(subscribe, snapshot, serverSnapshot).split("|");
  const supported = permission !== "unsupported";
  const blocked = permission === "denied";
  const enabled = state === "on" && permission === "granted";

  const toggle = async (next: boolean) => {
    if (!next) {
      writeAnswerNotificationEnabled(false);
      emit();
      return;
    }
    if (!notificationsSupported()) return;
    let result: NotificationPermission = Notification.permission;
    if (result === "default") {
      try {
        result = await Notification.requestPermission();
      } catch {
        result = "denied";
      }
    }
    writeAnswerNotificationEnabled(result === "granted");
    emit();
  };

  return (
    <div
      data-testid="settings-answer-notification"
      className="flex items-start gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/60"
    >
      <BellRing className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <span className="block text-xs font-semibold text-zinc-500">{copy.notifyTitle}</span>
        <label className="mt-1 flex cursor-pointer items-center gap-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          <input
            type="checkbox"
            data-testid="settings-answer-notification-toggle"
            checked={enabled}
            disabled={!supported || blocked}
            onChange={(event) => void toggle(event.target.checked)}
            className="h-4 w-4"
          />
          {copy.notifyToggle}
        </label>
        <span className="mt-1 block text-xs leading-5 text-zinc-500">
          {!supported ? copy.notifyUnsupported : blocked ? copy.notifyBlocked : copy.notifyDescription}
        </span>
      </div>
    </div>
  );
}
