import { useLayoutEffect, useRef, useState } from "react";

/**
 * Uploads and the position read take time. What was being sent is dropped if the account or conversation
 * changed meanwhile (leaving and coming back counts as a change) or, for a composer draft, the draft is no longer the one it was.
 */
export function useSendGuard(scope: string, draft: string) {
  const scopeChanges = useRef(0);
  useLayoutEffect(() => { scopeChanges.current += 1; }, [scope]);
  const latestDraft = useRef(draft);
  useLayoutEffect(() => { latestDraft.current = draft; });
  const [preparing, setPreparing] = useState(false);
  return {
    /** True from the first wait until the send has been handed over; the composer is locked meanwhile. */
    preparing,
    /** `run` gets a check to call after every wait; `ownText` is for a message that is not the composer draft. */
    async guarded<Result>(run: (stale: () => boolean) => Promise<Result>, ownText = false) {
      const changes = scopeChanges.current;
      const stale = () => scopeChanges.current !== changes || (!ownText && latestDraft.current !== draft);
      setPreparing(true);
      try { return await run(stale); } finally { setPreparing(false); }
    },
  };
}
