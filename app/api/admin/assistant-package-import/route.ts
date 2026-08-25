export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { isAdminSession } from "@/lib/adminAuth";
import {
  isAssistantPackageImportEnabled,
  setAssistantPackageImportEnabled,
} from "@/lib/appSettings";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";

/**
 * The rollout control for external assistant package import.
 *
 * docs/policy/assistant-package-import.md §12.2.1.
 *
 * Its own route rather than a field on `/api/admin/app-settings`, and the
 * policy says why: that request carries the whole panel and rewrites all of
 * it, so the audit row it leaves can say settings were saved and cannot say
 * this flag moved. Here the request is the change, and the row records the
 * value on both sides of it.
 *
 * `enabled: false` is the rollback and takes the same path. A control that
 * only switches on leaves the reverse to a hand-typed `UPDATE`, and the record
 * then says a feature was released and never says it was withdrawn.
 */
const changeSchema = z
  .object({
    enabled: z.boolean(),
    /**
     * Why, in the operator's words, on the audit row.
     *
     * Required because "who and when" without "why" does not answer the
     * question the row is kept for. Bounded because it is a sentence, not a
     * report, and the audit summary column truncates anyway.
     */
    rationale: z.string().trim().min(1).max(500),
  })
  .strict();

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    const actorId = session?.user?.id;
    if (!isAdminSession(session) || !actorId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    await consumeApiRateLimit(req, actorId, "admin-read", {
      minute: 60,
      day: 2_000,
    });
    return NextResponse.json(
      { enabled: await isAssistantPackageImportEnabled() },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) return security;
    console.error("Failed to read the package import flag:", error);
    return NextResponse.json(
      { error: "Failed to read the flag." },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    const actorId = session?.user?.id;
    if (!isAdminSession(session) || !actorId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    await consumeApiRateLimit(req, actorId, "admin-write", {
      minute: 20,
      day: 200,
    });
    const body = await readLimitedJson(req, 8 * 1024, changeSchema);
    const outcome = await setAssistantPackageImportEnabled({
      session,
      request: req,
      enabled: body.enabled,
      rationale: body.rationale,
    });
    if (outcome.outcome === "refused") {
      // Distinct statuses because the two refusals ask for different things:
      // one wants a different operator, the other wants the same one to sign
      // in again.
      return NextResponse.json(
        { error: "Refused.", code: refusalCode(outcome.reason) },
        { status: outcome.reason === "reauthentication-required" ? 401 : 403 }
      );
    }
    return NextResponse.json(outcome, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) return security;
    console.error("Failed to change the package import flag:", error);
    return NextResponse.json(
      { error: "Failed to change the flag." },
      { status: 500 }
    );
  }
}

const refusalCode = (
  reason: "reauthentication-required" | "not-authorized" | "rationale-required"
) =>
  reason === "reauthentication-required"
    ? "ADMIN_REAUTHENTICATION_REQUIRED"
    : reason === "rationale-required"
      ? "ASSISTANT_PACKAGE_IMPORT_RATIONALE_REQUIRED"
      : "FORBIDDEN";
