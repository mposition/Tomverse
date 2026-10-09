import "server-only";

import { prisma } from "@/lib/prisma";
import { qaReleaseDigestSchema } from "@/lib/qaReleaseDigestSchemaCore";
import { QA_RELEASE_SECRET_ROTATION_FIELDS } from "@/lib/qaReleaseOperatorControlFields";
import { qaReleaseDeployObservation } from "@/lib/qaReleaseMergeLaneReportCore";
import { readLatestQaReleaseOperatorControl } from "@/lib/qaReleaseOperatorControlStore";

/**
 * The read side of the common Agent digest area in the Admin Console
 * (docs/policy/qa-release-agent.md section 4). Reading takes ordinary admin
 * authentication, which the console layout has established; recording a
 * control revision is its own route, and `canWrite` only decides whether
 * this viewer is offered the form.
 *
 * Counts, dates and codes only: the stored digest has no free text, and this
 * reader re-parses it with the closed schema, so a body that no longer parses
 * is shown as unreadable rather than half-rendered.
 */

/** How many recent digests the screen lists; the screen says so. */
export const AGENT_DIGEST_CONSOLE_LIMIT = 14;

export type AgentDigestConsoleRow = {
  id: string;
  digestDate: string | null;
  createdAt: string;
  sizeBytes: number;
  payloadSha256: string;
  body: "present" | "expired" | "unreadable";
  summary: {
    gatesByVerdict: Record<string, number>;
    issueCandidates: number;
    issueBlocked: number;
    issuesAvailable: boolean;
    failedChecks: number;
    failedCiJobs: number;
    notChecked: string[];
  } | null;
};

export type AgentDigestConsole = {
  limit: number;
  /** Owner or ops (ops:write): whether this viewer is offered the control form. */
  canWrite: boolean;
  control: {
    revision: number;
    digestEnabled: boolean;
    mergeLaneEnabled: boolean;
    developLaneOn: boolean;
    iacCommit: string | null;
    createdAt: string;
    /** Rotation times only, never a secret's value. */
    rotatedAt: Record<string, string | null>;
  } | null;
  digests: AgentDigestConsoleRow[];
  /**
   * The develop merge lane: its latch, the attempt the latch names (which a
   * failed deploy has already closed) and the attempt the lane holds open.
   */
  mergeLane: {
    latched: boolean;
    latch: { sequence: number; reason: string | null; createdAt: string; attemptId: string | null } | null;
    latchAttempt: QaReleaseConsoleAttempt | null;
    openAttempt: QaReleaseConsoleAttempt | null;
  };
};

export type QaReleaseConsoleAttempt = {
  id: string;
  state: string;
  pullRequestNumber: number;
  headSha: string;
  mergeCommitSha: string | null;
  issuedAt: string;
  outcome: string | null;
  /** The staging deployments the lane last observed, re-checked against the closed shape. */
  deployObservation: { service: string; status: string; commitSha: string | null }[] | null;
  deployObservedAt: string | null;
};

const ATTEMPT_SELECT = {
        id: true,
        state: true,
        outcome: true,
        pullRequestNumber: true,
        headSha: true,
        mergeCommitSha: true,
        issuedAt: true,
        deployObservation: true,
        deployObservedAt: true,
      } as const;

type AttemptRow = {
  id: string;
  state: string;
  outcome: string | null;
  pullRequestNumber: number;
  headSha: string;
  mergeCommitSha: string | null;
  issuedAt: Date;
  deployObservation: unknown;
  deployObservedAt: Date | null;
};

const toConsoleAttempt = (row: AttemptRow): QaReleaseConsoleAttempt => ({
  id: row.id,
  state: row.state,
  outcome: row.outcome,
  pullRequestNumber: row.pullRequestNumber,
  headSha: row.headSha,
  mergeCommitSha: row.mergeCommitSha,
  issuedAt: row.issuedAt.toISOString(),
  deployObservation: qaReleaseDeployObservation(row.deployObservation),
  deployObservedAt: row.deployObservedAt?.toISOString() ?? null,
});

export async function readAgentDigestConsole(canWrite: boolean): Promise<AgentDigestConsole> {
  const [control, rows, latch, openAttempt] = await Promise.all([
    readLatestQaReleaseOperatorControl(),
    prisma.agentDigestItem.findMany({
      where: { agentKey: "qa-release" },
      orderBy: { createdAt: "desc" },
      take: AGENT_DIGEST_CONSOLE_LIMIT,
      select: { id: true, createdAt: true, sizeBytes: true, payloadSha256: true, payload: true },
    }),
    prisma.qaReleaseMergeLaneLatch.findFirst({
      orderBy: { sequence: "desc" },
      select: { sequence: true, latched: true, reason: true, createdAt: true, attemptId: true },
    }),
    prisma.qaReleaseMergeAttempt.findFirst({
      where: { state: { in: ["issued", "consumed", "awaiting_deploy"] } },
      select: ATTEMPT_SELECT,
    }),
  ]);

  // The attempt the newest latch event names: a failed deploy closed it, so
  // it is not the open one, and it is what the latch alert sends a person to.
  const latchAttempt = latch?.attemptId
    ? await prisma.qaReleaseMergeAttempt.findUnique({ where: { id: latch.attemptId }, select: ATTEMPT_SELECT })
    : null;

  const digests = rows.map((row): AgentDigestConsoleRow => {
    const base = {
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      sizeBytes: row.sizeBytes,
      payloadSha256: row.payloadSha256,
    };
    if (row.payload === null) return { ...base, digestDate: null, body: "expired", summary: null };
    const parsed = qaReleaseDigestSchema.safeParse(row.payload);
    if (!parsed.success) return { ...base, digestDate: null, body: "unreadable", summary: null };
    const digest = parsed.data;
    return {
      ...base,
      digestDate: digest.digestDate,
      body: "present",
      summary: {
        gatesByVerdict: { ...digest.gates.byVerdict },
        issueCandidates: digest.issues.byVerdict.open_work,
        issueBlocked: digest.issues.byVerdict.blocked,
        issuesAvailable: digest.issues.status === "ok",
        failedChecks: digest.checks.filter((check) => check.result === "fail").length,
        failedCiJobs: digest.ci.filter((job) => job.label !== null).length,
        notChecked: [...digest.notChecked],
      },
    };
  });

  return {
    limit: AGENT_DIGEST_CONSOLE_LIMIT,
    canWrite,
    control: control && {
      revision: control.revision,
      digestEnabled: control.digestEnabled,
      mergeLaneEnabled: control.mergeLaneEnabled,
      developLaneOn: control.developLaneOn,
      iacCommit: control.iacCommit,
      createdAt: control.createdAt.toISOString(),
      rotatedAt: Object.fromEntries(
        QA_RELEASE_SECRET_ROTATION_FIELDS.map((field) => [field, control[field]?.toISOString() ?? null]),
      ),
    },
    digests,
    mergeLane: {
      latched: latch?.latched === true,
      latch: latch && {
        sequence: latch.sequence,
        reason: latch.reason,
        createdAt: latch.createdAt.toISOString(),
        attemptId: latch.attemptId,
      },
      latchAttempt: latchAttempt && toConsoleAttempt(latchAttempt),
      openAttempt: openAttempt && toConsoleAttempt(openAttempt),
    },
  };
}
