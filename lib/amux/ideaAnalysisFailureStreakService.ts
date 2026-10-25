import "server-only";

import type { Prisma } from "@prisma/client";
import { auditRowActorKind,
  AMUX_V19_SESSION_BUDGET_RESOLVE_ACTION,
  AMUX_V19_SESSION_BUDGET_TARGET,
  AMUX_V4_ANALYSIS_BUDGET_SETTLE_ACTION,
  AMUX_V4_ANALYSIS_BUDGET_SETTLE_TARGET } from "@/lib/adminAuditSystemActors";
import { AMUX_V4_ANALYSIS_NAMESPACE } from "./ideaAnalysisBudgetCore.ts";

/** One Agent-wide breaker across preview and direct-read CLI invocations.
 * Unknown and owner resolution are separate stops, not execution outcomes. */
export async function readAmuxIdeaAnalysisFailureStreak(
  tx: Prisma.TransactionClient,
): Promise<"ready" | "stopped" | "integrity_unavailable"> {
  // Preserve the v4 fail-closed check: filtering terminal outcomes below must
  // not hide a malformed recent v4 settlement behind older audit entries.
  const recentV4 = await tx.adminAuditLog.findMany({
    where: { action: AMUX_V4_ANALYSIS_BUDGET_SETTLE_ACTION,
      targetType: AMUX_V4_ANALYSIS_BUDGET_SETTLE_TARGET },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 3,
  });
  if (recentV4.some((entry) => {
    const details = entry.metadata;
    return !entry.entryHash || auditRowActorKind(entry) !== "system" ||
      !details || typeof details !== "object" || Array.isArray(details) ||
      (details as Record<string, unknown>).namespace !==
        AMUX_V4_ANALYSIS_NAMESPACE ||
      !["failed", "succeeded"].includes(String(
        (details as Record<string, unknown>).status));
  })) return "integrity_unavailable";
  // v19's resolve action also carries unknown/owner decisions. Those do not
  // count as execution outcomes, but malformed recent records still halt.
  const recentSession = await tx.adminAuditLog.findMany({
    where: { action: AMUX_V19_SESSION_BUDGET_RESOLVE_ACTION,
      targetType: AMUX_V19_SESSION_BUDGET_TARGET },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 3,
  });
  if (recentSession.some((entry) => {
    const details = entry.metadata;
    const status = details && typeof details === "object" && !Array.isArray(details)
      ? (details as Record<string, unknown>).status : null;
    const expectedActor = ["failed", "succeeded", "outcome_unknown"].includes(
      String(status)) ? "system" : ["owner_consumed", "released"].includes(
      String(status)) ? "human" : null;
    return !entry.entryHash || !expectedActor ||
      auditRowActorKind(entry) !== expectedActor ||
      (details as Record<string, unknown> | null)?.namespace !==
        AMUX_V4_ANALYSIS_NAMESPACE;
  })) return "integrity_unavailable";
  const latest = await tx.adminAuditLog.findMany({
    where: {
      OR: [
        { action: AMUX_V4_ANALYSIS_BUDGET_SETTLE_ACTION,
          targetType: AMUX_V4_ANALYSIS_BUDGET_SETTLE_TARGET },
        { action: AMUX_V19_SESSION_BUDGET_RESOLVE_ACTION,
          targetType: AMUX_V19_SESSION_BUDGET_TARGET },
      ],
      AND: [{ OR: [
        { metadata: { path: ["status"], equals: "failed" } },
        { metadata: { path: ["status"], equals: "succeeded" } },
      ] }],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 3,
  });
  if (latest.some((entry) => {
    const details = entry.metadata;
    return !entry.entryHash || auditRowActorKind(entry) !== "system" ||
      !details || typeof details !== "object" || Array.isArray(details) ||
      (details as Record<string, unknown>).namespace !==
        AMUX_V4_ANALYSIS_NAMESPACE ||
      !["failed", "succeeded"].includes(String(
        (details as Record<string, unknown>).status));
  })) return "integrity_unavailable";
  return latest.length === 3 && latest.every((entry) =>
    (entry.metadata as Record<string, unknown>).status === "failed")
    ? "stopped" : "ready";
}
