import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import {
    apiSecurityResponse,
    consumeApiRateLimit,
    readLimitedJson,
} from "@/lib/apiSecurity";
import {
    assertMemoryExtractionEnabled,
    MemoryFeatureDisabledError,
} from "@/lib/appSettings";
import { authOptions } from "@/lib/auth";
import {
    createMemoryExtractionRun,
    estimateMemoryExtraction,
} from "@/lib/memoryExtractionService";
import type { ModelTier } from "@/lib/models";

/**
 * Extraction run creation (Release B, policy §11, §21).
 *
 * The §11 confirmation contract is two calls of this one endpoint: an
 * `estimateOnly` request returns the chunk count and credit estimate the UI
 * must show, and the real request carries `confirmedCredits` — a mismatch
 * (the selection changed underneath the dialog) is a 409 that re-opens the
 * dialog, never a silent re-price.
 */

const requestSchema = z
    .object({
        extractionModelId: z.string().trim().min(1).max(120),
        promptVersion: z.string().trim().min(1).max(64),
        selectedConversationIds: z
            .array(z.string().min(1).max(64))
            .min(1)
            .max(500),
        estimateOnly: z.boolean().optional(),
        confirmedCredits: z.number().int().min(0).max(1_000_000).optional(),
    })
    .strict();

const normalizePlan = (value: unknown): ModelTier | "Guest" =>
    value === "Pro" || value === "Max" ? value : "Free";

const disabledResponse = (error: MemoryFeatureDisabledError) =>
    NextResponse.json(
        { error: error.message, code: "MEMORY_FEATURE_DISABLED" },
        { status: 403 }
    );

export async function POST(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: "권한 없음" }, { status: 401 });
        }
        await assertMemoryExtractionEnabled();
        await consumeApiRateLimit(
            req,
            session.user.id,
            "memory-extraction-create",
            { minute: 10, day: 100 }
        );

        const body = await readLimitedJson(req, 64 * 1024, requestSchema);
        const base = {
            userId: session.user.id,
            extractionModelId: body.extractionModelId,
            promptVersion: body.promptVersion,
            plan: normalizePlan(session.user.plan),
            selectedConversationIds: body.selectedConversationIds,
        };

        if (body.estimateOnly) {
            const estimate = await estimateMemoryExtraction(base);
            return NextResponse.json(
                {
                    chunkCount: estimate.chunkCount,
                    estimatedCredits: estimate.estimatedCredits,
                    conversationCount: estimate.conversationCount,
                    basis: estimate.basis,
                    // Internal micro-USD figures stay internal (§11).
                },
                { headers: { "Cache-Control": "no-store" } }
            );
        }

        if (body.confirmedCredits === undefined) {
            return NextResponse.json(
                {
                    error: "confirmedCredits is required to start a run.",
                    code: "INVALID_REQUEST",
                },
                { status: 400 }
            );
        }
        const run = await createMemoryExtractionRun({
            ...base,
            confirmedCredits: body.confirmedCredits,
        });
        return NextResponse.json(
            {
                runId: run.id,
                status: run.status,
                chunkTotal: run.chunkTotal,
            },
            { status: 201, headers: { "Cache-Control": "no-store" } }
        );
    } catch (error) {
        if (error instanceof MemoryFeatureDisabledError) {
            return disabledResponse(error);
        }
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("memory extraction run create failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}
