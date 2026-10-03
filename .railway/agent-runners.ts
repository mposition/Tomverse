// The Agent project's runner services, as data.
//
// A second Railway project exists for one reason: a reference variable only
// resolves inside its own project, so a project that holds no database service
// and no shared variables has nothing for `${{ Postgres.DATABASE_URL }}` to
// resolve to. The agent services live there and reach product state through the
// app's internal routes instead.
//
// `.railway/agents-railway.ts` turns this table into Railway IaC as a
// whole-project file, not a named partial: this project is the agents' and
// nothing else's, so an apply should delete a database service somebody adds by
// hand. That is the opposite of `.railway/railway.ts`, which owns a named
// partial inside the shared `Tomverse` project.
//
// Kept dependency-free and separate from agents-railway.ts for the same reason
// scheduled-jobs.ts is: the unit tests read it without installing the SDK.
//
// Two differences from `RailwayCronService` are the whole point of this type:
// a service may exist in one environment and not the other (a probe that only
// staging needs), and a service may have no cron at all (a probe an operator
// runs by hand). Expressing either in the cron table would have meant giving
// every scheduled job an optional schedule.

export type RailwayEnvironment = "production" | "staging";

export type AgentRunnerService = {
  readonly key: string;
  readonly service: string;
  readonly startCommand: string;
  /** `null` for a service an operator runs by hand. */
  readonly cronSchedule: string | null;
  /**
   * Variable names per environment. An environment the service is absent from
   * is left out entirely, and no resource is created for it there.
   */
  readonly environments: Partial<Record<RailwayEnvironment, readonly string[]>>;
};

export const AGENT_RAILWAY_PROJECT = "Tomverse Agents";

export const AGENT_RAILWAY_REPOSITORY = "mposition/Tomverse";

/**
 * Where the agents run.
 *
 * Named rather than left to Railway, whose default for a new project is
 * `sfo`. The approved policy's APP 8 record states the processing region, so
 * an unnamed region is not a default -- it is a deployment somewhere the
 * record does not say. The app's own services run here too.
 */
export const AGENT_RAILWAY_REGION = "asia-southeast1-eqsg3a";

/** The branch each Railway environment deploys, as in the cron table. */
export const AGENT_ENVIRONMENT_BRANCHES: Readonly<
  Record<RailwayEnvironment, string>
> = {
  production: "main",
  staging: "develop",
};

export const isAgentRailwayEnvironment = (
  value: unknown
): value is RailwayEnvironment =>
  typeof value === "string" &&
  Object.prototype.hasOwnProperty.call(AGENT_ENVIRONMENT_BRANCHES, value);

/**
 * Variables the product-research runner may have, and no others.
 *
 * `lib/productResearchObservationRunnerCore.mjs` refuses to run when the
 * process has a name outside this list, and the test holds the two equal: the
 * list is what says a product database credential cannot be here, so a name
 * added to one and not the other would make the check meaningless.
 */
const PRODUCT_RESEARCH_VARIABLES = [
  "PRODUCT_RESEARCH_AGENT_ENABLED",
  "PRODUCT_RESEARCH_INGEST_URL",
  "PRODUCT_RESEARCH_INGEST_SECRET",
  "PRODUCT_RESEARCH_GITHUB_READ_TOKEN",
  "RAILPACK_DEPLOY_APT_PACKAGES",
] as const;

/**
 * The probe has no submission URL and no submission secret.
 *
 * S0 runs it by hand to measure what the real image can do -- whether git is
 * there at all, how long a bare partial clone takes, whether the report it
 * produces is byte-identical to one from a full local clone. None of that needs
 * the ability to write a row, so the variables that would allow one are absent.
 */
const PRODUCT_RESEARCH_PROBE_VARIABLES = [
  "PRODUCT_RESEARCH_AGENT_ENABLED",
  "PRODUCT_RESEARCH_GITHUB_READ_TOKEN",
  "RAILPACK_DEPLOY_APT_PACKAGES",
] as const;

export const AGENT_RUNNER_SERVICES: readonly AgentRunnerService[] = [
  {
    key: "product_research_observation",
    service: "Product Research Observation",
    startCommand: "npm run agent:product-research-observation",
    // 21:30 UTC, which is 07:30 Australia/Brisbane -- a restatement of the UTC
    // time for the operator who reads the result, not a second schedule.
    cronSchedule: "30 21 * * *",
    environments: {
      production: PRODUCT_RESEARCH_VARIABLES,
      staging: PRODUCT_RESEARCH_VARIABLES,
    },
  },
  {
    key: "product_research_probe",
    service: "Product Research Probe",
    startCommand: "npm run agent:product-research-observation -- --probe",
    cronSchedule: null,
    environments: { staging: PRODUCT_RESEARCH_PROBE_VARIABLES },
  },
];

type AgentRailwayDsl<Source, Preserved, Resource> = {
  readonly github: (repo: string, options: { branch: string }) => Source;
  readonly preserve: () => Preserved;
  readonly service: (
    name: string,
    config: {
      source: Source;
      start: string;
      deploy: { cronSchedule?: string; restartPolicyType: "NEVER" };
      replicas: Record<string, number>;
      env: Record<string, Preserved>;
    }
  ) => Resource;
};

export const buildAgentRunnerResources = <Source, Preserved, Resource>(
  environment: unknown,
  dsl: AgentRailwayDsl<Source, Preserved, Resource>
): Resource[] => {
  // Fail closed, as the cron table does: planning an environment this file
  // says nothing about would delete every service the project has there.
  if (!isAgentRailwayEnvironment(environment)) {
    throw new Error(
      `No agent runner configuration for Railway environment "${String(environment)}". ` +
        "Add it to .railway/agent-runners.ts before planning it."
    );
  }

  return AGENT_RUNNER_SERVICES.flatMap((runner) => {
    const variables = runner.environments[environment];
    // Absent here on purpose. Returning an empty env instead would declare the
    // service with no variables, and the apply would delete the ones it has.
    if (!variables) return [];
    return [
      dsl.service(runner.service, {
        source: dsl.github(AGENT_RAILWAY_REPOSITORY, {
          branch: AGENT_ENVIRONMENT_BRANCHES[environment],
        }),
        start: runner.startCommand,
        deploy: {
          ...(runner.cronSchedule === null ? {} : { cronSchedule: runner.cronSchedule }),
          restartPolicyType: "NEVER",
        },
        // One replica, placed. A cron that runs once a day needs no more, and
        // the region is the record's, not Railway's default.
        replicas: { [AGENT_RAILWAY_REGION]: 1 },
        env: Object.fromEntries(variables.map((name) => [name, dsl.preserve()])),
      }),
    ];
  });
};
