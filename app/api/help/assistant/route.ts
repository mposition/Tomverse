export const dynamic = "force-dynamic";

import { randomUUID } from "node:crypto";
import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { assertUserOperationalAccess } from "@/lib/chatSecurity";
import { answerHelpQuestion } from "@/lib/helpAssistant";
import { HELP_ASSISTANT_MAX_HISTORY_TURNS, HELP_ASSISTANT_MAX_QUESTION_CHARS } from "@/lib/helpAssistantCore";
import { isHelpAssistantEnabled } from "@/lib/helpAssistantSettings";
import { SUPPORTED_LANGUAGES } from "@/lib/language";

// GET  /api/help/assistant -- whether the question box can answer for this
//      reader: { enabled, signedIn }. The Help Centre pages are static, so the
//      box asks here instead of the page reading the session.
// POST /api/help/assistant -- one answer from the public help guides.
//
// Signed-in readers only. Each answer is a platform-paid model call with no
// per-reader daily question limit (owner decision 2026-11-18); keeping it
// behind sign-in is what stops an anonymous script from spending the shared
// provider budget the Auto router also draws on. The per-minute bucket only
// absorbs a burst; the day bucket is set out of reach on purpose.

const NO_STORE = { "Cache-Control": "no-store" };

const askSchema = z
  .object({
    lang: z.enum(SUPPORTED_LANGUAGES),
    question: z.string().trim().min(1).max(HELP_ASSISTANT_MAX_QUESTION_CHARS),
    history: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            text: z.string().max(HELP_ASSISTANT_MAX_QUESTION_CHARS * 2),
          })
          .strict()
      )
      .max(HELP_ASSISTANT_MAX_HISTORY_TURNS)
      .default([]),
    focusGuideId: z.string().trim().min(1).max(80).nullable().optional(),
  })
  .strict();

export async function GET() {
  const [session, enabled] = await Promise.all([getServerSession(authOptions), isHelpAssistantEnabled()]);
  return NextResponse.json({ enabled, signedIn: Boolean(session?.user?.id) }, { headers: NO_STORE });
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "sign_in_required" }, { status: 401, headers: NO_STORE });
    // Off costs nothing, not even the caller's rate-limit allowance.
    if (!(await isHelpAssistantEnabled())) {
      return NextResponse.json({ error: "unavailable" }, { status: 503, headers: NO_STORE });
    }
    await consumeApiRateLimit(req, userId, "help-assistant", { minute: 20, day: 1_000_000 });
    const body = await readLimitedJson(req, 64 * 1024, askSchema);
    try {
      await assertUserOperationalAccess(userId);
    } catch {
      return NextResponse.json({ error: "unavailable" }, { status: 503, headers: NO_STORE });
    }
    const result = await answerHelpQuestion({
      lang: body.lang,
      question: body.question,
      history: body.history,
      focusGuideId: body.focusGuideId ?? null,
      traceId: randomUUID(),
    });
    if (!result.ok) {
      return NextResponse.json({ error: "unavailable", reason: result.reason }, { status: 503, headers: NO_STORE });
    }
    return NextResponse.json({ answer: result.answer }, { headers: NO_STORE });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    return NextResponse.json({ error: "unavailable" }, { status: 500, headers: NO_STORE });
  }
}
