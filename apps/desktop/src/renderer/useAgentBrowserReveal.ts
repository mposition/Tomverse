import { useEffect, useRef } from "react";

/** Shows the browser panel when the agent of the running task starts using its tab, so the person sees what it does. */
export function useAgentBrowserReveal(enabled: boolean, reveal: () => void) {
  const latest = useRef(reveal);
  useEffect(() => { latest.current = reveal; });
  useEffect(() => {
    if (!enabled) return;
    return window.desktop.subscribeCodeBrowser((state) => { if (state.agent === "working") latest.current(); });
  }, [enabled]);
}
