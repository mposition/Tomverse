import { percentOf } from "./money.js";

export function lineDiscount(lineSubtotal, discount) {
    if (!discount) return 0;
    if (discount.type === "percent") return percentOf(lineSubtotal, discount.value);
    if (discount.type === "fixed") return discount.value;
    throw new Error(`unknown discount type: ${discount.type}`);
}
