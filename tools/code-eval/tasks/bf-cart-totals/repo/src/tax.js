import { percentOf } from "./money.js";

export function taxFor(amountCents, ratePercent) {
    return percentOf(amountCents, ratePercent);
}
