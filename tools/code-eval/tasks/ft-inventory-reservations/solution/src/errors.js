export class InsufficientStockError extends Error {
    constructor(sku, requested, available) {
        super(`not enough stock for ${sku}: requested ${requested}, available ${available}`);
        this.name = "InsufficientStockError";
        this.sku = sku;
        this.requested = requested;
        this.available = available;
    }
}

export class ReservationError extends Error {
    constructor(code, id) {
        super(`reservation ${id} is ${code}`);
        this.name = "ReservationError";
        this.code = code;
        this.id = id;
    }
}
