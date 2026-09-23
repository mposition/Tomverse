/**
 * Asks the page's feedback dialog to open, for the user to write in.
 *
 * HELP-NAV-01's "report a problem" destination uses this instead of a second
 * copy of the dialog. Opening is all it does: nothing is filled in beyond what
 * the dialog fills in when its own button is pressed, and nothing is submitted.
 *
 * Returns whether a mounted dialog took the request, so a caller never claims
 * to have opened something that is not on the page.
 */
export const FEEDBACK_DIALOG_OPEN_EVENT = "tomverse:feedback-dialog-open";

export type FeedbackDialogOpenDetail = { handled: boolean };

export const openFeedbackDialog = (): boolean => {
  if (typeof window === "undefined") return false;
  const detail: FeedbackDialogOpenDetail = { handled: false };
  window.dispatchEvent(new CustomEvent<FeedbackDialogOpenDetail>(FEEDBACK_DIALOG_OPEN_EVENT, { detail }));
  return detail.handled;
};
