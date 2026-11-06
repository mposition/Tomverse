/**
 * A red develop head becomes one SEV1 idea for the AMUX idea lane, on the
 * fifteen-minute maintenance cron (lib/developCiRepairCore.ts decides).
 *
 * Off by default. The Admin console holds one switch, saved with the owner who
 * turned it on: that owner is the ideas' data owner, under a system audit
 * entry, and the pass stops when that account stops being an owner. The pass
 * itself calls no model: the lane's coding run reads the failure and fixes it,
 * within the lane's own attempt and daily limits, and a person merges its PR.
 *
 * Never throws, so it cannot disturb the cron it rides on.
 */
import "server-only";

import type { Session } from "next-auth";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import { isAdminOwnerAccount } from "@/lib/adminAuth";
import { AMUX_IDEA_INPUT_MAX_BYTES } from "@/lib/amux/ideaInputCore";
import { amuxIdeaLaneEnabled, amuxIdeaLaneState } from "@/lib/amux/ideaLaneCore";
import { inspectAmuxIdeaSubmission } from "@/lib/amux/ideaSubmissionCore";
import { submitSystemIdea } from "@/lib/amux/ideaTraceReportSubmissionService";
import {
  DEVELOP_CI_REPAIR_MAX_JOBS,
  DEVELOP_CI_REPAIR_MODE_SETTING_KEY,
  DEVELOP_CI_REPAIR_STATE_SETTING_KEY,
  decideDevelopCiRepair,
  developCiLogTail,
  developCiRepairIdea,
  developCiRepairRequestId,
  parseDevelopCiRepairMode,
  readDevelopCiRepairState,
  type DevelopCheckRun,
  type DevelopCiRepairMode,
  type DevelopCiRepairState,
} from "@/lib/developCiRepairCore";
import {
  ENGINEERING_AGENT_GITHUB_READ_TOKEN_ENV,
  readEngineeringAgentDevelopChecks,
} from "@/lib/engineeringAgentGitHubRead";
import { prisma } from "@/lib/prisma";

const LOG_TIMEOUT_MS = 15_000;
/** The rolling tail kept while a job log streams in; only its end is used. */
const LOG_KEEP_BYTES = 64 * 1024;

export const readDevelopCiRepairMode = async (): Promise<DevelopCiRepairMode> => {
  const row = await prisma.appSetting.findUnique({
    where: { key: DEVELOP_CI_REPAIR_MODE_SETTING_KEY },
    select: { value: true },
  });
  return parseDevelopCiRepairMode(row?.value);
};

/** The caller checked the owner and a recent sign-in. */
export const writeDevelopCiRepairMode = async (input: { session: Session; request: Request; enabled: boolean }) => {
  const userId = input.session.user?.id;
  if (!userId) throw new Error("develop_ci_repair_mode_needs_a_user");
  const value = input.enabled ? `on:${userId}` : "off";
  await prisma.$transaction(async (tx) => {
    await tx.appSetting.upsert({
      where: { key: DEVELOP_CI_REPAIR_MODE_SETTING_KEY },
      create: { key: DEVELOP_CI_REPAIR_MODE_SETTING_KEY, value },
      update: { value },
    });
    await writeAdminAuditLog({
      tx,
      session: input.session,
      request: input.request,
      action: "develop_ci_repair.mode_updated",
      targetType: "AppSettings",
      targetId: DEVELOP_CI_REPAIR_MODE_SETTING_KEY,
      summary: `Develop CI repair turned ${input.enabled ? "on" : "off"}`,
      metadata: { enabled: input.enabled },
    });
  });
  return { enabled: input.enabled };
};

/**
 * The end of one Actions job log. GitHub answers with a redirect to a signed
 * blob URL; the stream is read to its end keeping only the last bytes, so a
 * long log costs memory for its tail only. Null when it cannot be read.
 */
