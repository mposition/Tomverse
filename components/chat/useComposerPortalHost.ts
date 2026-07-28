"use client";

import { useEffect, useState } from "react";

/**
 * STG-F003. Both shells render the composer with `createPortal` into
 * whichever of two slots is currently on screen: the welcome screen's slot
 * while the conversation is empty, the bottom dock once it is not.
 *
 * Passing those two slot elements to `createPortal` directly means that the
 * moment `isConversationEmpty` flips -- which happens asynchronously, when
 * the last panel reports back whether it has any messages -- React unmounts
 * the whole ChatInput subtree from one container and builds a fresh one in
 * the other. The `<textarea>` DOM node is destroyed and replaced, so:
 *
 *   * an `input` event already dispatched to the old node never reaches the
 *     new fiber, and the text it carried is dropped;
 *   * focus is lost, so the keystrokes after it go nowhere;
 *   * a following Enter lands on an empty composer, `handleGlobalSubmit`
 *     returns at its empty-prompt guard, and the user sees no request, no
 *     error, and no prompt -- the STG-F003 symptom.
 *
 * Portalling into one host element that we own, and moving that host between
 * the slots, keeps the subtree -- and every DOM node in it -- alive. Only its
 * position in the document changes. `display: contents` keeps the host out of
 * layout, so each slot lays its children out exactly as it did when ChatInput
 * was its direct child.
 *
 * Returns null during SSR and the first client render, which is the same
 * condition the callers already handle for "no slot resolved yet".
 */
export function useComposerPortalHost(target: HTMLElement | null) {
  const [host] = useState<HTMLDivElement | null>(() => {
    if (typeof document === "undefined") return null;
    const element = document.createElement("div");
    element.style.display = "contents";
    element.dataset.composerPortalHost = "true";
    return element;
  });

  useEffect(() => {
    if (!host || !target || host.parentElement === target) return;
    // appendChild moves the node rather than cloning it, but a move still
    // blurs whatever inside it had focus, so the caret is put back where the
    // user left it.
    const previouslyFocused = document.activeElement;
    const shouldRestoreFocus =
      previouslyFocused instanceof HTMLElement && host.contains(previouslyFocused);
    target.appendChild(host);
    if (shouldRestoreFocus) {
      (previouslyFocused as HTMLElement).focus({ preventScroll: true });
    }
  }, [host, target]);

  useEffect(() => {
    if (!host) return;
    return () => {
      host.remove();
    };
  }, [host]);

  return target ? host : null;
}
