/**
 * The engineering agent's registration sources and caps, kept for the
 * EngineeringAgentRegistration table that holds earlier registrations: its
 * source CHECK (scripts/check-enum-constraints.mjs) and its cap triggers
 * (tests/engineeringAgentSchema.test.mjs) are compared against these.
 *
 * Nothing registers any more. The path that read the shared backlog, develop
 * CI and Dependabot failures and asked a model to propose AMUX backlog cards
 * never had a caller, and it was removed on 2026-11-06: a red develop head
 * now goes to the AMUX idea lane as one idea (lib/developCiRepair.ts), and a
 * failing Dependabot PR to the PR CI auto-fix.
 */

/* ------------------------------------------------------------------------- */
/* Sources and caps                                                           */
/* ------------------------------------------------------------------------- */

/**
 * The registration sources, and nothing else. Adding or changing one is a
 * revision of the policy, which the agent cannot make.
 */
export const REGISTRATION_SOURCES = {
  S1: {
    kind: "shared_backlog",
    branch: "codex/product-idea-backlog-2026-09-15",
    path: ".github/audits/tomverse-product-idea-backlog.md",
  },
  S2: { kind: "develop_ci_failure", branch: "develop" },
  S3: { kind: "dependabot_failure" },
} as const;
export type RegistrationSource = keyof typeof REGISTRATION_SOURCES;

/** The source ids as a list, for the database's CHECK to be compared against. */
export const REGISTRATION_SOURCE_IDS = Object.keys(REGISTRATION_SOURCES) as RegistrationSource[];

/** Fixed by the policy (§2.2); changing them is a revision. */
export const REGISTRATION_CAPS = {
  perRound: 3,
  perUtcDay: 10,
  unpromoted: 20,
} as const;

export const REGISTRAR_SYSTEM_ACTOR = "engineering-agent-registrar";
