// The Railway cron services this repository deploys, as data.
//
// `.railway/railway.ts` turns this table into Railway Infrastructure as Code.
// It replaces the five `railway.*.json` Config as Code files, which Railway
// stops reading on 2026-12-01 (docs.railway.com/config-as-code). Until then
// both exist, and tests/scheduledJobsCore.test.mjs holds them equal.
//
// Kept dependency-free and separate from railway.ts on purpose: the unit tests
// and the security regression check read it without installing the Railway
// SDK, and lib/scheduledJobsCore.ts writes each job's trigger independently so
// that a schedule changed here without the catalogue goes red.
//
// `variables` lists every variable the service has in that environment. The
// file is applied as a named partial, and an IaC apply deletes whatever a
// service it owns does not declare -- a variable added in the dashboard and not
// listed here is removed by the next apply. `plan` shows it as
// "Delete variable"; stop there and add the name.

export type RailwayEnvironment = "production" | "staging" | "dev";

/**
 * production and staging must list every job: a job missing from either is a
 * service the partial deletes there. dev is opt-in per job, and a job without
 * a dev list is not declared in dev at all (operator decision, 2026-10-07:
 * dev does not run Provider Probe or Provider Usage Sync).
 */
export type RailwayCronVariables = Readonly<
  Record<Exclude<RailwayEnvironment, "dev">, readonly string[]> &
    Partial<Record<"dev", readonly string[]>>
>;

export type RailwayCronService = {
  readonly key: string;
  readonly service: string;
  readonly startCommand: string;
  readonly cronSchedule: string;
  readonly variables: RailwayCronVariables;
};

export const RAILWAY_REPOSITORY = "mposition/Tomverse";

/**
 * The branch each Railway environment deploys.
 *
 * dev takes every develop merge, so that staging (shown to people as Test) can
 * hold one release candidate while develop keeps moving. staging deploys the
 * `test` branch, which only the promotion script moves (`npm run promote:test`,
 * .github/RELEASE_CHECKLIST.md 7.9). An apply here reconnects staging's cron
 * services to `test`, so the branch must exist before the first apply.
 */
export const RAILWAY_ENVIRONMENT_BRANCHES: Readonly<
  Record<RailwayEnvironment, string>
> = {
  production: "main",
  staging: "test",
  dev: "develop",
};

export const isRailwayEnvironment = (
  value: unknown
): value is RailwayEnvironment =>
  typeof value === "string" &&
  Object.prototype.hasOwnProperty.call(RAILWAY_ENVIRONMENT_BRANCHES, value);

