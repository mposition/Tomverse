export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";

import { handleResendWebhook } from "@/lib/emailWebhookRoute";

/**
 * One webhook endpoint per provider account: `transactional` and `marketing`,
 * each verified with its own signing secret
 * (docs/policy/email-product-news-redesign-draft.md, section 7.4, C56).
 *
 * Any other segment is not found -- an event for an account this deployment
 * does not know has nowhere correct to be recorded.
 */
export async function POST(
  req: Request,
  context: { params: Promise<{ stream: string }> }
) {
  const { stream } = await context.params;
  if (stream !== "transactional" && stream !== "marketing") {
    return NextResponse.json(
      { error: "Not found." },
      { status: 404, headers: { "Cache-Control": "no-store" } }
    );
  }
  return handleResendWebhook(req, stream);
}
