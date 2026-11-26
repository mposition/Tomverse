export class NotFoundError extends Error {
    constructor(id) {
        super(`record not found: ${id}`);
        this.name = "NotFoundError";
        this.id = id;
    }
}
