import { computeTotal } from "./totals.js";

export { computeTotal };
export { renderInvoice } from "./invoice.js";
export { dailyReport } from "./report.js";
export { checkout } from "./checkout.js";
export { calculators } from "./registry.js";

let warned = false;

/** @deprecated Use computeTotal. */
export function calcTotal(...args) {
    if (!warned) {
        warned = true;
        console.warn("calcTotal is deprecated; use computeTotal");
    }
    return computeTotal(...args);
}
