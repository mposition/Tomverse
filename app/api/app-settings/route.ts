export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getPublicAppSettings } from "@/lib/appSettings";

export async function GET() {
  try {
    const settings = await getPublicAppSettings();
    return NextResponse.json(settings, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Failed to load app settings:", error);
    return NextResponse.json(
      { error: "Failed to load app settings." },
      { status: 500 }
    );
  }
}
