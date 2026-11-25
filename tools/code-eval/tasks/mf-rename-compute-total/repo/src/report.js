import { calcTotal as total } from "./totals.js";

// Revenue per day: orders look like { date, items, options }.
export function dailyReport(orders) {
    const days = {};
    for (const order of orders) {
        days[order.date] = (days[order.date] ?? 0) + total(order.items, order.options);
    }
    return days;
}
