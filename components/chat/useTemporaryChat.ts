"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { discardResponseBody } from "@/lib/discardResponseBody";
import {
  temporaryChatOnLeave,
  temporaryChatOnView,
  type TemporaryChatTracker,
} from "@/lib/temporaryChatClientCore";

/**
 * The browser half of temporary Chat (lib/temporaryChatAccess.ts).
 *
 * The page asks three things of it: whether the next new Chat is temporary
 * (`createFields`, spread into the create request), which conversation the
 * create returned as temporary (`adoptCreated`), and whether the open
 * conversation is that one (`isActive`). Everything else -- the availability
 * read and deleting the conversation when the person leaves it -- happens
 * here, so the page carries a few lines rather than the lifecycle. When to
 * delete is decided in lib/temporaryChatClientCore.ts.
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
  const [active, setActive] = useState<TemporaryChatTracker>(null);
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

  // The open conversation or the account changed. State changes are deferred
  // a microtask, as elsewhere on this page, so the effect only reacts to the
  // change it observed.
  useEffect(() => {
    const step = temporaryChatOnView(active, { ownerKey, currentChatId });
    if (step.deleteId) void deleteConversation(step.deleteId);
    if (step.next === active && !step.disarm) return;
    queueMicrotask(() => {
      setActive((current) => (current?.id === active?.id ? step.next : current));
      if (step.disarm) setArmedFor(null);
    });
  }, [active, currentChatId, ownerKey]);

  // The Chat screen going away is leaving too: an in-app navigation unmounts
  // it, and a reload or a closed tab fires `pagehide`. Both delete what is
  // tracked; a second request for the same conversation is a harmless 404.
  useEffect(() => {
    const leave = () => {
      const id = temporaryChatOnLeave(activeRef.current);
      if (id) void deleteConversation(id, true);
    };
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      leave();
    };
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
    const tracked = { owner: ownerKey, id: record.id, entered: false };
    // Read by the unmount and pagehide paths before the next render commits.
    activeRef.current = tracked;
    setActive(tracked);
  }, [ownerKey]);
  const matchesPending = useCallback(
    (conversationId: string) => armed === Boolean(active?.owner === ownerKey && active?.id === conversationId),
    [active, armed, ownerKey]
  );

  return { available: isAvailable, armed, setArmed, isActive, createFields, adoptCreated, matchesPending };
}
