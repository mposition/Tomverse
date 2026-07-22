export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { requestEmailLoginCode, EmailLoginError } from "@/lib/emailLogin";
import { apiSecurityResponse, readLimitedJson } from "@/lib/apiSecurity";

const requestSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    turnstileToken: z.string().trim().min(1).max(2_048).optional(),
  })
  .strict();

export async function POST(req: Request) {
  try {
    const body = await readLimitedJson(req, 2_048, requestSchema);
    await requestEmailLoginCode(req, body.email, body.turnstileToken);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof EmailLoginError) {
      const status = error.code === "TURNSTILE_REQUIRED" ? 403 : 403;
      return NextResponse.json({ ok: false, code: error.code }, { status });
    }
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Email login code request failed:", error);
    return NextResponse.json({ error: "Failed to send login code." }, { status: 500 });
  }
}
