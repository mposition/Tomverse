import { useEffect, useRef, useState } from "react";

/**
 * Shows the browser panel when the agent of the running task starts using its tab, so the person sees what it does.
 * Returns whether the agent is working in a tab now (for the dot on the browser button).
 */
export function useAgentBrowserReveal(enabled: boolean, reveal: () => void) {
  const latest = useRef(reveal);
  const [working, setWorking] = useState(false);
  useEffect(() => { latest.current = reveal; });
  useEffect(() => {
    if (!enabled) return;
    const busy = new Set<string>();
    const unsubscribe = window.desktop.subscribeCodeBrowser((state) => {
      if (state.agent === "working") { busy.add(state.tab); latest.current(); } else busy.delete(state.tab);
      setWorking(busy.size > 0);
    });
    return () => { unsubscribe(); setWorking(false); };
  }, [enabled]);
  return enabled && working;
}
