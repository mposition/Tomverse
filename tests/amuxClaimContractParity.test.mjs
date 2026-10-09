import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { AMUX_CLAIM_CLOSED_REFUSAL_REASONS } from "../lib/amux/auditContract.ts";
import {
  AMUX_EXECUTION_API_CODE_LATCH,
  amuxExecutionApiPermitted,
  isAmuxExecutionApiEnabled,
} from "../lib/amux/executionGate.ts";

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
  assert.ok(rustVersion);
  for (const version of [
    "amux-worker-router-v1",
    "amux-worker-router-v2",
    "amux-global-priority-v1",
    rustVersion,
  ]) {
    assert.match(contractSource, new RegExp(`"${version}"`));
  }
  assert.match(schedulerSource, /let worker_router_version = if server_v2 \{/);
  assert.match(schedulerSource, /"amux-worker-router-v2"/);
  assert.match(rustSource, /scoring_version: scoring_version\.to_owned\(\)/);
  assert.match(
    schedulerSource,
    /score\.total\(\),\s*scoring_version,\s*signals/s,
  );

  const schedulerMaximum =
    10_000 + 1_000_000 + 40 + 40 + 5_000_000 + 8 + 240 + 20 + 80;
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
  const budget = (profile) =>
    profileCallCeiling(profile) * perCallPlanningFactor + reserve;
  const threeTransactions = ["claimRouteClock", "routingSnapshot", "claim"];
  // The route was sized with a 250 ms connection wait per transaction (the
  // maxWait until 2026-09-30). The wait is now capped by the route's slack
  // (amuxDbConnectionWaitMs), so a longer one comes out of that slack and can
  // never make the route answer later; the sizing still has to hold.
  const sizingWaitMs = 250;
  const plannedDbCallBudgetMs = threeTransactions.reduce(
    (sum, profile) => sum + budget(profile) + sizingWaitMs,
    0,
  );

  // Orchestration policy version 20: an admitted claim adds its admission
  // transaction before these three, and one admission-lock call to the claim
  // transaction itself. That route has to fit as well.
  const admissionBudgetMs = dbNumber("AMUX_ORCHESTRATOR_ADMISSION_BUDGET_MS");
  const admissionLockCalls = dbNumber("AMUX_ORCHESTRATOR_ADMISSION_LOCK_CALLS");
  assert.equal(admissionLockCalls, 1);
  assert.ok(admissionBudgetMs > 0);
  const admittedPlannedMs =
    plannedDbCallBudgetMs +
    admissionBudgetMs +
    sizingWaitMs +
    admissionLockCalls * perCallPlanningFactor;
  assert.ok(
    admittedPlannedMs <= routeMs,
    `an admitted claim plans ${admittedPlannedMs} ms against a ${routeMs} ms route`,
  );

  assert.ok(Number.isFinite(plannedDbCallBudgetMs));
  assert.ok(
    plannedDbCallBudgetMs <= routeMs,
    "the anchored route must fit its three planned Prisma-call budgets",
  );
  // 8,700 ms of budgets: the first transaction may wait the whole maximum.
  assert.equal(maxWait, 2_000);
  assert.ok(
    Math.min(maxWait, routeMs - budget("claimRouteClock")) === maxWait,
    "the claim route's first transaction gets the full connection wait",
  );
  assert.match(dbBoundarySource, /maxWait: connectionWaitMs,/);
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
  const connectMs =
    Number(
      rustSource.match(
        /TOMVERSE_INTERNAL_CONNECT_TIMEOUT: Duration = Duration::from_secs\((\d+)\)/,
      )?.[1],
    ) * 1_000;
  const clientMs =
    Number(
      rustSource.match(
        /TOMVERSE_INTERNAL_LIFECYCLE_TIMEOUT: Duration = Duration::from_secs\((\d+)\)/,
      )?.[1],
    ) * 1_000;
  assert.ok(clientMs >= routeMs + connectMs + 1_000);
  // A transaction never starts later than its route's deadline less its
  // budget (the capped connection wait), and Prisma closes it at most the
  // slack after that budget: the server answers within the route budget plus
  // the slack, which the one-second transport reserve above covers.
  assert.equal(value("AMUX_DB_TRANSACTION_TIMEOUT_SLACK_MS"), 300);
  assert.ok(value("AMUX_DB_TRANSACTION_TIMEOUT_SLACK_MS") < 1_000);
  assert.match(
    dbBoundarySource,
    /timeout: transactionBudgetMs \+ AMUX_DB_TRANSACTION_TIMEOUT_SLACK_MS,/,
  );
  // Every lifecycle boundary fits its budget and the full 2,000 ms wait in
  // the 12 s route (the largest, execution start, is 9,200 + 2,000).
  assert.equal(value("AMUX_DB_MAX_WAIT_MS"), 2_000);

  const endpoints = [
    ["workers/register", ["workerRegister"], "worker_register"],
    ["workers/heartbeat", ["workerHeartbeat"], "worker_heartbeat"],
    ["delivery/pull", ["deliveryPull"], "delivery_pull"],
    ["delivery/ack", ["deliveryAck"], "delivery_ack"],
    ["execution/start", ["executionStart"], "execution_start"],
    ["execution/heartbeat", ["executionHeartbeat"], "execution_heartbeat"],
    // execution_settle delegates to this one, which makes the HTTP call.
    ["execution/settle", ["executionSettle"], "execution_settle_with_review_pr"],
    [
      "execution/recover",
      [
        "quotaObservationSweep",
        "executionRecoveryRead",
        "executionRecoveryWrite",
        "ownershipRecoveryRead",
        "ownershipRecoveryWrite",
      ],
      "execution_recover",
    ],
    // Orchestration policy version 20: the acknowledgement, and the halt
    // record and state read with the resolver that runs first.
    ["orchestrator/ack", ["orchestratorAck"], "orchestrator_ack"],
    [
      "orchestrator/halt",
      [
        "orchestratorResolveCandidates",
        "orchestratorResolve",
        "orchestratorHaltStateRead",
        "orchestratorHaltOpen",
      ],
      "orchestrator_halt_state",
    ],
  ];
  for (const [route, boundaries, method] of endpoints) {
    for (const boundary of boundaries) {
      const declared = Number(
        dbBoundarySource.match(
          new RegExp(`${boundary}: \\{[^}]*prismaCallCeiling: (\\d+)`, "s"),
        )?.[1],
      );
      assert.ok(Number.isInteger(declared), boundary);
      // An admitted write's mutation adds its admission lock
      // (AMUX_ORCHESTRATOR_ADMISSION_LOCK_CALLS); every boundary is held to
      // that wider figure, which bounds both.
      const ceiling = declared + value("AMUX_ORCHESTRATOR_ADMISSION_LOCK_CALLS");
      const plannedBudget =
        ceiling *
          (value("AMUX_DB_STATEMENT_TIMEOUT_MS") +
            value("AMUX_DB_IDLE_TRANSACTION_TIMEOUT_MS")) +
        value("AMUX_DB_COMMIT_RESERVE_MS") +
        value("AMUX_DB_MAX_WAIT_MS");
      assert.ok(
        plannedBudget <= routeMs,
        `${route}/${boundary} planned DB-call budget exceeds route budget`,
      );
    }
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

  // The plain settle carries no request of its own: it only forwards.
  const settleStart = rustSource.indexOf("pub async fn execution_settle(");
  const settleEnd = rustSource.indexOf("\n    pub async fn ", settleStart + 1);
  const settle = rustSource.slice(settleStart, settleEnd);
  assert.match(settle, /self\.execution_settle_with_review_pr\(/);
  assert.doesNotMatch(settle, /\.send\(\)/);
});

test("selection reads reserve connect and response time beyond both route budgets", () => {
  const dbNumber = (name) =>
    Number(
      dbBoundarySource
        .match(new RegExp(`export const ${name} = ([0-9_]+);`))?.[1]
        ?.replaceAll("_", ""),
    );
  const connectMs =
    Number(
      rustSource.match(
        /TOMVERSE_INTERNAL_CONNECT_TIMEOUT: Duration = Duration::from_secs\((\d+)\)/,
      )?.[1],
    ) * 1_000;
  const clientMs =
    Number(
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
        .at(-1)?.[1]
        ?.replaceAll("_", ""),
    );
    const ceiling = Number(
      dbBoundarySource.match(
        new RegExp(`${boundary}: \\{[^}]*prismaCallCeiling: (\\d+)`, "s"),
      )?.[1],
    );
    const transactionBudget =
      ceiling *
        (dbNumber("AMUX_DB_STATEMENT_TIMEOUT_MS") +
          dbNumber("AMUX_DB_IDLE_TRANSACTION_TIMEOUT_MS")) +
      dbNumber("AMUX_DB_COMMIT_RESERVE_MS");
    assert.ok(Number.isInteger(ceiling), boundary);
    assert.ok(Number.isInteger(routeMs), route);
    // The 2,000 ms maximum does not fit a 2.8 s selection route: the wait is
    // capped by the route's slack (amuxDbConnectionWaitMs), 800 ms for the
    // queue and 500 ms for the routing snapshot, still at least twice the
    // 250 ms that failed in production.
    const connectionWaitMs = Math.min(
      dbNumber("AMUX_DB_MAX_WAIT_MS"),
      routeMs - transactionBudget,
    );
    assert.ok(
      connectionWaitMs >= 500,
      `${route} leaves ${connectionWaitMs} ms to wait for a connection`,
    );
    assert.ok(
      clientMs >= routeMs + connectMs + 1_000,
      `${route} client deadline is too short`,
    );
    const start = rustSource.indexOf(`pub async fn ${method}(`);
    assert.ok(start >= 0, method);
    const next = rustSource.indexOf("\n    pub async fn ", start + 1);
    const source = rustSource.slice(start, next < 0 ? undefined : next);
    assert.match(source, /\.timeout\(self\.selection_read_timeout\)/);
  }
});

