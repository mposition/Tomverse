import type { AppToastTone } from "@/lib/appToast";

export type AppToastItem = {
  id: string;
  message: string;
  tone: AppToastTone;
};

/**
 * How many toasts a viewport keeps on screen at once.
 *
 * A burst of `dispatchAppToast()` calls -- a validation sweep that reports two
 * bad fields, or a retry that lands right after its own failure -- must not
 * grow an unbounded stack that swallows the page. The newest events win.
 */
export const APP_TOAST_MAX_VISIBLE = 3;

/**
 * Auto-dismiss delays. Errors stay long enough to be read and acted on;
 * success and info are acknowledgements, so they clear quickly.
 */
export const APP_TOAST_DURATION_MS: Record<AppToastTone, number> = {
  success: 4_000,
  info: 4_000,
  error: 9_000,
};

export const appToastDurationMs = (tone: AppToastTone) =>
  APP_TOAST_DURATION_MS[tone] ?? APP_TOAST_DURATION_MS.info;

export const appendAppToast = (
  queue: AppToastItem[],
  next: AppToastItem
): AppToastItem[] => [...queue, next].slice(-APP_TOAST_MAX_VISIBLE);

export const dismissAppToast = (
  queue: AppToastItem[],
  id: string
): AppToastItem[] => queue.filter((toast) => toast.id !== id);

/**
 * Errors interrupt: they are announced assertively so an administrator hears
 * that a control did not apply. Success and info are polite status updates.
 */
export const appToastRole = (tone: AppToastTone) =>
  tone === "error" ? "alert" : "status";

export const appToastPoliteness = (tone: AppToastTone) =>
  tone === "error" ? ("assertive" as const) : ("polite" as const);
