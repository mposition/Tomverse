import {
  PRODUCT_KEY_EXPAND_DEPLOYED_AT_ENV,
  PRODUCT_KEY_LEGACY_FALLBACK_EXPIRES_AT_ENV,
  PRODUCT_KEY_READ_MODE_ENV,
  readProductKey,
  resolveProductKeyReadMode,
} from "./productKeyReadMode";

export const DESKTOP_APP_ORIGIN = "tomverse://desktop";
export const DESKTOP_CHAT_CAPABILITIES = "/api/products/chat/capabilities";
export const DESKTOP_CHAT_HISTORY = "/api/conversations";
export const DESKTOP_CHAT_SEARCH = "/api/conversations/search";
export const DESKTOP_CHAT_CREATE = "/api/products/chat/conversations";
export const DESKTOP_CHAT_TURN = "/api/chat";
export const DESKTOP_CHAT_CONTEXT = "/api/chat/context";
export const DESKTOP_REVIEW_CREATE = "/api/products/review/conversations";
export const DESKTOP_REVIEW_ROUTING = "/api/review/route";
export const DESKTOP_REVIEW_PREFLIGHT = "/api/chat/preflight";
export const DESKTOP_IMAGE_GENERATIONS = "/api/images/generations";

const ownResourceRead = /^\/api\/(?:conversations|artifacts)\/[A-Za-z0-9_-]{1,128}$/;

export function desktopReadApiRoute(path: string, method: string): boolean {
  return method === "GET" && (path === DESKTOP_CHAT_CAPABILITIES || path === DESKTOP_CHAT_HISTORY ||
    path === DESKTOP_CHAT_SEARCH || ownResourceRead.test(path) ||
    /^\/api\/conversations\/[A-Za-z0-9_-]{1,100}\/continuation$/.test(path) ||
    (desktopReviewWriteEnabled() && (path === DESKTOP_IMAGE_GENERATIONS ||
      /^\/api\/conversations\/[A-Za-z0-9_-]{1,100}\/generations$/.test(path) ||
      /^\/api\/images\/(?:groups\/[A-Za-z0-9_-]{1,100}|generations\/[A-Za-z0-9_-]{1,100}\/download)$/.test(path))));
}

export function desktopChatWriteRoute(path: string, method: string): boolean {
  if (path === DESKTOP_CHAT_CREATE || path === DESKTOP_CHAT_TURN) return method === "POST";
  if (/^\/api\/conversations\/[A-Za-z0-9_-]{1,100}\/messages$/.test(path)) return method === "POST";
  if (["/api/conversations/search", "/api/conversations/export-all", "/api/conversations/import-guest"].includes(path)) return false;
  return (method === "PATCH" || method === "DELETE") && /^\/api\/conversations\/[A-Za-z0-9_-]{1,100}$/.test(path);
}

export function desktopChatWriteEnabled() {
  return process.env.TOMVERSE_DESKTOP_AUTH_ENABLED === "true" && process.env.TOMVERSE_DESKTOP_CHAT_WRITE_ENABLED === "true";
}

export function desktopReviewWriteEnabled() {
  return process.env.TOMVERSE_DESKTOP_AUTH_ENABLED === "true" && process.env.TOMVERSE_DESKTOP_REVIEW_ENABLED === "true";
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

export function desktopAttachmentEnabled() {
  return (desktopChatWriteEnabled() || desktopReviewWriteEnabled()) && process.env.TOMVERSE_DESKTOP_ATTACHMENTS_ENABLED === "true";
}

export function desktopWriteApiRoute(path: string, method: string): boolean {
  if (path === DESKTOP_CHAT_CONTEXT) return method === "POST" && desktopChatWriteEnabled();
  if (path === DESKTOP_CHAT_TURN && ["PUT", "PATCH", "DELETE"].includes(method) && desktopAttachmentEnabled()) return true;
  if (desktopChatWriteEnabled() && desktopChatWriteRoute(path, method)) return true;
  if (!desktopReviewWriteEnabled()) return false;
  if (path === DESKTOP_CHAT_CREATE || method === "DELETE") return false;
  return desktopChatWriteRoute(path, method) || (method === "POST" &&
    [DESKTOP_REVIEW_CREATE, DESKTOP_REVIEW_ROUTING, DESKTOP_REVIEW_PREFLIGHT, DESKTOP_IMAGE_GENERATIONS].includes(path));
}
