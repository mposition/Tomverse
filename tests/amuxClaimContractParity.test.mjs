import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { AMUX_CLAIM_CLOSED_REFUSAL_REASONS } from "../lib/amux/auditContract.ts";
import { isAmuxExecutionApiEnabled } from "../lib/amux/executionGate.ts";

const rustSource = readFileSync(
  join(
    process.cwd(),
    "apps",
    "tomverse-orchestrator",
    "src",
    "tomverse_api.rs",
  ),
  "utf8",
);
const schedulerSource = readFileSync(
  join(process.cwd(), "apps", "tomverse-orchestrator", "src", "scheduler.rs"),
  "utf8",
);
const contractSource = readFileSync(
  join(process.cwd(), "lib", "amux", "claimContract.ts"),
  "utf8",
);
const dbBoundarySource = readFileSync(
  join(process.cwd(), "lib", "amux", "dbBoundary.ts"),
  "utf8",
);
const claimDeadlineSource = readFileSync(
  join(process.cwd(), "lib", "amux", "claimDeadline.ts"),
  "utf8",
);
const claimRouteSource = readFileSync(
  join(process.cwd(), "app", "api", "internal", "amux", "claim", "route.ts"),
  "utf8",
);

const enumBody = rustSource.match(
  /pub enum ClaimRefusalReason \{([\s\S]*?)\n\}/,
)?.[1];
const mappingBody = rustSource.match(
  /pub const fn as_str\(self\)[\s\S]*?match self \{([\s\S]*?)\n\s*\}\n\s*\}/,
)?.[1];
const closedBody = rustSource.match(
  /pub const CLOSED:[\s\S]*?= &\[([\s\S]*?)\n\s*\];/,
)?.[1];

test("TypeScript and Rust keep one exact closed claim-refusal vocabulary", () => {
  assert.ok(enumBody, "Rust ClaimRefusalReason enum was not found");
  assert.ok(
    mappingBody,
    "Rust ClaimRefusalReason::as_str mapping was not found",
  );
  assert.ok(closedBody, "Rust ClaimRefusalReason::CLOSED list was not found");

  const variants = [...enumBody.matchAll(/^\s*([A-Z][A-Za-z0-9]*),\s*$/gm)].map(
    (match) => match[1],
  );
  const mappings = [
    ...mappingBody.matchAll(/Self::([A-Za-z0-9]+)\s*=>\s*"([^"]+)"/g),
  ].map((match) => ({ variant: match[1], reason: match[2] }));
  const closedVariants = [...closedBody.matchAll(/Self::([A-Za-z0-9]+),/g)].map(
    (match) => match[1],
  );

  assert.deepEqual(
    mappings.map(({ variant }) => variant),
    variants,
    "every Rust refusal variant must have exactly one explicit string mapping",
  );
  assert.deepEqual(
    closedVariants,
    variants,
    "every Rust refusal variant must remain terminal for the process run",
  );
  assert.deepEqual(
    mappings.map(({ reason }) => reason),
    [...AMUX_CLAIM_CLOSED_REFUSAL_REASONS],
    "a refusal addition must update both the server contract and Rust client",
  );
});

test("claim scoring versions and supported scheduler-score bounds match both runtimes", () => {
  const rustVersion = schedulerSource.match(
    /const SCORING_VERSION: &str = "([^"]+)";/,
  )?.[1];
  const contractVersions = [
    ...contractSource.matchAll(/scoring_version: z\.literal\("([^"]+)"\)/g),
  ].map((match) => match[1]);
  const wireVersion = rustSource.match(
    /decision: ClaimDecision\s*\{[^}]*?scoring_version: "([^"]+)"/s,
  )?.[1];
  assert.ok(rustVersion);
  assert.deepEqual(contractVersions, ["amux-worker-router-v1", rustVersion]);
  assert.equal(wireVersion, rustVersion);

  const schedulerMaximum = 10_000 + 1_000_000 + 40 + 40 + 5_000_000 + 8;
  const declaredMaximum = Number(
    contractSource
      .match(/AMUX_MAX_SCHEDULER_SCORE = ([0-9_]+);/)?.[1]
      ?.replaceAll("_", ""),
  );
  assert.equal(declaredMaximum, schedulerMaximum);
});

