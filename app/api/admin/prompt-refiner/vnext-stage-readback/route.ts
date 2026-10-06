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

const headers = { "Cache-Control": "private, no-store, max-age=0" };

/** Owner-only, content-free diagnostic; never stages or authorizes a run. */
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
        return NextResponse.json({
          error: "Recent administrator authentication is required.",
          code: "ADMIN_REAUTHENTICATION_REQUIRED",
        }, { status: 428, headers });
      }
      throw error;
    }
    await consumeApiRateLimit(request, session.user.id,
      "admin-prompt-refiner-vnext-stage-readback", { minute: 3, day: 30 });
    const { readback, thirdStage, previousStage, firstStage } = await readOnlySnapshotTransaction(
      async (tx) => ({
        readback: await readPromptRefinerVnextOneShotStage(tx),
        thirdStage: await readPromptRefinerVnextOneShotStage(
          tx, "prompt-refiner-vnext-one-shot-v3"
        ),
        previousStage: await readPromptRefinerVnextOneShotStage(
          tx, "prompt-refiner-vnext-one-shot-v2"
        ),
        firstStage: await readPromptRefinerVnextOneShotStage(
          tx, "prompt-refiner-vnext-one-shot-v1"
        ),
      }),
      { maxWait: 5_000, timeout: 10_000 }
    );
    return NextResponse.json({ readback, thirdStage, previousStage, firstStage }, { headers });
  } catch (error) {
    const response = apiSecurityResponse(error);
    if (response) {
      response.headers.set("Cache-Control", headers["Cache-Control"]);
      return response;
    }
    console.error("Prompt Refiner vNext stage read-back unexpectedly failed");
    return NextResponse.json({ error: "Read-back unavailable." },
      { status: 503, headers });
  }
}
