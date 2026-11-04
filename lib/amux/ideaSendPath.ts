import type { Session } from "next-auth";

import { AMUX_SESSION_INTAKE_READBACK_ENV, amuxSessionIntakeReadbackEnabled } from "./ideaSessionIntakeReadbackCore.ts";
import {
  AMUX_SESSION_INTAKE_ENV,
  amuxSessionIntakeWritePermitted,
  inspectAmuxIdeaSessionSubmission,
  type AmuxIdeaSessionSource,
} from "./ideaSessionSubmissionCore.ts";
import {
  AmuxIdeaSessionSubmissionError,
  readAmuxIdeaSessionSubmissionRequest,
  submitAmuxIdeaFromSession,
} from "./ideaSessionSubmissionService.ts";
import {
  AMUX_V4_IDEA_READBACK_ENV,
  AMUX_V4_IDEA_SUBMISSION_ENV,
  inspectAmuxIdeaSubmission,
} from "./ideaSubmissionCore.ts";
import { IdeaSubmissionError, readIdeaSubmissionByDerivedRequestId, submitIdea } from "./ideaSubmissionService.ts";

/**
 * Which door an idea an owner sends from another Admin screen comes in by. It
 * is the Admin idea form's choice (app/api/admin/amux/ideas/submissions): while
 * session intake is on, the idea is a session idea, so it is analysed, gets its
 * cards and reaches the workers; otherwise it stays on the v4 path. A session
 * idea reads its references from pinned checkouts and must name at least one:
 * what these screens report on lives in this repository, which the owner's
 * operating scope must include (the intake refuses it otherwise). Its model is
 * the scope's.
 */
export type IdeaSendPath =
  | { readonly ok: false; readonly code: string; readonly status: number }
  | {
      readonly ok: true;
      readonly readBack: () => Promise<
        { readonly status: "absent" } | { readonly status: "partial" | "committed"; readonly ideaId: string }
      >;
      readonly submit: () => Promise<{ readonly ideaId: string }>;
      readonly isAlreadySeen: (error: unknown) => boolean;
    };

const REPOSITORY = "mposition/Tomverse";

const sessionWriteOn = () =>
  amuxSessionIntakeWritePermitted(process.env[AMUX_SESSION_INTAKE_ENV], process.env[AMUX_V4_IDEA_SUBMISSION_ENV]);
const sessionReadBackOn = () =>
  amuxSessionIntakeReadbackEnabled(process.env[AMUX_SESSION_INTAKE_READBACK_ENV], process.env[AMUX_V4_IDEA_READBACK_ENV]);

/** The session submission a send makes: the operator's click, naming this repository. */
export function inspectIdeaSendForSession(input: {
  requestId: string;
  idea: string;
  sessionDisplay: string;
}) {
  const source: AmuxIdeaSessionSource = {
    toolName: "tomverse-admin",
    modelProvider: "operator",
    sessionDisplay: input.sessionDisplay,
  };
  return inspectAmuxIdeaSessionSubmission({
    version: 1,
    requestId: input.requestId,
    input: { version: 1, idea: input.idea, repositories: [REPOSITORY], pullRequests: [] },
    source,
  });
}

export async function ideaSendPath(input: {
  session: Session;
  request: Request;
  requestId: string;
  idea: string;
  /** Names the screen in the idea's encrypted source labels. */
  sessionDisplay: string;
}): Promise<IdeaSendPath> {
  const { session, request, requestId, idea } = input;
  // The session read comes first: the v4 read calls a stored session idea partial.
  const readBack = async () => {
    if (sessionReadBackOn()) {
      const seen = await readAmuxIdeaSessionSubmissionRequest(requestId);
      if (seen.status !== "absent") return seen;
    }
    return readIdeaSubmissionByDerivedRequestId(session, requestId);
  };
  const isAlreadySeen = (error: unknown) =>
    (error instanceof IdeaSubmissionError || error instanceof AmuxIdeaSessionSubmissionError) &&
    error.code === "request_already_seen";

  if (sessionWriteOn() && sessionReadBackOn()) {
    const inspected = inspectIdeaSendForSession({ requestId, idea, sessionDisplay: input.sessionDisplay });
    if (!inspected.ok) return { ok: false, code: inspected.code, status: 400 };
    return { ok: true, readBack, isAlreadySeen, submit: () => submitAmuxIdeaFromSession({ inspected }) };
  }

  const inspected = inspectAmuxIdeaSubmission(
    JSON.stringify({ version: 1, requestId, input: { version: 1, idea, repositories: [], pullRequests: [] } }),
  );
  if (!inspected.ok) return { ok: false, code: inspected.code, status: 400 };
  return { ok: true, readBack, isAlreadySeen, submit: () => submitIdea({ session, request, inspected }) };
}
