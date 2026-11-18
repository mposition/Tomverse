export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { HELP_GUIDE_IDS } from "@/lib/helpCentre/catalog";

// POST /api/help/feedback -- the thumbs on a help answer. Written to the log
// only (outcome and cited guide ids, never the question or the answer), so
// which guides send readers away unanswered can be read from the log stream.

const feedbackSchema = z
  .object({
    helpful: z.boolean(),
    guideIds: z.array(z.string().max(80)).max(10).default([]),
    lang: z.string().max(10),
  })
  .strict();

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "sign_in_required" }, { status: 401 });
    await consumeApiRateLimit(req, userId, "help-feedback", { minute: 30, day: 1_000_000 });
    const body = await readLimitedJson(req, 4 * 1024, feedbackSchema);
    const known = new Set<string>(HELP_GUIDE_IDS);
    console.info(
      JSON.stringify({
        event: "help_assistant_feedback",
        helpful: body.helpful,
        lang: body.lang,
        guideIds: body.guideIds.filter((id) => known.has(id)),
      })
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    return NextResponse.json({ error: "unavailable" }, { status: 500 });
  }
}
