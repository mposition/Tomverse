import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import {
    ApiSecurityError,
    apiSecurityResponse,
    consumeApiRateLimit,
    readLimitedText,
} from "@/lib/apiSecurity";
import {
    assertExternalImportEnabled,
    ExternalImportDisabledError,
} from "@/lib/appSettings";
import { authOptions } from "@/lib/auth";
import { EXTERNAL_IMPORT_MAX_BATCH_REQUEST_BYTES } from "@/lib/externalImportLimits";
import { recordExternalImportCounter } from "@/lib/externalImportMetrics";
import { appendExternalImportBatch } from "@/lib/externalImportService";

// Content length limits here are transport guards in UTF-16 units; the
// authoritative code-point limits (stored 100k / inbound 1M) are enforced by
// the service against the parsed content. 1M code points is at most 2M
// UTF-16 units.
const messageSchema = z
    .object({
        rawExternalMessageId: z.string().min(1).max(512),
        role: z.enum(["user", "assistant"]),
        ordinal: z.number().int().min(0).max(1_000_000),
        content: z.string().min(1).max(2_100_000),
        sourceModelLabel: z.string().trim().min(1).max(120).optional(),
        sourceTimestamp: z.string().datetime().optional(),
    })
    .strict();

const conversationSchema = z
    .object({
        rawExternalConversationId: z.string().min(1).max(512),
        title: z.string().trim().min(1).max(300),
        sourceModelLabels: z
            .array(z.string().trim().min(1).max(120))
            .max(10)
            .optional(),
        sourceCreatedAt: z.string().datetime().optional(),
        sourceUpdatedAt: z.string().datetime().optional(),
        messages: z.array(messageSchema).min(1).max(2_000),
    })
    .strict();

const batchSchema = z
    .object({
        sequence: z.number().int().min(0).max(1_000_000),
        conversations: z.array(conversationSchema).min(1).max(50),
    })
    .strict();

export async function POST(
    req: Request,
    context: RouteContext<"/api/imports/external/[importId]/batches">
) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: "권한 없음" }, { status: 401 });
        }
        await assertExternalImportEnabled();
        await consumeApiRateLimit(req, session.user.id, "external-import-batch", {
            minute: 60,
            day: 2000,
        });

        // The ledger digest is computed over the raw body text, so a
        // byte-identical network retry is recognized without trusting any
        // client-declared identifier (policy §5.5).
        const rawBody = await readLimitedText(
            req,
            EXTERNAL_IMPORT_MAX_BATCH_REQUEST_BYTES
        );
        let parsedBody: unknown;
        try {
            parsedBody = JSON.parse(rawBody);
        } catch {
            throw new ApiSecurityError(400, "INVALID_JSON", "Invalid JSON request.");
        }
        const parsed = batchSchema.safeParse(parsedBody);
        if (!parsed.success) {
            throw new ApiSecurityError(
                400,
                "INVALID_REQUEST",
                "Invalid request payload."
            );
        }
        const batchDigest = createHash("sha256")
            .update(rawBody, "utf8")
            .digest("hex");

        const params = await context.params;
        const result = await appendExternalImportBatch({
            userId: session.user.id,
            importId: params.importId,
            sequence: parsed.data.sequence,
            batchDigest,
            conversations: parsed.data.conversations.map((conversation) => ({
                rawExternalConversationId: conversation.rawExternalConversationId,
                title: conversation.title,
                sourceModelLabels: conversation.sourceModelLabels ?? null,
                sourceCreatedAt: conversation.sourceCreatedAt
                    ? new Date(conversation.sourceCreatedAt)
                    : null,
                sourceUpdatedAt: conversation.sourceUpdatedAt
                    ? new Date(conversation.sourceUpdatedAt)
                    : null,
                messages: conversation.messages.map((message) => ({
                    rawExternalMessageId: message.rawExternalMessageId,
                    role: message.role,
                    ordinal: message.ordinal,
                    content: message.content,
                    sourceModelLabel: message.sourceModelLabel ?? null,
                    sourceTimestamp: message.sourceTimestamp
                        ? new Date(message.sourceTimestamp)
                        : null,
                })),
            })),
        });

        return NextResponse.json(result, {
            headers: { "Cache-Control": "no-store" },
        });
    } catch (error) {
        if (error instanceof ExternalImportDisabledError) {
            return NextResponse.json(
                { error: error.message, code: "EXTERNAL_IMPORT_DISABLED" },
                { status: 403 }
            );
        }
        if (
            error instanceof ApiSecurityError &&
            error.code === "EXTERNAL_IMPORT_QUOTA_EXCEEDED"
        ) {
            // Quota refusals leave no terminal row to aggregate (§22): the
            // import stays in staging, so the rejection is a day counter.
            await recordExternalImportCounter("quota_rejected");
        }
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("external import batch failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}
