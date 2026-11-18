export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { AMUX_V22_PROXY_BODY_MAX_BYTES } from "@/lib/amux/v22TransferCore";
import { isRunId } from "@/lib/engineeringAgentCore";
import {
  engineeringAgentErrorResponse,
  engineeringAgentJson,
  engineeringAgentUnauthorized,
  isEngineeringAgentRouteAuthorized,
  runIdempotentEngineeringAgentRequest,
} from "@/lib/engineeringAgentRouteAuth";
import { openEngineeringAgentWorkItem } from "@/lib/engineeringAgentStore";

// The runner submits a T2 draft for its active run
// (docs/policy/engineering-agent.md §7, §11): the patch and a reason code go
// to the app's own table, never to a branch, and the owner decides. T2 is the
// conservative tier, so the runner may always choose it; nothing it submits
// here reaches GitHub. The store admits the patch by digest and the app's
// secret patterns, and the database admits it only from an active run.

const requestSchema = z
  .object({
    requestKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    runId: z.string().refine(isRunId),
    baseSha: z.string().regex(/^[0-9a-f]{40}$/),
    patchBody: z.string().min(1),
    patchDigest: z.string().regex(/^[0-9a-f]{64}$/),
    reason: z.string().regex(/^[a-z_]{1,64}$/),
  })
  .strict();

// No bound of ours: the request body Next.js buffers through proxy.ts is the
// external one (docs/policy/amux-v22-result-transfer.md §4). The legacy
// runner sends its draft in one body; a v22 draft arrives with its settlement.
const BODY_MAX_BYTES = AMUX_V22_PROXY_BODY_MAX_BYTES;

export async function POST(request: Request) {
  if (!isEngineeringAgentRouteAuthorized(request, "runner")) return engineeringAgentUnauthorized();
  try {
    const body = await readLimitedJson(request, BODY_MAX_BYTES, requestSchema);
    const outcome = await runIdempotentEngineeringAgentRequest({
      route: "run/draft",
      requestKey: body.requestKey,
      body: { ...body, patchBody: undefined },
      work: (tx) =>
        openEngineeringAgentWorkItem(tx, {
          kind: "t2_draft",
          // One product per run: a second draft for the same run is a conflict.
          causeKey: `t2_draft:${body.runId}`,
          runId: body.runId,
          patchBody: body.patchBody,
          patchDigest: body.patchDigest,
          baseSha: body.baseSha,
          reason: body.reason,
        }),
      resultRef: (opened) => opened.workItemId,
    });
    if (outcome.kind === "conflict") return engineeringAgentJson({ error: "request_key_reused" }, 409);
    if (outcome.kind === "replay") {
      return engineeringAgentJson({ replayed: true, state: outcome.state, resultRef: outcome.resultRef }, 200);
    }
    return engineeringAgentJson(outcome.value, 200);
  } catch (error) {
    return engineeringAgentErrorResponse("run_draft", error);
  }
}
