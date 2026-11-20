import type { Session } from "next-auth";

import {
  inspectAmuxIdeaSessionSubmission,
  type AmuxIdeaSessionSource,
} from "./ideaSessionSubmissionCore.ts";
import {
  AmuxIdeaSessionSubmissionError,
  readAmuxIdeaSessionSubmissionRequest,
  submitAmuxIdeaFromSession,
} from "./ideaSessionSubmissionService.ts";
import { IdeaSubmissionError, readIdeaSubmissionByDerivedRequestId } from "./ideaSubmissionService.ts";

/**
 * Which door an idea an owner sends from another Admin screen comes in by. It
 * is the Admin idea form's choice (app/api/admin/amux/ideas/submissions): the
 * idea is a session idea, so it is analysed, gets its
 * cards and reaches the workers. A session
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
  const { session, requestId, idea } = input;
  // The session read comes first: the v4 read calls a stored session idea partial.
  const readBack = async () => {
    const seen = await readAmuxIdeaSessionSubmissionRequest(requestId);
    if (seen.status !== "absent") return seen;
    return readIdeaSubmissionByDerivedRequestId(session, requestId);
  };
  const isAlreadySeen = (error: unknown) =>
    (error instanceof IdeaSubmissionError || error instanceof AmuxIdeaSessionSubmissionError) &&
    error.code === "request_already_seen";

  const inspected = inspectIdeaSendForSession({ requestId, idea, sessionDisplay: input.sessionDisplay });
  if (!inspected.ok) return { ok: false, code: inspected.code, status: 400 };
  return { ok: true, readBack, isAlreadySeen, submit: () => submitAmuxIdeaFromSession({ inspected }) };
}