test("the execution API opens on the code latch and the flag, in any NODE_ENV", () => {
  // Policy version 18.
  assert.equal(AMUX_EXECUTION_API_CODE_LATCH, true);
  assert.equal(amuxExecutionApiPermitted(false, "1"), false);
  assert.equal(amuxExecutionApiPermitted(true, "1"), true);
  assert.equal(amuxExecutionApiPermitted(true, " 1 "), true);
  for (const value of [undefined, "", "0", "true", "enabled", "11"]) {
    assert.equal(amuxExecutionApiPermitted(true, value), false, String(value));
  }
  const priorNodeEnv = process.env.NODE_ENV;
  const priorFlag = process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED;
  try {
    process.env.NODE_ENV = "production";
    process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED = "1";
    assert.equal(isAmuxExecutionApiEnabled(), true);
    delete process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED;
    assert.equal(isAmuxExecutionApiEnabled(), false);
    process.env.NODE_ENV = "test";
    assert.equal(isAmuxExecutionApiEnabled(), false);
    // NODE_ENV=test is not a special case either way.
    process.env.TOMVERSE_AMUX_EXECUTION_API_ENABLED = "1";
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
  assert.match(
    dbBoundarySource,
    /A single Prisma call can emit more than one SQL statement/,
  );
  assert.doesNotMatch(dbBoundarySource, /set_config\(\s*'transaction_timeout'/);
  assert.match(
    readinessSource,
    /현재 코드는 `transaction_timeout`을 설정하지 않으므로/,
  );
  assert.match(
    readinessSource,
    /PostgreSQL 17에서는 transaction\s+내부에서 설정한 순간부터/,
  );
  assert.match(readinessSource, /PostgreSQL 16에는/);
  assert.match(
    readinessSource,
    /늦은 실행이 성공으로 기록되지 않음을 DB가 강제/,
  );
  assert.match(
    readinessSource,
    /수 상한이나 전체 transaction 시간 상한 자체도 필수 조건이 아니다/,
  );
  assert.match(
    dbBoundarySource,
    /executionHeartbeat: \{[\s\S]*?prismaCallCeiling: 10/,
  );
  const heartbeat = executionSource
    .split("async function heartbeatAmuxExecutionBound(")[1]
    ?.split("export const heartbeatAmuxExecution")[0];
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
    join(
      process.cwd(),
      "app",
      "api",
      "internal",
      "amux",
      "routing-snapshot",
      "route.ts",
    ),
    "utf8",
  );
  const serverKiB = Number(
    serverSource.match(
      /AMUX_INTERNAL_RESPONSE_MAX_BYTES = (\d+) \* 1_024/,
    )?.[1],
  );
  const rustKiB = Number(
    rustSource.match(/MAX_ROUTING_RESPONSE_BYTES: usize = (\d+) \* 1024/)?.[1],
  );
  assert.equal(rustKiB, serverKiB);
  assert.match(routeSource, /error instanceof AmuxResponseCapacityError/);
  assert.match(routeSource, /reason: "board_capacity_exceeded"/);
});

test("TypeScript and Rust share the database-busy reason and its exact body", async () => {
  const { AMUX_DATABASE_BUSY_REASON } = await import("../lib/amux/readFailureCore.ts");
  assert.match(
    rustSource,
    new RegExp(`pub const DATABASE_BUSY: &str = "${AMUX_DATABASE_BUSY_REASON}";`),
  );
  const route = readFileSync(join(process.cwd(), "lib", "amux", "internalRoute.ts"), "utf8");
  assert.match(
    route,
    /error: "AMUX database is busy\.",\s*reason: AMUX_DATABASE_BUSY_REASON,\s*\}\),\s*\{\s*status: 503,/,
  );
  // The body the server sends (tests/server-contract/amux-commit-deadline-boundary.test.ts
  // holds the server to it) is the literal every Rust test parses.
  const body = JSON.stringify({ error: "AMUX database is busy.", reason: AMUX_DATABASE_BUSY_REASON });
  for (const file of ["tomverse_api.rs", "scheduler.rs", "wsl_bridge.rs"]) {
    const source = readFileSync(
      join(process.cwd(), "apps", "tomverse-orchestrator", "src", file),
      "utf8",
    );
    assert.ok(source.includes(`r#"${body}"#`), file);
  }
  // The selection reads skip a tick on it, uncounted. Since orchestration
  // policy version 20 the claim, the recovery sweep and the automatic
  // promotion tick treat it -- and the other two "nothing committed" 503
  // reasons -- as a known answer, acknowledged `no_commit`; every other answer
  // halts instead of ending the process.
  assert.match(
    schedulerSource,
    /Ok\(SelectionRead::DatabaseBusy\) => SelectionClass::Uncounted\(DATABASE_BUSY\),/,
  );
  assert.match(schedulerSource, /self\.handle_selection_read\("queue", queue_result\)/);
  assert.match(
    schedulerSource,
    /self\.handle_selection_read\("routing_snapshot", snapshot_result\)/,
  );
  assert.match(schedulerSource, /Settled::NothingCommitted\(reason\) => \{[\s\S]*?verdict = "claim_skipped"[\s\S]*?return Flow::Continue;/);
  assert.match(schedulerSource, /Settled::NothingCommitted\(reason\) => \{[\s\S]*?verdict = "recovery_skipped"/);
  assert.match(schedulerSource, /self\.open_halt\(kind\.unknown_outcome\(\), request_id, Some\(request_id\), class\);/);
  assert.doesNotMatch(schedulerSource, /anyhow::anyhow!\("AMUX_CLAIM_OUTCOME_UNKNOWN"\)/);
  assert.doesNotMatch(schedulerSource, /anyhow::anyhow!\("AMUX_RECOVERY_OUTCOME_UNKNOWN"\)/);
  assert.match(schedulerSource, /fn an_answer_outside_section_1_halts_before_the_next_write_and_is_never_acknowledged\(/);
  // Only the exact body at 503 is the busy answer, a typed error a caller
  // must ask for: a caller that does not still stops.
  assert.match(rustSource, /pub fn is_database_busy\(error: &anyhow::Error\) -> bool/);
  assert.match(rustSource, /if is_database_busy_body\(&body\) \{\s*anyhow::Error::new\(DatabaseBusy\)/);
});

test("unknown future-lifecycle outcomes stop the whole runtime run", () => {
  const runtimeSource = readFileSync(
    join(
      process.cwd(),
      "apps",
      "tomverse-orchestrator",
      "src",
      "runtime_service.rs",
    ),
    "utf8",
  );
  const boardSource = readFileSync(
    join(
      process.cwd(),
      "apps",
      "tomverse-orchestrator",
      "src",
      "board_driver.rs",
    ),
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

test("the auto-promotion client deadline outlives the tick's DB-clock route budget", async () => {
  const { AUTO_TICK_ROUTE_BUDGET_MS } = await import("../lib/amux/autoPromotionCore.ts");
  const seconds = (name) =>
    Number(
      rustSource.match(
        new RegExp(`${name}: Duration = Duration::from_secs\\((\\d+)\\)`),
      )?.[1],
    ) * 1_000;
  const connectMs = seconds("TOMVERSE_INTERNAL_CONNECT_TIMEOUT");
  const clientMs = seconds("TOMVERSE_INTERNAL_AUTO_PROMOTION_TIMEOUT");
  assert.ok(Number.isFinite(clientMs) && Number.isFinite(connectMs));
  // The Rust test pins its own copy of the budget; it must be this one.
  assert.equal(seconds("AUTO_PROMOTION_ROUTE_BUDGET"), AUTO_TICK_ROUTE_BUDGET_MS);
  assert.ok(
    clientMs >= AUTO_TICK_ROUTE_BUDGET_MS + connectMs + 1_000,
    "the tick client must reserve a second beyond route and connect",
  );
  const start = rustSource.indexOf("pub async fn auto_promotion_tick(");
  assert.ok(start >= 0);
  const next = rustSource.indexOf("\n    pub async fn ", start + 1);
  assert.match(
    rustSource.slice(start, next),
    /\.timeout\(TOMVERSE_INTERNAL_AUTO_PROMOTION_TIMEOUT\)/,
  );
  // A client timeout is unknown only on the client side; the server does not
  // record it, and the comment must not say it does.
  const doc = rustSource.slice(
    rustSource.lastIndexOf("///", rustSource.indexOf("pub const TOMVERSE_INTERNAL_AUTO_PROMOTION_TIMEOUT")) - 2_000,
    rustSource.indexOf("pub const TOMVERSE_INTERNAL_AUTO_PROMOTION_TIMEOUT"),
  );
  assert.doesNotMatch(doc, /server records it on its side/);
  assert.doesNotMatch(doc, /runs\s+one transaction/);
  const route = readFileSync(
    join(process.cwd(), "app", "api", "internal", "amux", "auto-promotion", "tick", "route.ts"),
    "utf8",
  );
  assert.match(route, /\}, AUTO_TICK_ROUTE_BUDGET_MS\);/);
});

test("TypeScript and Rust keep one closed AMUX claim refusal vocabulary", () => {
  const [contract, rust, route, store, routing] = [
    "lib/amux/auditContract.ts",
    "apps/tomverse-orchestrator/src/tomverse_api.rs",
    "app/api/internal/amux/claim/route.ts",
    "lib/amux/store.ts",
    "lib/amux/routing.ts",
  ].map((path) => readFileSync(path, "utf8"));

  for (const reason of AMUX_CLAIM_CLOSED_REFUSAL_REASONS) {
    assert.match(contract, new RegExp(`"${reason}"`), reason);
    assert.match(rust, new RegExp(`"${reason}"`), reason);
  }

  assert.match(rust, /reason: Option<ClaimRefusalReason>/);
  assert.match(route, /claim\.reason === "cas_lost"/);
  assert.match(route, /recordAmuxClaimRefusal\("invalid_request"\)/);
  assert.match(store, /reason: "incident_admission_blocked" as const/);
  assert.match(store, /reason: "wip_limit_reached" as const/);
  // One open card per worker; the refusal reuses the closed vocabulary so the
  // Rust wire enum needs no new variant.
  assert.match(store, /reason: "execution_lifecycle_unavailable" as const/);
  assert.ok(store.includes('status: { in: ["todo", "doing"] }'));
  // The router agrees, so a tick does not re-select a worker the claim refuses:
  // both the readiness summary and each candidate exclude busy owners.
  assert.equal(routing.split("!busyOwners.has(worker.worker_name)").length - 1, 2);
  assert.match(store, /AMUX_DB_BOUNDARIES\.claim/);
  assert.match(store, /AMUX_DB_BOUNDARIES\.claimRefusal/);
  assert.match(store, /action: "amux\.claim\.refused"/);
  assert.match(store, /measured: true/);
  assert.match(store, /verdict: "refused"/);
});
