export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { AVAILABLE_MODELS, type AiProvider } from "@/lib/models";
import {
  PROVIDER_API_KEY_ENV,
  PROVIDER_DISPLAY_NAMES,
} from "@/lib/providerMonitoring";
import { prisma } from "@/lib/prisma";

const providers = Object.keys(PROVIDER_DISPLAY_NAMES) as [AiProvider, ...AiProvider[]];
const modelIds: ReadonlySet<string> = new Set<string>(
  AVAILABLE_MODELS.map((model) => model.id)
);

const providerTestSchema = z
  .object({
    provider: z.enum(providers),
    modelId: z
      .string()
      .trim()
      .max(120)
      .optional()
      .refine((value) => !value || modelIds.has(value), {
        message: "Unknown model.",
      }),
  })
  .strict();

const isConfigured = (value: string | undefined) =>
  typeof value === "string" && value.trim().length > 0;

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-provider-test-read", {
      minute: 40,
      day: 800,
    });

    const checks = await prisma.providerHealthCheck.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return NextResponse.json({ checks });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to load provider checks:", error);
    return NextResponse.json(
      { error: "Failed to load provider checks." },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-provider-test-write", {
      minute: 20,
      day: 200,
    });

    const started = Date.now();
    const body = await readLimitedJson(req, 2 * 1024, providerTestSchema);
    const envNames = PROVIDER_API_KEY_ENV[body.provider] || [];
    const hasKey = envNames.some((name) => isConfigured(process.env[name]));
    const model = body.modelId
      ? AVAILABLE_MODELS.find((candidate) => candidate.id === body.modelId)
      : null;
    const providerMatchesModel = !model || model.provider === body.provider;

    const status = hasKey && providerMatchesModel ? "ok" : "failed";
    const message = !hasKey
      ? `Missing API key: ${envNames.join(" or ")}`
      : !providerMatchesModel
        ? "Selected model does not belong to this provider."
        : "Provider configuration is ready for live traffic.";
    const errorCode = status === "ok" ? null : !hasKey ? "missing_api_key" : "provider_model_mismatch";

    const check = await prisma.providerHealthCheck.create({
      data: {
        provider: body.provider,
        modelId: body.modelId || null,
        status,
        latencyMs: Date.now() - started,
        errorCode,
        message,
        createdById: session.user.id,
        createdByEmail: session.user.email || null,
      },
    });

    await writeAdminAuditLog({
      session,
      request: req,
      action: "provider.test",
      targetType: "Provider",
      targetId: body.provider,
      summary: `Ran provider readiness test for ${body.provider}: ${status}.`,
      metadata: {
        provider: body.provider,
        modelId: body.modelId || null,
        status,
        errorCode,
      },
    });

    return NextResponse.json({ success: status === "ok", check });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Provider readiness test failed:", error);
    return NextResponse.json(
      { error: "Provider readiness test failed." },
      { status: 500 }
    );
  }
}