test("the claim HTTP deadline outlives one anchored DB-clock route budget", () => {
  const dbNumber = (name) =>
    Number(
      dbBoundarySource
        .match(new RegExp(`export const ${name} = ([0-9_]+);`))?.[1]
        ?.replaceAll("_", ""),
    );
  const profileCallCeiling = (name) =>
    Number(
      dbBoundarySource.match(
        new RegExp(`${name}: \\{[^}]*prismaCallCeiling: (\\d+)`, "s"),
      )?.[1],
    );
  const routeMs = Number(
    claimDeadlineSource
      .match(/AMUX_CLAIM_ROUTE_BUDGET_MS = ([0-9_]+);/)?.[1]
      ?.replaceAll("_", ""),
  );
  const connectSeconds = Number(
    rustSource.match(
      /TOMVERSE_INTERNAL_CONNECT_TIMEOUT: Duration = Duration::from_secs\((\d+)\)/,
    )?.[1],
  );
  const claimSeconds = Number(
    rustSource.match(
      /TOMVERSE_INTERNAL_CLAIM_TIMEOUT: Duration = Duration::from_secs\((\d+)\)/,
    )?.[1],
  );
  const maxWait = dbNumber("AMUX_DB_MAX_WAIT_MS");
  const perCallPlanningFactor =
    dbNumber("AMUX_DB_STATEMENT_TIMEOUT_MS") +
    dbNumber("AMUX_DB_IDLE_TRANSACTION_TIMEOUT_MS");
  const reserve = dbNumber("AMUX_DB_COMMIT_RESERVE_MS");
  const threeTransactions = ["claimRouteClock", "routingSnapshot", "claim"];
  const plannedDbCallBudgetMs = threeTransactions.reduce(
    (sum, profile) =>
      sum + profileCallCeiling(profile) * perCallPlanningFactor + reserve + maxWait,
    0,
  );

  assert.ok(Number.isFinite(plannedDbCallBudgetMs));
  assert.ok(
    plannedDbCallBudgetMs <= routeMs,
    "the anchored route must fit its three planned Prisma-call budgets",
  );
  assert.ok(
    claimSeconds * 1_000 >= routeMs + connectSeconds * 1_000 + 1_000,
    "claim HTTP must reserve a second for response transport beyond route and connect",
  );
  assert.match(
    rustSource,
    /\.post\(format!\("\{\}\/api\/internal\/amux\/claim"[\s\S]*?\.timeout\(self\.claim_timeout\)/,
  );
  assert.match(
    claimRouteSource,
    /await anchorAmuxClaimDeadline\(\);[\s\S]*?readLimitedJson\(/,
  );
  assert.match(claimRouteSource, /\}, AMUX_CLAIM_ROUTE_BUDGET_MS\);/);
});

test("future lifecycle client deadlines cover the DB-clock route and transport reserve", () => {
  const value = (name) =>
    Number(
      dbBoundarySource
        .match(new RegExp(`export const ${name} = ([0-9_]+);`))?.[1]
        ?.replaceAll("_", ""),
    );
  const routeMs = value("AMUX_LIFECYCLE_ROUTE_BUDGET_MS");
  const connectMs = Number(
    rustSource.match(
      /TOMVERSE_INTERNAL_CONNECT_TIMEOUT: Duration = Duration::from_secs\((\d+)\)/,
    )?.[1],
  ) * 1_000;
  const clientMs = Number(
    rustSource.match(
      /TOMVERSE_INTERNAL_LIFECYCLE_TIMEOUT: Duration = Duration::from_secs\((\d+)\)/,
    )?.[1],
  ) * 1_000;
  assert.ok(clientMs >= routeMs + connectMs + 1_000);

  const endpoints = [
    ["workers/register", "workerRegister", "worker_register"],
    ["workers/heartbeat", "workerHeartbeat", "worker_heartbeat"],
    ["delivery/pull", "deliveryPull", "delivery_pull"],
    ["delivery/ack", "deliveryAck", "delivery_ack"],
    ["execution/start", "executionStart", "execution_start"],
    ["execution/heartbeat", "executionHeartbeat", "execution_heartbeat"],
    ["execution/settle", "executionSettle", "execution_settle"],
  ];
  for (const [route, boundary, method] of endpoints) {
    const ceiling = Number(
      dbBoundarySource.match(
        new RegExp(`${boundary}: \\{[^}]*prismaCallCeiling: (\\d+)`, "s"),
      )?.[1],
    );
    assert.ok(Number.isInteger(ceiling), boundary);
    const plannedBudget = ceiling *
      (value("AMUX_DB_STATEMENT_TIMEOUT_MS") +
        value("AMUX_DB_IDLE_TRANSACTION_TIMEOUT_MS")) +
      value("AMUX_DB_COMMIT_RESERVE_MS") +
      value("AMUX_DB_MAX_WAIT_MS");
    assert.ok(plannedBudget <= routeMs, `${route} planned DB-call budget exceeds route budget`);
    const routeSource = readFileSync(
      join(process.cwd(), "app", "api", "internal", "amux", route, "route.ts"),
      "utf8",
    );
    assert.match(routeSource, /\}, AMUX_LIFECYCLE_ROUTE_BUDGET_MS\);/);
    const start = rustSource.indexOf(`pub async fn ${method}(`);
    assert.ok(start >= 0, method);
    const next = rustSource.indexOf("\n    pub async fn ", start + 1);
    const source = rustSource.slice(start, next < 0 ? undefined : next);
    assert.match(source, /\.timeout\(TOMVERSE_INTERNAL_LIFECYCLE_TIMEOUT\)/);
  }
});

