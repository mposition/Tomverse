export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { adminApprovalErrorResponse } from "@/lib/adminApproval";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import {
  SEMANTIC_RETRIEVAL_FEATURES,
  resolveSemanticRetrievalConfig,
  semanticRetrievalFeatureConfigured,
  semanticRetrievalNoticePublished,
  type SemanticRetrievalFeature,
} from "@/lib/semanticRetrievalCore";
import { readSemanticRetrievalKey } from "@/lib/semanticRetrievalClient";
import {
  readSemanticRetrievalSwitches,
  updateSemanticRetrievalSwitches,
} from "@/lib/semanticRetrievalSettings";

/**
 * Admin › Feature flags: the switches for semantic retrieval (Cohere rerank and
 * embeddings). Every switch is off until an operator turns it on, and a switch
 * only does anything once the deployment also has the key, the model and price
 * for its API, and a provider budget in its environment.
 *
 * The response names what is missing by environment variable name only. The key
 * is read for whether it exists and its value never leaves this function.
 */

const updateSchema = z
  .object(
    Object.fromEntries(
      SEMANTIC_RETRIEVAL_FEATURES.map((feature) => [feature, z.boolean().optional()])
    ) as Record<SemanticRetrievalFeature, z.ZodOptional<z.ZodBoolean>>
  )
  .strict();

const readState = async () => {
  const switches = await readSemanticRetrievalSwitches();
  const config = resolveSemanticRetrievalConfig();
  const keyConfigured = readSemanticRetrievalKey() !== null;
  // Before the privacy notice is published nothing may be turned on, so every
  // switch reads as not configured.
  const privacyNoticePublished = semanticRetrievalNoticePublished();
  const features = Object.fromEntries(
    SEMANTIC_RETRIEVAL_FEATURES.map((feature) => [
      feature,
      {
        on: switches[feature],
        configured:
          privacyNoticePublished &&
          keyConfigured &&
          semanticRetrievalFeatureConfigured(feature, config),
      },
    ])
  ) as Record<SemanticRetrievalFeature, { on: boolean; configured: boolean }>;
  return {
    features,
    keyConfigured,
    budgetConfigured: config.budget !== null,
    privacyNoticePublished,
    models: { rerank: config.rerank?.model ?? null, embed: config.embed?.model ?? null },
    problems: config.problems,
  };
};

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-semantic-retrieval-read", {
      minute: 30,
      day: 500,
    });
    return NextResponse.json(await readState());
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to load the semantic retrieval switches:", error);
    return NextResponse.json({ error: "Failed to load the settings." }, { status: 500 });
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
    await consumeApiRateLimit(req, session.user.id, "admin-semantic-retrieval-write", {
      minute: 10,
      day: 100,
    });

    const requested = await readLimitedJson(req, 1024, updateSchema);
    const before = await readState();

    // Turning a switch on needs everything its API needs; turning one off never does.
    const unconfigured = SEMANTIC_RETRIEVAL_FEATURES.filter(
      (feature) => requested[feature] === true && !before.features[feature].configured
    );
    if (unconfigured.length > 0) {
      return NextResponse.json(
        {
          error:
            "A switch cannot be turned on before the privacy notice is published and its environment variables are set.",
        },
        { status: 409 }
      );
    }

    // One transaction for the whole request: a second switch that fails to
    // write must not leave the first one changed.
    const changes: Partial<Record<SemanticRetrievalFeature, boolean>> = {};
    for (const feature of SEMANTIC_RETRIEVAL_FEATURES) {
      const next = requested[feature];
      if (next !== undefined && next !== before.features[feature].on) changes[feature] = next;
    }
    if (Object.keys(changes).length > 0) {
      await updateSemanticRetrievalSwitches({ session, request: req }, changes);
    }
    return NextResponse.json(await readState());
  } catch (error) {
    const approvalResponse = adminApprovalErrorResponse(error);
    if (approvalResponse) return approvalResponse;
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to update the semantic retrieval switches:", error);
    return NextResponse.json({ error: "Failed to update the settings." }, { status: 500 });
  }
}
