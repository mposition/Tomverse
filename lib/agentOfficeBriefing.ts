/**
 * The Agent office's AI briefing: one model call, asked for by the owner,
 * that summarises what the office reads (owner decision 2026-11-07, paid call
 * approved in chat). Off unless AGENT_OFFICE_BRIEFING_ENABLED is "true".
 *
 * The boundary is deterministic:
 *   - owner only, a recent sign-in, the mutation origin (the route checks);
 *   - at most AGENT_OFFICE_BRIEFING_PER_DAY calls a Brisbane day, reserved
 *     under a lock before the call, one in flight at a time, and audited in
 *     the same transaction;
 *   - a briefing younger than AGENT_OFFICE_BRIEFING_REUSE_MS is shown again
 *     instead of calling;
 *   - a reserved call that fails is not retried: it may have been billed.
 * Agent spending is not the user's credits: nothing here touches a credit or
 * a Chat budget. The answer is checked by parseAgentOfficeBriefing and shown
 * as text; it approves, sends or changes nothing.
 */
import "server-only";

import { randomUUID } from "node:crypto";

import { generateText, jsonSchema, Output } from "ai";
import type { JSONSchema7 } from "@ai-sdk/provider";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { getActiveAiModel } from "@/lib/activeAiModel";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import {
  AGENT_OFFICE_BRIEFING_PER_DAY,
  AGENT_OFFICE_BRIEFING_SCHEMA,
  agentOfficeBriefingClaimHeld,
  agentOfficeBriefingReusable,
  agentOfficeBriefingDay,
  agentOfficeBriefingFacts,
  agentOfficeBriefingPrompt,
  agentOfficeBriefingSystem,
  parseAgentOfficeBriefing,
  parseAgentOfficeBriefingUsage,
  parseStoredAgentOfficeBriefing,
  type AgentOfficeBriefing,
  type AgentOfficeBriefingFacts,
  type BriefingLocale,
  type StoredAgentOfficeBriefing,
} from "@/lib/agentOffice/briefing";
import { readAgentOfficeLiveRooms } from "@/lib/agentOfficeLiveRead";
import { getEnabledRuntimeModel } from "@/lib/modelRegistry";
import { prisma } from "@/lib/prisma";

export const AGENT_OFFICE_BRIEFING_ENABLED_ENV = "AGENT_OFFICE_BRIEFING_ENABLED";
export const AGENT_OFFICE_BRIEFING_MODEL_ENV = "AGENT_OFFICE_BRIEFING_MODEL";
const DEFAULT_MODEL_ID = "gpt-6-luna";
/**
 * {day, calls, claim: {id, until} | null}: the Brisbane day's calls, moved only
 * by `reserve`, and the one call in flight, whatever day it started on.
 */
export const AGENT_OFFICE_BRIEFING_USAGE_KEY = "agentOffice.briefing.usage";
export const AGENT_OFFICE_BRIEFING_LATEST_KEY = "agentOffice.briefing.latest";
const MAX_OUTPUT_TOKENS = 700;
const TIMEOUT_MS = 45_000;
/**
 * The office read before the call is cut off here; the claim is then renewed
 * for CLAIM_MS, which outlives the call's TIMEOUT_MS, so a second click cannot
 * start another call while this one may still run.
 */
const FACTS_MS = 20_000;
const CLAIM_MS = 90_000;

export const agentOfficeBriefingEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  env[AGENT_OFFICE_BRIEFING_ENABLED_ENV] === "true";

const configuredModelId = (env: NodeJS.ProcessEnv = process.env) =>
  env[AGENT_OFFICE_BRIEFING_MODEL_ENV]?.trim() || DEFAULT_MODEL_ID;

export type AgentOfficeBriefingStatus = {
  enabled: boolean;
  modelId: string;
  usedToday: number;
  limit: number;
  latest: StoredAgentOfficeBriefing | null;
};

export async function readAgentOfficeBriefingStatus(now: Date = new Date()): Promise<AgentOfficeBriefingStatus> {
  const rows = await prisma.appSetting.findMany({
    where: { key: { in: [AGENT_OFFICE_BRIEFING_USAGE_KEY, AGENT_OFFICE_BRIEFING_LATEST_KEY] } },
    select: { key: true, value: true },
  });
  const value = (key: string) => rows.find((row) => row.key === key)?.value ?? null;
  return {
    enabled: agentOfficeBriefingEnabled(),
    modelId: configuredModelId(),
    usedToday: parseAgentOfficeBriefingUsage(value(AGENT_OFFICE_BRIEFING_USAGE_KEY), agentOfficeBriefingDay(now)).calls,
    limit: AGENT_OFFICE_BRIEFING_PER_DAY,
    latest: parseStoredAgentOfficeBriefing(value(AGENT_OFFICE_BRIEFING_LATEST_KEY)),
  };
}

