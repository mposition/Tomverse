import { computeTotal } from "./totals.js";

// Calculators by name, for callers that pick one at run time.
export const calculators = {
    computeTotal,
    default: computeTotal,
};
