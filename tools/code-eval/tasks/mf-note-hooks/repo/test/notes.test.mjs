import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStorage, NotFoundError, NotesService, ValidationError, fixedClock } from "../src/index.js";

const service = () => new NotesService({ storage: new MemoryStorage(), clock: fixedClock("2024-01-01T00:00:00.000Z") });

test("create, update, remove", async () => {
    const notes = service();
    const note = await notes.create({ title: " First ", body: "hello" });
    assert.deepEqual(note, { id: "n1", title: "First", body: "hello", createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z" });
    assert.equal((await notes.update("n1", { body: "changed", ignored: 1 })).body, "changed");
    await notes.remove("n1");
    assert.equal(await notes.get("n1"), undefined);
    await assert.rejects(notes.remove("n1"), NotFoundError);
});

test("validation", async () => {
    await assert.rejects(service().create({ title: "  " }), ValidationError);
});
