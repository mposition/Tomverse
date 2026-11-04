import type { Session } from "next-auth";

import { prisma } from "@/lib/prisma";

import { AMUX_IDEA_STANDARD_TRANSACTION } from "./ideaRequestTimeoutsCore.ts";
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
import { readAmuxOperatingScopeAuthority } from "./ideaOperatingScopeStore.ts";
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
 * idea reads its references from pinned checkouts and must name at least one,
 * so it names every repository in the owner's operating scope, the form's
 * default. Its model is the scope's.
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

const sessionWriteOn = () =>
  amuxSessionIntakeWritePermitted(process.env[AMUX_SESSION_INTAKE_ENV], process.env[AMUX_V4_IDEA_SUBMISSION_ENV]);
const sessionReadBackOn = () =>
  amuxSessionIntakeReadbackEnabled(process.env[AMUX_SESSION_INTAKE_READBACK_ENV], process.env[AMUX_V4_IDEA_READBACK_ENV]);

/** The session submission a send makes: the operator's click, naming the scope's repositories. */
export function inspectIdeaSendForSession(input: {
  requestId: string;
  idea: string;
  repositories: readonly string[];
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
    input: { version: 1, idea: input.idea, repositories: input.repositories, pullRequests: [] },
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
    const authority = await prisma.$transaction((tx) => readAmuxOperatingScopeAuthority(tx), {
      ...AMUX_IDEA_STANDARD_TRANSACTION,
    });
    if (!authority) return { ok: false, code: "scope_unavailable", status: 409 };
    const inspected = inspectIdeaSendForSession({
      requestId,
      idea,
      repositories: authority.scope.repositories,
      sessionDisplay: input.sessionDisplay,
    });
    if (!inspected.ok) return { ok: false, code: inspected.code, status: 400 };
    return { ok: true, readBack, isAlreadySeen, submit: () => submitAmuxIdeaFromSession({ inspected }) };
  }

  const inspected = inspectAmuxIdeaSubmission(
    JSON.stringify({ version: 1, requestId, input: { version: 1, idea, repositories: [], pullRequests: [] } }),
  );
  if (!inspected.ok) return { ok: false, code: inspected.code, status: 400 };
  return { ok: true, readBack, isAlreadySeen, submit: () => submitIdea({ session, request, inspected }) };
}