export const RAILWAY_CRON_SERVICES: readonly RailwayCronService[] = [
  {
    key: "creditReconciliation",
    service: "Credit Reconciliation",
    startCommand: "npm run maintenance:credit-reservations",
    cronSchedule: "*/15 * * * *",
    variables: {
      production: ["MAINTENANCE_SECRET", "MAINTENANCE_URL"],
      staging: ["MAINTENANCE_SECRET", "MAINTENANCE_URL"],
      dev: ["MAINTENANCE_SECRET", "MAINTENANCE_URL"],
    },
  },
  {
    key: "providerProbe",
    service: "Provider Probe",
    startCommand: "npm run maintenance:provider-probe",
    cronSchedule: "*/10 * * * *",
    variables: {
      production: ["MAINTENANCE_SECRET", "PROVIDER_PROBE_URL"],
      staging: ["MAINTENANCE_SECRET", "PROVIDER_PROBE_URL"],
      // Not on dev (operator decision, 2026-10-07).
    },
  },
  {
    key: "maintenance",
    service: "Maintenance Cron",
    startCommand: "npm run maintenance:cleanup",
    cronSchedule: "0 3 * * *",
    variables: {
      production: ["MAINTENANCE_SECRET", "MAINTENANCE_URL"],
      staging: ["MAINTENANCE_SECRET", "MAINTENANCE_URL"],
      dev: ["MAINTENANCE_SECRET", "MAINTENANCE_URL"],
    },
  },
  {
    key: "providerModelCatalog",
    service: "Provider Model Catalog",
    startCommand: "npm run maintenance:provider-model-catalog",
    cronSchedule: "0 0 * * *",
    variables: {
      production: ["MAINTENANCE_SECRET", "PROVIDER_MODEL_CATALOG_SYNC_URL"],
      staging: ["MAINTENANCE_SECRET", "PROVIDER_MODEL_CATALOG_SYNC_URL"],
      dev: ["MAINTENANCE_SECRET", "PROVIDER_MODEL_CATALOG_SYNC_URL"],
    },
  },
  {
    key: "providerUsageSync",
    service: "Provider Usage Sync",
    startCommand: "npm run maintenance:provider-usage",
    cronSchedule: "30 0 * * *",
    variables: {
      production: ["PROVIDER_USAGE_SYNC_SECRET", "PROVIDER_USAGE_SYNC_URL"],
      // Staging carries five more than production. They are recorded as found
      // on 2026-09-17, not endorsed: whether the cron needs them is a separate
      // question, and dropping them belongs in a dashboard change first.
      staging: [
        "CLOUDFLARE_API_TOKEN",
        "INFRASTRUCTURE_SLACK_WEBHOOK_URL",
        "PRISMA_DATABASE_ID",
        "PRISMA_MANAGEMENT_API_TOKEN",
        "PROVIDER_USAGE_SLACK_WEBHOOK_URL",
        "PROVIDER_USAGE_SYNC_SECRET",
        "PROVIDER_USAGE_SYNC_URL",
      ],
      // Not on dev (operator decision, 2026-10-07).
    },
  },
];

/**
 * The engineering agent's two services (docs/policy/engineering-agent.md §8,
 * §12): production only, each a cron that runs one cycle and stops. They are
 * not built by Railway: they run the image .github/workflows/engineering-
 * agent-image.yml builds on main, by digest, with automatic updates off.
 *
 * `digest` is null until a person records the digest that workflow printed,
 * in a pull request they merge; while it is null the service is not declared
 * at all, so nothing is deployed and nothing is owned. Changing it is that PR
 * and an operator's apply -- never the agent (§13).
 *
 * `variables` is the service's whole list. The runner holds no GitHub write,
 * App key or database credential; the publisher holds no model key or
 * database credential; neither holds an AMUX secret. The lists equal
 * RUNNER_VARIABLES and PUBLISHER_VARIABLES in the scripts, which
 * tests/engineeringAgentServices.test.mjs holds.
 *
 * Each schedule is longer than its service's hard deadline, so two cycles
 * never overlap.
 */
export type RailwayAgentService = {
  readonly key: string;
  readonly service: string;
  readonly digest: string | null;
  readonly startCommand: string;
  readonly cronSchedule: string;
  readonly variables: Readonly<Partial<Record<RailwayEnvironment, readonly string[]>>>;
};

export const ENGINEERING_AGENT_IMAGE = "ghcr.io/mposition/tomverse-engineering-agent";

