export const dynamic = "force-dynamic";

import { z } from "zod";

import { runQaReleaseControlAdminMutation } from "@/lib/qaReleaseOperatorControlAdmin";
import { recordQaReleaseOperatorControl } from "@/lib/qaReleaseOperatorControlStore";

// Records the next QA-release operator control revision
// (docs/policy/qa-release-agent.md section 6): service enablement, the
// develop lane switch, the IaC commit, and when each secret and key was last
// rotated -- times only, never a value. Owner or ops and a recent sign-in;
// the step-up refusal is answered by the shared wrapper.

const rotatedAt = z.string().datetime({ offset: false }).nullable();

const schema = z
  .object({
    digestEnabled: z.boolean(),
    mergeLaneEnabled: z.boolean(),
    developLaneOn: z.boolean(),
    iacCommit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
    digestSecretRotatedAt: rotatedAt,
    monitorSecretRotatedAt: rotatedAt,
    mergeLaneSecretRotatedAt: rotatedAt,
    githubAppKeyRotatedAt: rotatedAt,
    railwayTokenRotatedAt: rotatedAt,
    githubReadTokenRotatedAt: rotatedAt,
  })
  .strict();

const asDate = (value: string | null) => (value === null ? null : new Date(value));

export async function POST(request: Request) {
  return runQaReleaseControlAdminMutation({
    request,
    bucket: "qa-release-control",
    schema,
    run: async ({ body, session }) => {
      const record = await recordQaReleaseOperatorControl({
        session,
        request,
        control: {
          digestEnabled: body.digestEnabled,
          mergeLaneEnabled: body.mergeLaneEnabled,
          developLaneOn: body.developLaneOn,
          iacCommit: body.iacCommit,
          digestSecretRotatedAt: asDate(body.digestSecretRotatedAt),
          monitorSecretRotatedAt: asDate(body.monitorSecretRotatedAt),
          mergeLaneSecretRotatedAt: asDate(body.mergeLaneSecretRotatedAt),
          githubAppKeyRotatedAt: asDate(body.githubAppKeyRotatedAt),
          railwayTokenRotatedAt: asDate(body.railwayTokenRotatedAt),
          githubReadTokenRotatedAt: asDate(body.githubReadTokenRotatedAt),
        },
      });
      return { revision: record.revision };
    },
  });
}
