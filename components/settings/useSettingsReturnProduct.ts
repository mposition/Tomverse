"use client";

import { useSyncExternalStore } from "react";
import type { ConversationProductKey } from "@/lib/conversationProduct";
import {
    SETTINGS_RETURN_PRODUCT_STORAGE_KEY,
    settingsReturnProductFrom,
} from "@/lib/settingsNavigation";

/** Records the product whose settings panel is open, for the detail pages. */
export function rememberSettingsReturnProduct(product: ConversationProductKey) {
    try {
        window.sessionStorage.setItem(SETTINGS_RETURN_PRODUCT_STORAGE_KEY, product);
    } catch {
        // Storage can be unavailable; the detail pages then fall back to Review.
    }
}

const readStored = () => {
    try {
        return window.sessionStorage.getItem(SETTINGS_RETURN_PRODUCT_STORAGE_KEY);
    } catch {
        return null;
    }
};

const subscribe = () => () => {};

/**
 * The product a settings detail page returns to. Review on the server and when
 * nothing usable was stored, so the first render matches the server's.
 */
export function useSettingsReturnProduct(): ConversationProductKey {
    const stored = useSyncExternalStore(subscribe, readStored, () => null);
    return settingsReturnProductFrom(stored);
}
