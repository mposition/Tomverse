// Prints the deadline marks for the pending-price register.
//
// Usage:
//   npm run report:pending-price-deadlines
//
// Reads only the tracked source of this checkout. No credentials, no network,
// nothing written; the result is stdout and the exit code (0 quiet, 2 notice or
// register_invalid). A run that ends without a `verdict=` line failed -- it is
// not "nothing to report". Contract: docs/policy/billing-finance-ops.md
// section 2; the rules live in report-pending-price-deadlines-core.mjs.

import { AVAILABLE_MODELS } from "../lib/models.ts";
import { PENDING_VERIFIED_PRICE_REGISTER } from "../lib/modelPricing.ts";
import { buildPendingPriceDeadlineReport } from "./report-pending-price-deadlines-core.mjs";

const report = buildPendingPriceDeadlineReport({
    register: PENDING_VERIFIED_PRICE_REGISTER,
    models: AVAILABLE_MODELS,
    now: new Date(),
});

process.stdout.write(`${report.lines.join("\n")}\n`);
process.exitCode = report.exitCode;
