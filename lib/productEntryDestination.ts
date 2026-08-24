/**
 * Where the landing CTA sends this particular visitor.
 *
 * Product boundary decision record v1.2 §3, closing paragraph: the CTA goes
 * straight to `/chat` today, and the moment `/chat` is bound to the Chat
 * cohort that link starts bouncing everybody outside it. **A visitor must not
 * be sent somewhere they will be redirected away from.** Landing on a product
 * and being thrown out of it is worse than never being offered it, because the
 * bounce is the only part the user sees.
 *
 * So the destination is decided on the server, per visitor, before the link is
 * rendered -- not by the client reading a flag it is not allowed to have.
 *
 * ## Today this changes nothing
 *
 * Chat is not released and `chatSurfaceAvailable` is false for everybody, so
 * every visitor gets the Review workspace, which is still at `/chat`. The
 * function exists so that the day `/chat` changes meaning is a change to one
 * constant here rather than a scramble across every CTA.
 *
 * Pure.
 */

import { LEGACY_REVIEW_PATH, PRODUCT_SURFACE_PATH } from "@/lib/productSurfaceRoutes";

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
   * False today, and deliberately an input rather than a constant read here:
   * flipping it is a release decision with its own deep-link evidence, and a
   * function that decided it for itself would make that decision invisible.
   */
  chatPathIsChat?: boolean;
};

export const REVIEW_ENTRY_MARKER = "entry=guest-preview";

export const workspaceDestination = ({
  chatSurfaceAvailable,
  lang,
  isAuthenticated,
  chatPathIsChat = false,
}: WorkspaceDestinationInput): string => {
  const reviewPath = chatPathIsChat ? PRODUCT_SURFACE_PATH.review : LEGACY_REVIEW_PATH;
  const path = chatSurfaceAvailable ? PRODUCT_SURFACE_PATH.chat : reviewPath;

  const query = `lang=${encodeURIComponent(lang)}`;
  // The guest preview marker belongs to the Review entry. A guest cannot be
  // Chat-eligible today, and marking a Chat entry as a guest preview would
  // claim an experience that does not exist.
  const suffix = !isAuthenticated && !chatSurfaceAvailable ? `&${REVIEW_ENTRY_MARKER}` : "";
  return `${path}?${query}${suffix}`;
};
