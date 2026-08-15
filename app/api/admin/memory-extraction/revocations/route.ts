export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { adminApprovalErrorResponse } from "@/lib/adminApproval";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import {
  getMemoryExtractionRevokedPairs,
  MemoryRevocationRequestError,
  setMemoryExtractionRevokedPairs,
} from "@/lib/appSettings";
import {
  memoryPairLabel,
  REVOKE_ALL_ENTRY,
  type RevokedPairsRequest,
  type RevokedPairsState,
} from "@/lib/memoryAccess";
import { MEMORY_EXTRACTION_EVAL_REGISTER } from "@/lib/memoryExtractionEvalRegister";

/**
 * Emergency revocation of memory-extraction pairs (policy §12.1).
 *
 * The policy is explicit that this is changed "without a deploy, by an
 * approved operator in the Admin Console, audit-logged, immediately
 * fail-closed". Until this route existed only the reading half was built: the
 * one way to revoke a pair was a hand-written `UPDATE` against production,
 * which carries no permission check, leaves no audit record, and stores a
 * format where a single typo reads back as "revoke everything" instead of the
 * pair that was meant.
 *
 * It only ever *restricts*. There is no enable here and there must not be:
 * turning memory injection on is the §12.4 human procedure, and a control
 * that can both stop and start would put half of that procedure behind a
 * button.
 *
 * The register is returned alongside so an operator picks a pair rather than
 * types one. Typing one is still allowed -- an emergency control must work for
 * a pair the register no longer lists -- so the response says which requested
 * labels the register knows and which it does not, instead of refusing.
 */

const revocationSchema = z
  .object({
    mode: z.enum(["none", "pairs", "all"]),
    labels: z.array(z.string().max(200)).max(50).optional(),
    /** Why, in the operator's words. Stored on the audit entry, not the setting. */
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

const registerLabels = () =>
  new Set(MEMORY_EXTRACTION_EVAL_REGISTER.map(memoryPairLabel));

const describeState = (state: RevokedPairsState) => {
  if (state.kind === "none") return { kind: state.kind, pairs: [] as string[] };
  if (state.kind === "revoke_all") {
    return { kind: state.kind, reason: state.reason, pairs: [REVOKE_ALL_ENTRY] };
  }
  return { kind: state.kind, pairs: state.pairs.map(memoryPairLabel) };
};

const registerView = () =>
  MEMORY_EXTRACTION_EVAL_REGISTER.map((entry) => ({
    label: memoryPairLabel(entry),
    extractionModelId: entry.extractionModelId,
    promptVersion: entry.promptVersion,
    status: entry.status,
    owner: entry.owner,
  }));

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(
      req,
      session.user.id,
      "admin-memory-revocations-read",
      { minute: 30, day: 500 }
    );

    return NextResponse.json({
      revoked: describeState(await getMemoryExtractionRevokedPairs()),
      register: registerView(),
      canWrite: hasAdminPermission(session, "ops:write"),
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to load memory extraction revocations:", error);
    return NextResponse.json(
      { error: "Failed to load extraction revocations." },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    await assertRecentAdminAuthentication(session);
    await consumeApiRateLimit(
      req,
      session.user.id,
      "admin-memory-revocations-write",
      { minute: 10, day: 100 }
    );

    const body = await readLimitedJson(req, 8 * 1024, revocationSchema);
    const request: RevokedPairsRequest =
      body.mode === "pairs"
        ? { mode: "pairs", labels: body.labels ?? [] }
        : { mode: body.mode };

    const before = await getMemoryExtractionRevokedPairs();
    // Written before the change, so an update that fails afterwards still
    // leaves a record that it was attempted and by whom.
    await writeAdminAuditLog({
      session,
      request: req,
      action: "memory_extraction.revocations.update_started",
      targetType: "AppSettings",
      targetId: "memoryExtractionRevokedPairs",
      summary: "Started a memory extraction revocation change.",
      metadata: { before: describeState(before), requested: body },
    });

    const after = await setMemoryExtractionRevokedPairs(request);
    const known = registerLabels();
    const unknownLabels =
      request.mode === "pairs"
        ? request.labels.filter((label) => !known.has(label))
        : [];

    await writeAdminAuditLog({
      session,
      request: req,
      action: "memory_extraction.revocations.updated",
      targetType: "AppSettings",
      targetId: "memoryExtractionRevokedPairs",
      summary:
        after.kind === "revoke_all"
          ? "Stopped every memory extraction pair."
          : after.kind === "none"
            ? "Cleared every memory extraction revocation."
            : `Revoked ${after.pairs.length} memory extraction pair(s).`,
      metadata: {
        before: describeState(before),
        after: describeState(after),
        reason: body.reason,
        unknownLabels,
      },
    });

    return NextResponse.json({
      revoked: describeState(after),
      register: registerView(),
      // Not an error: revoking a pair the register does not list is a valid
      // emergency action, and it is also what a typo looks like. Reporting it
      // is the difference between the operator knowing which they did.
      unknownLabels,
    });
  } catch (error) {
    if (error instanceof MemoryRevocationRequestError) {
      return NextResponse.json(
        {
          error: "The revocation request cannot be stored as written.",
          code: "INVALID_REVOCATION_REQUEST",
          problems: error.problems,
        },
        { status: 400 }
      );
    }
    const approvalResponse = adminApprovalErrorResponse(error);
    if (approvalResponse) return approvalResponse;
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to update memory extraction revocations:", error);
    return NextResponse.json(
      { error: "Failed to update extraction revocations." },
      { status: 500 }
    );
  }
}
