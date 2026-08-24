export const dynamic = "force-dynamic";

import type { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";

import {
    apiSecurityResponse,
    consumeApiRateLimit,
    readLimitedJson,
} from "@/lib/apiSecurity";
import { ASSISTANT_PACKAGE_DECLARED_SOURCE_KINDS } from "@/lib/assistantPackageManifest";
import {
    assertImportEnabled,
    importErrorResponse,
} from "@/lib/assistantProfileImportHttp";
import { createProfileImport } from "@/lib/assistantProfileImportService";
import { authOptions } from "@/lib/auth";

/**
 * Starting an import.
 *
 * docs/policy/assistant-package-import.md §5.4.
 *
 * This is step 7 -- the first request the wizard makes. Everything before it
 * happened in the browser, which is why there is no earlier endpoint to have
 * validated any of this: the whole reviewed package arrives here at once, and
 * the server re-decides everything it is going to rely on.
 *
 * The body carries no upload keys and no file contents. Documents come later,
 * one at a time, through the import's own upload path.
 */

const requestSchema = z
    .object({
        mode: z.enum(["create", "merge"]),
        /** Required for `merge`, ignored for `create`. */
        targetProfileId: z.string().trim().min(1).max(64).optional(),
        identity: z
            .object({
                name: z.string().trim().min(1).max(200),
                icon: z.string().trim().max(16).nullable(),
                description: z.string().trim().max(600).nullable(),
            })
            .strict(),
        /**
         * What the owner assembled. Stored so an interrupted import can be
         * resumed -- the container is not kept, so there is nothing else to
         * read it back from. Bounded because it is a JSON column and an
         * unbounded one is a row somebody can make arbitrarily large.
         */
        stagingManifest: z.record(z.string(), z.unknown()),
        declared: z
            .object({
                sourceKind: z.enum(ASSISTANT_PACKAGE_DECLARED_SOURCE_KINDS).nullable(),
                sourceName: z.string().trim().max(200).nullable(),
                // Stored as text the owner or the package supplied. Nothing
                // fetches it, which §1.1 makes a prohibition rather than an
                // omission -- so it is not even parsed as a URL here.
                sourceUrl: z.string().trim().max(2000).nullable(),
                previousProvenance: z.record(z.string(), z.unknown()).nullable(),
            })
            .strict(),
    })
    .strict()
    .refine(
        (body) => body.mode !== "merge" || Boolean(body.targetProfileId),
        "merge needs a target"
    );

export async function POST(req: Request) {
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

        const body = await readLimitedJson(req, 256 * 1024, requestSchema);
        const created = await createProfileImport({
            userId,
            mode: body.mode,
            targetProfileId: body.targetProfileId,
            identity: body.identity,
            // Cast rather than re-modelled. Prisma's `InputJsonValue` is a
            // recursive type Zod cannot produce, and the schema above has
            // already established that this is a JSON object -- restating its
            // shape here would be a second, weaker description of the same
            // thing.
            stagingManifest: body.stagingManifest as Prisma.InputJsonValue,
            declared: {
                sourceKind: body.declared.sourceKind,
                sourceName: body.declared.sourceName,
                sourceUrl: body.declared.sourceUrl,
                previousProvenance:
                    (body.declared.previousProvenance as Prisma.InputJsonValue | null) ??
                    null,
            },
        });

        return NextResponse.json(created, {
            status: 201,
            headers: { "Cache-Control": "no-store" },
        });
    } catch (error) {
        const known = importErrorResponse(error);
        if (known) return known;
        const security = apiSecurityResponse(error);
        if (security) return security;
        console.error("Failed to start an assistant package import:", error);
        return NextResponse.json(
            { error: "Failed to start the import." },
            { status: 500 }
        );
    }
}
