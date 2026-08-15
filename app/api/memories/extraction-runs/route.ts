/**
 * The `after()` kick below runs inside this budget, not outside it: Next's
 * `after` reference states the callback "will run for the platform's default
 * or configured max duration of your route". Undeclared, the kick got whatever
 * the platform happened to allow, and a kick killed mid-chunk leaves the run
 * `running` under a lease that has to lapse before the dispatcher can reclaim
 * it -- so the driver that exists to reduce latency could increase it.
 *
 * 120s covers what the kick attempts: one chunk, with the adapter aborting
 * just under the driver's 60s chunk timeout, and a claimed chunk always
 * allowed to finish.
 */
export const maxDuration = 120;

import { NextResponse, after } from "next/server";
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
import { chatErrorResponse } from "@/lib/chatSecurity";
import { listMemoryExtractionRuns } from "@/lib/memoryExtractionCatalogue";
import {
    createMemoryExtractionRun,
    estimateMemoryExtraction,
} from "@/lib/memoryExtractionService";
import { kickMemoryExtractionRun } from "@/lib/memoryExtractionWorker";
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

/**
 * Recent runs and whichever one is still open (§21).
 *
 * The open run is the reason this exists: the launch screen has to say "a run
 * is already going" before a selection is made, rather than after a create
 * request comes back 409 MEMORY_EXTRACTION_ALREADY_RUNNING.
 */
export async function GET(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: "권한 없음" }, { status: 401 });
        }
        await assertMemoryExtractionEnabled();
        await consumeApiRateLimit(req, session.user.id, "memory-extraction-list", {
            minute: 60,
            day: 2000,
        });

        const result = await listMemoryExtractionRuns(session.user.id);
        return NextResponse.json(result, {
            headers: { "Cache-Control": "no-store" },
        });
    } catch (error) {
        if (error instanceof MemoryFeatureDisabledError) {
            return disabledResponse(error);
        }
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("memory extraction run list failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}

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
        // The low-latency half of §11.1. `after()` runs once this response has
        // been sent, so the user is not held while a background run starts --
        // and it is explicitly *not* a durable queue: it is bound to this
        // request's process and dies with it. What guarantees the run finishes
        // is the fifteen-minute dispatcher, which is why this is allowed to be
        // best-effort and why `kickMemoryExtractionRun` never throws.
        after(() => kickMemoryExtractionRun(run.id));
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
        // An account-level refusal (suspended, restricted, pending deletion)
        // carries its own status and code. Without this it would fall through
        // to the generic 500 below, and a suspended account would be told the
        // server broke rather than why it was refused.
        const chatResponse = chatErrorResponse(error);
        if (chatResponse) return chatResponse;
        const securityResponse = apiSecurityResponse(error);
        if (securityResponse) return securityResponse;
        console.error("memory extraction run create failed", error);
        return NextResponse.json({ error: "서버 오류" }, { status: 500 });
    }
}
