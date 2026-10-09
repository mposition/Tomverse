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
  /**
   * A service Railway does not build: it runs this image, by digest, with
   * automatic updates off. While `digest` is null the service is not declared
   * in any environment. Absent for a service built from the repository.
   */
  readonly image?: { readonly reference: string; readonly digest: string | null };
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

/**
 * The billing-finance-ops stage W trigger's variables
 * (docs/policy/billing-finance-ops.md §3 item 6): the run secret, the dead-man
 * signal URL and the deployment setting, and nothing else. The same list
 * lib/billingFinanceOpsServiceCore.ts accepts at start; the IaC test holds the
 * two equal.
 */
const BILLING_FINANCE_OPS_VARIABLES = [
  "BILLING_FINANCE_OPS_AGENT_ENABLED",
  "BILLING_FINANCE_OPS_RUN_SECRET",
  "BILLING_FINANCE_OPS_DEADMAN_URL",
] as const;

/** The marketing publisher's two variables (S2 plan, S2d1). */
const MARKETING_PUBLISHER_VARIABLES = ["MARKETING_PUBLISH_SECRET", "MARKETING_PUBLISH_URL"] as const;

/**
 * The sre-ops page service's variables at S1b (docs/policy/sre-ops.md §7, §8):
 * the page service's list in scripts/ops-observer/runtime-variables-core.mjs
 * without OPS_OBSERVER_PAGE_WEBHOOK_URL, which exists from S2 only. The
 * supervisor refuses to start on any other name; the IaC test holds the two
 * lists to that difference. RAILWAY_DOCKERFILE_PATH points the build at
 * docker/ops-observer.Dockerfile, which the operator sets.
 */
const OPS_OBSERVER_PAGE_S1B_VARIABLES = [
  "OPS_OBSERVER_SECRET",
  "OPS_OBSERVER_HEARTBEAT_URL",
  "OPS_OBSERVER_ENABLED",
  "OPS_OBSERVER_APP_URL",
  "RAILWAY_DOCKERFILE_PATH",
] as const;

/**
 * The sre-ops digest service's variables (docs/policy/sre-ops.md §7): the
 * digest list in scripts/ops-observer/runtime-variables-core.mjs, all of it --
 * the digest notice goes to the owner's Slack channel from S1b on. The IaC
 * test holds the two equal.
 */
const OPS_OBSERVER_DIGEST_VARIABLES = [
  "OPS_OBSERVER_DIGEST_SECRET",
  "OPS_OBSERVER_DIGEST_WEBHOOK_URL",
  "OPS_OBSERVER_DIGEST_HEARTBEAT_URL",
  "OPS_OBSERVER_ENABLED",
  "OPS_OBSERVER_APP_URL",
  "RAILWAY_DOCKERFILE_PATH",
] as const;

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
 * Each environment list is the service's whole list. The runner holds no
 * GitHub write, App key or database credential; the publisher holds no model
 * key or database credential; neither holds an AMUX secret. The lists equal
 * RUNNER_VARIABLES and PUBLISHER_VARIABLES in the scripts, which
 * tests/engineeringAgentServices.test.mjs holds.
 *
 * Each schedule is longer than its service's hard deadline, so two cycles
 * never overlap.
 */
export const ENGINEERING_AGENT_IMAGE = "ghcr.io/mposition/tomverse-engineering-agent";

