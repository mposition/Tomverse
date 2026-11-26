export class ValidationError extends Error {
    constructor(field, message) {
        super(message);
        this.name = "ValidationError";
        this.field = field;
    }
}

export class NotFoundError extends Error {
    constructor(id) {
        super(`todo ${id} not found`);
        this.name = "NotFoundError";
        this.id = id;
    }
}
