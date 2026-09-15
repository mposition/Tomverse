"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * How often an open, visible support screen re-reads the server. Case state
 * also moves without an operator click (a verified report arriving, the
 * maintenance worker observing a deployment), and a screen that only
 * refreshed on its own actions would keep showing the state before that.
 */
export const SUPPORT_INBOX_REFRESH_INTERVAL_MS = 60_000;

/**
 * Keeps a support workspace in step with the server.
 *
 * `refreshNow()` is what every successful state change calls: the page's
 * server component re-reads its rows *and* the layout re-reads the sidebar
 * badge counts, which a local `setState` merge never touched. Between
 * actions the screen refreshes on an interval while the document is visible
 * and again the moment it becomes visible.
 */
export function useSupportInboxRefresh(options?: { paused?: boolean }) {
  const router = useRouter();
  const paused = options?.paused ?? false;

  const refreshNow = useCallback(() => {
    router.refresh();
  }, [router]);

  // A refresh that came due while paused (the tab returned, or the interval
  // fired, with a dialog open) is owed, not dropped: it runs the moment the
  // pause lifts, so closing the dialog never leaves a stale screen for a
  // whole interval.
  const pausedRef = useRef(paused);
  const owedRef = useRef(false);

  useEffect(() => {
    pausedRef.current = paused;
    if (!paused && owedRef.current) {
      owedRef.current = false;
      router.refresh();
    }
  }, [paused, router]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (pausedRef.current) {
        owedRef.current = true;
        return;
      }
      router.refresh();
    };
    const interval = window.setInterval(
      refreshWhenVisible,
      SUPPORT_INBOX_REFRESH_INTERVAL_MS
    );
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [router]);

  return refreshNow;
}

/**
 * Local rows that follow the server's rows.
 *
 * The panels keep a local copy so a PATCH response can show at once, but a
 * copy taken only on mount ignores every later `router.refresh()`. When the
 * server hands down a new array the local copy is replaced during render
 * (React's documented "adjust state when a prop changes" pattern), so the
 * refreshed rows win over an older optimistic merge.
 */
export function useServerSyncedRows<Row>(rows: Row[]) {
  const [items, setItems] = useState(rows);
  const [sourceRows, setSourceRows] = useState(rows);
  if (sourceRows !== rows) {
    setSourceRows(rows);
    setItems(rows);
  }
  return [items, setItems] as const;
}