export const RAILWAY_AGENT_SERVICES: readonly RailwayAgentService[] = [
  {
    key: "engineeringAgentRunner",
    service: "Engineering Agent Runner",
    digest: "sha256:465e6eb26f88abd08dde8294b51608b509a74c5ff60b48ec26ab01164a871a4d",
    startCommand: "node --experimental-strip-types scripts/engineering-agent-runner.mjs",
    cronSchedule: "*/30 * * * *",
    variables: {
      production: [
        "ENGINEERING_AGENT_APP_URL",
        "ENGINEERING_AGENT_RUNNER_SECRET",
        "ENGINEERING_AGENT_ANTHROPIC_API_KEY",
        "ENGINEERING_AGENT_GITHUB_READ_TOKEN",
        "ENGINEERING_AGENT_RUNNER_DEADMAN_URL",
      ],
    },
  },
  {
    key: "engineeringAgentPublisher",
    service: "Engineering Agent Publisher",
    digest: "sha256:465e6eb26f88abd08dde8294b51608b509a74c5ff60b48ec26ab01164a871a4d",
    startCommand: "node --experimental-strip-types scripts/engineering-agent-publisher.mjs",
    cronSchedule: "*/10 * * * *",
    variables: {
      production: [
        "ENGINEERING_AGENT_APP_URL",
        "ENGINEERING_AGENT_PUBLISHER_SECRET",
        "ENGINEERING_AGENT_PUBLISHER_APP_ID",
        "ENGINEERING_AGENT_PUBLISHER_INSTALLATION_ID",
        "ENGINEERING_AGENT_PUBLISHER_PRIVATE_KEY",
        "ENGINEERING_AGENT_PUBLISHER_DEADMAN_URL",
      ],
    },
  },
];

const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * The DSL functions `railway.ts` passes in from the SDK. Injected rather than
 * imported so the resource list is built -- and tested -- without the SDK:
 * tests/scheduledJobsCore.test.mjs calls this with recording fakes, which is
 * what catches an edit that would drop a service (and so delete it on apply).
 */
export type RailwayDsl<Source, Preserved, Resource> = {
  readonly github: (repo: string, options: { branch: string }) => Source;
  readonly image: (reference: string, options: { autoUpdates: { type: "disabled" } }) => Source;
  readonly preserve: () => Preserved;
  readonly service: (
    name: string,
    config: {
      source: Source;
      start: string;
      deploy: { cronSchedule: string; restartPolicyType: "NEVER" };
      env: Record<string, Preserved>;
    }
  ) => Resource;
};

export const buildScheduledJobResources = <Source, Preserved, Resource>(
  environment: unknown,
  dsl: RailwayDsl<Source, Preserved, Resource>
): Resource[] => {
  // Fail closed. A PR environment or a newly created one has no declared
  // variable list, and planning it with an empty list would delete every
  // variable its cron services have.
  if (!isRailwayEnvironment(environment)) {
    throw new Error(
      `No scheduled-job configuration for Railway environment "${String(environment)}". ` +
        "Add it to .railway/scheduled-jobs.ts before planning it."
    );
  }
  const cron: Resource[] = [];
  for (const job of RAILWAY_CRON_SERVICES) {
    const variables = job.variables[environment];
    // Only dev may leave a job out; the type requires production and staging.
    // An empty env instead would declare the service and delete its variables.
    if (variables === undefined) continue;
    cron.push(
      dsl.service(job.service, {
        source: dsl.github(RAILWAY_REPOSITORY, {
          branch: RAILWAY_ENVIRONMENT_BRANCHES[environment],
        }),
        start: job.startCommand,
        deploy: { cronSchedule: job.cronSchedule, restartPolicyType: "NEVER" },
        env: Object.fromEntries(variables.map((name) => [name, dsl.preserve()])),
      })
    );
  }
  const agents: Resource[] = [];
  for (const agent of RAILWAY_AGENT_SERVICES) {
    const variables = agent.variables[environment];
    // Not in this environment, or no image recorded yet: not declared.
    if (variables === undefined || agent.digest === null) continue;
    if (!IMAGE_DIGEST.test(agent.digest)) {
      throw new Error(`${agent.service}: the image digest is not a sha256 digest.`);
    }
    agents.push(
      dsl.service(agent.service, {
        source: dsl.image(`${ENGINEERING_AGENT_IMAGE}@${agent.digest}`, {
          autoUpdates: { type: "disabled" },
        }),
        start: agent.startCommand,
        deploy: { cronSchedule: agent.cronSchedule, restartPolicyType: "NEVER" },
        env: Object.fromEntries(variables.map((name) => [name, dsl.preserve()])),
      })
    );
  }
  return [...cron, ...agents];
};
