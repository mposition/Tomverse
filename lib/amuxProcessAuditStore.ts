// The app side of the AMUX process analysis agent (lib/amuxProcessAuditCore.ts
// says what it is). Three jobs:
//
// - the figures: deterministic, read-only SQL over the AMUX and engineering
//   tables for one window. Aggregates and card display keys only: no title,
//   body, brief, e-mail or free text a person wrote;
// - the controls: one AppSetting row (schedule on/off, cadence, "run now", the
//   claim of the run in flight);
// - the reports: stored once per run, older than 26 weeks removed in the same
//   transaction.
//
// Nothing here calls a model or spends money. Storing a report is not an
// audited action: it is an observation, and the audit chain is for decisions
// (the 2026-11-14 report's item 10). The owner's settings change is audited in
// its route, in the same transaction as the write.

import "server-only";

import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import {
  AMUX_PROCESS_AUDIT_CHANNEL,
  AMUX_PROCESS_AUDIT_RETENTION_DAYS,
  AMUX_PROCESS_AUDIT_SETTINGS_KEY,
  parseProcessAuditAnalysis,
  parseProcessAuditSettings,
  previousReportForPrompt,
  processAuditDue,
  processAuditRequestAfterRun,
  processAuditWindow,
  serializeProcessAuditSettings,
  type AmuxProcessAuditAnalysis,
  type AmuxProcessAuditDue,
  type AmuxProcessAuditSettings,
} from "./amuxProcessAuditCore";
import { readProcessAuditMetrics, type AmuxProcessAuditMetrics } from "./amuxProcessAuditMetrics";
import { prisma } from "./prisma";

type Db = Prisma.TransactionClient;

const STATEMENT_TIMEOUT_MS = "8000";
const TRANSACTION = { maxWait: 5_000, timeout: 60_000 } as const;
const DAY_MS = 24 * 60 * 60 * 1000;

const limitTransaction = (db: Db) =>
  db.$queryRaw`SELECT set_config('statement_timeout', ${STATEMENT_TIMEOUT_MS}, true),
    set_config('idle_in_transaction_session_timeout', '15000', true)`;

export async function readProcessAuditSettings(db: Db): Promise<AmuxProcessAuditSettings> {
  const row = await db.appSetting.findUnique({ where: { key: AMUX_PROCESS_AUDIT_SETTINGS_KEY }, select: { value: true } });
  return parseProcessAuditSettings(row?.value);
}

/** Locks the settings row (creating it) so two writers of it take turns. */
async function lockProcessAuditSettings(db: Db): Promise<AmuxProcessAuditSettings> {
  await db.$executeRaw`
    INSERT INTO "AppSetting" ("key", "value", "createdAt", "updatedAt")
    VALUES (${AMUX_PROCESS_AUDIT_SETTINGS_KEY}, ${serializeProcessAuditSettings(parseProcessAuditSettings(null))}, now(), now())
    ON CONFLICT ("key") DO NOTHING`;
  const rows = await db.$queryRaw<{ value: string }[]>`
    SELECT "value" FROM "AppSetting" WHERE "key" = ${AMUX_PROCESS_AUDIT_SETTINGS_KEY} FOR UPDATE`;
  return parseProcessAuditSettings(rows[0]?.value);
}

async function saveProcessAuditSettings(db: Db, settings: AmuxProcessAuditSettings): Promise<void> {
  await db.appSetting.update({
    where: { key: AMUX_PROCESS_AUDIT_SETTINGS_KEY },
    data: { value: serializeProcessAuditSettings(settings) },
  });
}

async function lastReportAt(db: Db): Promise<Date | null> {
  const row = await db.amuxProcessAuditReport.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  return row?.createdAt ?? null;
}

