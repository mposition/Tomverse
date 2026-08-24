/**
 * The approval a write-mode reconciliation run has to carry, checked before
 * anything is written.
 *
 * `--apply` on its own was the whole gate. That is enough for a command an
 * operator types once, deliberately, having read the runbook -- and not enough
 * for anything else: a copied command line, a "just run the maintenance
 * scripts" habit, or a scheduled job inheriting the flag all reach the same
 * `updateMany`, and it rewrites the model every affected account had chosen.
 *
 * Timing is the reason this is more than paperwork. Section 7 of
 * docs/policy/default-model-luna-migration.md says this script runs *with the
 * retirement deploy*, not before it: while gpt-5-4-mini is still enabled and
 * publicly listed it is a working model somebody may have picked on purpose,
 * and moving them off it is overriding a live choice rather than flattening a
 * stale pointer. Nothing in `--apply` expresses which of those two situations
 * the operator believes they are in. The fields below do, and they name a
 * person and a ticket the decision can be traced back to afterwards.
 *
 * Pure so it can be tested without a database. The one check that needs one --
 * that the model being moved off is actually retired -- takes the rows as an
 * argument rather than reading them, for the same reason.
 */

export type ReconciliationApproval = {
  apply: boolean;
  /** Explicit acknowledgement that this is the retirement deploy. */
  approvedRetirement: boolean;
  /** The ticket recording the retirement decision. */
  ticket: string | null;
  /** Who is running it. */
  actor: string | null;
  /** The model being moved off, and the model rows are moved to. */
  fromModelId: string | null;
  toModelId: string | null;
  /** Non-interactive contexts, where an --apply must never be honoured. */
  environment: {
    ci: boolean;
    /** A lifecycle hook: build, deploy, start, migrate, cron. */
    automatedHook: string | null;
  };
};

export type ApprovalProblem = {
  code:
    | "missing_approval_flag"
    | "missing_ticket"
    | "missing_actor"
    | "missing_target"
    | "same_target"
    | "from_unknown"
    | "from_not_retired"
    | "to_unknown"
    | "to_not_usable"
    | "automated_context";
  message: string;
};

/**
 * What the registry says about one of the two models named on the command line.
 *
 * A shape rather than a Prisma row so the rules below can be tested without a
 * database, and so the script stays the only place that knows how to read one.
 */
export type ReconciliationModelState = {
  modelId: string;
  /** False when no ModelRegistryEntry names this id at all. */
  found: boolean;
  enabled: boolean;
  publiclyListed: boolean;
  catalogDeleted: boolean;
};

/**
 * Environment variables that mean "this process was started by automation".
 * A reconciliation that runs itself is the failure this list exists to
 * prevent: it would move every account's stored model on the next deploy,
 * before anybody decided the model should be retired.
 */
export const AUTOMATED_CONTEXT_ENV_VARS = [
  "CI",
  "GITHUB_ACTIONS",
  "RAILWAY_DEPLOYMENT_ID",
  "VERCEL",
  "npm_lifecycle_event",
] as const;

/** Lifecycle events that must never reach a write. */
export const FORBIDDEN_LIFECYCLE_EVENTS = [
  "build",
  "prebuild",
  "postbuild",
  "start",
  "prestart",
  "poststart",
  "deploy",
  "predeploy",
  "postdeploy",
  "db:migrate",
  "postinstall",
] as const;

export const readReconciliationEnvironment = (
  env: Record<string, string | undefined>
): ReconciliationApproval["environment"] => {
  const lifecycle = env.npm_lifecycle_event?.trim() || "";
  return {
    ci: env.CI === "1" || env.CI === "true" || env.GITHUB_ACTIONS === "true",
    automatedHook: (FORBIDDEN_LIFECYCLE_EVENTS as readonly string[]).includes(
      lifecycle
    )
      ? lifecycle
      : null,
  };
};

/**
 * Everything wrong with a write-mode invocation. Empty means it may proceed.
 * A dry run is always allowed and never checked -- reporting what *would*
 * change is the safe half of this script and should stay one command away.
 */
