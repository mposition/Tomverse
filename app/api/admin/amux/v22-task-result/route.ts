export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getAdminRole } from "@/lib/adminAuth";
import { readAmuxV22TaskResultForOwner } from
  "@/lib/amux/v22TaskResultStore";
import { authOptions } from "@/lib/auth";

const json = (body: object, status = 200) => NextResponse.json(body, {
  status, headers: { "Cache-Control": "private, no-store, max-age=0" },
});

export async function GET(request: Request): Promise<Response> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || getAdminRole(session) !== "owner")
    return json({ error: "Not found." }, 404);
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].length !== 1 || !params.has("taskId"))
    return json({ error: "Invalid request." }, 400);
  const taskId = z.string().min(1).max(160).safeParse(params.get("taskId"));
  if (!taskId.success) return json({ error: "Invalid request." }, 400);
  try {
    const result = await readAmuxV22TaskResultForOwner(taskId.data);
    return result ? json({ result }) : json({ error: "Not found." }, 404);
  } catch { return json({ error: "Result unavailable." }, 503); }
}
