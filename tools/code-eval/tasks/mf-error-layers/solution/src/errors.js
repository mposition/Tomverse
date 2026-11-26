export class AppError extends Error {
    constructor(message, { status = 500, code = "internal" } = {}) {
        super(message);
        this.name = new.target.name;
        this.status = status;
        this.code = code;
    }
}

export class ValidationError extends AppError {
    constructor(field, message) {
        super(message, { status: 400, code: "invalid_input" });
        this.field = field;
    }
}

export class NotFoundError extends AppError {
    constructor(resource, id) {
        super(`${resource} ${id} not found`, { status: 404, code: "not_found" });
        this.resource = resource;
        this.id = id;
    }
}

export class ConflictError extends AppError {
    constructor(message) {
        super(message, { status: 409, code: "conflict" });
    }
}
