import { useSyncExternalStore } from "react";
import type { ChatImageOffer } from "../chat-extras-contract";

let current: ChatImageOffer | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const publish = (next: ChatImageOffer | null) => { current = next; for (const listener of listeners) listener(); };

/** The one pending "create this image?" question of a Chat send; a newer send replaces it. */
export const showImageOffer = (offer: ChatImageOffer) => publish(offer);
export const clearImageOffer = () => publish(null);
export const useImageOffer = (conversationId: string | undefined) => {
  const offer = useSyncExternalStore(subscribe, () => current);
  return offer && offer.conversationId === conversationId ? offer : null;
};
