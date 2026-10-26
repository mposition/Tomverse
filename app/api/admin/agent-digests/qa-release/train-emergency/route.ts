export const dynamic = "force-dynamic";

import { z } from "zod";

import { runQaReleaseControlAdminMutation } from "@/lib/qaReleaseOperatorControlAdmin";
import {
  QA_RELEASE_TRAIN_CARGO_MAX,
  QA_RELEASE_TRAIN_EMERGENCY_REASON_MAX,
  QA_RELEASE_TRAIN_EMERGENCY_REASON_MIN,
  parseQaReleaseTrainEmergencyReason,
} from "@/lib/qaReleaseTrainCargoCore";
import { saveQaReleaseTrainEmergency } from "@/lib/qaReleaseTrainCargoStore";

// An emergency release train (owner request 2026-10-25): owner or ops with a
// recent sign-in names the pull requests and a reason, audited; the train
// service departs with them on its next round. No numbers withdraws a
// pending request. `pendingId` is the request the page saw pending (null for
// none); a request or withdrawal made from a page that is out of date is
// refused with `emergency_changed`. Reading the state is the train-cargo
// route's GET.

const schema = z
  .object({
    numbers: z.array(z.number().int().positive().max(9_999_999)).max(QA_RELEASE_TRAIN_CARGO_MAX).refine((numbers) => new Set(numbers).size === numbers.length),
    reason: z
      .string()
      .max(QA_RELEASE_TRAIN_EMERGENCY_REASON_MAX * 2)
      .transform((value, context) => {
        const reason = parseQaReleaseTrainEmergencyReason(value);
        if (reason === null) {
          context.addIssue({ code: "custom", message: `A reason of ${QA_RELEASE_TRAIN_EMERGENCY_REASON_MIN} to ${QA_RELEASE_TRAIN_EMERGENCY_REASON_MAX} characters.` });
          return z.NEVER;
        }
        return reason;
      }),
    pendingId: z.string().min(1).max(64).nullable(),
  })
  .strict();

export async function POST(request: Request) {
  return runQaReleaseControlAdminMutation({
    request,
    bucket: "qa-release-train-emergency",
    schema,
    run: ({ body, session }) => saveQaReleaseTrainEmergency({ session, request }, body),
  });
}
