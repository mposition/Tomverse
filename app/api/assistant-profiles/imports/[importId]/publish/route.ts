export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";

import {
    apiSecurityResponse,
    consumeApiRateLimit,
    readLimitedJson,
} from "@/lib/apiSecurity";
import { ASSISTANT_PROFILE_LIMITS } from "@/lib/assistantProfileVersioning";
import {
    assertImportEnabled,
    importErrorResponse,
} from "@/lib/assistantProfileImportHttp";
import { publishProfileImport } from "@/lib/assistantProfileImportService";
import { authOptions } from "@/lib/auth";

/**
 * Step 8: the owner confirms, and the import becomes a published revision.
 *
 * docs/policy/assistant-package-import.md §5.4, §5.6.
 *
 * The body is the approval, not the content. Everything it names was already
 * staged by earlier requests, and everything it decides -- which documents to
 * keep, what the version says -- is re-checked server-side: the files have to
 * belong to this import and be ready, the draft has to pass the profile's own
 * validation, and the target must not have moved.
 *
 * `approvedDigest` is what makes the approval provable afterwards. It is the
 * digest of what the confirmation screen showed, stored beside the row it
 * approved, and it is what the waived credential findings bind to.
 */

const requestSchema = z
    .object({
        approvedDigest: z.string().trim().min(1).max(200),
        digestVersion: z.number().int().positive(),
        keepFileIds: z.array(z.string().trim().min(1).max(64)).max(64),
        identity: z
            .object({
                name: z.string().trim().min(1).max(200),
                icon: z.string().trim().max(16).nullable(),
                description: z.string().trim().max(600).nullable(),
            })
            .strict(),
        draft: z
            .object({
                instructions: z
                    .string()
                    .max(ASSISTANT_PROFILE_LIMITS.maxInstructionsCharacters),
                modelIds: z.array(z.string().trim().min(1).max(120)).max(16),
                toolPolicy: z
                    .object({ webSearch: z.boolean(), deepResearch: z.boolean() })
                    .strict(),
                memoryPolicy: z
                    .object({ useAccountMemory: z.boolean() })
                    .strict(),
                starters: z.array(z.string().trim().max(400)).max(16),
            })
            .strict(),
    })
    .strict();

export async function POST(
    req: Request,
    { params }: { params: Promise<{ importId: string }> }
) {
    try {
        const session = await getServerSession(authOptions);
        const userId = session?.user?.id;
        if (!userId) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        await assertImportEnabled();
        await consumeApiRateLimit(req, userId, "assistant-package-import", {
            minute: 10,
            day: 100,
        });

        const { importId } = await params;
        const body = await readLimitedJson(req, 128 * 1024, requestSchema);

        const outcome = await publishProfileImport({
            userId,
            importId,
            approvedDigest: body.approvedDigest,
            digestVersion: body.digestVersion,
            keepFileIds: body.keepFileIds,
            identity: body.identity,
            draft: {
                instructions: body.draft.instructions,
                modelIds: body.draft.modelIds,
                toolPolicy: body.draft.toolPolicy,
                memoryPolicy: body.draft.memoryPolicy,
                starters: body.draft.starters,
                // The manifest is the kept files, resolved server-side from
                // the rows rather than taken from the request: a client-named
                // manifest would let a caller decide what a past version is
                // recorded as having contained.
                knowledgeManifest: body.keepFileIds.map((fileId) => ({
                    fileId,
                    name: "",
                    digest: "",
                })),
            },
        });

        // Not an error: a document still processing is a state the owner can
        // wait out, and saying so is more useful than a 409 they have to
        // interpret.
        if (outcome.outcome === "not_ready") {
            return NextResponse.json(outcome, {
                status: 409,
                headers: { "Cache-Control": "no-store" },
            });
        }

        return NextResponse.json(outcome, {
            headers: { "Cache-Control": "no-store" },
        });
    } catch (error) {
        const known = importErrorResponse(error);
        if (known) return known;
        const security = apiSecurityResponse(error);
        if (security) return security;
        console.error("Failed to publish an assistant package import:", error);
        return NextResponse.json(
            { error: "Failed to publish the import." },
            { status: 500 }
        );
    }
}
