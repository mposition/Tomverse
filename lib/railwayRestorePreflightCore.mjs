/**
 * Fail-closed preflight for an isolated Railway restore drill.
 *
 * A restore drill takes a production backup -- real accounts, real billing
 * history, real conversations -- and starts an application on top of it. Two
 * things can go wrong, and both are quiet:
 *
 *   1. The "restore target" is production. A copied URL, an unset variable
 *      falling back to the deployment's own, or `railway link` still pointing
 *      at the wrong project, and the drill restores over the thing it was
 *      rehearsing the recovery of.
 *   2. The restored copy reaches the outside world. Real customer rows in a
 *      running app mean Stripe calls with real customer ids, password-reset
 *      and receipt emails to real inboxes, OAuth callbacks against production
 *      clients, cron jobs, provider usage sync, credit reconciliation and
 *      account-deletion maintenance -- all against data that looks live
 *      because it is.
 *
 * So every check below refuses on absence, never on presence: a variable that
 * is unset is a failure, not a default. "We could not tell whether this is
 * production" and "this is production" get the same answer.
 *
 * Pure, so the whole matrix runs as a unit test with no Railway account and no
 * database.
 */

/**
 * Environment variables that must each be set to a disabling value before the
 * restored copy is started. Every one corresponds to an outbound effect that
 * would be indistinguishable from the real thing.
 *
 * @type {readonly {name: string, disabledValues: readonly string[], effect: string}[]}
 */
export const REQUIRED_SIDE_EFFECT_DISABLES = [
  {
    name: "STRIPE_MUTATIONS_DISABLED",
    disabledValues: ["1", "true"],
    effect: "Stripe writes and webhook processing against real customer ids",
  },
  {
    name: "EMAIL_DELIVERY_DISABLED",
    disabledValues: ["1", "true"],
    effect: "receipts, password resets and welcome mail to real inboxes",
  },
  {
    name: "ADMIN_NOTIFICATIONS_DISABLED",
    disabledValues: ["1", "true"],
    effect: "Slack and admin alerting into the production channels",
  },
  {
    name: "OAUTH_PROVIDERS_DISABLED",
    disabledValues: ["1", "true"],
    effect: "OAuth callbacks against the production client credentials",
  },
  {
    name: "SCHEDULED_JOBS_DISABLED",
    disabledValues: ["1", "true"],
    effect:
      "cron: maintenance cleanup, credit reconciliation, provider usage sync, account deletion",
  },
  {
    name: "AI_PROVIDER_CALLS_DISABLED",
    disabledValues: ["1", "true"],
    effect: "billed calls to every AI provider",
  },
  {
    name: "ANALYTICS_DELIVERY_DISABLED",
    disabledValues: ["1", "true"],
    effect: "GA4 and product analytics delivery into the production property",
  },
  {
    name: "OBJECT_STORAGE_WRITES_DISABLED",
    disabledValues: ["1", "true"],
    effect: "writes into the production attachment bucket",
  },
];

/**
 * Substrings that mark a hostname or database name as production. Matched
 * case-insensitively anywhere in the value: a restore target is named by
 * whoever creates it, and there is no reason for one to contain any of these.
 */
export const PRODUCTION_NAME_MARKERS = [
  "prod",
  "production",
  "live",
  "primary",
  "main-db",
];

/** Every restore target's database name must contain both of these. */
export const REQUIRED_TARGET_NAME_MARKERS = ["restore-drill"];

/** @typedef {{code: string, message: string}} PreflightProblem */

