import { test } from "node:test";
import assert from "node:assert/strict";
import { UserRepo, UserService, createHandler } from "../src/index.js";

const handler = () => createHandler(new UserService(new UserRepo()));

test("registers and fetches a user", () => {
    const handle = handler();
    const created = handle({ method: "POST", path: "/users", body: { name: " Ann ", email: "Ann@Example.com" } });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body, { id: 1, name: "Ann", email: "ann@example.com" });
    assert.deepEqual(handle({ method: "GET", path: "/users/1" }), { status: 200, body: created.body });
});
