export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { NextResponse } from "next/server";
import { z } from "zod";

import {
  MARKETING_GENERATOR_CONTEXT_MAX_BYTES,
  readMarketingGeneratorContext,
} from "@/lib/marketingGeneratorContext";
import { marketingGeneratorAuthorized, marketingGeneratorSecret } from "@/lib/marketingGeneratorAuth";
import { runMarketingTransaction } from "@/lib/marketingStore";
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
  const body = await request.json().catch(() => null);
  if (!requestSchema.safeParse(body).success) return json({ code: "invalid_request" }, 400);

  const context = await runMarketingTransaction(
    prisma,
    (tx) => readMarketingGeneratorContext(tx),
    { maxWait: 5_000, timeout: 10_000 },
  );
  const answer = { context };
  if (Buffer.byteLength(JSON.stringify(answer), "utf8") > MARKETING_GENERATOR_CONTEXT_MAX_BYTES) {
    return json({ code: "context_too_large" }, 500);
  }
  return json(answer, 200);
}
