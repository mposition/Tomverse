export function createHandler(service) {
    return function handle(request) {
        try {
            const found = /^\/users\/(\d+)$/.exec(request.path);
            if (request.method === "GET" && found) return { status: 200, body: service.getUser(Number(found[1])) };
            if (request.method === "POST" && request.path === "/users") return { status: 201, body: service.registerUser(request.body) };
            return { status: 404, body: { error: "no such route" } };
        } catch (error) {
            return { status: 500, body: { error: error.message } };
        }
    };
}
