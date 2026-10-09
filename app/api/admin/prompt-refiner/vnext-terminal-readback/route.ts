export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { authOptions } from "@/lib/auth";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication,
  isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { readOnlySnapshotTransaction } from "@/lib/readOnlySnapshotTransaction";
import { readPromptRefinerVnextOneShotTerminalReceipts } from
  "@/lib/promptRefinerVnextOneShotTerminalReceipt";

const headers = { "Cache-Control": "private, no-store, max-age=0" };

/** Owner-only, content-free readback; never grants a paid run or changes slots. */
export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404, headers });
    }
    if (getAdminRole(session) !== "owner") {
      return NextResponse.json({ error: "Forbidden." }, { status: 403, headers });
    }
    try {
      await assertRecentAdminAuthentication(session);
    } catch (error) {
      if (isAdminReauthenticationError(error)) {
        return NextResponse.json({ code: "ADMIN_REAUTHENTICATION_REQUIRED" },
          { status: 428, headers });
      }
      throw error;
    }
    await consumeApiRateLimit(request, session.user.id,
      "admin-prompt-refiner-vnext-terminal-readback", { minute: 3, day: 30 });
    const requested = new URL(request.url).searchParams.get("stageId");
    if (requested !== null &&
        requested !== "prompt-refiner-vnext-one-shot-v5") {
      return NextResponse.json({ code: "ONE_SHOT_STAGE_INVALID" },
        { status: 400, headers });
    }
    const readback = await readOnlySnapshotTransaction(
      (tx) => readPromptRefinerVnextOneShotTerminalReceipts(tx,
        requested ?? "prompt-refiner-vnext-one-shot-v4"),
      { maxWait: 5_000, timeout: 15_000 },
    );
    return NextResponse.json({ readback }, { headers });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", headers["Cache-Control"]);
      return security;
    }
    return NextResponse.json({ code: "ONE_SHOT_TERMINAL_READBACK_UNAVAILABLE" },
      { status: 503, headers });
  }
}
