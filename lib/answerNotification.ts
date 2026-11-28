/**
 * "Tell me when an answer is ready" (browser notification).
 *
 * The switch lives in this browser's localStorage only: nothing is sent to or
 * kept by the server, and the browser's own permission prompt is shown only
 * when the person turns the switch on in Settings. The notification never
 * carries the answer or the question, because notification centres are often
 * visible on a locked screen.
 */

export const ANSWER_NOTIFICATION_STORAGE_KEY = "tomverse:answer-notification:v1";
export const ANSWER_NOTIFICATION_TAG = "tomverse-answer-ready";

type NotificationPermissionState = "default" | "granted" | "denied";

export function shouldNotifyAnswerReady(input: {
  enabled: boolean;
  permission: NotificationPermissionState | "unsupported";
  documentHidden: boolean;
  wasSending: boolean;
  isSending: boolean;
  lastAnswer: { role: string; status?: string; content: string } | undefined;
}): boolean {
  if (!input.enabled || input.permission !== "granted" || !input.documentHidden) return false;
  if (!input.wasSending || input.isSending) return false;
  const answer = input.lastAnswer;
  if (!answer || answer.role !== "assistant" || !answer.content.trim()) return false;
  return answer.status === undefined || answer.status === "normal" || answer.status === "incomplete";
}

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function currentNotificationPermission(): NotificationPermissionState | "unsupported" {
  return notificationsSupported() ? Notification.permission : "unsupported";
}

export function readAnswerNotificationEnabled(): boolean {
  try {
    return window.localStorage.getItem(ANSWER_NOTIFICATION_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

export function writeAnswerNotificationEnabled(enabled: boolean) {
  try {
    if (enabled) window.localStorage.setItem(ANSWER_NOTIFICATION_STORAGE_KEY, "on");
    else window.localStorage.removeItem(ANSWER_NOTIFICATION_STORAGE_KEY);
  } catch {
    // Without storage the switch simply does not persist.
  }
}

/** Shown through the page when it can be; a service worker is not required. */
export function showAnswerReadyNotification(copy: { title: string; body: string }) {
  try {
    const notification = new Notification(copy.title, {
      body: copy.body,
      tag: ANSWER_NOTIFICATION_TAG,
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    // Some mobile browsers only allow notifications from a service worker.
  }
}
