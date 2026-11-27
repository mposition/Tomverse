"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { discardResponseBody } from "@/lib/discardResponseBody";

/**
 * The browser half of temporary Chat (lib/temporaryChatAccess.ts).
 *
 * The page asks three things of it: whether the next new Chat is temporary
 * (`createFields`, spread into the create request), which conversation the
 * create returned as temporary (`adoptCreated`), and whether the open
 * conversation is that one (`isActive`). Everything else -- the availability
 * read, deleting the conversation when the person leaves it, deleting it when
 * the page is closed -- happens here, so the page carries a few lines rather
 * than the lifecycle.
 *
 * "Leaving" is the open conversation changing away from the temporary one
 * after it was opened, or the page going away. Both delete it through the
 * ordinary conversation delete. Anything that slips past both (a crash, a
 * lost connection) is deleted by the server at its expiry.
 */
export type TemporaryChatController = {
  available: boolean;
  /** The next new Chat this tab starts is temporary. */
  armed: boolean;
  setArmed: (armed: boolean) => void;
  isActive: (conversationId: string | null) => boolean;
  createFields: () => { temporary?: true };
  adoptCreated: (created: unknown) => void;
  /**
   * Whether a conversation created earlier for this draft may be reused for
   * the send: only when it is temporary exactly when the toggle says so. A
   * row the Auto toggle created before temporary was turned on must not
   * answer a send the person was told is temporary.
   */
  matchesPending: (conversationId: string) => boolean;
};

const deleteConversation = (conversationId: string, keepalive = false) =>
  fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, { method: "DELETE", keepalive })
    .then(discardResponseBody)
    .catch(() => undefined);

export function useTemporaryChat(input: {
  /** Signed in, on the Chat surface. Off means the feature is not offered at all. */
  enabled: boolean;
  /** The signed-in account, so a sign-out or account switch resets everything. */
  ownerKey: string | null;
  currentChatId: string | null;
}): TemporaryChatController {
  const { enabled, ownerKey, currentChatId } = input;
  const [available, setAvailable] = useState<{ owner: string; value: boolean } | null>(null);
  const [armedFor, setArmedFor] = useState<string | null>(null);
  const [active, setActive] = useState<{ owner: string; id: string; entered: boolean } | null>(null);
  const activeRef = useRef(active);
  useEffect(() => { activeRef.current = active; }, [active]);

  useEffect(() => {
    if (!enabled || !ownerKey) return;
    const controller = new AbortController();
    void fetch("/api/products/chat/temporary", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as { available?: unknown } | null;
        if (!controller.signal.aborted) setAvailable({ owner: ownerKey, value: response.ok && body?.available === true });
      })
      .catch(() => { if (!controller.signal.aborted) setAvailable({ owner: ownerKey, value: false }); });
    return () => controller.abort();
  }, [enabled, ownerKey]);

  // Opening the temporary conversation marks it entered; moving to any other
  // conversation (or to a new one) afterwards deletes it. A conversation of
  // another account is simply not this one's (`isActive` checks the owner).
  // State changes are deferred a microtask, as elsewhere on this page, so the
  // effect only reacts to the navigation it observed.
  useEffect(() => {
    if (!active || active.owner !== ownerKey) return;
    if (currentChatId === active.id) {
      if (!active.entered) {
        queueMicrotask(() => {
          setActive((current) => (current?.id === active.id ? { ...current, entered: true } : current));
          setArmedFor(null);
        });
      }
      return;
    }
    if (active.entered) {
      void deleteConversation(active.id);
      queueMicrotask(() => setActive((current) => (current?.id === active.id ? null : current)));
    }
  }, [active, currentChatId, ownerKey]);

  // Closing or reloading the page leaves the conversation as well.
  useEffect(() => {
    const leave = () => {
      const current = activeRef.current;
      if (current) void deleteConversation(current.id, true);
    };
    window.addEventListener("pagehide", leave);
    return () => window.removeEventListener("pagehide", leave);
  }, []);

  const isAvailable = enabled && Boolean(ownerKey) && available?.owner === ownerKey && available.value;
  const armed = isAvailable && armedFor !== null && armedFor === ownerKey;

  const setArmed = useCallback((next: boolean) => setArmedFor(next ? ownerKey : null), [ownerKey]);
  const isActive = useCallback(
    (conversationId: string | null) => Boolean(conversationId && active?.owner === ownerKey && active.id === conversationId),
    [active, ownerKey]
  );
  const createFields = useCallback((): { temporary?: true } => (armed ? { temporary: true } : {}), [armed]);
  const adoptCreated = useCallback((created: unknown) => {
    const record = created as { id?: unknown; temporary?: unknown } | null;
    if (!ownerKey || record?.temporary !== true || typeof record.id !== "string") return;
    setActive({ owner: ownerKey, id: record.id, entered: false });
  }, [ownerKey]);

  const matchesPending = useCallback(
    (conversationId: string) => armed === Boolean(active?.owner === ownerKey && active?.id === conversationId),
    [active, armed, ownerKey]
  );

  return { available: isAvailable, armed, setArmed, isActive, createFields, adoptCreated, matchesPending };
}
