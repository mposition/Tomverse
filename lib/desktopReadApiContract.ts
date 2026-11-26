import {
  PRODUCT_KEY_EXPAND_DEPLOYED_AT_ENV,
  PRODUCT_KEY_LEGACY_FALLBACK_EXPIRES_AT_ENV,
  PRODUCT_KEY_READ_MODE_ENV,
  readProductKey,
  resolveProductKeyReadMode,
} from "./productKeyReadMode";

import {
  desktopChatWriteEnabled,
  desktopReviewWriteEnabled,
} from "./nativeBearerGate";

export {
  DESKTOP_APP_ORIGIN,
  DESKTOP_CHAT_CAPABILITIES,
  DESKTOP_CHAT_HISTORY,
  DESKTOP_CHAT_SEARCH,
  desktopAttachmentEnabled,
  desktopChatWriteEnabled,
  desktopComposerToolsEnabled,
  desktopReadApiRoute,
  desktopReviewAnalysisEnabled,
  desktopReviewWriteEnabled,
  desktopWriteApiRoute,
} from "./nativeBearerGate";

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
