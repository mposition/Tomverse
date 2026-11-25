"use client";

import { useSyncExternalStore } from "react";
import type { ConversationProductKey } from "@/lib/conversationProduct";
import {
    SETTINGS_RETURN_ENTRY_STORAGE_KEY,
    SETTINGS_RETURN_PRODUCT_STORAGE_KEY,
    settingsReturnProductFrom,
    type SettingsEntry,
} from "@/lib/settingsNavigation";

const SETTINGS_RETURN_CHANGED = "tomverse:settings-return-changed";

/** Records the product whose settings panel is open, for the detail pages. */
export function rememberSettingsReturnProduct(product: ConversationProductKey, entry: SettingsEntry = "workspace") {
    try {
        window.sessionStorage.setItem(SETTINGS_RETURN_PRODUCT_STORAGE_KEY, product);
        window.sessionStorage.setItem(SETTINGS_RETURN_ENTRY_STORAGE_KEY, entry);
        window.dispatchEvent(new Event(SETTINGS_RETURN_CHANGED));
    } catch {
        // Storage can be unavailable; the detail pages then fall back to Review.
    }
}

const readStored = (key: string) => {
    try {
        return window.sessionStorage.getItem(key);
    } catch {
        return null;
    }
};

const subscribe = (onChange: () => void) => {
    window.addEventListener(SETTINGS_RETURN_CHANGED, onChange);
    return () => window.removeEventListener(SETTINGS_RETURN_CHANGED, onChange);
};
const readProduct = () => readStored(SETTINGS_RETURN_PRODUCT_STORAGE_KEY);
const readEntry = () => readStored(SETTINGS_RETURN_ENTRY_STORAGE_KEY);
const serverSnapshot = () => null;

/**
 * The product a settings detail page returns to. Review on the server and when
 * nothing usable was stored, so the first render matches the server's.
 */
export function useSettingsReturnProduct(): ConversationProductKey {
    const stored = useSyncExternalStore(subscribe, readProduct, serverSnapshot);
    return settingsReturnProductFrom(stored);
}

export function useSettingsReturnTarget() {
    const product = useSettingsReturnProduct();
    const stored = useSyncExternalStore(subscribe, readEntry, serverSnapshot);
    const entry: SettingsEntry = stored === "page" || stored === "desktop" ? stored : "workspace";
    return { product, entry };
}
