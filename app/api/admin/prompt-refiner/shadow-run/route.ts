export const dynamic = "force-dynamic";

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
    PROMPT_REFINER_SHADOW_RUN_CONFIRMATION,
} from "@/lib/promptRefinerShadowRunContract";
import {
    createPromptRefinerShadowRun,
    promptRefinerShadowRunErrorResponse,
    promptRefinerShadowRunPreview,
} from "@/lib/promptRefinerShadowRunStore";
import { promptRefinerStageAdmissionErrorResponse } from "@/lib/promptRefinerStageAdmission";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const createSchema = z
    .object({
        runContractDigest: digest,
        stageRuntimeSourceManifestDigest: digest,
        runSourceManifestDigest: digest,
        previewBindingDigest: digest,
        confirmation: z.literal(PROMPT_REFINER_SHADOW_RUN_CONFIRMATION),
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

export async function GET() {
    try {
        const auth = await requireOwner();
        if ("response" in auth) return auth.response;
        const preview = await promptRefinerShadowRunPreview();
        return NextResponse.json({ preview }, { headers: noStoreHeaders });
    } catch (error) {
        const run = promptRefinerShadowRunErrorResponse(error);
        if (run) return withNoStore(run);
        const stage = promptRefinerStageAdmissionErrorResponse(error);
        if (stage) return withNoStore(stage);
        console.error("Failed to preview Prompt Refiner shadow run:", error);
        return NextResponse.json(
            { error: "Failed to preview Prompt Refiner shadow run." },
            { status: 500, headers: noStoreHeaders }
        );
    }
}
/** Records approval only. It cannot import or invoke the provider adapter. */
export async function POST(request: Request) {
    try {
        const auth = await requireOwner();
        if ("response" in auth) return auth.response;
        await consumeApiRateLimit(
            request,
            auth.session.user.id,
            "admin-prompt-refiner-shadow-run-approve",
            { minute: 2, day: 4 }
        );
        const body = await readLimitedJson(request, 4 * 1024, createSchema);
        const result = await createPromptRefinerShadowRun({
            session: auth.session,
            request,
            expected: {
                runContractDigest: body.runContractDigest,
                stageRuntimeSourceManifestDigest:
                    body.stageRuntimeSourceManifestDigest,
                runSourceManifestDigest: body.runSourceManifestDigest,
                previewBindingDigest: body.previewBindingDigest,
            },
        });
        return NextResponse.json(
            {
                run: {
                    id: result.run.id,
                    status: result.run.status,
                    runContractDigest: result.run.runContractDigest,
                    corpusDigest: result.run.corpusDigest,
                    adapterVersion: result.run.adapterVersion,
                    environment: "staging",
                    deploymentId: result.run.runtimeDeploymentId,
                    commitSha: result.run.runtimeCommitSha,
                    perRequestCostMicroUsd: Number(
                        result.run.perRequestCostMicroUsd
                    ),
                    maxDispatches: result.run.maxDispatches,
                    costCeilingMicroUsd: Number(
                        result.run.costCeilingMicroUsd
                    ),
                    approvedAt: result.run.approvedAt.toISOString(),
                    approvalExpiresAt:
                        result.run.approvalExpiresAt.toISOString(),
                    authorizationAuditLogId:
                        result.run.authorizationAuditLogId,
                    executionAdmitted: false,
                    productAdapterReady: false,
                },
                created: result.created,
                replayed: result.replayed,
            },
            {
                status: result.created ? 201 : 200,
                headers: noStoreHeaders,
            }
        );
    } catch (error) {
        const run = promptRefinerShadowRunErrorResponse(error);
        if (run) return withNoStore(run);
        const stage = promptRefinerStageAdmissionErrorResponse(error);
        if (stage) return withNoStore(stage);
        const security = apiSecurityResponse(error);
        if (security) return withNoStore(security);
        console.error("Failed to approve Prompt Refiner shadow run:", error);
        return NextResponse.json(
            { error: "Failed to approve Prompt Refiner shadow run." },
            { status: 500, headers: noStoreHeaders }
        );
    }
}
