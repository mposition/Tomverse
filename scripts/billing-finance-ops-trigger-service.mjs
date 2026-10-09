// The billing-finance-ops stage W trigger's entry point
// (docs/policy/billing-finance-ops.md §1.1, §1.3, §4). Railway runs it with
// `node --experimental-strip-types scripts/billing-finance-ops-trigger-service.mjs`
// (never through npm, which adds variables the start check refuses). It holds
// the run secret, the dead-man signal URL and its deployment setting, and
// nothing else. All decisions are in lib/billingFinanceOpsServiceCore.ts; this
// file connects the two network ports and the hard timeout.
//
// Requests follow no redirect and time out. The output is the outcome code --
// never a header, the secret, the signal URL or a body.

import { runBillingFinanceOpsService } from "../lib/billingFinanceOpsServiceCore.ts";

// §4: the whole run is bounded at 90 s, the route call at 70 s (strictly past
// the route's 60 s maxDuration) and the signal at 10 s.
const HARD_TIMEOUT_MS = 90_000;
const RUN_TIMEOUT_MS = 70_000;
const SIGNAL_TIMEOUT_MS = 10_000;

const supervisor = setTimeout(() => {
  console.log(JSON.stringify({ exitCode: 1, outcome: "hard_timeout" }));
  process.exit(1);
}, HARD_TIMEOUT_MS);

const result = await runBillingFinanceOpsService(process.env, {
  post: async (url, headers) => {
    const response = await fetch(url, {
      method: "POST",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  },
  signal: async (url) => {
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(SIGNAL_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return { status: response.status };
  },
});

clearTimeout(supervisor);
console.log(JSON.stringify(result));
process.exitCode = result.exitCode;
