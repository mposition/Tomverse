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

export type RailwayEnvironment = "production" | "staging";

export type RailwayCronService = {
  readonly key: string;
  readonly service: string;
  readonly startCommand: string;
  readonly cronSchedule: string;
  readonly variables: Readonly<Record<RailwayEnvironment, readonly string[]>>;
};

export const RAILWAY_REPOSITORY = "mposition/Tomverse";

/** The branch each Railway environment deploys. */
export const RAILWAY_ENVIRONMENT_BRANCHES: Readonly<
  Record<RailwayEnvironment, string>
> = {
  production: "main",
  staging: "develop",
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
    },
  },
];

/**
 * The DSL functions `railway.ts` passes in from the SDK. Injected rather than
 * imported so the resource list is built -- and tested -- without the SDK:
 * tests/scheduledJobsCore.test.mjs calls this with recording fakes, which is
 * what catches an edit that would drop a service (and so delete it on apply).
 */
export type RailwayDsl<Source, Preserved, Resource> = {
  readonly github: (repo: string, options: { branch: string }) => Source;
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
  return RAILWAY_CRON_SERVICES.map((job) =>
    dsl.service(job.service, {
      source: dsl.github(RAILWAY_REPOSITORY, {
        branch: RAILWAY_ENVIRONMENT_BRANCHES[environment],
      }),
      start: job.startCommand,
      deploy: { cronSchedule: job.cronSchedule, restartPolicyType: "NEVER" },
      env: Object.fromEntries(
        job.variables[environment].map((name) => [name, dsl.preserve()])
      ),
    })
  );
};
