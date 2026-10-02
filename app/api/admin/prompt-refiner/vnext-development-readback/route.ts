export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { authOptions } from "@/lib/auth";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import {
    assertRecentAdminAuthentication,
    isAdminReauthenticationError,
} from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { readOnlySnapshotTransaction } from "@/lib/readOnlySnapshotTransaction";
import { promptRefinerVnextOneShotDevelopmentSourceFailureCode,
    promptRefinerVnextOneShotDeploymentFailureCode,
    promptRefinerVnextOneShotPriceFailureCode,
    summarizePromptRefinerVnextOneShotDevelopmentReadback } from
    "@/lib/promptRefinerQualityEvaluationVnextOneShotDevelopmentReadback";
import { observePromptRefinerVnextOneShotDeployment } from
    "@/lib/promptRefinerQualityEvaluationVnextOneShotDeploymentReadback";
import { readPromptRefinerVnextOneShotPrice } from
    "@/lib/promptRefinerQualityEvaluationVnextOneShotPriceReadback";
import { verifyPromptRefinerVnextOneShotDevelopmentSource } from
    "@/lib/promptRefinerQualityEvaluationVnextOneShotSource";

const headers = { "Cache-Control": "private, no-store, max-age=0" };

/** Read-only development diagnostics; no holdout, approval or provider call. */
export async function GET(request: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.id || !isAdminSession(session)) {
            return NextResponse.json({ error: "Not found." }, { status: 404, headers });
        }
        if (getAdminRole(session) !== "owner") {
            return NextResponse.json({ error: "Forbidden." }, { status: 403, headers });
        }
        try {
            await assertRecentAdminAuthentication(session);
        } catch (error) {
            if (isAdminReauthenticationError(error)) {
                return NextResponse.json(
                    { error: "Recent administrator authentication is required.",
                        code: "ADMIN_REAUTHENTICATION_REQUIRED" },
                    { status: 428, headers }
                );
            }
            throw error;
        }
        await consumeApiRateLimit(request, session.user.id,
            "admin-prompt-refiner-vnext-development-readback", { minute: 3, day: 30 });

        let sourceProblem: string | undefined;
        const source = await verifyPromptRefinerVnextOneShotDevelopmentSource(process.cwd())
            .catch((error: unknown) => {
                sourceProblem = promptRefinerVnextOneShotDevelopmentSourceFailureCode(error);
                return null;
            });
        let deploymentProblem: string | undefined;
        const deployment = await observePromptRefinerVnextOneShotDeployment()
            .catch((error: unknown) => {
                deploymentProblem = promptRefinerVnextOneShotDeploymentFailureCode(error);
                return null;
            });
        let priceProblem: string | undefined;
        const price = await readOnlySnapshotTransaction((tx) =>
            readPromptRefinerVnextOneShotPrice(tx), { maxWait: 5_000, timeout: 10_000 }
        ).catch((error: unknown) => {
            priceProblem = promptRefinerVnextOneShotPriceFailureCode(error);
            return null;
        });
        return NextResponse.json({ readback:
            summarizePromptRefinerVnextOneShotDevelopmentReadback({
                source, sourceProblem, deployment, deploymentProblem, price, priceProblem,
            })
        }, { headers });
    } catch (error) {
        const response = apiSecurityResponse(error);
        if (response) {
            response.headers.set("Cache-Control", headers["Cache-Control"]);
            return response;
        }
        console.error("Prompt Refiner vNext development read-back unexpectedly failed");
        return NextResponse.json({ error: "Read-back unavailable." },
            { status: 503, headers });
    }
}
