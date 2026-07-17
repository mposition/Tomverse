export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getRuntimeModels } from "@/lib/modelRegistry";

export async function GET() {
  try {
    const models = await getRuntimeModels({ includeCatalogDeleted: true });
    return NextResponse.json(
      {
        models: models.map((model) => {
          const publicModel = { ...model };
          delete publicModel.apiBaseUrl;
          delete publicModel.apiKeyEnvName;
          delete publicModel.operationalReason;
          return publicModel;
        }),
      },
      {
        headers: {
          "Cache-Control": "private, no-store, max-age=0",
          "X-Content-Type-Options": "nosniff",
        },
      }
    );
  } catch (error) {
    console.error("Public model catalog error:", error);
    return NextResponse.json({ error: "Model catalog unavailable." }, { status: 503 });
  }
}
