import {
  PRODUCT_KEY_EXPAND_DEPLOYED_AT_ENV,
  PRODUCT_KEY_LEGACY_FALLBACK_EXPIRES_AT_ENV,
  PRODUCT_KEY_READ_MODE_ENV,
  readProductKey,
  resolveProductKeyReadMode,
} from "./productKeyReadMode";

import {
  DESKTOP_IMAGE_GENERATIONS,
  desktopChatWriteEnabled,
  desktopReviewWriteEnabled,
} from "./nativeBearerGate";

export {
  DESKTOP_APP_ORIGIN,
  desktopAttachmentEnabled,
  desktopChatWriteEnabled,
  desktopReviewWriteEnabled,
  desktopWriteApiRoute,
} from "./nativeBearerGate";

export const DESKTOP_CHAT_CAPABILITIES = "/api/products/chat/capabilities";
export const DESKTOP_CHAT_HISTORY = "/api/conversations";
export const DESKTOP_CHAT_SEARCH = "/api/conversations/search";

const ownResourceRead = /^\/api\/(?:conversations|artifacts)\/[A-Za-z0-9_-]{1,128}$/;

export function desktopReadApiRoute(path: string, method: string): boolean {
  return method === "GET" && (path === DESKTOP_CHAT_CAPABILITIES || path === DESKTOP_CHAT_HISTORY ||
    path === DESKTOP_CHAT_SEARCH || ownResourceRead.test(path) ||
    /^\/api\/conversations\/[A-Za-z0-9_-]{1,100}\/continuation$/.test(path) ||
    (desktopReviewWriteEnabled() && (path === DESKTOP_IMAGE_GENERATIONS ||
      /^\/api\/conversations\/[A-Za-z0-9_-]{1,100}\/generations$/.test(path) ||
      /^\/api\/images\/(?:groups\/[A-Za-z0-9_-]{1,100}|generations\/[A-Za-z0-9_-]{1,100}\/download)$/.test(path))));
}

export function desktopTextWriteEnabled(product: unknown) {
  return product === "chat" ? desktopChatWriteEnabled() : product === "review" && desktopReviewWriteEnabled();
}

export function desktopConversationWriteProduct(
  conversation: { kind: string; productKey: string | null } | null,
): "chat" | "review" | null {
  if (!conversation || conversation.kind !== "chat") return null;
  let productKey = conversation.productKey;
  if (productKey === null && desktopReviewWriteEnabled()) {
    const { mode } = resolveProductKeyReadMode({
      mode: process.env[PRODUCT_KEY_READ_MODE_ENV],
      expiresAt: process.env[PRODUCT_KEY_LEGACY_FALLBACK_EXPIRES_AT_ENV],
      expandDeployedAt: process.env[PRODUCT_KEY_EXPAND_DEPLOYED_AT_ENV],
      now: new Date(),
    });
    if (mode) productKey = readProductKey(productKey, mode).productKey;
  }
  if (productKey === "chat" && desktopChatWriteEnabled()) return "chat";
  if (productKey === "review" && desktopReviewWriteEnabled()) return "review";
  return null;
}
