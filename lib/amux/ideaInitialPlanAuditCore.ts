import { auditRowActorKind, AMUX_V4_IDEA_SYSTEM_ACTOR } from "@/lib/adminAuditSystemActors";

export function matchesInitialPlanSystemAudit(
  row: Parameters<typeof auditRowActorKind>[0], manifestDigest: string,
): boolean {
  const metadata = row.metadata;
  return metadata !== null && typeof metadata === "object" && !Array.isArray(metadata) &&
    auditRowActorKind(row) === "system" &&
    (metadata as Record<string, unknown>).systemActor === AMUX_V4_IDEA_SYSTEM_ACTOR &&
    (metadata as Record<string, unknown>).manifestDigest === manifestDigest;
}
