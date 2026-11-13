export const dynamic = "force-dynamic";
// A measurement sends its samples after this response; the run is bounded by
// at most 12 samples, each under the adapter's provider timeout.
export const maxDuration = 900;

import { getServerSession } from "next-auth/next";
import { after, NextResponse } from "next/server";
import { z } from "zod";

import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import {
  confirmBodySchema,
  confirmImageBillingTerms,
  imageBillingMeasurementView,
  MeasurementRefusal,
  runImageBillingMeasurement,
  startImageBillingMeasurement,
} from "@/lib/imageBillingMeasurement";
import { IMAGE_BILLING_MEASUREMENT_ENV, measurementPlanSchema } from "@/lib/imageBillingMeasurementCore";

// Billing measurement of an image model (policy section 12.1). GET reads a
// model's measurements and confirmed terms; POST starts a paid measurement the
// operator approved on screen, or confirms the terms a completed one supports.

const refusal = (error: unknown) => {
  if (error instanceof MeasurementRefusal) {
    return NextResponse.json(
      { error: error.code, reasons: error.reasons, ...(error.code === "measurement_disabled" ? { env: IMAGE_BILLING_MEASUREMENT_ENV } : {}) },
      { status: error.status }
    );
  }
  if (error instanceof z.ZodError) return NextResponse.json({ error: "invalid_plan" }, { status: 400 });
  return apiSecurityResponse(error);
};

const adminSession = async (write: boolean) => {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminSession(session)) {
    return { response: NextResponse.json({ error: "Not found." }, { status: 404 }) } as const;
  }
  if (write && !hasAdminPermission(session, "ops:write")) {
    return { response: NextResponse.json({ error: "Forbidden." }, { status: 403 }) } as const;
  }
  return { session } as const;
};

const modelQuery = z.object({ provider: z.string().min(1).max(40), apiModelId: z.string().min(1).max(120) });

export async function GET(req: Request) {
  try {
    const auth = await adminSession(false);
    if ("response" in auth) return auth.response;
    await consumeApiRateLimit(req, auth.session.user.id, "admin-model-catalog", { minute: 60, day: 2_000 });
    const params = new URL(req.url).searchParams;
    const query = modelQuery.safeParse({ provider: params.get("provider"), apiModelId: params.get("apiModelId") });
    if (!query.success) return NextResponse.json({ error: "invalid_model" }, { status: 400 });
    return NextResponse.json(await imageBillingMeasurementView(query.data.provider, query.data.apiModelId));
  } catch (error) {
    return refusal(error) ?? NextResponse.json({ error: "Measurement read failed." }, { status: 500 });
  }
}

const postBodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), plan: measurementPlanSchema }).strict(),
  confirmBodySchema.extend({ action: z.literal("confirm") }),
]);

export async function POST(req: Request) {
  try {
    const auth = await adminSession(true);
    if ("response" in auth) return auth.response;
    await consumeApiRateLimit(req, auth.session.user.id, "admin-model-catalog-write", { minute: 20, day: 300 });
    const body = await readLimitedJson(req, 16 * 1024, postBodySchema);
    const session = auth.session;
    if (body.action === "confirm") {
      const terms = await confirmImageBillingTerms({
        measurementId: body.measurementId,
        sources: body.sources,
        session,
        request: req,
      });
      return NextResponse.json({ ok: true, terms });
    }
    const row = await startImageBillingMeasurement({ plan: body.plan, session, request: req });
    // The samples run after the response; the panel reads progress from GET.
    after(() => runImageBillingMeasurement({ measurementId: row.id, session }));
    return NextResponse.json({ ok: true, measurementId: row.id }, { status: 202 });
  } catch (error) {
    return refusal(error) ?? NextResponse.json({ error: "Measurement action failed." }, { status: 500 });
  }
}
