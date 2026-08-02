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
 * Pure so it can be tested without a database.
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
    | "target_mismatch"
    | "automated_context";
  message: string;
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
  approval: ReconciliationApproval,
  expected: { fromModelId: string; toModelId: string }
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
        "--approved-retirement is required. It states that gpt-5-4-mini is being retired in this same deploy; until it is, an account that named it named a model that still works.",
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
  } else if (
    approval.fromModelId !== expected.fromModelId ||
    approval.toModelId !== expected.toModelId
  ) {
    problems.push({
      code: "target_mismatch",
      message: `This script moves ${expected.fromModelId} to ${expected.toModelId}; it was asked to move ${approval.fromModelId} to ${approval.toModelId}.`,
    });
  }

  return problems;
};
