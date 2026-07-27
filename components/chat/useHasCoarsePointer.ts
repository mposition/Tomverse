"use client";

import { useSyncExternalStore } from "react";

// Reports whether the device has a coarse (touch) pointer available, via
// `(any-pointer: coarse)`. This is deliberately separate from useIsMobileShell:
// that hook drives *layout* (the mobile sheet + Enter-to-send policy) and so is
// gated on width < 768px, whereas touch *hit area* should track the input
// device regardless of width. `any-pointer` (not `pointer`) is used on purpose
// so a hybrid touch laptop -- whose primary pointer is the mouse -- still counts
// as touch-capable, while a mouse-only desktop keeps its compact density.
const COARSE_POINTER_QUERY = "(any-pointer: coarse)";

const getSnapshot = () => window.matchMedia(COARSE_POINTER_QUERY).matches;

const getServerSnapshot = () => false;

const subscribe = (onChange: () => void) => {
  const query = window.matchMedia(COARSE_POINTER_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};

export function useHasCoarsePointer(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