export type AgentOfficeBriefingLlm = (input: {
  facts: AgentOfficeBriefingFacts;
  locale: BriefingLocale;
}) => Promise<{ briefing: AgentOfficeBriefing; modelId: string } | null>;

/** The configured model, or null when it is not an enabled runtime model. */
async function briefingLlmFromEnv(): Promise<AgentOfficeBriefingLlm | null> {
  const model = await getEnabledRuntimeModel(configuredModelId());
  if (!model) return null;
  return async ({ facts, locale }) => {
    try {
      const generated = await generateText({
        model: getActiveAiModel(model),
        system: agentOfficeBriefingSystem(locale),
        prompt: agentOfficeBriefingPrompt(facts),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(TIMEOUT_MS),
        output: Output.object({
          schema: jsonSchema(AGENT_OFFICE_BRIEFING_SCHEMA as unknown as JSONSchema7),
          name: "agent_office_briefing",
        }),
        providerOptions: { openai: { strictJsonSchema: true } },
      });
      const usage = generated.usage as { inputTokens?: number; outputTokens?: number } | undefined;
      console.info(
        JSON.stringify({
          event: "agent_office_briefing_call",
          modelId: model.id,
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
        })
      );
      const briefing = parseAgentOfficeBriefing(generated.output);
      return briefing ? { briefing, modelId: model.id } : null;
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "agent_office_briefing_call_failed",
          modelId: model.id,
          error: error instanceof Error ? error.name : "unknown",
        })
      );
      return null;
    }
  };
}

export type AgentOfficeBriefingResult =
  | { kind: "off" }
  | { kind: "model_unavailable" }
  | { kind: "limit" }
  | { kind: "busy" }
  | { kind: "reused"; stored: StoredAgentOfficeBriefing }
  | { kind: "done"; stored: StoredAgentOfficeBriefing }
  | { kind: "failed" };

type Reservation = { kind: "reserved"; calls: number; claimId: string } | { kind: "limit" } | { kind: "busy" } | { kind: "reused"; stored: StoredAgentOfficeBriefing };

/**
 * Reserves one call under a lock every request takes: a fresh briefing is
 * reused, a claim in flight refuses, the day's count goes up, and the request
 * is audited, all in one transaction. A reservation is spent even if the call
 * then fails, as it may have been billed.
 */
