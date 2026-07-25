"use client";

import { useSyncExternalStore } from "react";

// Mirrors the (max-width: 767px) breakpoint that page.tsx already uses to
// choose between MobileChatShell and DesktopChatShell, but additionally
// requires a coarse (touch) pointer. Width alone isn't enough here: a PC
// user narrowing their browser window would otherwise flip keyboard policy
// (Enter-to-send) into mobile mode, which is exactly the case this must
// avoid. Combining width with pointer type -- rather than user-agent
// sniffing -- follows the same pattern ChatInput.tsx already uses elsewhere
// (autofocus and menu-focus behavior) to tell a narrow desktop window apart
// from a real touch device.
const MOBILE_SHELL_WIDTH_QUERY = "(max-width: 767px)";
const COARSE_POINTER_QUERY = "(pointer: coarse)";

const getSnapshot = () =>
  window.matchMedia(MOBILE_SHELL_WIDTH_QUERY).matches &&
  window.matchMedia(COARSE_POINTER_QUERY).matches;

const getServerSnapshot = () => false;

const subscribe = (onChange: () => void) => {
  const widthQuery = window.matchMedia(MOBILE_SHELL_WIDTH_QUERY);
  const pointerQuery = window.matchMedia(COARSE_POINTER_QUERY);
  widthQuery.addEventListener("change", onChange);
  pointerQuery.addEventListener("change", onChange);
  return () => {
    widthQuery.removeEventListener("change", onChange);
    pointerQuery.removeEventListener("change", onChange);
  };
};

export function useIsMobileShell(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
