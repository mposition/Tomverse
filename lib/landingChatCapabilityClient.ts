/**
 * Read only the existing server-owned Chat offer for a resolved account.
 * Cancellation binds the result to one mounted account identity; it is never
 * cached across sign-out or an A-to-B-to-A transition.
 */
export function startLandingChatCapabilityRead({
  accountUserId,
  onResolved,
  fetcher = fetch,
}: {
  accountUserId: string | null;
  onResolved: (offered: boolean) => void;
  fetcher?: typeof fetch;
}): () => void {
  if (!accountUserId) return () => {};

  const controller = new AbortController();
  let active = true;
  const resolve = (offered: boolean) => {
    if (active && !controller.signal.aborted) onResolved(offered);
  };

  void (async () => {
    try {
      const response = await fetcher("/api/products/chat/capabilities", {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!active || controller.signal.aborted) return;
      if (!response.ok) {
        resolve(false);
        return;
      }
      const body: unknown = await response.json();
      const autoSelection = body && typeof body === "object" &&
        !Array.isArray(body) && "autoSelection" in body
          ? body.autoSelection : null;
      resolve(Boolean(autoSelection && typeof autoSelection === "object" &&
        !Array.isArray(autoSelection) && "offered" in autoSelection &&
        autoSelection.offered === true));
    } catch {
      resolve(false);
    }
  })();

  return () => {
    active = false;
    controller.abort();
  };
}