async function reserve(input: { session: Session; request: Request; locale: BriefingLocale; modelId: string; now: Date }): Promise<Reservation> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('agent_office_briefing'))`;
    const rows = await tx.appSetting.findMany({
      where: { key: { in: [AGENT_OFFICE_BRIEFING_USAGE_KEY, AGENT_OFFICE_BRIEFING_LATEST_KEY] } },
      select: { key: true, value: true },
    });
    const value = (key: string) => rows.find((row) => row.key === key)?.value ?? null;
    const latest = parseStoredAgentOfficeBriefing(value(AGENT_OFFICE_BRIEFING_LATEST_KEY));
    if (latest && agentOfficeBriefingReusable(latest, input.locale, input.now.getTime())) return { kind: "reused", stored: latest };
    const day = agentOfficeBriefingDay(input.now);
    const usage = parseAgentOfficeBriefingUsage(value(AGENT_OFFICE_BRIEFING_USAGE_KEY), day);
    if (agentOfficeBriefingClaimHeld(usage.claim, input.now.getTime())) return { kind: "busy" };
    if (usage.unreadable || usage.calls >= AGENT_OFFICE_BRIEFING_PER_DAY) return { kind: "limit" };
    const calls = usage.calls + 1;
    const claimId = randomUUID();
    const next = JSON.stringify({ day, calls, claim: { id: claimId, until: new Date(input.now.getTime() + CLAIM_MS).toISOString() } });
    await tx.appSetting.upsert({
      where: { key: AGENT_OFFICE_BRIEFING_USAGE_KEY },
      create: { key: AGENT_OFFICE_BRIEFING_USAGE_KEY, value: next },
      update: { value: next },
    });
    await writeAdminAuditLog({
      tx,
      session: input.session,
      request: input.request,
      action: "agent_office.briefing_requested",
      targetType: "AppSettings",
      targetId: AGENT_OFFICE_BRIEFING_USAGE_KEY,
      summary: `Agent office briefing call ${calls} of ${AGENT_OFFICE_BRIEFING_PER_DAY} today`,
      metadata: { modelId: input.modelId, locale: input.locale, day, calls },
    });
    return { kind: "reserved", calls, claimId };
  });
}

/** The usage row as stored, or null when there is none or it cannot be read. */
async function readUsageRow(tx: Prisma.TransactionClient): Promise<Record<string, unknown> | null> {
  const row = await tx.appSetting.findUnique({ where: { key: AGENT_OFFICE_BRIEFING_USAGE_KEY }, select: { value: true } });
  try {
    return row ? (JSON.parse(row.value) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
const ownsClaim = (raw: Record<string, unknown> | null, claimId: string) =>
  (raw?.claim as { id?: unknown } | null | undefined)?.id === claimId;

/**
 * Right before the call: if this request still holds its claim, it is renewed
 * for CLAIM_MS from now; if not (it lapsed during the read and another request
 * took it), the call is not made.
 */
async function renew(claimId: string, now: Date): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('agent_office_briefing'))`;
    const raw = await readUsageRow(tx);
    if (!raw || !ownsClaim(raw, claimId)) return false;
    await tx.appSetting.update({
      where: { key: AGENT_OFFICE_BRIEFING_USAGE_KEY },
      data: { value: JSON.stringify({ ...raw, claim: { id: claimId, until: new Date(now.getTime() + CLAIM_MS).toISOString() } }) },
    });
    return true;
  });
}

/**
 * Ends this call's own claim and keeps the row's day and count as they are,
 * and stores the answer only while the claim was still this call's. A claim
 * another call holds, or a row that cannot be read, is left alone.
 */
async function release(claimId: string, stored: StoredAgentOfficeBriefing | null): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('agent_office_briefing'))`;
    const raw = await readUsageRow(tx);
    if (!raw || !ownsClaim(raw, claimId)) return;
    await tx.appSetting.update({
      where: { key: AGENT_OFFICE_BRIEFING_USAGE_KEY },
      data: { value: JSON.stringify({ ...raw, claim: null }) },
    });
    if (stored) {
      const value = JSON.stringify(stored);
      await tx.appSetting.upsert({
        where: { key: AGENT_OFFICE_BRIEFING_LATEST_KEY },
        create: { key: AGENT_OFFICE_BRIEFING_LATEST_KEY, value },
        update: { value },
      });
    }
  });
}

/** The caller checked the owner, a recent sign-in and the request's origin. */
export async function requestAgentOfficeBriefing(input: {
  session: Session;
  request: Request;
  locale: BriefingLocale;
  now?: () => Date;
  /** Replaces the configured model (tests). */
  llm?: AgentOfficeBriefingLlm | null;
  /** Replaces the office read (tests). */
  readFacts?: (now: Date) => Promise<AgentOfficeBriefingFacts>;
}): Promise<AgentOfficeBriefingResult> {
  if (!agentOfficeBriefingEnabled()) return { kind: "off" };
  const now = input.now ?? (() => new Date());
  const llm = input.llm === undefined ? await briefingLlmFromEnv() : input.llm;
  if (!llm) return { kind: "model_unavailable" };
  const reserved = await reserve({ session: input.session, request: input.request, locale: input.locale, modelId: configuredModelId(), now: now() });
  if (reserved.kind !== "reserved") return reserved;
  let stored: StoredAgentOfficeBriefing | null = null;
  try {
    const at = now();
    const read = input.readFacts
      ? input.readFacts(at)
      : readAgentOfficeLiveRooms(at, { owner: true }).then((live) => agentOfficeBriefingFacts(live, at));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const facts = await Promise.race([
      read,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), FACTS_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    if (facts && (await renew(reserved.claimId, now()))) {
      const answer = await llm({ facts, locale: input.locale });
      if (answer) stored = { at: at.toISOString(), locale: input.locale, modelId: answer.modelId, briefing: answer.briefing };
    }
  } finally {
    await release(reserved.claimId, stored);
  }
  return stored ? { kind: "done", stored } : { kind: "failed" };
}
