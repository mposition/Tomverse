import { calcTotal } from "./totals.js";

// Calculators by name, for callers that pick one at run time.
export const calculators = {
    calcTotal,
    default: calcTotal,
};
