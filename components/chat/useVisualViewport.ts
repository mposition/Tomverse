"use client";

import { useSyncExternalStore } from "react";

/**
 * One subscription to `window.visualViewport`, shared by everything that has to
 * react to the on-screen keyboard.
 *
 * Focus is not a usable signal in either direction: a hardware keyboard focuses
 * the textarea without stealing any rows, and a mobile browser can keep the
 * keyboard up while focus moves to a button in the same form. The visual
 * viewport is the only thing that reports what the user can actually see.
 *
 * Browsers without `visualViewport` (and SSR) report "no keyboard, not
 * compact", so a layout never collapses or shrinks in a way the user cannot
 * undo.
 */
const KEYBOARD_COVERAGE_RATIO = 0.78;
const MIN_COMFORTABLE_HEIGHT = 480;
/**
 * Rounding, scrollbars and the URL bar's own transitions all move the visual
 * viewport by a few pixels without a keyboard being involved. Only an occlusion
 * bigger than a control row is treated as one.
 */
const MIN_KEYBOARD_INSET = 48;

const subscribeToVisualViewport = (onStoreChange: () => void) => {
  const viewport = typeof window === "undefined" ? null : window.visualViewport;
  if (!viewport) return () => {};
  viewport.addEventListener("resize", onStoreChange);
  viewport.addEventListener("scroll", onStoreChange);
  return () => {
    viewport.removeEventListener("resize", onStoreChange);
    viewport.removeEventListener("scroll", onStoreChange);
  };
};

const getCompactBottomDockSnapshot = () => {
  const viewport = typeof window === "undefined" ? null : window.visualViewport;
  const layoutHeight = typeof window === "undefined" ? 0 : window.innerHeight;
  if (!viewport || !layoutHeight) return false;
  const isKeyboardCovering =
    viewport.height / layoutHeight < KEYBOARD_COVERAGE_RATIO;
  return isKeyboardCovering || viewport.height < MIN_COMFORTABLE_HEIGHT;
};

/**
 * How many CSS pixels at the bottom of the *layout* viewport the user cannot
 * see, which on iOS Safari is exactly the on-screen keyboard: the layout
 * viewport keeps its full height there, so a `position: fixed` element anchored
 * to `bottom` stays underneath the keyboard. Android Chrome's default
 * "resizes-visual" mode behaves the same way; in "resizes-content" mode the
 * layout viewport shrinks with the keyboard and this correctly reports 0,
 * because the browser has already done the work.
 *
 * Pinch zoom also shrinks `visualViewport.height`, but repositioning a dialog
 * for it would fight the user's own panning, so a zoomed viewport reports 0.
 */
const getKeyboardInsetSnapshot = () => {
  const viewport = typeof window === "undefined" ? null : window.visualViewport;
  const layoutHeight = typeof window === "undefined" ? 0 : window.innerHeight;
  if (!viewport || !layoutHeight) return 0;
  if (viewport.scale > 1.01) return 0;
  const occluded = layoutHeight - (viewport.height + viewport.offsetTop);
  return occluded >= MIN_KEYBOARD_INSET ? Math.round(occluded) : 0;
};

const getServerCompactBottomDockSnapshot = () => false;
const getServerKeyboardInsetSnapshot = () => 0;

/**
 * True when the *visible* viewport is too short to afford a full-height bottom
 * dock, so secondary controls there should collapse to a single row. Either an
 * on-screen keyboard is covering the viewport, or the device is in landscape
 * (or a very short window) with no height to give the answers, the tools and
 * the composer a full row each.
 */
export function useCompactBottomDock() {
  return useSyncExternalStore(
    subscribeToVisualViewport,
    getCompactBottomDockSnapshot,
    getServerCompactBottomDockSnapshot
  );
}

/**
 * The bottom inset a viewport-fixed sheet must add so its footer stays inside
 * the visible viewport while the keyboard is up. 0 whenever there is nothing to
 * compensate for, so the element keeps its plain CSS positioning.
 */
export function useKeyboardInset() {
  return useSyncExternalStore(
    subscribeToVisualViewport,
    getKeyboardInsetSnapshot,
    getServerKeyboardInsetSnapshot
  );
}
