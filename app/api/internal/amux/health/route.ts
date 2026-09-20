import { NextResponse } from "next/server";

import { requireInternalAmuxToken } from "@/lib/amux";

export async function GET(request: Request) {
  try {
    requireInternalAmuxToken(request);

    return NextResponse.json({
      ok: true,
      subsystem: "amux",
    });
  } catch {
    return NextResponse.json(
      { ok: false },
      { status: 401 },
    );
  }
}
