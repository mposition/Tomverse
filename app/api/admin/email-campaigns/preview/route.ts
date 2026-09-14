export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";

import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { renderCampaignContent } from "@/lib/emailCampaignContent";
import { CampaignContentError } from "@/lib/emailCampaignContentCore";
import { campaignContentDigest } from "@/lib/emailCampaignAttestationCore";
import { SUPPORTED_LANGUAGES, type Language } from "@/lib/language";

const previewSchema = z
  .object({
    templateKey: z.string().trim().min(1).max(120),
    locales: z
      .array(z.enum(SUPPORTED_LANGUAGES as unknown as [Language, ...Language[]]))
      .min(1)
      .max(7),
    contentByLocale: z.record(z.string(), z.record(z.string(), z.unknown())),
  })
  .strict();

/** Renders draft input without storing it or sending anything. */
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-email-campaign-preview", {
      minute: 30,
      day: 1_000,
    });
    const body = await readLimitedJson(req, 96 * 1024, previewSchema);
    const rendered = renderCampaignContent(body);
    const hashes = Object.fromEntries(
      rendered.previews.map((preview) => [preview.language, preview.contentHash])
    );
    return NextResponse.json({
      previews: rendered.previews,
      copyDigest: campaignContentDigest(hashes),
    });
  } catch (error) {
    const response = apiSecurityResponse(error);
    if (response) return response;
    if (error instanceof CampaignContentError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 400 }
      );
    }
    console.error("Failed to render campaign preview.", error);
    return NextResponse.json(
      { error: "Failed to render campaign preview." },
      { status: 500 }
    );
  }
}
