/** Approved v4 identity. These names do not grant audit or execution rights. */
// Distinct from the v1-v3 source namespace; a registered v4 card names this source.
export const AMUX_V4_IDEA_SOURCE_SYSTEM = "admin-idea-v4" as const;
// The analysis agent family is shared with earlier intake, not a system audit actor.
export const AMUX_V4_IDEA_AGENT_ID = "amux-intake" as const;
// The first scoped action is source-plan creation. Any later expiry action
// needs its own reviewed scope; this actor never authorizes worker promotion.
export { AMUX_V4_IDEA_SYSTEM_ACTOR } from "../adminAuditSystemActors.ts";