export const findReconciliationApprovalProblems = (
  approval: ReconciliationApproval
): ApprovalProblem[] => {
  if (!approval.apply) return [];
  const problems: ApprovalProblem[] = [];

  if (approval.environment.automatedHook) {
    problems.push({
      code: "automated_context",
      message: `This process is an npm "${approval.environment.automatedHook}" lifecycle step. Reconciliation writes are an operator action taken with the retirement deploy, never a build, start, migration or cron side effect.`,
    });
  } else if (approval.environment.ci) {
    problems.push({
      code: "automated_context",
      message:
        "CI is set. A reconciliation write moves every affected account's stored model choice and is not something a pipeline decides.",
    });
  }

  if (!approval.approvedRetirement) {
    problems.push({
      code: "missing_approval_flag",
      message:
        `--approved-retirement is required. It states that ${approval.fromModelId ?? "the model being moved off"} is being retired in this same deploy; until it is, an account that named it named a model that still works.`,
    });
  }
  if (!approval.ticket) {
    problems.push({
      code: "missing_ticket",
      message:
        '--ticket="<url or id>" is required: the retirement decision this run implements.',
    });
  }
  if (!approval.actor) {
    problems.push({
      code: "missing_actor",
      message: '--actor="<who is running this>" is required.',
    });
  }
  if (!approval.fromModelId || !approval.toModelId) {
    problems.push({
      code: "missing_target",
      message:
        "--from=<model id> and --to=<model id> are required. Naming them is what makes a mistyped run fail instead of rewriting the wrong column.",
    });
  } else if (approval.fromModelId === approval.toModelId) {
    // Not a harmless no-op: every matching row would be "rewritten" to the
    // value it already holds, and each rewrite writes a ModelMigrationRecord.
    // The notice built from those records would then tell people their setting
    // moved to the model it was already on.
    problems.push({
      code: "same_target",
      message: `--from and --to both name ${approval.fromModelId}. There is nothing to move, and running it anyway would file a migration record per row saying otherwise.`,
    });
  }

  return problems;
};

/**
 * The precondition the policy states in prose and nothing checked.
 *
 * Section 7 of docs/policy/default-model-luna-migration.md says this runs *with
 * the retirement deploy*. Before ML-10 the only thing enforcing that was a pair
 * of constants in the script naming one specific migration -- which made the
 * timing rule true by accident for that migration and unavailable for the next
 * one. Reading the registry makes it a check: a model still enabled or still
 * listed is one somebody may have chosen on purpose, and moving them off it is
 * overriding a live choice.
 *
 * Separate from the approval problems above because the two fail for different
 * reasons: those are about what the operator supplied, these about what is
 * true in the database at the moment of the run.
 */
export const findReconciliationTargetProblems = (input: {
  apply: boolean;
  from: ReconciliationModelState;
  to: ReconciliationModelState;
}): { problems: ApprovalProblem[]; warnings: string[] } => {
  if (!input.apply) return { problems: [], warnings: [] };
  const problems: ApprovalProblem[] = [];
  const warnings: string[] = [];
  const { from, to } = input;

  if (!from.found) {
    // Fail closed. An absent row proves nothing about whether the model was
    // retired, and the whole point of this check is proof.
    problems.push({
      code: "from_unknown",
      message: `No ModelRegistryEntry names ${from.modelId}, so nothing here can show it was retired. A missing row is not evidence of a retirement.`,
    });
  } else if (from.enabled || from.publiclyListed) {
    problems.push({
      code: "from_not_retired",
      message:
        `${from.modelId} is still ${[
          from.enabled ? "enabled" : null,
          from.publiclyListed ? "publicly listed" : null,
        ]
          .filter(Boolean)
          .join(" and ")}. Retire it in this same deploy first; until then an account that named it named a model that still works, and rewriting its setting overrides a live choice.`,
    });
  }

  if (!to.found) {
    problems.push({
      code: "to_unknown",
      message: `No ModelRegistryEntry names ${to.modelId}. Moving accounts onto an id the registry does not know would replace one stale pointer with another.`,
    });
  } else if (!to.enabled || to.catalogDeleted) {
    problems.push({
      code: "to_not_usable",
      message: `${to.modelId} is ${to.catalogDeleted ? "deleted from the catalogue" : "disabled"}, so every account moved onto it would land on a model that cannot answer.`,
    });
  } else if (!to.publiclyListed) {
    // Not fatal: the model works, and an unlisted replacement can be a
    // deliberate choice. Loud, because the accounts moved onto it will not
    // find it in their own picker afterwards.
    warnings.push(
      `${to.modelId} is not publicly listed. Accounts moved onto it will not see it in the model picker.`
    );
  }

  return { problems, warnings };
};