export const ENGINEERING_AGENT_SERVICES: readonly AgentRunnerService[] = [
  {
    key: "engineering_agent_runner",
    service: "Engineering Agent Runner",
    image: {
      reference: ENGINEERING_AGENT_IMAGE,
      digest: "sha256:465e6eb26f88abd08dde8294b51608b509a74c5ff60b48ec26ab01164a871a4d",
    },
    startCommand: "node --experimental-strip-types scripts/engineering-agent-runner.mjs",
    cronSchedule: "*/30 * * * *",
    environments: {
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
    key: "engineering_agent_publisher",
    service: "Engineering Agent Publisher",
    image: {
      reference: ENGINEERING_AGENT_IMAGE,
      digest: "sha256:465e6eb26f88abd08dde8294b51608b509a74c5ff60b48ec26ab01164a871a4d",
    },
    startCommand: "node --experimental-strip-types scripts/engineering-agent-publisher.mjs",
    cronSchedule: "*/10 * * * *",
    environments: {
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
    key: "billing_finance_ops_deadline",
    service: "Billing Finance Ops Deadline",
    // Node directly, not npm run: npm adds npm_*, INIT_CWD and NODE to the
    // environment, and the start check refuses any name it does not know
    // (lib/billingFinanceOpsServiceCore.ts).
    startCommand: "node --experimental-strip-types scripts/billing-finance-ops-trigger-service.mjs",
    // docs/policy/billing-finance-ops.md §1.1: 01:00 UTC daily, two hours
    // before the Maintenance Cron's silence check reads the day.
    cronSchedule: "0 1 * * *",
    environments: {
      production: BILLING_FINANCE_OPS_VARIABLES,
      staging: BILLING_FINANCE_OPS_VARIABLES,
    },
  },
  {
    // The marketing publisher (S2 plan, S2d1). A clock and a supervisor: every
    // five minutes it asks the app to run, with a deadline four minutes out,
    // and kills its own worker at that deadline. The contract is
    // `run deadline < cron period`; lib/marketingPublisherRunCore.ts holds the
    // numbers and a test holds this schedule to them. The admin Jobs screen
    // judges it through CRON_TRIGGERS.marketingPublisher in
    // lib/scheduledJobsCore.ts, which a test holds to this schedule.
    //
    // Two variables and no others -- the plan's exhaustive list. No database,
    // platform, object-store, GitHub or LLM credential: the service changes
    // nothing itself, and the app route is where the work happens. Set both
    // after the apply creates the service: this file preserves declared
    // variables, it does not create them, and a service without its secret
    // fails every five minutes.
    key: "marketing_publisher",
    service: "Marketing Publisher",
    startCommand: "npm run maintenance:marketing-publisher",
    cronSchedule: "*/5 * * * *",
    environments: {
      production: MARKETING_PUBLISHER_VARIABLES,
      staging: MARKETING_PUBLISHER_VARIABLES,
      // Not on dev (operator decision, 2026-10-07): the one job that acts on
      // outside accounts, and dev runs every merge before anyone has verified it.
    },
  },
  {
    // docs/policy/sre-ops.md §1 item 1, §8 S1b: every ten minutes, built from
    // docker/ops-observer.Dockerfile. The start command replaces the image's
    // ENTRYPOINT in exec form, so it names the supervisor and its service
    // argument itself, with no shell and nothing npm would add.
    // Production only: the supervisor refuses any app URL but production's
    // (scripts/ops-observer/supervise.mjs), and §3 rule 9's no-restart policy
    // is the deploy setting below.
    key: "ops_observer_page",
    service: "Ops Observer",
    startCommand: "node scripts/ops-observer/supervise.mjs page",
    cronSchedule: "*/10 * * * *",
    environments: {
      production: OPS_OBSERVER_PAGE_S1B_VARIABLES,
    },
  },
  {
    // docs/policy/sre-ops.md §1 item 3: once a day at 21:00 UTC, which is
    // 07:00 Australia/Brisbane (decision T-1) -- yesterday's owner date is
    // closed by then. Same image and supervisor as the page service; the
    // argument picks the digest child.
    key: "ops_observer_digest",
    service: "Ops Observer Digest",
    startCommand: "node scripts/ops-observer/supervise.mjs digest",
    cronSchedule: "0 21 * * *",
    environments: {
      production: OPS_OBSERVER_DIGEST_VARIABLES,
    },
  },
  {
    key: "product_research_probe",
    service: "Product Research Probe",
    startCommand: "npm run agent:product-research-observation -- --probe",
    cronSchedule: null,
    environments: { staging: PRODUCT_RESEARCH_PROBE_VARIABLES },
  },
  ...ENGINEERING_AGENT_SERVICES,
];

type AgentRailwayDsl<Source, Preserved, Resource> = {
  readonly github: (repo: string, options: { branch: string }) => Source;
  readonly image: (reference: string, options: { autoUpdates: { type: "disabled" } }) => Source;
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
    // No image recorded yet: not declared, so nothing is deployed or owned.
    if (runner.image && runner.image.digest === null) return [];
    if (runner.image && !IMAGE_DIGEST.test(runner.image.digest ?? "")) {
      throw new Error(`${runner.service}: the image digest is not a sha256 digest.`);
    }
    return [
      dsl.service(runner.service, {
        source: runner.image
          ? dsl.image(`${runner.image.reference}@${runner.image.digest}`, {
              autoUpdates: { type: "disabled" },
            })
          : dsl.github(AGENT_RAILWAY_REPOSITORY, {
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
