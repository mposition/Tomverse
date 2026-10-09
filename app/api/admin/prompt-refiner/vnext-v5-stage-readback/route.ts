export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { authOptions } from "@/lib/auth";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import {
  assertRecentAdminAuthentication,
  isAdminReauthenticationError,
} from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { readOnlySnapshotTransaction } from "@/lib/readOnlySnapshotTransaction";
import { readPromptRefinerVnextOneShotStage } from
  "@/lib/promptRefinerVnextOneShotStageReadback";
import { readPromptRefinerVnextOneShotTerminalReceipts } from
  "@/lib/promptRefinerVnextOneShotTerminalReceipt";

const headers = { "Cache-Control": "private, no-store, max-age=0" };

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
      "admin-prompt-refiner-vnext-v5-stage-readback", { minute: 3, day: 30 });
    const result = await readOnlySnapshotTransaction(async (tx) => {
      const v4 = await readPromptRefinerVnextOneShotStage(tx,
        "prompt-refiner-vnext-one-shot-v4");
      const v5 = await readPromptRefinerVnextOneShotStage(tx,
        "prompt-refiner-vnext-one-shot-v5");
      const terminals = await readPromptRefinerVnextOneShotTerminalReceipts(tx);
      return { v4, v5, v4TerminalSummary: {
        valid: terminals.valid,
        terminalReceipts: terminals.terminalReceipts,
        unknownReceipts: terminals.unknownReceipts,
        notAttemptedSlots: terminals.slots.filter(
          (slot) => slot.state === "not_attempted").length,
        consumedWithoutReceipt: terminals.consumedWithoutReceipt,
        observedCostMicroUsd: terminals.observedCostMicroUsd,
        unresolvedCostUpperBoundMicroUsd:
          terminals.unresolvedCostUpperBoundMicroUsd,
      } };
    }, { maxWait: 5_000, timeout: 10_000 });
    return NextResponse.json(result, { headers });
  } catch (error) {
    const response = apiSecurityResponse(error);
    if (response) {
      response.headers.set("Cache-Control", headers["Cache-Control"]);
      return response;
    }
    return NextResponse.json({ error: "Read-back unavailable." },
      { status: 503, headers });
  }
}
