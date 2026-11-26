import { systemClock } from "./clock.js";
import { InsufficientStockError } from "./errors.js";

export class Inventory {
    #stock = new Map();

    constructor({ clock = systemClock } = {}) {
        this.clock = clock;
    }

    onHand(sku) {
        return this.#stock.get(sku) ?? 0;
    }

    add(sku, qty) {
        this.#stock.set(sku, this.onHand(sku) + qty);
    }

    remove(sku, qty) {
        const have = this.onHand(sku);
        if (qty > have) throw new InsufficientStockError(sku, qty, have);
        this.#stock.set(sku, have - qty);
    }
}
