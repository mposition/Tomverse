"use client";

import { useEffect, useState } from "react";
import { discardResponseBody } from "@/lib/discardResponseBody";

const FIRST_POLL_MS = 1_500;
const POLL_MS = 5_000;

/**
 * True once the caller could start one more response.
 *
 * Polls GET /api/chat/concurrency while `messageId` names a concurrency-refused
 * turn, and stops as soon as a slot is free or the turn is gone. The answer is
 * keyed to that turn, so a later refusal starts out waiting again. It is only a
 * hint for enabling the retry button: the retry itself is admitted, or refused
 * again, by the server like any other send.
 */
export function useChatConcurrencySlot(messageId: string | null): boolean {
  const [readyFor, setReadyFor] = useState<string | null>(null);

  useEffect(() => {
    if (!messageId || readyFor === messageId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      if (cancelled) return;
      if (document.visibilityState !== "hidden") {
        try {
          const response = await fetch("/api/chat/concurrency", { cache: "no-store" });
          let body: unknown = null;
          if (response.ok) body = await response.json();
          else await discardResponseBody(response);
          if (
            !cancelled &&
            body !== null &&
            typeof body === "object" &&
            (body as { available?: unknown }).available === true
          ) {
            setReadyFor(messageId);
            return;
          }
        } catch {
          // A failed read keeps the button waiting; the next poll tries again.
        }
      }
      if (!cancelled) timer = setTimeout(() => void poll(), POLL_MS);
    };

    timer = setTimeout(() => void poll(), FIRST_POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [messageId, readyFor]);

  return messageId !== null && readyFor === messageId;
}
