export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { handleResendWebhook } from "@/lib/emailWebhookRoute";

/**
 * The transactional account's webhook, at the address every deployment's
 * Resend dashboard already points to. The same account is also served at
 * /api/webhooks/email/resend/transactional; the marketing account has only
 * its own path (docs/policy/email-product-news-redesign-draft.md, section 7.4).
 *
 * `runtime = "nodejs"` is load-bearing: the signature covers the raw bytes, and
 * verifying it needs `node:crypto` and a body that has not been through a parse
 * and a re-serialise.
 */
export async function POST(req: Request) {
  return handleResendWebhook(req, "transactional");
}