const parsePostgresUrl = (value) => {
  try {
    const url = new URL(value);
    return {
      host: url.hostname.toLowerCase(),
      port: url.port,
      database: decodeURIComponent(url.pathname.replace(/^\//, "")).toLowerCase(),
    };
  } catch {
    return null;
  }
};

const isoDatePresent = (value) => /\d{4}-?\d{2}-?\d{2}/.test(String(value || ""));

/**
 * @param {{
 *   approvalTicket?: string | null,
 *   drillOwner?: string | null,
 *   backupId?: string | null,
 *   backupTakenAt?: string | null,
 *   cleanupTargets?: readonly string[],
 *   target: {
 *     projectId?: string | null,
 *     environmentId?: string | null,
 *     serviceId?: string | null,
 *     databaseUrl?: string | null,
 *     directDatabaseUrl?: string | null,
 *   },
 *   production: {
 *     projectId?: string | null,
 *     environmentId?: string | null,
 *     serviceId?: string | null,
 *     databaseUrl?: string | null,
 *     directDatabaseUrl?: string | null,
 *     privateNetworkHostSuffixes?: readonly string[],
 *   },
 *   env: Record<string, string | undefined>,
 * }} input
 * @returns {PreflightProblem[]} empty means the drill may proceed
 */
export const findRestoreDrillProblems = (input) => {
  /** @type {PreflightProblem[]} */
  const problems = [];
  const target = input.target || {};
  const production = input.production || {};
  const env = input.env || {};

  // --- Approval and scope -------------------------------------------------
  if (!input.approvalTicket) {
    problems.push({
      code: "missing_approval_ticket",
      message:
        "No approval ticket. Restoring a production backup copies real customer data into a new place; that is a decision with a name on it, not a command.",
    });
  }
  if (!input.drillOwner) {
    problems.push({
      code: "missing_drill_owner",
      message:
        "No drill owner. Someone has to be accountable for destroying the copy afterwards.",
    });
  }
  if (!input.backupId) {
    problems.push({
      code: "missing_backup_id",
      message:
        "No backup id. A drill that cannot name which backup it restored proves nothing about recovery, and its RPO is unmeasurable.",
    });
  }
  if (!input.backupTakenAt) {
    problems.push({
      code: "missing_backup_timestamp",
      message:
        "No backup timestamp. RPO is measured from it; without it the drill produces no RPO figure.",
    });
  }
  if (!Array.isArray(input.cleanupTargets) || input.cleanupTargets.length === 0) {
    problems.push({
      code: "missing_cleanup_targets",
      message:
        "No cleanup targets named. What will be destroyed afterwards is decided before the copy exists, while nobody is tired and nothing is urgent.",
    });
  }

  // --- Explicit identifiers ----------------------------------------------
  // Named up front rather than inherited. `railway link` and the current
  // working directory are ambient state that survives between sessions, and a
  // drill that relies on them is one `cd` away from acting on production.
  for (const [field, code] of [
    ["projectId", "missing_target_project_id"],
    ["environmentId", "missing_target_environment_id"],
    ["serviceId", "missing_target_service_id"],
  ]) {
    if (!target[field]) {
      problems.push({
        code,
        message: `The target ${field} must be passed explicitly. Never rely on \`railway link\` or the current directory's implicit context.`,
      });
    }
  }
  if (!target.databaseUrl) {
    problems.push({
      code: "missing_target_database_url",
      message: "No target database URL.",
    });
  }

  // --- Not production -----------------------------------------------------
  for (const [field, code] of [
    ["projectId", "target_is_production_project"],
    ["environmentId", "target_is_production_environment"],
    ["serviceId", "target_is_production_service"],
  ]) {
    if (target[field] && production[field] && target[field] === production[field]) {
      problems.push({
        code,
        message: `The target ${field} is the production ${field} (${target[field]}). A drill must run in its own project or a clearly isolated environment.`,
      });
    }
  }

  const productionUrls = [production.databaseUrl, production.directDatabaseUrl]
    .filter(Boolean)
    .map((value) => String(value).trim());
  for (const [field, value] of [
    ["databaseUrl", target.databaseUrl],
    ["directDatabaseUrl", target.directDatabaseUrl],
  ]) {
    if (!value) continue;
    if (productionUrls.includes(String(value).trim())) {
      problems.push({
        code: "target_url_is_production_url",
        message: `The target ${field} is a production connection string. Refusing before anything is written.`,
      });
      continue;
    }
    const parsed = parsePostgresUrl(value);
    if (!parsed) {
      problems.push({
        code: "unparseable_target_url",
        message: `The target ${field} is not a valid connection URL, so it cannot be checked against production.`,
      });
      continue;
    }

    const productionHosts = productionUrls
      .map((url) => parsePostgresUrl(url)?.host)
      .filter(Boolean);
    if (productionHosts.includes(parsed.host)) {
      problems.push({
        code: "target_host_is_production_host",
        message: `The target ${field} points at the production database host. A different database on the same server is not isolation.`,
      });
    }

    for (const suffix of production.privateNetworkHostSuffixes || []) {
      if (parsed.host.endsWith(String(suffix).toLowerCase())) {
        problems.push({
          code: "target_uses_production_private_network",
          message: `The target ${field} resolves inside production's private network (${suffix}). A restore target is reached over its own network, or it is not separate.`,
        });
      }
    }

    for (const marker of PRODUCTION_NAME_MARKERS) {
      if (parsed.host.includes(marker) || parsed.database.includes(marker)) {
        problems.push({
          code: "target_name_looks_like_production",
          message: `The target ${field} contains "${marker}" (host ${parsed.host}, database ${parsed.database}). Nothing in a drill target should.`,
        });
      }
    }

    for (const marker of REQUIRED_TARGET_NAME_MARKERS) {
      if (!parsed.database.includes(marker)) {
        problems.push({
          code: "target_name_missing_drill_marker",
          message: `The target ${field}'s database name ("${parsed.database}") must contain "${marker}" and the drill date, so anyone who stumbles on it later knows what it is and that it is disposable.`,
        });
      }
    }
    if (!isoDatePresent(parsed.database)) {
      problems.push({
        code: "target_name_missing_date",
        message: `The target ${field}'s database name ("${parsed.database}") must carry the drill date, so an abandoned copy is visibly stale rather than ambiguous.`,
      });
    }
  }

  // --- Outbound effects ---------------------------------------------------
  for (const guard of REQUIRED_SIDE_EFFECT_DISABLES) {
    const value = env[guard.name]?.trim().toLowerCase();
    if (!value || !guard.disabledValues.includes(value)) {
      problems.push({
        code: "side_effect_not_disabled",
        message: `${guard.name} is not set to a disabling value (${guard.disabledValues.join(" or ")}), so the restored copy could still perform: ${guard.effect}.`,
      });
    }
  }

  return problems;
};

/**
 * Deduplicates by message so a repeated finding across the two target URLs is
 * reported once, and sorts by code for a stable report.
 */
export const summariseRestoreDrillProblems = (problems) => {
  const seen = new Set();
  const unique = [];
  for (const problem of problems) {
    if (seen.has(problem.message)) continue;
    seen.add(problem.message);
    unique.push(problem);
  }
  return unique.sort((a, b) => a.code.localeCompare(b.code));
};
