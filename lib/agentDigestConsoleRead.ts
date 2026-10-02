import "server-only";

import { prisma } from "@/lib/prisma";
import { qaReleaseDigestSchema } from "@/lib/qaReleaseDigestSchemaCore";
import { readLatestQaReleaseOperatorControl } from "@/lib/qaReleaseOperatorControlStore";

/**
 * The read side of the common Agent digest area in the Admin Console
 * (docs/policy/qa-release-agent.md section 4). Reading takes ordinary admin
 * authentication, which the console layout has established; this slice has
 * no control on it.
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
  control: {
    revision: number;
    digestEnabled: boolean;
    mergeLaneEnabled: boolean;
    developLaneOn: boolean;
    iacCommit: string | null;
    createdAt: string;
  } | null;
  digests: AgentDigestConsoleRow[];
};

export async function readAgentDigestConsole(): Promise<AgentDigestConsole> {
  const [control, rows] = await Promise.all([
    readLatestQaReleaseOperatorControl(),
    prisma.agentDigestItem.findMany({
      where: { agentKey: "qa-release" },
      orderBy: { createdAt: "desc" },
      take: AGENT_DIGEST_CONSOLE_LIMIT,
      select: { id: true, createdAt: true, sizeBytes: true, payloadSha256: true, payload: true },
    }),
  ]);

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
    control: control && {
      revision: control.revision,
      digestEnabled: control.digestEnabled,
      mergeLaneEnabled: control.mergeLaneEnabled,
      developLaneOn: control.developLaneOn,
      iacCommit: control.iacCommit,
      createdAt: control.createdAt.toISOString(),
    },
    digests,
  };
}
