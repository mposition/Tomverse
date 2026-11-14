export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { NextResponse } from "next/server";
import { z } from "zod";

import { MARKETING_AUTOMATION_KILL_SWITCH_ENV } from "@/lib/marketingAutomationAccess";
import {
  MARKETING_GENERATOR_CONTEXT_MAX_BYTES,
  marketingGeneratorContextAllowed,
  readMarketingGeneratorContext,
  withMarketingMorningInputs,
} from "@/lib/marketingGeneratorContext";
import {
  marketingGeneratorAuthorized,
  marketingGeneratorSecret,
  parseMarketingGeneratorJson,
  readMarketingGeneratorBody,
} from "@/lib/marketingGeneratorAuth";
import { runMarketingTransaction } from "@/lib/marketingStore";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import { prisma } from "@/lib/prisma";

// What the marketing generator reads before it writes (S3 plan, S3b;
// docs/policy/marketing-automation.md §4).
//
// POST, like every internal route the policy allows: a GET is a request any
// cache, prefetcher or log line can repeat. The body names the run asking and
// nothing else. The answer is the structured context in
// `lib/marketingGeneratorContext.ts` -- no URL, evidence, credential or post --
// read in one transaction so the accounts and the reports are one moment.

const requestSchema = z
  .object({ generatorRunId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) })
  .strict();

const json = (body: Record<string, unknown>, status: number) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: Request) {
  const secret = marketingGeneratorSecret();
  if (!secret || !marketingGeneratorAuthorized(request, secret)) {
    return json({ error: "Unauthorized" }, 401);
  }
  // A run id is a few dozen bytes; the body is read no further than this.
  const raw = await readMarketingGeneratorBody(request, 1024);
  if (raw === null) return json({ code: "body_too_large" }, 413);
  if (!requestSchema.safeParse(parseMarketingGeneratorJson(raw)).success) {
    return json({ code: "invalid_request" }, 400);
  }

  // Stopped means stopped: no accounts, no claims, nothing to write from.
  if (
    !marketingGeneratorContextAllowed({
      ok: true,
      value: process.env[MARKETING_AUTOMATION_KILL_SWITCH_ENV],
    })
  ) {
    return json({ code: "kill_switch" }, 503);
  }

  let context;
  try {
    context = await runMarketingTransaction(
      prisma,
      (tx) => readMarketingGeneratorContext(tx),
      { maxWait: 5_000, timeout: 10_000 },
    );
  } catch (error) {
    void reportOperationalIncident({
      code: "MARKETING_GENERATOR_ROUTE_FAILED",
      title: "Marketing generator context could not be read",
      error,
      severity: "error",
      cooldownMs: 30 * 60 * 1_000,
      context: { component: "marketing-generator-context" },
    }).catch((reportError: unknown) => {
      console.error("Marketing generator incident could not be reported:", reportError);
    });
    return json({ code: "context_unavailable" }, 500);
  }
  // Outside the transaction: the morning report's counts (best effort).
  context = await withMarketingMorningInputs(context);
  const answer = { context };
  const bytes = Buffer.byteLength(JSON.stringify(answer), "utf8");
  if (bytes > MARKETING_GENERATOR_CONTEXT_MAX_BYTES) {
    // Which part grew, so the next fix need not guess (2026-11-14 the run only saw "http 500").
    const part = (value: unknown) => Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
    console.error(
      JSON.stringify({
        event: "marketing_generator_context_too_large",
        bytes,
        maxBytes: MARKETING_GENERATOR_CONTEXT_MAX_BYTES,
        parts: Object.fromEntries(Object.entries(context).map(([key, value]) => [key, part(value)])),
      }),
    );
    return json({ code: "context_too_large" }, 500);
  }
  return json(answer, 200);
}
