import { test } from "node:test";
import assert from "node:assert/strict";
import { AppError, ConflictError, NotFoundError, UserRepo, UserService, ValidationError, createHandler } from "../src/index.js";

const setup = () => {
    const service = new UserService(new UserRepo());
    return { service, handle: createHandler(service) };
};
const post = (handle, body) => handle({ method: "POST", path: "/users", body });

test("error classes", () => {
    const base = new AppError("boom", { status: 418, code: "teapot" });
    assert.equal(base.status, 418);
    assert.equal(base.code, "teapot");
    const validation = new ValidationError("email", "email is invalid");
    assert.ok(validation instanceof AppError && validation instanceof Error);
    assert.deepEqual([validation.status, validation.code, validation.field, validation.name], [400, "invalid_input", "email", "ValidationError"]);
    const missing = new NotFoundError("user", 7);
    assert.ok(missing instanceof AppError);
    assert.deepEqual([missing.status, missing.code, missing.message, missing.resource, missing.id, missing.name], [404, "not_found", "user 7 not found", "user", 7, "NotFoundError"]);
    const conflict = new ConflictError("taken");
    assert.ok(conflict instanceof AppError);
    assert.deepEqual([conflict.status, conflict.code, conflict.message, conflict.name], [409, "conflict", "taken", "ConflictError"]);
});

test("the service throws typed errors", () => {
    const { service } = setup();
    assert.throws(() => service.getUser(5), (e) => e instanceof NotFoundError && e.resource === "user" && e.id === 5);
    assert.throws(() => service.registerUser({ name: " ", email: "a@b.c" }), (e) => e instanceof ValidationError && e.field === "name" && e.message === "name is required");
    assert.throws(() => service.registerUser({ name: "A", email: "nope" }), (e) => e instanceof ValidationError && e.field === "email" && e.message === "email is invalid");
    service.registerUser({ name: "A", email: "a@b.c" });
    assert.throws(() => service.registerUser({ name: "B", email: "A@B.C" }), (e) => e instanceof ConflictError && e.message === "email already registered");
});

test("success responses are unchanged", () => {
    const { handle } = setup();
    const created = post(handle, { name: " Ann ", email: "Ann@Example.com" });
    assert.deepEqual(created, { status: 201, body: { id: 1, name: "Ann", email: "ann@example.com" } });
    assert.deepEqual(handle({ method: "GET", path: "/users/1" }), { status: 200, body: created.body });
});

test("a missing user is 404", () => {
    const { handle } = setup();
    assert.deepEqual(handle({ method: "GET", path: "/users/42" }), { status: 404, body: { error: { code: "not_found", message: "user 42 not found" } } });
});

test("invalid input is 400 with the field", () => {
    const { handle } = setup();
    assert.deepEqual(post(handle, { name: "", email: "a@b.c" }), { status: 400, body: { error: { code: "invalid_input", message: "name is required", field: "name" } } });
    assert.deepEqual(post(handle, { name: "A", email: "x" }), { status: 400, body: { error: { code: "invalid_input", message: "email is invalid", field: "email" } } });
    assert.equal(post(handle, undefined).status, 400);
});

test("a duplicate e-mail is 409", () => {
    const { handle } = setup();
    post(handle, { name: "A", email: "a@b.c" });
    assert.deepEqual(post(handle, { name: "B", email: "a@b.c" }), { status: 409, body: { error: { code: "conflict", message: "email already registered" } } });
});

test("unknown routes are 404", () => {
    const { handle } = setup();
    const expected = { status: 404, body: { error: { code: "not_found", message: "no such route" } } };
    assert.deepEqual(handle({ method: "GET", path: "/nope" }), expected);
    assert.deepEqual(handle({ method: "DELETE", path: "/users/1" }), expected);
    assert.deepEqual(handle({ method: "GET", path: "/users/abc" }), expected);
});

test("unexpected errors are 500 and never leak their message", () => {
    const secret = "db password is hunter2";
    const handle = createHandler({
        getUser() {
            throw new TypeError(secret);
        },
        registerUser() {
            throw new Error(secret);
        },
    });
    for (const request of [{ method: "GET", path: "/users/1" }, { method: "POST", path: "/users", body: {} }]) {
        const response = handle(request);
        assert.deepEqual(response, { status: 500, body: { error: { code: "internal", message: "internal error" } } });
        assert.ok(!JSON.stringify(response).includes("hunter2"));
    }
});

test("an AppError from any source keeps its own status and code", () => {
    const handle = createHandler({
        getUser() {
            throw new AppError("slow down", { status: 429, code: "rate_limited" });
        },
    });
    assert.deepEqual(handle({ method: "GET", path: "/users/1" }), { status: 429, body: { error: { code: "rate_limited", message: "slow down" } } });
});
