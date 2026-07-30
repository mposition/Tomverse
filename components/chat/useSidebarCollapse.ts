"use client";

import { useCallback, useSyncExternalStore } from "react";

// "auto" defers to whatever the desktop shell's content-width measurement
// suggests (see DesktopChatShell's autoCollapseSuggested); "expanded"/
// "collapsed" are explicit, sticky user choices that always win over that
// suggestion. Same localStorage+event sync pattern this file's neighboring
// sidebar preferences (e.g. the "organizer" panel) already use, so both
// ChatSidebar and DesktopChatShell can read/write it without prop drilling.
export type SidebarCollapsePreference = "auto" | "expanded" | "collapsed";

const STORAGE_KEY = "tomverse_sidebar_collapsed_v1";
const CHANGE_EVENT = "tomverse-sidebar-collapsed-change";

const getPreference = (): SidebarCollapsePreference => {
  const stored = localStorage.getItem(STORAGE_KEY);
  // Migrates the old boolean "1"/"0" scheme: "1" was an explicit collapse,
  // so it maps to "collapsed"; "0" (or nothing) never distinguished "never
  // touched" from "explicitly reopened", so it maps to "auto" -- safe,
  // since "auto" resolves to expanded on any screen with room to spare.
  if (stored === "1" || stored === "collapsed") return "collapsed";
  if (stored === "expanded") return "expanded";
  return "auto";
};

const getServerPreference = (): SidebarCollapsePreference => "auto";

const subscribe = (onStoreChange: () => void) => {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener(CHANGE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(CHANGE_EVENT, onStoreChange);
  };
};

export function useSidebarCollapsePreference(): [
  SidebarCollapsePreference,
  (next: SidebarCollapsePreference) => void,
] {
  const preference = useSyncExternalStore(
    subscribe,
    getPreference,
    getServerPreference
  );
  const setPreference = useCallback((next: SidebarCollapsePreference) => {
    localStorage.setItem(STORAGE_KEY, next);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);
  return [preference, setPreference];
}
