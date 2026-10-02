import { AMUX_V4_IDEA_SYSTEM_ACTOR } from "./ideaIdentityCore.ts";

export function matchesInitialPlanSystemAudit(metadata: unknown, manifestDigest: string): boolean {
  return metadata !== null && typeof metadata === "object" && !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>).systemActor === AMUX_V4_IDEA_SYSTEM_ACTOR &&
    (metadata as Record<string, unknown>).manifestDigest === manifestDigest;
}
