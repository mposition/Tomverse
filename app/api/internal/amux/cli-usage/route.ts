export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import { AMUX_V4_ANALYSIS_AGENT_SECRET_ENV,
  isAmuxV4AnalysisAgentAuthorized } from "@/lib/amux/ideaAnalysisQueueCore";
import { amuxCliUsageReceiptSchema } from "@/lib/amux/cliUsageLedgerCore";
import { AmuxCliUsageLedgerError, recordAmuxCliUsage } from
  "@/lib/amux/cliUsageLedgerStore";
import { purgeExpiredAmuxCliUsage } from "@/lib/amux/cliUsageRetention";
import { prisma } from "@/lib/prisma";

// The environment switch remains off by default. Deployment and activation
// require separate approval after Ubuntu receipt/read-back verification.
const WRITE_CODE_LATCH = true;
const WRITE_ENV = "TOMVERSE_AMUX_CLI_USAGE_WRITE";
const id = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/);

function ideaAuthorized(request: Request): boolean {
  return isAmuxV4AnalysisAgentAuthorized(request,
      process.env[AMUX_V4_ANALYSIS_AGENT_SECRET_ENV],
      process.env.TOMVERSE_AMUX_SYNC_SECRET);
}

function authorized(request: Request): boolean {
  return isAmuxSyncAuthorized(request) || ideaAuthorized(request);
}

export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  if (!WRITE_CODE_LATCH || process.env[WRITE_ENV] !== "enabled") return amuxJsonNoStore(
    { available: false, reason: "cli_usage_write_disabled" }, 409);
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json") return amuxJsonNoStore({ error: "Invalid content type." }, 415);
  let body: z.infer<typeof amuxCliUsageReceiptSchema>;
  try { body = await readLimitedJson(request, 4096, amuxCliUsageReceiptSchema); }
  catch { return amuxJsonNoStore({ error: "Invalid request." }, 400); }
  if (body.binding.kind === "task_attempt" ? !isAmuxSyncAuthorized(request) :
      !ideaAuthorized(request)) return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  let callbackReturned = false;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const saved = await recordAmuxCliUsage(tx, body);
      callbackReturned = true;
      return saved;
    }, { maxWait: 5_000, timeout: 10_000 });
    return amuxJsonNoStore(result);
  } catch (error) {
    if (!callbackReturned && error instanceof AmuxCliUsageLedgerError) {
      return amuxJsonNoStore({ error: error.code }, 409);
    }
    // A disconnect after COMMIT may be a recorded event. Read back by exact
    // invocationId before considering a new call; never blind-retry the CLI.
    return amuxJsonNoStore({ error: "outcome_unknown" }, 503);
  }
}

export async function GET(request: Request): Promise<Response> {
  if (!authorized(request)) return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  const url = new URL(request.url);
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== "invocationId") return amuxJsonNoStore(
    { error: "Invalid request." }, 400);
  const invocationId = id.safeParse(url.searchParams.get("invocationId"));
  if (!invocationId.success) return amuxJsonNoStore({ error: "Invalid request." }, 400);
  try {
    const row = await prisma.amuxCliUsageEvent.findUnique({
      where: { invocationId: invocationId.data },
      select: { invocationId: true, receiptDigest: true, completeness: true,
        bindingKind: true },
    });
    if (row && (row.bindingKind === "idea_analysis" ?
      !ideaAuthorized(request) : !isAmuxSyncAuthorized(request)))
      return amuxJsonNoStore({ status: "absent" });
    return amuxJsonNoStore(row === null ? { status: "absent" } :
      { status: "recorded", invocationId: row.invocationId,
        receiptDigest: row.receiptDigest, completeness: row.completeness });
  } catch { return amuxJsonNoStore({ error: "outcome_unknown" }, 503); }
}

export async function DELETE(request: Request): Promise<Response> {
  if (!isAmuxSyncAuthorized(request)) return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  if (process.env.TOMVERSE_AMUX_CLI_USAGE_RETENTION !== "enabled")
    return amuxJsonNoStore({ available: false,
      reason: "cli_usage_retention_disabled" }, 409);
  try { return amuxJsonNoStore(await purgeExpiredAmuxCliUsage()); }
  catch { return amuxJsonNoStore({ error: "outcome_unknown" }, 503); }
}
