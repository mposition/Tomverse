export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import {
  getPublicAppSettings,
  isValidGuestDefaultModel,
  updateGuestDefaultModel,
} from "@/lib/appSettings";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";

const updateAppSettingsSchema = z
  .object({
    guestDefaultModelId: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine(isValidGuestDefaultModel, {
        message: "Guest default model must be an enabled Free model.",
      }),
  })
  .strict();

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-app-settings-read", {
      minute: 30,
      day: 500,
    });

    const settings = await getPublicAppSettings();
    return NextResponse.json({ settings });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to load admin app settings:", error);
    return NextResponse.json(
      { error: "Failed to load app settings." },
      { status: 500 }
    );
  }
}

export async function PATCH(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-app-settings-write", {
      minute: 10,
      day: 100,
    });

    const body = await readLimitedJson(req, 4 * 1024, updateAppSettingsSchema);
    await updateGuestDefaultModel(body.guestDefaultModelId);

    const settings = await getPublicAppSettings();
    return NextResponse.json({ settings });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to update admin app settings:", error);
    return NextResponse.json(
      { error: "Failed to update app settings." },
      { status: 500 }
    );
  }
}
