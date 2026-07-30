// Pure, DOM-free logic for the chat message list's auto-scroll state machine.
// Kept separate from ChatMessageList.tsx so the actual scroll-position math
// can be unit tested without a browser: the previous implementation locked
// out real user scroll input for a fixed window after every programmatic
// scroll, which meant fast streaming (chunks arriving faster than the lock
// expired) could keep the lock effectively open forever. This module has no
// concept of time at all -- state only ever changes in response to an actual
// scroll position or an explicit caller action (new message sent, button
// clicked), never a clock.

export type ChatScrollMode = "following" | "paused";

export type ScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

// How close to the true bottom counts as "there". One threshold used for
// both leaving and returning to "following" -- a separate, larger
// leave-threshold would add a dead zone where small layout jitter could
// strand the mode in a state that doesn't match what's on screen.
export const NEAR_BOTTOM_THRESHOLD_PX = 80;

export const getDistanceFromBottom = (metrics: ScrollMetrics): number =>
  Math.max(0, metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight);

export const isNearBottom = (
  metrics: ScrollMetrics,
  threshold: number = NEAR_BOTTOM_THRESHOLD_PX
): boolean => getDistanceFromBottom(metrics) <= threshold;

// The only place "paused" is entered, and the only place "following" is
// re-entered purely from scroll position (the other two resume paths --
// sending a new message, clicking the jump-to-latest button -- are explicit
// caller actions, not a function of scroll position, so they just set the
// mode directly rather than going through this). Must only ever be called
// with a scroll position that came from real user input, never from a
// scroll this module's own caller just performed programmatically.
export const nextModeForUserScroll = (
  metrics: ScrollMetrics,
  threshold: number = NEAR_BOTTOM_THRESHOLD_PX
): ChatScrollMode => (isNearBottom(metrics, threshold) ? "following" : "paused");
