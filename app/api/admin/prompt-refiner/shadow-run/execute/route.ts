export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import {
    assertRecentAdminAuthentication,
    isAdminReauthenticationError,
} from "@/lib/adminReauthentication";
import {
    apiSecurityResponse,
    consumeApiRateLimit,
    readLimitedJson,
} from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import {
    PROMPT_REFINER_SHADOW_EXECUTION_CONFIRMATION,
    PROMPT_REFINER_SHADOW_EXECUTION_FLAG,
    PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST,
    PROMPT_REFINER_SHADOW_RUN_ID,
} from "@/lib/promptRefinerShadowRunContract";
import {
    promptRefinerShadowRunnerErrorResponse,
    runPromptRefinerShadowExecution,
} from "@/lib/promptRefinerShadowRunner";
import {
    promptRefinerShadowRunErrorResponse,
    readPromptRefinerShadowExecutionState,
} from "@/lib/promptRefinerShadowRunStore";
import { promptRefinerStageAdmissionErrorResponse } from "@/lib/promptRefinerStageAdmission";

const executeSchema = z
    .object({
        runId: z.literal(PROMPT_REFINER_SHADOW_RUN_ID),
        runContractDigest: z.literal(
            PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST
        ),
        confirmation: z.literal(
            PROMPT_REFINER_SHADOW_EXECUTION_CONFIRMATION
        ),
    })
    .strict();

const noStoreHeaders = {
    "Cache-Control": "private, no-store, max-age=0",
};

const withNoStore = (response: Response) => {
    response.headers.set("Cache-Control", noStoreHeaders["Cache-Control"]);
    return response;
};

const requireOwner = async () => {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
        return {
            response: NextResponse.json(
                { error: "Not found." },
                { status: 404, headers: noStoreHeaders }
            ),
        } as const;
    }
    if (getAdminRole(session) !== "owner") {
        return {
            response: NextResponse.json(
                { error: "Forbidden." },
                { status: 403, headers: noStoreHeaders }
            ),
        } as const;
    }
    try {
        await assertRecentAdminAuthentication(session);
    } catch (error) {
        if (isAdminReauthenticationError(error)) {
            return {
                response: NextResponse.json(
                    {
                        error: "Recent administrator authentication is required.",
                        code: "ADMIN_REAUTHENTICATION_REQUIRED",
                    },
                    { status: 428, headers: noStoreHeaders }
                ),
            } as const;
        }
        throw error;
    }
    return { session } as const;
};

export async function GET(request: Request) {
    try {
        const auth = await requireOwner();
        if ("response" in auth) return auth.response;
        await consumeApiRateLimit(
            request,
            auth.session.user.id,
            "admin-prompt-refiner-shadow-run-execution-preview",
            { minute: 10, day: 40 }
        );
        const state = await readPromptRefinerShadowExecutionState();
        return NextResponse.json(
            {
                execution: {
                    ...state,
                    runContractDigest:
                        PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST,
                    enabled:
                        process.env[PROMPT_REFINER_SHADOW_EXECUTION_FLAG] ===
                        "true",
                    confirmation:
                        PROMPT_REFINER_SHADOW_EXECUTION_CONFIRMATION,
                    productAdapterReady: false,
                },
            },
            { headers: noStoreHeaders }
        );
    } catch (error) {
        const run = promptRefinerShadowRunErrorResponse(error);
        if (run) return withNoStore(run);
        const stage = promptRefinerStageAdmissionErrorResponse(error);
        if (stage) return withNoStore(stage);
        const security = apiSecurityResponse(error);
        if (security) return withNoStore(security);
        console.error("Failed to preview Prompt Refiner shadow execution:", error);
        return NextResponse.json(
            { error: "Failed to preview Prompt Refiner shadow execution." },
            { status: 500, headers: noStoreHeaders }
        );
    }
}

export async function POST(request: Request) {
    try {
        const auth = await requireOwner();
        if ("response" in auth) return auth.response;
        await readLimitedJson(request, 4 * 1024, executeSchema);
        await consumeApiRateLimit(
            request,
            auth.session.user.id,
            "admin-prompt-refiner-shadow-run-execute",
            { minute: 2, day: 8 }
        );
        const result = await runPromptRefinerShadowExecution();
        return NextResponse.json(
            { execution: result, productAdapterReady: false },
            { headers: noStoreHeaders }
        );
    } catch (error) {
        const runner = promptRefinerShadowRunnerErrorResponse(error);
        if (runner) return withNoStore(runner);
        const run = promptRefinerShadowRunErrorResponse(error);
        if (run) return withNoStore(run);
        const stage = promptRefinerStageAdmissionErrorResponse(error);
        if (stage) return withNoStore(stage);
        const security = apiSecurityResponse(error);
        if (security) return withNoStore(security);
        console.error("Failed to execute Prompt Refiner shadow run:", error);
        return NextResponse.json(
            { error: "Failed to execute Prompt Refiner shadow run." },
            { status: 500, headers: noStoreHeaders }
        );
    }
}