const dbNow = async (db: Db): Promise<Date> => {
  const rows = await db.$queryRaw<{ now: string }[]>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`;
  return new Date(rows[0]!.now);
};

export type ProcessAuditSettingsChange = {
  readonly enabled: boolean;
  readonly cadenceDays: number;
  readonly runNow: boolean;
};

/**
 * The owner's change, in the caller's transaction (which writes its audit
 * entry). Returns what was and what is, for that entry.
 */
export async function changeProcessAuditSettings(db: Db, change: ProcessAuditSettingsChange): Promise<{
  readonly before: AmuxProcessAuditSettings;
  readonly after: AmuxProcessAuditSettings;
}> {
  await limitTransaction(db);
  const before = await lockProcessAuditSettings(db);
  const now = await dbNow(db);
  const after: AmuxProcessAuditSettings = {
    ...before,
    enabled: change.enabled,
    cadenceDays: change.cadenceDays,
    runRequestedAt: change.runNow ? now.toISOString() : before.runRequestedAt,
  };
  await saveProcessAuditSettings(db, after);
  return { before, after };
}

export type ProcessAuditContext =
  | { readonly due: false; readonly reason: Extract<AmuxProcessAuditDue, { due: false }>["reason"] }
  | {
    readonly due: true;
    readonly trigger: Extract<AmuxProcessAuditDue, { due: true }>["trigger"];
    readonly token: string;
    readonly windowStart: string;
    readonly windowEnd: string;
    readonly metrics: AmuxProcessAuditMetrics;
    readonly previous: { readonly createdAt: string; readonly analysis: Omit<AmuxProcessAuditAnalysis, "markdown"> } | null;
  };

/**
 * The box's poll. Not due: nothing is written. Due: in one transaction under
 * the settings row's lock, the figures for the window are computed and the run
 * is claimed with them (token, window, trigger, figures), so the report stores
 * exactly the figures the model was given.
 */
export async function claimProcessAuditRun(): Promise<ProcessAuditContext> {
  return prisma.$transaction(async (db) => {
    await limitTransaction(db);
    const settings = await lockProcessAuditSettings(db);
    const now = await dbNow(db);
    const due = processAuditDue({ settings, lastReportAt: await lastReportAt(db), now });
    if (!due.due) return { due: false, reason: due.reason };
    const window = processAuditWindow(now);
    const metrics = await readProcessAuditMetrics(db, window);
    const claim = {
      token: randomUUID(),
      at: now.toISOString(),
      windowStart: window.start.toISOString(),
      windowEnd: window.end.toISOString(),
      trigger: due.trigger,
      metrics,
    };
    await saveProcessAuditSettings(db, { ...settings, claim });
    const last = await db.amuxProcessAuditReport.findFirst({
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, analysis: true },
    });
    const analysis = last ? parseProcessAuditAnalysis(last.analysis) : null;
    return {
      due: true,
      trigger: due.trigger,
      token: claim.token,
      windowStart: claim.windowStart,
      windowEnd: claim.windowEnd,
      metrics,
      // Its conclusions, not its prose.
      previous: last && analysis ? { createdAt: last.createdAt.toISOString(), analysis: previousReportForPrompt(analysis) } : null,
    };
  }, TRANSACTION);
}

export class ProcessAuditReportRefused extends Error {
  constructor(readonly code: "no_claim" | "invalid_analysis") {
    super(code);
  }
}

/**
 * One finished run. The token must be the claim in flight, so a late or
 * repeated post stores nothing. The figures are the claim's own snapshot, the
 * ones the model was given: the box never supplies them. The claim is cleared,
 * and so is a "run now" this run answered (one made during the run stays for
 * the next poll); reports past the retention are removed.
 */
export async function recordProcessAuditReport(input: {
  readonly token: string;
  readonly developSha: string;
  readonly model: string | null;
  readonly analysis: unknown;
}): Promise<{ readonly id: string; readonly removed: number }> {
  const analysis = parseProcessAuditAnalysis(input.analysis);
  if (analysis === null) throw new ProcessAuditReportRefused("invalid_analysis");
  return prisma.$transaction(async (db) => {
    await limitTransaction(db);
    const settings = await lockProcessAuditSettings(db);
    const claim = settings.claim;
    if (claim === null || claim.token !== input.token) throw new ProcessAuditReportRefused("no_claim");
    const window = { start: new Date(claim.windowStart), end: new Date(claim.windowEnd) };
    const now = await dbNow(db);
    const created = await db.amuxProcessAuditReport.create({
      data: {
        windowStart: window.start,
        windowEnd: window.end,
        developSha: input.developSha,
        channel: AMUX_PROCESS_AUDIT_CHANNEL,
        model: input.model,
        trigger: claim.trigger,
        metrics: claim.metrics as Prisma.InputJsonValue,
        analysis: analysis as unknown as Prisma.InputJsonValue,
        markdown: analysis.markdown,
      },
      select: { id: true },
    });
    const removed = await db.amuxProcessAuditReport.deleteMany({
      where: { createdAt: { lt: new Date(now.getTime() - AMUX_PROCESS_AUDIT_RETENTION_DAYS * DAY_MS) } },
    });
    await saveProcessAuditSettings(db, {
      ...settings,
      claim: null,
      runRequestedAt: processAuditRequestAfterRun(settings.runRequestedAt, claim),
    });
    return { id: created.id, removed: removed.count };
  }, TRANSACTION);
}

export type ProcessAuditReportSummary = {
  readonly id: string;
  readonly createdAt: Date;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly developSha: string;
  readonly model: string | null;
  readonly trigger: string;
  readonly headline: string;
};

export type ProcessAuditAdminView = {
  readonly settings: AmuxProcessAuditSettings;
  readonly reports: readonly ProcessAuditReportSummary[];
  readonly selected: (ProcessAuditReportSummary & { readonly analysis: AmuxProcessAuditAnalysis | null; readonly markdown: string }) | null;
};

/** The Admin tab: the controls, the list of reports and one report (the latest, or the one asked for). */
export async function readProcessAuditForAdmin(reportId: string | null): Promise<ProcessAuditAdminView> {
  return prisma.$transaction(async (db) => {
    await db.$executeRaw`SET TRANSACTION READ ONLY`;
    await limitTransaction(db);
    const settings = await readProcessAuditSettings(db);
    const rows = await db.amuxProcessAuditReport.findMany({
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { id: true, createdAt: true, windowStart: true, windowEnd: true, developSha: true, model: true, trigger: true, analysis: true },
    });
    const reports = rows.map((row) => ({
      id: row.id, createdAt: row.createdAt, windowStart: row.windowStart, windowEnd: row.windowEnd,
      developSha: row.developSha, model: row.model, trigger: row.trigger,
      headline: parseProcessAuditAnalysis(row.analysis)?.headline ?? "",
    }));
    const wanted = reportId ?? reports[0]?.id ?? null;
    const full = wanted === null ? null : await db.amuxProcessAuditReport.findUnique({
      where: { id: wanted },
      select: { id: true, createdAt: true, windowStart: true, windowEnd: true, developSha: true, model: true, trigger: true, analysis: true, markdown: true },
    });
    const analysis = full ? parseProcessAuditAnalysis(full.analysis) : null;
    return {
      settings,
      reports,
      selected: full ? {
        id: full.id, createdAt: full.createdAt, windowStart: full.windowStart, windowEnd: full.windowEnd,
        developSha: full.developSha, model: full.model, trigger: full.trigger,
        headline: analysis?.headline ?? "", analysis, markdown: full.markdown,
      } : null,
    };
  }, TRANSACTION);
}
