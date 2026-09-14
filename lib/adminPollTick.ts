/**
 * Whether a polling admin panel should issue this request.
 *
 * Two panels poll -- provider health every two minutes, infrastructure every
 * ten -- and they disagreed about both halves of the question.
 *
 * **Overlap.** Neither tracked an in-flight request. A tick that fires while
 * the previous one is still open issues a second, and then a third: the
 * requests stack for as long as the endpoint is slow, which is exactly when
 * the extra load is least welcome. Worse than the load, the responses race --
 * `finally { setLoading(false) }` from the first clears the spinner belonging
 * to the second, and a late response overwrites newer data with older. Both
 * failures are silent and both look like the panel is fine.
 *
 * **Visibility.** Provider health checked `document.visibilityState` before
 * polling; infrastructure did not, so a console left open in a background tab
 * kept querying every ten minutes forever. That asymmetry was not a decision,
 * and one of the two had to be wrong.
 *
 * A function rather than a `useRef` check inside each panel, because the rule
 * has three inputs and two callers and was already inconsistent between them.
 * `tests/adminPollTick.test.mjs` pins it.
 */

export type AdminPollTrigger =
  /** The panel's own timer. */
  | "interval"
  /** The operator pressed something. */
  | "manual"
  /** A console-wide refresh, a window focus, or a sibling panel's event. */
  | "event";

export const shouldIssueAdminPoll = (input: {
  /** Whether a request from this panel is still open. */
  inFlight: boolean;
  /** `document.visibilityState === "visible"`. */
  documentVisible: boolean;
  trigger: AdminPollTrigger;
}): boolean => {
  // Never two at once, whatever asked. A dropped duplicate costs nothing: the
  // request already in flight is about to answer the same question, and it is
  // the newer data of the two by the time it lands.
  if (input.inFlight) return false;

  // A background tab has nobody reading it. Manual and event triggers still
  // fire -- `focus` is an event, and it is the one that brings the panel back
  // up to date the moment somebody looks at it again.
  if (input.trigger === "interval" && !input.documentVisible) return false;

  return true;
};
