import { systemClock } from "./clock.js";
import { InsufficientStockError, ReservationError } from "./errors.js";
import { Reservations } from "./reservations.js";

const positiveInt = (qty) => {
    if (!Number.isInteger(qty) || qty <= 0) throw new RangeError("quantity must be a positive integer");
};

export class Inventory {
    #stock = new Map();
    #reservations;

    constructor({ clock = systemClock } = {}) {
        this.clock = clock;
        this.#reservations = new Reservations(clock);
    }

    onHand(sku) {
        return this.#stock.get(sku) ?? 0;
    }

    reservedQty(sku) {
        return this.#reservations.live(sku).reduce((sum, item) => sum + item.qty, 0);
    }

    available(sku) {
        return this.onHand(sku) - this.reservedQty(sku);
    }

    add(sku, qty) {
        positiveInt(qty);
        this.#stock.set(sku, this.onHand(sku) + qty);
    }

    remove(sku, qty) {
        positiveInt(qty);
        const have = this.available(sku);
        if (qty > have) throw new InsufficientStockError(sku, qty, have);
        this.#stock.set(sku, this.onHand(sku) - qty);
    }

    reserve(sku, qty, { ttlMs = 900000 } = {}) {
        positiveInt(qty);
        const have = this.available(sku);
        if (qty > have) throw new InsufficientStockError(sku, qty, have);
        return this.#reservations.create(sku, qty, ttlMs);
    }

    release(id) {
        const item = this.#reservations.get(id);
        if (!item || !this.#reservations.isLive(item)) return false;
        return this.#reservations.delete(id);
    }

    commit(id) {
        const item = this.#reservations.get(id);
        if (!item) throw new ReservationError("unknown", id);
        if (!this.#reservations.isLive(item)) throw new ReservationError("expired", id);
        this.#reservations.delete(id);
        this.#stock.set(item.sku, this.onHand(item.sku) - item.qty);
    }
}
