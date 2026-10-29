export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";

import { isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { runQaReleaseControlAdminMutation } from "@/lib/qaReleaseOperatorControlAdmin";
import { QA_RELEASE_TRAIN_CANDIDATE_DAYS, QA_RELEASE_TRAIN_CARGO_MAX, qaReleaseTrainWithTrainVerdicts } from "@/lib/qaReleaseTrainCargoCore";
import { qaReleaseTrainNextDepartureMs } from "@/lib/qaReleaseTrainCore";
import { expireQaReleaseTrainBoardReads } from "@/lib/qaReleaseTrainBoardRead";
import { readQaReleaseTrainCargoCandidates } from "@/lib/qaReleaseTrainCargoRead";
import { saveQaReleaseTrainSelection } from "@/lib/qaReleaseTrainCargoStore";
import {
  readQaReleaseTrainFoundOnMain,
  readQaReleaseTrainHidden,
  readQaReleaseTrainSchedule,
  readQaReleaseTrainSelection,
} from "@/lib/qaReleaseTrainStore";

// The next release train's cargo (lib/qaReleaseTrainCargoCore.ts): any
// administrator reads the candidates and the saved pick; owner or ops with a
// recent sign-in saves a pick, audited. The train reads the pick when it departs.

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) return NextResponse.json({ error: "Not found." }, { status: 404 });
    await consumeApiRateLimit(request, session.user.id, "qa-release-train-cargo-read", { minute: 30, day: 1000 });
    // `fresh=1`: the train tab's "Read GitHub again" (or a save on it), read
    // from GitHub rather than the shared read -- and the departure board's
    // reads expire too, for the page's next server read.
    const fresh = new URL(request.url).searchParams.get("fresh") === "1";
    if (fresh) expireQaReleaseTrainBoardReads(Date.now());
    const [read, selection, schedule, hidden, foundOnMain] = await Promise.all([
      readQaReleaseTrainCargoCandidates(Date.now(), { fresh }),
      readQaReleaseTrainSelection(),
      readQaReleaseTrainSchedule(),
      readQaReleaseTrainHidden(),
      readQaReleaseTrainFoundOnMain(new Date(Date.now() - QA_RELEASE_TRAIN_CANDIDATE_DAYS * 24 * 60 * 60 * 1000)),
    ]);
    // What a train found already on main reads as released, though no main
    // pull request names it (its change came under another commit).
    const candidates = read.status === "ok" ? { ...read, candidates: qaReleaseTrainWithTrainVerdicts(read.candidates, foundOnMain) } : read;
    // The next departure by the hours the train service reported, from this server clock.
    const nextMs = schedule ? qaReleaseTrainNextDepartureMs(Date.now(), schedule.hours) : null;
    return NextResponse.json({
      candidates,
      selection,
      hidden,
      schedule: schedule ? { ...schedule, nextDepartureAt: nextMs === null ? null : new Date(nextMs).toISOString() } : null,
    });
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
