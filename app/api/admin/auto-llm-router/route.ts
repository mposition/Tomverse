export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { adminApprovalErrorResponse } from "@/lib/adminApproval";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import {
  AUTO_LLM_ROUTER_MODEL_SETTING_KEY,
  readAutoLlmRouterModelId,
  writeAutoLlmRouterModelId,
} from "@/lib/autoLlmRouterSettings";
import { getRuntimeModels } from "@/lib/modelRegistry";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";

/**
 * Admin › Routing: which model makes Auto's per-prompt choice
 * (lib/autoLlmRouter.ts). Null is off.
 *
 * The options are the enabled runtime models, the same list Auto chooses
 * answering models from, so a stored id can always be resolved by the chat
 * route. A model disabled later reads as off there rather than failing.
 */

const updateSchema = z
  .object({ modelId: z.string().trim().min(1).max(120).nullable() })
  .strict();

const routerModelOptions = async () =>
  (await getRuntimeModels())
    .filter((model) => model.enabled && !model.catalogDeleted)
    .map((model) => ({ id: model.id, name: model.name, provider: model.provider }));

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-auto-llm-router-read", {
      minute: 30,
      day: 500,
    });
    const [modelId, options] = await Promise.all([
      readAutoLlmRouterModelId(),
      routerModelOptions(),
    ]);
    return NextResponse.json({ modelId, options });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to load the Auto LLM router setting:", error);
    return NextResponse.json({ error: "Failed to load the setting." }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    await assertRecentAdminAuthentication(session);
    await consumeApiRateLimit(req, session.user.id, "admin-auto-llm-router-write", {
      minute: 10,
      day: 100,
    });

    const { modelId } = await readLimitedJson(req, 1024, updateSchema);
    const options = await routerModelOptions();
    if (modelId !== null && !options.some((option) => option.id === modelId)) {
      return NextResponse.json(
        { error: "That model is not an enabled model." },
        { status: 400 }
      );
    }

    const before = await readAutoLlmRouterModelId();
    await writeAutoLlmRouterModelId(modelId);
    await writeAdminAuditLog({
      session,
      request: req,
      action: "auto.llm_router_model.updated",
      targetType: "AppSettings",
      targetId: AUTO_LLM_ROUTER_MODEL_SETTING_KEY,
      summary: modelId
        ? `Set the Auto LLM router model to ${modelId}.`
        : "Turned the Auto LLM router off.",
      metadata: { before, after: modelId },
    });
    return NextResponse.json({ modelId, options });
  } catch (error) {
    const approvalResponse = adminApprovalErrorResponse(error);
    if (approvalResponse) return approvalResponse;
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to update the Auto LLM router setting:", error);
    return NextResponse.json({ error: "Failed to update the setting." }, { status: 500 });
  }
}
