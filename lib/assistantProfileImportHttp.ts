import "server-only";

import { NextResponse } from "next/server";

import { AssistantKnowledgeError } from "@/lib/assistantKnowledgeService";
import { AssistantProfileImportError } from "@/lib/assistantProfileImportService";
import { AssistantProfileError } from "@/lib/assistantProfileService";
import {
    AssistantProfilesDisabledError,
    isAssistantKnowledgeEnabled,
    isAssistantPackageImportEnabled,
} from "@/lib/appSettings";

/**
 * The shared HTTP surface of the import routes.
 *
 * docs/policy/assistant-package-import.md §5.6, §9.
 *
 * Four routes answer with the same vocabulary, so the mapping lives once. A
 * per-route copy is how two of them end up disagreeing about whether a
 * cancelled import is a 404 or a 409 -- and the whole point of scoping every
 * query by owner is that "not yours" and "not there" have to be one answer.
 *
 * Only the code and the message travel. No storage key, no file name from a
 * package, no parser detail: §9 keeps those out of anything that leaves the
 * server, and an error body is the easiest place to forget that.
 */

/**
 * Both flags. The import needs knowledge files to exist as a feature, so
 * turning knowledge off has to turn this off too -- otherwise the wizard
 * reaches step 7 and finds the upload path disabled underneath it.
 */
export const assertImportEnabled = async (): Promise<void> => {
    const [importEnabled, knowledgeEnabled] = await Promise.all([
        isAssistantPackageImportEnabled(),
        isAssistantKnowledgeEnabled(),
    ]);
    if (!importEnabled || !knowledgeEnabled) {
        throw new AssistantProfilesDisabledError();
    }
};

const json = (body: unknown, status: number) =>
    NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** A typed refusal turned into a response, or `null` for anything unexpected. */
export const importErrorResponse = (error: unknown) => {
    if (error instanceof AssistantProfileImportError) {
        return json({ error: error.message, code: error.code }, error.status);
    }
    if (error instanceof AssistantKnowledgeError) {
        return json({ error: error.message, code: error.code }, error.status);
    }
    if (error instanceof AssistantProfileError) {
        return json(
            {
                error: error.message,
                code: error.code,
                ...(error.problems ? { problems: error.problems } : {}),
            },
            error.status
        );
    }
    if (error instanceof AssistantProfilesDisabledError) {
        return json(
            {
                error: "Importing an assistant package is not enabled.",
                code: "ASSISTANT_PACKAGE_IMPORT_DISABLED",
            },
            403
        );
    }
    return null;
};