test("selection reads reserve connect and response time beyond both route budgets", () => {
  const dbNumber = (name) =>
    Number(
      dbBoundarySource
        .match(new RegExp(`export const ${name} = ([0-9_]+);`))?.[1]
        ?.replaceAll("_", ""),
    );
  const connectMs = Number(
    rustSource.match(
      /TOMVERSE_INTERNAL_CONNECT_TIMEOUT: Duration = Duration::from_secs\((\d+)\)/,
    )?.[1],
  ) * 1_000;
  const clientMs = Number(
    rustSource.match(
      /TOMVERSE_INTERNAL_SELECTION_READ_TIMEOUT: Duration = Duration::from_secs\((\d+)\)/,
    )?.[1],
  ) * 1_000;
  assert.match(
    rustSource,
    /api\.selection_read_timeout = TOMVERSE_INTERNAL_SELECTION_READ_TIMEOUT;/,
  );

  for (const [route, boundary, method] of [
    ["queue", "queueRead", "queue"],
    ["routing-snapshot", "routingSnapshot", "routing_snapshot"],
  ]) {
    const routeSource = readFileSync(
      join(process.cwd(), "app", "api", "internal", "amux", route, "route.ts"),
      "utf8",
    );
    const routeMs = Number(
      [...routeSource.matchAll(/^\s*\}, ([0-9_]+)\);\s*$/gm)]
        .at(-1)?.[1]?.replaceAll("_", ""),
    );
    const ceiling = Number(
      dbBoundarySource.match(
        new RegExp(`${boundary}: \\{[^}]*prismaCallCeiling: (\\d+)`, "s"),
      )?.[1],
    );
    const plannedBudget = ceiling *
      (dbNumber("AMUX_DB_STATEMENT_TIMEOUT_MS") +
        dbNumber("AMUX_DB_IDLE_TRANSACTION_TIMEOUT_MS")) +
      dbNumber("AMUX_DB_COMMIT_RESERVE_MS") +
      dbNumber("AMUX_DB_MAX_WAIT_MS");
    assert.ok(Number.isInteger(ceiling), boundary);
    assert.ok(Number.isInteger(routeMs), route);
    assert.ok(plannedBudget <= routeMs, `${route} planned DB-call budget exceeds route budget`);
    assert.ok(clientMs >= routeMs + connectMs + 1_000, `${route} client deadline is too short`);
    const start = rustSource.indexOf(`pub async fn ${method}(`);
    assert.ok(start >= 0, method);
    const next = rustSource.indexOf("\n    pub async fn ", start + 1);
    const source = rustSource.slice(start, next < 0 ? undefined : next);
    assert.match(source, /\.timeout\(self\.selection_read_timeout\)/);
  }
});