export const readDevelopJobLogTail = async (
  jobId: number,
  deps: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<string | null> => {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const token = env[ENGINEERING_AGENT_GITHUB_READ_TOKEN_ENV]?.trim();
  if (!token || !Number.isSafeInteger(jobId) || jobId <= 0) return null;
  try {
    const response = await fetchImpl(`https://api.github.com/repos/mposition/Tomverse/actions/jobs/${jobId}/logs`, {
      method: "GET",
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(LOG_TIMEOUT_MS),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const reader = response.body.getReader();
    let kept = new Uint8Array(0);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const joined = new Uint8Array(kept.byteLength + value.byteLength);
      joined.set(kept, 0);
      joined.set(value, kept.byteLength);
      kept = joined.byteLength > LOG_KEEP_BYTES ? joined.slice(joined.byteLength - LOG_KEEP_BYTES) : joined;
    }
    // A cut may split a character at the start; the decoder replaces only that one.
    return developCiLogTail(new TextDecoder("utf-8").decode(kept));
  } catch {
    return null;
  }
};

/** Whether the last repair idea still waits, runs or holds an open PR. */
export const developCiRepairInFlight = async (ideaId: string | null, nowMs: number): Promise<boolean> => {
  if (!ideaId) return false;
  const idea = await prisma.amuxIdeaSubmission.findUnique({
    where: { id: ideaId },
    select: {
      state: true,
      cancelledAt: true,
      laneAttempts: {
        select: { claimedAt: true, leaseUntil: true, outcome: true, prNumber: true, mergedAt: true, prClosedAt: true, continues: true },
      },
    },
  });
  if (!idea || idea.state !== "submitted" || idea.cancelledAt) return false;
  const state = amuxIdeaLaneState(
    idea.laneAttempts.map((attempt) => ({
      claimedAtMs: attempt.claimedAt.getTime(),
      leaseUntilMs: attempt.leaseUntil.getTime(),
      outcome: attempt.outcome,
      prNumber: attempt.prNumber,
      mergedAtMs: attempt.mergedAt?.getTime() ?? null,
      prClosedAtMs: attempt.prClosedAt?.getTime() ?? null,
      continues: attempt.continues,
    })),
    nowMs,
  );
  return state === null || state.state === "queued" || state.state === "running" || state.state === "pr_open";
};

const writeState = (state: DevelopCiRepairState) => {
  const value = JSON.stringify(state);
  return prisma.appSetting.upsert({
    where: { key: DEVELOP_CI_REPAIR_STATE_SETTING_KEY },
    create: { key: DEVELOP_CI_REPAIR_STATE_SETTING_KEY, value },
    update: { value },
  });
};

export type DevelopCiRepairPass = {
  outcome: "off" | "owner_gone" | "lane_off" | "unreadable" | "none" | "submitted" | "failed";
  reason?: string;
  ideaId?: string;
};

export type DevelopCiRepairSubmit = (input: {
  ownerUserId: string;
  headSha: string;
  idea: string;
  checks: number;
}) => Promise<{ ideaId: string }>;

export const submitDevelopCiRepair: DevelopCiRepairSubmit = async ({ ownerUserId, headSha, idea, checks }) => {
  const requestId = developCiRepairRequestId(headSha);
  const inspected = inspectAmuxIdeaSubmission(
    JSON.stringify({ version: 1, requestId, input: { version: 1, idea, repositories: [], pullRequests: [] } }),
  );
  if (!inspected.ok) throw new Error(`develop_ci_repair_idea_refused_${inspected.code}`);
  return submitSystemIdea({
    source: "develop-ci-repair",
    ownerUserId,
    inspected,
    metadata: { headSha, checks },
  });
};

export const runDevelopCiRepairQuietly = async ({
  readChecks = () => readEngineeringAgentDevelopChecks(),
  readLogTail = (jobId: number) => readDevelopJobLogTail(jobId),
  submit = submitDevelopCiRepair,
  laneEnabled = () => amuxIdeaLaneEnabled(process.env),
  now = new Date(),
}: {
  readChecks?: () => Promise<{ headSha: string; checkRuns: DevelopCheckRun[] }>;
  readLogTail?: (jobId: number) => Promise<string | null>;
  submit?: DevelopCiRepairSubmit;
  laneEnabled?: () => boolean;
  now?: Date;
} = {}): Promise<DevelopCiRepairPass> => {
  const report = (pass: DevelopCiRepairPass) => {
    if (pass.outcome !== "off") console.info(JSON.stringify({ event: "develop_ci_repair_pass", ...pass }));
    return pass;
  };
  try {
    const mode = await readDevelopCiRepairMode();
    if (mode.mode === "off") return report({ outcome: "off" });
    const owner = await prisma.user.findUnique({ where: { id: mode.ownerUserId }, select: { id: true, email: true } });
    if (!owner || !isAdminOwnerAccount(owner)) return report({ outcome: "owner_gone" });
    // Without the lane an idea would only wait; nothing is spent or stored.
    if (!laneEnabled()) return report({ outcome: "lane_off" });
    let observed: { headSha: string; checkRuns: DevelopCheckRun[] };
    try {
      observed = await readChecks();
    } catch (error) {
      return report({ outcome: "unreadable", reason: error instanceof Error ? error.message : "unknown" });
    }
    const stateRow = await prisma.appSetting.findUnique({
      where: { key: DEVELOP_CI_REPAIR_STATE_SETTING_KEY },
      select: { value: true },
    });
    const state = readDevelopCiRepairState(stateRow?.value);
    const decision = decideDevelopCiRepair({
      state,
      headSha: observed.headSha,
      checkRuns: observed.checkRuns,
      repairInFlight: await developCiRepairInFlight(state.lastIdeaId, now.getTime()),
      now,
    });
    if (decision.action === "none") {
      if (JSON.stringify(decision.state) !== JSON.stringify(state)) await writeState(decision.state);
      return report({ outcome: "none", reason: decision.reason });
    }
    const jobs = decision.checks.slice(0, DEVELOP_CI_REPAIR_MAX_JOBS);
    const tails = await Promise.all(jobs.map((check) => readLogTail(check.id).catch(() => null)));
    const idea = developCiRepairIdea({
      headSha: decision.headSha,
      checks: jobs.map((check, index) => ({ ...check, logTail: tails[index] ?? null })),
      maxBytes: AMUX_IDEA_INPUT_MAX_BYTES,
    });
    const { ideaId } = await submit({ ownerUserId: owner.id, headSha: decision.headSha, idea, checks: decision.checks.length });
    await writeState({
      ...decision.state,
      submitted: decision.state.submitted + 1,
      lastIdeaId: ideaId,
      lastHeadSha: decision.headSha,
    });
    return report({ outcome: "submitted", ideaId });
  } catch (error) {
    return report({ outcome: "failed", reason: error instanceof Error ? error.name : "unknown" });
  }
};
