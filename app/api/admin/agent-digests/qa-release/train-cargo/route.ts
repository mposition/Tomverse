export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";

import { isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { runQaReleaseControlAdminMutation } from "@/lib/qaReleaseOperatorControlAdmin";
import { QA_RELEASE_TRAIN_CARGO_MAX } from "@/lib/qaReleaseTrainCargoCore";
import { readQaReleaseTrainCargoCandidates } from "@/lib/qaReleaseTrainCargoRead";
import { saveQaReleaseTrainSelection } from "@/lib/qaReleaseTrainCargoStore";
import { readQaReleaseTrainSelection } from "@/lib/qaReleaseTrainStore";

// The next release train's cargo (lib/qaReleaseTrainCargoCore.ts): any
// administrator reads the candidates and the saved pick; owner or ops with a
// recent sign-in saves a pick, audited. The train reads the pick when it departs.

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) return NextResponse.json({ error: "Not found." }, { status: 404 });
    await consumeApiRateLimit(request, session.user.id, "qa-release-train-cargo-read", { minute: 30, day: 1000 });
    const [candidates, selection] = await Promise.all([readQaReleaseTrainCargoCandidates(), readQaReleaseTrainSelection()]);
    return NextResponse.json({ candidates, selection });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error(JSON.stringify({ event: "qa_release_train_cargo_read_failed" }));
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}

const schema = z
  .object({
    numbers: z.array(z.number().int().positive().max(9_999_999)).max(QA_RELEASE_TRAIN_CARGO_MAX).refine((numbers) => new Set(numbers).size === numbers.length),
  })
  .strict();

export async function POST(request: Request) {
  return runQaReleaseControlAdminMutation({
    request,
    bucket: "qa-release-train-cargo",
    schema,
    run: ({ body, session }) => saveQaReleaseTrainSelection({ session, request }, body.numbers),
  });
}
