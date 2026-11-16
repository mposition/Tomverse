import "server-only";

import type { Prisma } from "@prisma/client";
import { auditRowActorKind,
  AMUX_V19_SESSION_BUDGET_RESOLVE_ACTION,
  AMUX_V19_SESSION_BUDGET_TARGET,
  AMUX_V4_ANALYSIS_BUDGET_SETTLE_ACTION,
  AMUX_V4_ANALYSIS_BUDGET_SETTLE_TARGET } from "@/lib/adminAuditSystemActors";
import { AMUX_V4_ANALYSIS_NAMESPACE } from "./ideaAnalysisBudgetCore.ts";
import { amuxInfraFailureRoutingEnabled } from "./infraFailureCore.ts";
import { AMUX_SESSION_SYSTEM_CLOSURE } from "./ideaSessionLateResult.ts";

/** One Agent-wide breaker across preview and direct-read CLI invocations.
 * Unknown and owner resolution are separate stops, not execution outcomes.
 *
 * Owner direction 2026-11-15 ("내부 개발용 Flow입니다. 제한을 줄 이유가
 * 없습니다."): three failures in a row stop only the paid API path, counted on
 * that path's own settlements. A subscription session is never stopped by a
 * failure streak; its next claim simply runs. A malformed recent audit row
 * still stops both (integrity, not a limit). With
 * TOMVERSE_AMUX_INFRA_FAILURE_ROUTING=disabled both paths share the old
 * breaker. */
export async function readAmuxIdeaAnalysisFailureStreak(
  tx: Prisma.TransactionClient,
  path: "paid" | "session" = "paid",
): Promise<"ready" | "stopped" | "integrity_unavailable"> {
  const pathOnly = amuxInfraFailureRoutingEnabled();
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
    const fields = details && typeof details === "object" && !Array.isArray(details)
      ? details as Record<string, unknown> : null;
    const status = fields?.status ?? null;
    // The system closes an unknown subscription claim at zero (operator,
    // 2026-11-16); that owner_consumed row is the system's, not an owner's.
    const systemClosure = status === "owner_consumed" &&
      fields?.closedBy === AMUX_SESSION_SYSTEM_CLOSURE &&
      fields.budgetMode === "max_shadow" && fields.verification === "not_proven";
    const expectedActor = ["failed", "succeeded", "outcome_unknown"].includes(
      String(status)) || systemClosure ? "system" : ["owner_consumed", "released"]
      .includes(String(status)) ? "human" : null;
    return !entry.entryHash || !expectedActor ||
      auditRowActorKind(entry) !== expectedActor ||
      (details as Record<string, unknown> | null)?.namespace !==
        AMUX_V4_ANALYSIS_NAMESPACE;
  })) return "integrity_unavailable";
  if (pathOnly && path === "session") return "ready";
  const latest = await tx.adminAuditLog.findMany({
    where: {
      OR: [
        { action: AMUX_V4_ANALYSIS_BUDGET_SETTLE_ACTION,
          targetType: AMUX_V4_ANALYSIS_BUDGET_SETTLE_TARGET },
        ...(pathOnly ? [] : [{ action: AMUX_V19_SESSION_BUDGET_RESOLVE_ACTION,
          targetType: AMUX_V19_SESSION_BUDGET_TARGET }]),
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
