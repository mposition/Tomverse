// Bookkeeping of reservations; knows nothing about stock levels.
export class Reservations {
    #items = new Map();
    #next = 1;

    constructor(clock) {
        this.clock = clock;
    }

    create(sku, qty, ttlMs) {
        const id = `r${this.#next++}`;
        this.#items.set(id, { id, sku, qty, expiresAt: this.clock.now() + ttlMs });
        return id;
    }

    isLive(item) {
        return this.clock.now() < item.expiresAt;
    }

    live(sku) {
        return [...this.#items.values()].filter((item) => item.sku === sku && this.isLive(item));
    }

    get(id) {
        return this.#items.get(id);
    }

    delete(id) {
        return this.#items.delete(id);
    }
}
