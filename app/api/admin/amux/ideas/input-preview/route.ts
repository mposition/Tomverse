export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { adminApprovalErrorResponse } from "@/lib/adminApproval";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedText } from "@/lib/apiSecurity";
import { inspectAmuxIdeaInput, AMUX_IDEA_INPUT_ENVELOPE_MAX_BYTES } from "@/lib/amux/ideaInputCore";
import { authOptions } from "@/lib/auth";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };

/** This route checks only the operator's input. The security rate limiter
 * writes its own counter, but no idea/draft row is created, no GitHub data is
 * collected, no model payload is prepared, and no model is called. */
export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404, headers: noStore });
    }
    if (getAdminRole(session) !== "owner") {
      return NextResponse.json({ error: "Forbidden." }, { status: 403, headers: noStore });
    }
    try {
      await assertRecentAdminAuthentication(session);
    } catch (error) {
      if (isAdminReauthenticationError(error)) {
        return NextResponse.json(
          { error: "ADMIN_REAUTHENTICATION_REQUIRED" },
          { status: 428, headers: noStore },
        );
      }
      throw error;
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return NextResponse.json({ error: "content_type_refused" }, { status: 415, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user.id, "admin-amux-v4-idea-input-preview", {
      minute: 10,
      day: 100,
    });
    const raw = await readLimitedText(request, AMUX_IDEA_INPUT_ENVELOPE_MAX_BYTES);
    const inspected = inspectAmuxIdeaInput(raw);
    if (!inspected.ok) {
      return NextResponse.json(
        { error: inspected.code, ideaWrites: 0 },
        { status: inspected.code === "too_large" ? 413 : 400, headers: noStore },
      );
    }
    return NextResponse.json(
      {
        outcome: "input_checked",
        ideaWrites: 0,
        transferReady: false,
        ideaBytes: inspected.ideaBytes,
        repositoryCount: inspected.repositoryCount,
        pullRequestCount: inspected.pullRequestCount,
        notAutomaticallyCollected: ["conversation_history", "private_documents", "user_data", "github_content"],
      },
      { headers: noStore },
    );
  } catch (error) {
    const approval = adminApprovalErrorResponse(error);
    if (approval) {
      approval.headers.set("Cache-Control", noStore["Cache-Control"]);
      return approval;
    }
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", noStore["Cache-Control"]);
      return security;
    }
    console.error("AMUX v4 idea input preview failed");
    return NextResponse.json({ error: "input_preview_failed" }, { status: 500, headers: noStore });
  }
}
