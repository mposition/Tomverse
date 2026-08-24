export const dynamic = "force-dynamic";

import { createConversationForProduct } from "@/lib/conversationCreateHandler";
import { REVIEW_PRODUCT_KEY } from "@/lib/conversationProduct";

/**
 * Create a Tomverse Review conversation.
 *
 * Product boundary decision record v1.2, §6. The product is this module's
 * constant, not anything the request carries: a body field or a `Referer`
 * would be the client's claim about which screen it was on, and a product
 * identity derived from a claim is not server-derived.
 */
export async function POST(req: Request) {
  return createConversationForProduct(req, REVIEW_PRODUCT_KEY);
}
