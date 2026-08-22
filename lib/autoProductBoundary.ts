/**
 * The one place that answers "may Auto act here at all?", before anything
 * else is consulted.
 *
 * Product boundary decision record v1.2, §3.
 *
 * ## Three consumers, one decision
 *
 * The product question has three askers, and they used to have none:
 *
 *   1. surface entry   -- may this account start a Chat? (`chatSurfaceAvailable`)
 *   2. UI exposure     -- is Auto offered? (`autoUiAvailability`)
 *   3. turn routing    -- does Auto route this turn? (`selectAutoModel`)
 *
 * If each decided separately the screen and the execution would be free to
 * disagree, and the user would get a control that flips, saves and changes
 * nothing -- which UI contract §1 exists to prevent. So all three call this.
 *
 * ## Why the product comes before the cohort
 *
 * `lib/autoCohort.ts` already documents that refusal order changes what the
 * rollout metrics say: "Reporting the bucket for a subject who was actually
 * blocked by an outstanding gate would make the rollout look larger than it
 * is." The same argument applies one level up.
 *
 * A Review conversation is not *outside* the cohort -- it was never a subject
 * of the cohort question. Evaluating it anyway dilutes the rollout percentage
 * with Review traffic, and "what share of Chat users are being routed" stops
 * being readable. So the product is settled first, and `product_not_chat` is
 * an `AutoSelectionRefusal`, never an `AutoCohortRefusal`.
 *
 * The full order, of which this is step 2:
 *
 *   1. trusted product decided
 *   2. product_not_chat            <- here
 *   3. cohort / readiness / kill switch / plan / bucket
 *   4. no_conversation
 *   5. conversation_is_manual
 *   6. attachments_unmeasurable
 *   7. Router
 *
 * ## Two different nulls
 *
 * They must not be conflated, and conflating them is how a Review
 * conversation gets routed during the transition:
 *
 *   no conversation at all      -> no trusted product. `no_conversation` at
 *                                  step 4, not a product refusal;
 *   a conversation whose        -> resolved through PRODUCT_KEY_READ_MODE.
 *   productKey is still NULL       Under `legacy_fallback` that is Review, so
 *                                  Auto refuses it. Under `strict` it is a
 *                                  data defect, and a defect is not Chat
 *                                  either.
 *
 * The second is the whole reason `hasConversation` is a separate input rather
 * than being inferred from `productKey === null`. Every conversation in the
 * database is in that state today.
 *
 * What null must never mean is "use the surface instead". §6 is explicit:
 * once the row exists its own productKey is the only source, and the actual
 * dispatch may not fall back to a `surfaceProductKey`. A surface is what the
 * client was looking at; the row is what the server decided.
 *
 * Pure, and deliberately free of any cohort, flag or readiness import: this
 * module answers one question and must be callable before those are read.
 */

import {
  AUTO_SELECTION_PRODUCT,
  isConversationProductKey,
  type ConversationProductKey,
} from "@/lib/conversationProduct";
import {
  DEFAULT_PRODUCT_KEY_READ_MODE,
  readProductKey,
  type ProductKeyReadMode,
} from "@/lib/productKeyReadMode";

export type AutoProductRefusal = "product_not_chat";

export type AutoProductDecision = {
  allowed: boolean;
  /** `null` when there was no conversation to have a product at all. */
  reason: AutoProductRefusal | null;
  /** The resolved product, or null when there was no conversation. */
  productKey: ConversationProductKey | string | null;
  /**
   * True when the row exists, carries no product, and the read mode is
   * `strict`. Auto refuses either way -- this is for the operator log, so a
   * defect is not reported as an ordinary Review conversation.
   */
  defect: boolean;
};

export type AutoProductBoundaryInput = {
  /** The value stored on the Conversation row. Never a body, header or surface. */
  productKey: string | null;
  /**
   * Whether a conversation row exists at all.
   *
   * Separate from `productKey === null` on purpose: a row with a NULL product
   * is resolved through the read mode, and a turn with no row has nothing to
   * resolve.
   */
  hasConversation: boolean;
  readMode?: ProductKeyReadMode;
};

/** Steps 1 and 2 of the decision order. */
export const autoProductBoundary = (
  input: AutoProductBoundaryInput
): AutoProductDecision => {
  if (!input.hasConversation) {
    return { allowed: false, reason: null, productKey: null, defect: false };
  }

  const resolved = readProductKey(
    input.productKey,
    input.readMode ?? DEFAULT_PRODUCT_KEY_READ_MODE
  );

  // A strict-mode defect is not Chat. Refusing rather than routing is the only
  // safe reading: a row whose product nobody recorded is not evidence that it
  // is the one product Auto is offered in.
  if (resolved.productKey === null) {
    return {
      allowed: false,
      reason: "product_not_chat",
      productKey: null,
      defect: resolved.defect,
    };
  }

  // An unrecognised stored value is not Chat either. Being permissive here
  // would let a value the allowlist does not know about route turns.
  if (
    !isConversationProductKey(resolved.productKey) ||
    resolved.productKey !== AUTO_SELECTION_PRODUCT
  ) {
    return {
      allowed: false,
      reason: "product_not_chat",
      productKey: resolved.productKey,
      defect: false,
    };
  }

  return {
    allowed: true,
    reason: null,
    productKey: resolved.productKey,
    defect: false,
  };
};

/**
 * Whether this account may *start* a Tomverse Chat conversation.
 *
 * Deliberately separate from whether an existing conversation still opens.
 * Decision record §3: "chatSurfaceAvailable과 기존 대화의 지속 가능성은
 * 분리합니다" -- the first is "can I begin one", the second is "can I open the
 * one I have". Merging them locks a user out of their own conversation the
 * moment the cohort shrinks, which is the same failure UI contract §5 avoids
 * by accepting a return to manual unconditionally.
 *
 * Takes the availability decision rather than computing it, so the surface and
 * the toggle cannot read different cohort state.
 */
export const chatSurfaceAvailable = (availability: { offered: boolean }): boolean =>
  availability.offered;
