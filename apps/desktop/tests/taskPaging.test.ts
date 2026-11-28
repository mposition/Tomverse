import assert from "node:assert/strict";
import test from "node:test";
import { appendTaskPage, nextTaskPage, TASK_PAGE_SIZE } from "../src/host/taskPaging";

const rows = Array.from({ length: 53 }, (_, i) => ({
  id: `s-20261122-120000-${(53 - i).toString(16).padStart(6, "0")}`,
  title: `Task ${i}`, status: "completed",
}));

test("the next page continues after the last stable task ID", () => {
  const first = nextTaskPage(rows, null);
  assert.equal(first.items.length, TASK_PAGE_SIZE);
  const second = nextTaskPage(rows, first.cursor);
  assert.equal(second.cursor, null);
  assert.deepEqual([...first.items, ...second.items], rows);
});

test("inserting a new task or losing the cursor row does not reinsert old rows", () => {
  const first = nextTaskPage(rows, null);
  const changed = [{ id: "s-20261122-120009-000001", title: "new", status: "completed" }, ...rows.filter(({ id }) => id !== first.cursor)];
  assert.deepEqual(nextTaskPage(changed, first.cursor).items, rows.slice(TASK_PAGE_SIZE));
});

test("repeated pages update earlier rows without changing their order", () => {
  const first = rows[0]!;
  const updated = { ...first, status: "blocked" };
  assert.deepEqual(appendTaskPage(rows, [updated]), [updated, ...rows.slice(1)]);
});
