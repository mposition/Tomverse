export class InsufficientStockError extends Error {
    constructor(sku, requested, available) {
        super(`not enough stock for ${sku}: requested ${requested}, available ${available}`);
        this.name = "InsufficientStockError";
        this.sku = sku;
        this.requested = requested;
        this.available = available;
    }
}
