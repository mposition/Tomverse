import { writeSystemAuditLogEntry } from "@/lib/adminAudit";
import { AMUX_V4_IDEA_SYSTEM_ACTOR } from "@/lib/adminAuditSystemActors";

/** Keep v4 housekeeping separate from owner decision audit call sites. */
export function writeAmuxV4UnitHousekeepingAudit(
  input: Omit<Parameters<typeof writeSystemAuditLogEntry>[0], "systemActor">,
) {
  return writeSystemAuditLogEntry({ ...input, systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR });
}
