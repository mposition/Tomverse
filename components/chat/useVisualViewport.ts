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
  if (typeof window === "undefined") return () => {};
  const viewport = window.visualViewport;
  // The window listener is the fallback for a browser without
  // `visualViewport`, where the layout viewport is the only thing any of these
  // snapshots can read -- without it a rotation would change nothing at all.
  window.addEventListener("resize", onStoreChange);
  window.addEventListener("orientationchange", onStoreChange);
  viewport?.addEventListener("resize", onStoreChange);
  viewport?.addEventListener("scroll", onStoreChange);
  return () => {
    window.removeEventListener("resize", onStoreChange);
    window.removeEventListener("orientationchange", onStoreChange);
    viewport?.removeEventListener("resize", onStoreChange);
    viewport?.removeEventListener("scroll", onStoreChange);
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

/**
 * SHORT-VIEWPORT-001. The mobile sidebar drawer's pinned layout -- fixed
 * header, fixed account footer, a scrolling conversation list between them --
 * needs about 658 CSS px before the footer starts falling off the bottom of the
 * panel: 245px of chrome above the list, the list's own 10rem floor, and up to
 * 253px of account footer. 700px is that measurement rounded up for locale,
 * font-size and rounding slack; below it the drawer has to become a single
 * scroll region instead.
 *
 * Measured against the *visible* viewport, never `window.innerHeight` or a CSS
 * `max-height` query. Both of those still report the full 844px of a phone
 * whose bottom 320px is covered by the keyboard, which is exactly the case
 * where the footer disappears.
 */
const MIN_PINNED_DRAWER_HEIGHT = 700;

const getShortViewportSnapshot = () => {
  const viewport = typeof window === "undefined" ? null : window.visualViewport;
  const layoutHeight = typeof window === "undefined" ? 0 : window.innerHeight;
  const visibleHeight = viewport?.height ?? layoutHeight;
  if (!visibleHeight) return false;
  return visibleHeight < MIN_PINNED_DRAWER_HEIGHT;
};

/**
 * PROV-BANNER-001. How many CSS pixels of the page the user can actually see
 * right now -- the layout viewport minus whatever the on-screen keyboard (or
 * the browser's own chrome) is covering.
 *
 * `100dvh`, `45dvh` and `window.innerHeight` all still report the phone's full
 * height while the keyboard is up on iOS Safari and on Android Chrome's default
 * "resizes-visual" mode, so a box sized as a fraction of any of them can take
 * far more of the *visible* screen than its percentage suggests: 45dvh of an
 * 844px phone is 380px, which is 73% of what is left once a 320px keyboard is
 * raised. Anything that has to stay a minority of the visible screen has to
 * measure it here instead.
 *
 * Pinch zoom also shrinks `visualViewport.height`, but the user is panning
 * deliberately there and nothing should reflow underneath them, so a zoomed
 * viewport reports the layout height unchanged -- the same rule
 * `getKeyboardInsetSnapshot` already applies.
 *
 * 0 means "not measured yet" (SSR and the hydration render), which callers read
 * as "keep the CSS fallback" rather than as a zero-height viewport.
 */
const getVisibleViewportHeightSnapshot = () => {
  if (typeof window === "undefined") return 0;
  const viewport = window.visualViewport;
  const layoutHeight = window.innerHeight;
  if (!viewport) return layoutHeight;
  if (viewport.scale > 1.01) return layoutHeight;
  return Math.round(Math.min(viewport.height, layoutHeight));
};

const getServerCompactBottomDockSnapshot = () => false;
const getServerKeyboardInsetSnapshot = () => 0;
const getServerShortViewportSnapshot = () => false;
const getServerVisibleViewportHeightSnapshot = () => 0;

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

/**
 * True when the visible viewport is too short for the sidebar drawer to keep
 * its header and account footer pinned around a scrolling conversation list.
 * The drawer becomes one scroll region for as long as this holds -- including
 * mid-session, when the keyboard rises or the phone is rotated.
 */
export function useShortViewport() {
  return useSyncExternalStore(
    subscribeToVisualViewport,
    getShortViewportSnapshot,
    getServerShortViewportSnapshot
  );
}

/**
 * The height of the part of the page the user can actually see, in CSS pixels.
 * 0 until it has been measured on the client, so a caller keeps whatever CSS
 * fallback it declared instead of collapsing during hydration.
 *
 * Shares the one subscription above, so a keyboard opening moves this, the
 * keyboard inset and the compact-dock flag within the same commit.
 */
export function useVisibleViewportHeight() {
  return useSyncExternalStore(
    subscribeToVisualViewport,
    getVisibleViewportHeightSnapshot,
    getServerVisibleViewportHeightSnapshot
  );
}
