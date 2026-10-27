export const dynamic = "force-dynamic";

import { z } from "zod";

import { runQaReleaseControlAdminMutation } from "@/lib/qaReleaseOperatorControlAdmin";
import { saveQaReleaseTrainHidden } from "@/lib/qaReleaseTrainCargoStore";

// Hides a candidate from the next train's list, or shows it again
// (lib/qaReleaseTrainCargoCore.ts). Owner or ops, audited; display only, so
// no recent sign-in, and a looser limit for hiding a long list one by one.
// The train never reads it.

const schema = z.object({ number: z.number().int().positive().max(9_999_999), hidden: z.boolean() }).strict();

export async function POST(request: Request) {
  return runQaReleaseControlAdminMutation({
    request,
    bucket: "qa-release-train-cargo-hidden",
    schema,
    recentSignIn: false,
    limit: { minute: 60, day: 1000 },
    run: ({ body, session }) => saveQaReleaseTrainHidden({ session, request }, body.number, body.hidden),
  });
}
