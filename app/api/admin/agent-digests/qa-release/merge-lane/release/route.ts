export const dynamic = "force-dynamic";

import { z } from "zod";

import { releaseQaReleaseMergeLaneLatch } from "@/lib/qaReleaseMergeLaneRelease";
import { runQaReleaseControlAdminMutation } from "@/lib/qaReleaseOperatorControlAdmin";

// Releases the develop merge lane's latch (docs/policy/qa-release-agent.md
// version 4, section 8 item 5), optionally ending the attempt the rules could
// not by one of the two facts a person confirmed for its state. Owner or ops
// and a recent sign-in; the step-up refusal is answered by the shared wrapper.
// The attempt change is bound to the id and state the screen showed.

const sha = z.string().regex(/^[0-9a-f]{40}$/);

const resolution = z.discriminatedUnion("fact", [
  z.object({ attemptId: z.string().min(1).max(64), shownState: z.enum(["issued", "consumed"]), fact: z.literal("not_merged") }).strict(),
  z
    .object({
      attemptId: z.string().min(1).max(64),
      shownState: z.enum(["issued", "consumed"]),
      fact: z.literal("merged_on_develop"),
      mergeCommitSha: sha,
    })
    .strict(),
  z.object({ attemptId: z.string().min(1).max(64), shownState: z.literal("awaiting_deploy"), fact: z.literal("deployed") }).strict(),
  z.object({ attemptId: z.string().min(1).max(64), shownState: z.literal("awaiting_deploy"), fact: z.literal("restored") }).strict(),
]);

const schema = z.object({ resolution: resolution.nullable() }).strict();

export async function POST(request: Request) {
  return runQaReleaseControlAdminMutation({
    request,
    bucket: "qa-release-merge-lane-release",
    schema,
    run: ({ body, session }) => releaseQaReleaseMergeLaneLatch({ session, request, resolution: body.resolution }),
  });
}
