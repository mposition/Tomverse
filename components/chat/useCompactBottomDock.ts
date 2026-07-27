"use client";

import { useSyncExternalStore } from "react";

/**
 * True when the *visible* viewport is too short to afford a full-height bottom
 * dock, so secondary controls there should collapse to a single row.
 *
 * Two situations produce that, and both are read from `visualViewport` rather
 * than from focus or a media query:
 *
 * - An on-screen keyboard is covering the viewport. Focus alone lies in both
 *   directions: a hardware keyboard focuses the textarea without stealing any
 *   rows, and a mobile browser can keep the keyboard up while focus moves to a
 *   button in the same form.
 * - The device is in landscape (or a very short window), where there is simply
 *   not enough height to give the answers, the tools and the composer a full
 *   row each.
 *
 * Browsers without `visualViewport` (and SSR) always report "not compact", so
 * the layout never collapses controls a user cannot get back.
 */
const KEYBOARD_COVERAGE_RATIO = 0.78;
const MIN_COMFORTABLE_HEIGHT = 480;

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

const getServerCompactBottomDockSnapshot = () => false;

export function useCompactBottomDock() {
  return useSyncExternalStore(
    subscribeToVisualViewport,
    getCompactBottomDockSnapshot,
    getServerCompactBottomDockSnapshot
  );
}
