/**
 * Where the landing CTA sends this particular visitor.
 *
 * Entry and availability: docs/ui-contracts/chat-product-switcher.md. After the canonical cutover,
 * `/chat` is Chat and `/review` is Review. A visitor must not be sent to Chat
 * when the server has not offered it; landing on a product and being thrown
 * out is worse than being shown the available Review entry directly.
 *
 * So the destination is decided on the server, per visitor, before the link is
 * rendered -- not by the client reading a flag it is not allowed to have.
 *
 * `chatPathIsChat` is retained only for an explicitly requested compatibility
 * calculation. Its default is the shipped canonical mapping.
 *
 * Pure.
 */

import {
  CHAT_WORKSPACE_COMPATIBILITY_PATH,
  LEGACY_REVIEW_PATH,
  PRODUCT_SURFACE_PATH,
} from "@/lib/productSurfaceRoutes";

export type WorkspaceDestinationInput = {
  /**
   * Whether this visitor may *start* a Tomverse Chat conversation.
   *
   * From `chatSurfaceAvailable` (lib/autoProductBoundary.ts), computed on the
   * server. Never a client-side flag read: the refusal is internal rollout
   * state, and a client that could see it could work out the rollout share.
   */
  chatSurfaceAvailable: boolean;
  /** UI language, carried through so the workspace opens in it. */
  lang: string;
  /** A guest gets the preview entry marker the CTA already used. */
  isAuthenticated: boolean;
  /**
   * Whether `/chat` has been repointed at Tomverse Chat yet.
   *
   * Defaults to the canonical cutover. `false` is a compatibility calculation
   * for callers testing the former route map, not the landing default.
   */
  chatPathIsChat?: boolean;
};

export const REVIEW_ENTRY_MARKER = "entry=guest-preview";

export const workspaceDestination = ({
  chatSurfaceAvailable,
  lang,
  isAuthenticated,
  chatPathIsChat = true,
}: WorkspaceDestinationInput): string => {
  const reviewPath = chatPathIsChat ? PRODUCT_SURFACE_PATH.review : LEGACY_REVIEW_PATH;
  const path = chatSurfaceAvailable
    ? (chatPathIsChat
        ? PRODUCT_SURFACE_PATH.chat
        : CHAT_WORKSPACE_COMPATIBILITY_PATH)
    : reviewPath;

  const query = `lang=${encodeURIComponent(lang)}`;
  // The guest preview marker belongs to the Review entry. A guest cannot be
  // Chat-eligible today, and marking a Chat entry as a guest preview would
  // claim an experience that does not exist.
  const suffix = !isAuthenticated && !chatSurfaceAvailable ? `&${REVIEW_ENTRY_MARKER}` : "";
  return `${path}?${query}${suffix}`;
};
