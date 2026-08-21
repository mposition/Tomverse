export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";

import { authOptions } from "@/lib/auth";
import {
  adminApprovalErrorResponse,
  runWithAdminApproval,
} from "@/lib/adminApproval";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import {
  JurisdictionPolicyError,
  activatePolicyVersion,
  ensureJurisdictionPolicyDraft,
  listPolicyVersions,
  readPolicyVersion,
} from "@/lib/emailJurisdictionPolicy";

/**
 * Jurisdiction policy versions.
 *
 * Contract: docs/policy/email-notifications.md §12.5, §12.3.
 *
 * Two writes, and they are deliberately asymmetric. Creating a draft is
 * ordinary work -- it changes nothing about what is sent, and a draft nobody
 * activates is a document. Activating one changes the labelling rules of every
 * marketing message in eight jurisdictions at once, so it goes through
 * two-person approval like the other irreversible administrative acts.
 *
 * There is no edit endpoint yet: the first version is the seed, and editing a
 * profile means a new draft rather than a change to one that has been
 * approved. When editing arrives it belongs on the draft only -- an active
 * version is what some delivery was rendered under.
 */

const requestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create_draft"),
    version: z.string().trim().min(1).max(120).optional(),
    changeSummary: z.string().trim().min(1).max(2_000).optional(),
  }),
  z.object({
    action: z.literal("activate"),
    versionId: z.string().trim().min(1).max(120),
    reason: z.string().trim().min(1).max(500),
  }),
]);

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    await consumeApiRateLimit(req, session.user.id, "admin-email-policy-read", {
      minute: 30,
      day: 500,
    });

    const url = new URL(req.url);
    const versionId = url.searchParams.get("versionId");
    const versions = await listPolicyVersions();
    // Without an explicit id the screen opens on whatever is live, falling back
    // to the newest row: a console that opened on nothing would make "what is
    // in force right now" a question you have to click to answer.
    const selectedId =
      versionId ||
      versions.find((version) => version.status === "active")?.id ||
      versions[0]?.id ||
      null;

    return NextResponse.json({
      versions,
      selected: selectedId ? await readPolicyVersion(selectedId) : null,
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Admin email policy read failed:", error);
    return NextResponse.json(
      { error: "Failed to read jurisdiction policy versions." },
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

    const body = await readLimitedJson(req, 8 * 1024, requestSchema);

    if (body.action === "create_draft") {
      await consumeApiRateLimit(
        req,
        session.user.id,
        "admin-email-policy-draft",
        { minute: 5, day: 40 }
      );

      const result = await ensureJurisdictionPolicyDraft({
        version: body.version,
        changeSummary: body.changeSummary,
      });
      if (result.created) {
        await writeAdminAuditLog({
          session,
          request: req,
          action: "email_policy.draft_created",
          targetType: "EmailPolicyVersion",
          targetId: result.version.id,
          summary: `Created jurisdiction policy draft ${result.version.version}.`,
          metadata: {
            profileCount: result.version.profileCount,
            countryCount: result.version.countryCount,
          },
        });
      }
      return NextResponse.json({
        created: result.created,
        version: result.version,
      });
    }

    await consumeApiRateLimit(
      req,
      session.user.id,
      "admin-email-policy-activate",
      { minute: 3, day: 20 }
    );

    const result = await runWithAdminApproval(
      {
        session,
        request: req,
        action: "email_policy.activate",
        targetType: "EmailPolicyVersion",
        targetId: body.versionId,
        payload: { versionId: body.versionId },
        reason: body.reason,
      },
      () =>
        activatePolicyVersion({
          versionId: body.versionId,
          actorId: session.user!.id!,
          actorEmail: session.user?.email || null,
        })
    );

    await writeAdminAuditLog({
      session,
      request: req,
      action: "email_policy.activated",
      targetType: "EmailPolicyVersion",
      targetId: result.version.id,
      summary: `Activated jurisdiction policy ${result.version.version}.`,
      metadata: {
        reason: body.reason,
        supersededVersion: result.supersededVersion,
        profileCount: result.version.profileCount,
        countryCount: result.version.countryCount,
      },
    });

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const approvalResponse = adminApprovalErrorResponse(error);
    if (approvalResponse) return approvalResponse;
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    if (error instanceof JurisdictionPolicyError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status }
      );
    }
    console.error("Admin email policy write failed:", error);
    return NextResponse.json(
      { error: "Failed to change the jurisdiction policy." },
      { status: 500 }
    );
  }
}
