import { AppError } from "./errors.js";

const failure = (status, code, message, extra = {}) => ({ status, body: { error: { code, message, ...extra } } });

export function createHandler(service) {
    return function handle(request) {
        try {
            const found = /^\/users\/(\d+)$/.exec(request.path);
            if (request.method === "GET" && found) return { status: 200, body: service.getUser(Number(found[1])) };
            if (request.method === "POST" && request.path === "/users") return { status: 201, body: service.registerUser(request.body) };
            return failure(404, "not_found", "no such route");
        } catch (error) {
            if (error instanceof AppError) return failure(error.status, error.code, error.message, error.field ? { field: error.field } : {});
            return failure(500, "internal", "internal error");
        }
    };
}