test("a production build cannot activate future execution with an environment flag", () => {
  const priorNodeEnv = process.env.NODE_ENV;
  const priorFlag = process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED;
  try {
    process.env.NODE_ENV = "production";
    process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED = "1";
    assert.equal(isAmuxExecutionApiEnabled(), false);
    process.env.NODE_ENV = "test";
    assert.equal(isAmuxExecutionApiEnabled(), true);
  } finally {
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorNodeEnv;
    if (priorFlag === undefined)
      delete process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED;
    else process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED = priorFlag;
  }
});

test("the Prisma-call limit is not presented as an SQL statement-count guarantee", () => {
  const readinessSource = readFileSync(
    join(process.cwd(), "docs", "ops", "amux", "staging-readiness.md"),
    "utf8",
  );
  const executionSource = readFileSync(
    join(process.cwd(), "lib", "amux", "execution.ts"),
    "utf8",
  );
  assert.doesNotMatch(dbBoundarySource, /statementCeiling/);
  assert.match(dbBoundarySource, /prismaCallCeiling/);
  assert.match(dbBoundarySource, /A single Prisma call can emit more than one SQL statement/);
  assert.doesNotMatch(dbBoundarySource, /set_config\(\s*'transaction_timeout'/);
  assert.match(readinessSource, /현재 코드는 `transaction_timeout`을 설정하지 않으므로/);
  assert.match(readinessSource, /PostgreSQL 17에서는 transaction\s+내부에서 설정한 순간부터/);
  assert.match(readinessSource, /PostgreSQL 16에는/);
  assert.match(readinessSource, /늦은 실행이 성공으로 기록되지 않음을 DB가 강제/);
  assert.match(readinessSource, /수 상한이나 전체 transaction 시간 상한 자체도 필수 조건이 아니다/);
  assert.match(dbBoundarySource, /executionHeartbeat: \{[\s\S]*?prismaCallCeiling: 10/);
  const heartbeat = executionSource.split("export async function heartbeatAmuxExecution")[1]
    ?.split("export async function settleAmuxExecution")[0];
  assert.ok(heartbeat);
  assert.match(heartbeat, /action: "amux\.execution\.lease_renewed"/);
  assert.match(heartbeat, /await writeSystemAuditLog\(\{[\s\S]*?tx,/);
});

test("routing response byte ceilings match and overflow refuses complete output", () => {
  const serverSource = readFileSync(
    join(process.cwd(), "lib", "amux", "internalRoute.ts"),
    "utf8",
  );
  const routeSource = readFileSync(
    join(process.cwd(), "app", "api", "internal", "amux", "routing-snapshot", "route.ts"),
    "utf8",
  );
  const serverKiB = Number(
    serverSource.match(/AMUX_INTERNAL_RESPONSE_MAX_BYTES = (\d+) \* 1_024/)?.[1],
  );
  const rustKiB = Number(
    rustSource.match(/MAX_ROUTING_RESPONSE_BYTES: usize = (\d+) \* 1024/)?.[1],
  );
  assert.equal(rustKiB, serverKiB);
  assert.match(routeSource, /error instanceof AmuxResponseCapacityError/);
  assert.match(routeSource, /reason: "board_capacity_exceeded"/);
});

test("unknown future-lifecycle outcomes stop the whole runtime run", () => {
  const runtimeSource = readFileSync(
    join(process.cwd(), "apps", "tomverse-orchestrator", "src", "runtime_service.rs"),
    "utf8",
  );
  const boardSource = readFileSync(
    join(process.cwd(), "apps", "tomverse-orchestrator", "src", "board_driver.rs"),
    "utf8",
  );
  assert.match(
    runtimeSource,
    /AMUX_WORKER_POLL_UNVERIFIED[\s\S]*?return Err\(anyhow!\(\s*"AMUX worker poll outcome unknown; process run dormant"\s*\)\)/,
  );
  assert.match(
    runtimeSource,
    /AMUX_BOARD_TICK_UNVERIFIED[\s\S]*?return Err\(anyhow!\(\s*"AMUX board tick outcome unknown; process run dormant"\s*\)\)/,
  );
  assert.match(boardSource, /AMUX_EXECUTION_START_OUTCOME_UNKNOWN/);
});
