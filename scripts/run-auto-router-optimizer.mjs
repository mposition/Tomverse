// Runs the Auto router optimizer's daily cycle in its own process and waits
// for it to finish.
//
// The maintenance route used to start the cycle inside the web container and
// return; a redeploy's SIGTERM then cut the cycle off and its spend went
// unrecorded. The Auto Router Optimizer cron service runs this instead, once
// a day, when AUTO_ROUTER_OPTIMIZER_OWN_PROCESS is on (and the maintenance
// route then skips its optimizer step). Off, it does nothing.
//
// Usage:
//   npm run maintenance:auto-router-optimizer
//
// Which cycle runs, and whether one runs at all, is decided in the library:
// the routing and rewrite switches in Admin › Routing, one system cycle a day,
// the two targets in turn, the same caps and reservation as before. The
// output names the cycle, its status and its failure only -- no message text,
// no credentials, no database URL.
//
// Exit code: 0 when a cycle ran and recorded its result, or there was nothing
// to do; 1 when a started cycle could not record its result, the run threw,
// or the process deadline passed. At the deadline it exits without
// recording; the cycle row stays running and the next start closes it as
// interrupted (the stale close, 60 minutes, is later than the deadline).
//
// Requires DATABASE_URL, ADMIN_AUDIT_INTEGRITY_KEY (the web service's audit
// signing key) and the answering providers' API keys.

import {
  AUTO_ROUTER_OPTIMIZER_PROCESS_DEADLINE_MS,
  optimizerProcessExitCode,
  optimizerProcessRefusal,
} from "../lib/autoRouterOptimizerCore.ts";

const log = (event, fields = {}) =>
  console.log(JSON.stringify({ event, ...fields, at: new Date().toISOString() }));

// Off is nothing to do. Without the database, or without the audit signing
// key the web service signs with, the service is misconfigured: a cycle's
// system audit entries would otherwise be stored unsigned, outside the chain.
const refusal = optimizerProcessRefusal(process.env);
if (refusal === "off") {
  log("auto_router_optimizer_process_off");
  process.exit(0);
}
if (refusal) {
  log("auto_router_optimizer_process_refused", { reason: refusal });
  process.exit(1);
}

const deadline = setTimeout(() => {
  log("auto_router_optimizer_process_deadline", {
    deadlineMs: AUTO_ROUTER_OPTIMIZER_PROCESS_DEADLINE_MS,
  });
  process.exit(1);
}, AUTO_ROUTER_OPTIMIZER_PROCESS_DEADLINE_MS);
// The run below keeps the process alive; the timer alone must not.
deadline.unref();

const { runAutoRouterOptimizerCycleToCompletion } = await import(
  "../lib/autoRewriteOptimizer.ts"
);
const { prisma } = await import("../lib/prisma.ts");

try {
  const result = await runAutoRouterOptimizerCycleToCompletion();
  log("auto_router_optimizer_process_run", result);
  process.exitCode = optimizerProcessExitCode(result);
} catch (error) {
  log("auto_router_optimizer_process_failed", {
    reason: error instanceof Error ? error.name : "unknown",
  });
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await prisma.$disconnect();
}
