export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { authOptions } from "@/lib/auth";
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
import {
  PROMPT_REFINER_STAGE_CONFIRMATION,
} from "@/lib/promptRefinerStageAdmissionCore";
import {
  createPromptRefinerReservationStage,
  promptRefinerStageAdmissionErrorResponse,
  promptRefinerStagePreview,
} from "@/lib/promptRefinerStageAdmission";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const createSchema = z
  .object({
    proposalDigest: digest,
    runtimeSourceManifestDigest: digest,
    executionManifestDigest: digest,
    previewBindingDigest: digest,
    confirmation: z.literal(PROMPT_REFINER_STAGE_CONFIRMATION),
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
    return { response: NextResponse.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders }) } as const;
  }
  if (getAdminRole(session) !== "owner") {
    return { response: NextResponse.json({ error: "Forbidden." }, { status: 403, headers: noStoreHeaders }) } as const;
  }
  try {
    await assertRecentAdminAuthentication(session);
  } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return {
        response: NextResponse.json(
          { error: "Recent administrator authentication is required.", code: "ADMIN_REAUTHENTICATION_REQUIRED" },
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
    const preview = await promptRefinerStagePreview();
    return NextResponse.json({ preview }, { headers: noStoreHeaders });
  } catch (error) {
    const admission = promptRefinerStageAdmissionErrorResponse(error);
    if (admission) return withNoStore(admission);
    console.error("Failed to preview Prompt Refiner shadow stage:", error);
    return NextResponse.json(
      { error: "Failed to preview Prompt Refiner shadow stage." },
      { status: 500, headers: noStoreHeaders }
    );
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireOwner();
    if ("response" in auth) return auth.response;
    await consumeApiRateLimit(
      request,
      auth.session.user.id,
      "admin-prompt-refiner-stage-activate",
      { minute: 2, day: 10 }
    );
    const body = await readLimitedJson(request, 4 * 1024, createSchema);
    const result = await createPromptRefinerReservationStage({
      session: auth.session,
      request,
      expected: {
        proposalDigest: body.proposalDigest,
        runtimeSourceManifestDigest: body.runtimeSourceManifestDigest,
        executionManifestDigest: body.executionManifestDigest,
        previewBindingDigest: body.previewBindingDigest,
      },
    });
    return NextResponse.json(
      {
        stage: {
          id: result.stage.id,
          status: result.stage.status,
          proposalDigest: result.stage.proposalDigest,
          runtimeSourceManifestDigest: result.stage.runtimeSourceManifestDigest,
          executionManifestDigest: result.stage.executionManifestDigest,
          environment: result.stage.runtimeEnvironment,
          deploymentId: result.stage.runtimeDeploymentId,
          commitSha: result.stage.runtimeCommitSha,
          approvedAt: result.stage.approvedAt.toISOString(),
          approvalExpiresAt: result.stage.approvalExpiresAt.toISOString(),
          authorizationAuditLogId: result.stage.authorizationAuditLogId,
          executionAdmitted: false,
          productAdapterReady: false,
        },
        created: result.created,
        replayed: result.replayed,
      },
      { status: result.created ? 201 : 200, headers: noStoreHeaders }
    );
  } catch (error) {
    const admission = promptRefinerStageAdmissionErrorResponse(error);
    if (admission) return withNoStore(admission);
    const security = apiSecurityResponse(error);
    if (security) return withNoStore(security);
    console.error("Failed to create Prompt Refiner shadow stage:", error);
    return NextResponse.json(
      { error: "Failed to create Prompt Refiner shadow stage." },
      { status: 500, headers: noStoreHeaders }
    );
  }
}
