export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { z } from "zod";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";
import {
  listSupportTriageModelOptions,
  readSupportTriageLlmModelSetting,
  resolveSupportTriageEnabled,
  SupportTriageModelRefused,
  writeSupportTriageEnabledSetting,
  writeSupportTriageLlmModelSetting,
} from "@/lib/supportTriageLlmSetting";

/**
 * The support-triage switch and LLM model, set in the Admin console. GET for
 * any administrator; PUT for the owner with a recent sign-in, audited. A null
 * model id clears the choice (the environment variable applies again).
 */
const headers = { "Cache-Control": "private, no-store, max-age=0" };
// Either field or both; an absent field is left as it is.
const schema = z
  .object({ modelId: z.string().trim().min(1).max(200).nullable().optional(), enabled: z.boolean().optional() })
  .strict()
  .refine((body) => body.modelId !== undefined || body.enabled !== undefined);

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return Response.json({ error: "Not found." }, { status: 404, headers });
    }
    await consumeApiRateLimit(request, session.user.id, "admin-support-triage-llm-model-read", {
      minute: 30,
      day: 600,
    });
    const [modelId, options, switchState] = await Promise.all([
      readSupportTriageLlmModelSetting(),
      listSupportTriageModelOptions(),
      resolveSupportTriageEnabled(process.env),
    ]);
    return Response.json(
      { modelId, options, enabled: switchState.enabled, enabledSource: switchState.source },
      { headers }
    );
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) return security;
    return Response.json({ code: "SUPPORT_TRIAGE_LLM_MODEL_READ_UNAVAILABLE" }, { status: 503, headers });
  }
}

export async function PUT(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return Response.json({ error: "Not found." }, { status: 404, headers });
    }
    if (getAdminRole(session) !== "owner" || !hasValidMutationOrigin(request)) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers });
    }
    try {
      await assertRecentAdminAuthentication(session);
    } catch (error) {
      if (isAdminReauthenticationError(error)) {
        return Response.json({ code: "ADMIN_REAUTHENTICATION_REQUIRED" }, { status: 428, headers });
      }
      throw error;
    }
    const body = await readLimitedJson(request, 1024, schema);
    await consumeApiRateLimit(request, session.user.id, "admin-support-triage-llm-model", { minute: 10, day: 100 });
    // The model first: refusing an unknown model must not leave the switch flipped.
    const model =
      body.modelId === undefined
        ? undefined
        : (await writeSupportTriageLlmModelSetting({ session, request, modelId: body.modelId })).modelId;
    const enabled =
      body.enabled === undefined
        ? undefined
        : (await writeSupportTriageEnabledSetting({ session, request, enabled: body.enabled })).enabled;
    return Response.json({ modelId: model, enabled }, { headers });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) return security;
    if (error instanceof SupportTriageModelRefused) {
      return Response.json({ code: "SUPPORT_TRIAGE_LLM_MODEL_NOT_ENABLED" }, { status: 400, headers });
    }
    return Response.json({ code: "SUPPORT_TRIAGE_LLM_MODEL_WRITE_FAILED" }, { status: 500, headers });
  }
}
