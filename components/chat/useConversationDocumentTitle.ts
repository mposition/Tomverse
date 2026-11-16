"use client";

import { useEffect } from "react";

// The browser tab used to read "Tomverse Chat" for every conversation, so two open tabs
// could not be told apart. While a titled conversation is on screen the tab carries its
// title; an untitled (new) conversation keeps the route's own title.
//
// Next streams the route's metadata <title> into <head> after hydration, which overwrote a
// title set once from this effect. The observer puts the conversation title back whenever
// <head> changes underneath it, and stops (restoring the route title) when the conversation
// is closed or the shell unmounts.
export function useConversationDocumentTitle(title: string | null | undefined) {
  const name = title?.trim();
  useEffect(() => {
    if (!name) return;
    const desired = `${name} · Tomverse`;
    const previous = document.title;
    const apply = () => {
      if (document.title !== desired) document.title = desired;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      document.title = previous;
    };
  }, [name]);
}
