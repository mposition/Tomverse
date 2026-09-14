// An unread notification list is not an empty one.
//
// The drawer set rows only on a 2xx and said nothing otherwise, so any failure
// left it at `[]` and it rendered "No notification records." -- a statement of
// fact assembled out of never having read one, on the surface an operator
// opens first when something is wrong.
//
// The branch order is the fix and the branch order is what is tested: an
// unreadable response must be classified before the row count is consulted,
// because a failed read holds no rows and would otherwise look empty.

import assert from "node:assert/strict";
import test from "node:test";
import {
  adminAlertsDrawerView,
  adminAlertsShouldFetch,
} from "../lib/adminAlertsDrawer.ts";

test("a server refusal is unreadable, never empty", () => {
  for (const status of [403, 429, 500, 503]) {
    const view = adminAlertsDrawerView({
      loading: false,
      failure: { reason: "status", status },
      rowCount: 0,
    });
    assert.equal(view.kind, "unreadable", `status ${status}`);
    assert.deepEqual(view.failure, { reason: "status", status });
  }
});

test("a request that never reached the server is unreadable, never empty", () => {
  const view = adminAlertsDrawerView({
    loading: false,
    failure: { reason: "network" },
    rowCount: 0,
  });
  assert.equal(view.kind, "unreadable");
  assert.equal(view.failure.reason, "network");
});

test("a clean read with no records is the only thing that says empty", () => {
  assert.equal(
    adminAlertsDrawerView({ loading: false, failure: null, rowCount: 0 }).kind,
    "empty"
  );
});

test("rows win over an empty state and nothing else", () => {
  assert.equal(
    adminAlertsDrawerView({ loading: false, failure: null, rowCount: 3 }).kind,
    "rows"
  );
  // Loading outranks everything: a stale list must not be presented as current
  // while a newer read is in flight.
  assert.equal(
    adminAlertsDrawerView({ loading: true, failure: null, rowCount: 3 }).kind,
    "loading"
  );
  assert.equal(
    adminAlertsDrawerView({
      loading: true,
      failure: { reason: "network" },
      rowCount: 0,
    }).kind,
    "loading"
  );
});

test("reopening the drawer after a failure reads again", () => {
  // The old guard was `rows.length > 0 || loading`. After a failure the list is
  // still empty, so it returned every time and the drawer stayed stuck on the
  // first error until a full page load.
  assert.equal(
    adminAlertsShouldFetch({
      loading: false,
      failure: { reason: "status", status: 500 },
      rowCount: 0,
    }),
    true
  );
});

test("a drawer holding rows does not re-read on every open", () => {
  assert.equal(
    adminAlertsShouldFetch({ loading: false, failure: null, rowCount: 2 }),
    false
  );
  assert.equal(
    adminAlertsShouldFetch({ loading: true, failure: null, rowCount: 0 }),
    false
  );
  // An empty-but-clean read is worth retrying on reopen: it is cheap, and the
  // records it looks for arrive without the browser being told.
  assert.equal(
    adminAlertsShouldFetch({ loading: false, failure: null, rowCount: 0 }),
    true
  );
});

test("a failure that has been re-read replaces the error rather than stacking", () => {
  // Once rows come back the drawer is showing an answer, not an error.
  assert.equal(
    adminAlertsDrawerView({ loading: false, failure: null, rowCount: 1 }).kind,
    "rows"
  );
});
