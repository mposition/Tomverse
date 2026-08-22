import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DELIVERY_PAGE_SIZE,
  DELIVERY_PAGE_SIZE_MAX,
  UNDELIVERED_STATUSES,
  isDefaultDeliveryFilter,
  parseDeliveryFilters,
  suppressionRemovalProblem,
} from "../lib/adminEmailDeliveryFilters.ts";

// What the delivery history may be asked, and what it will never answer.
// Contract: docs/policy/email-notifications.md §9.5, §13.7.

test("an empty query opens on the messages that did not arrive", () => {
  // A history screen opened to everything opens on whatever was sent in the
  // last minute, which is never the question somebody brings to it.
  const filters = parseDeliveryFilters({});
  assert.deepEqual(filters.statuses, [...UNDELIVERED_STATUSES]);
  assert.equal(filters.limit, DELIVERY_PAGE_SIZE);
  assert.equal(isDefaultDeliveryFilter(filters), true);
});

test("an unknown status is dropped, not answered with an error", () => {
  // This parses hand-edited URLs and bookmarks that outlived a status name.
  // What it must never do is pass the unrecognised value into a query.
  const filters = parseDeliveryFilters({ status: "abandoned,teleported" });
  assert.deepEqual(filters.statuses, ["abandoned"]);

  // Every value unknown falls back to the default rather than to "no filter",
  // which would be a silent request for the whole table.
  assert.deepEqual(parseDeliveryFilters({ status: "teleported" }).statuses, [
    ...UNDELIVERED_STATUSES,
  ]);
});

test("the address filter is exact, or it is nothing", () => {
  // A substring search over every address we have ever mailed is a different
  // feature with a different justification -- it is the one that turns a
  // support lookup into a way to enumerate users.
  assert.equal(
    parseDeliveryFilters({ address: "  Someone@Example.COM " }).emailAddress,
    "someone@example.com"
  );
  for (const address of ["example.com", "someone", "%", ""]) {
    assert.equal(
      parseDeliveryFilters({ address }).emailAddress,
      null,
      `"${address}" was accepted as an address`
    );
  }
});

test("a page size cannot be talked upward without limit", () => {
  assert.equal(parseDeliveryFilters({ limit: "10000" }).limit, DELIVERY_PAGE_SIZE_MAX);
  assert.equal(parseDeliveryFilters({ limit: "0" }).limit, 1);
  assert.equal(parseDeliveryFilters({ limit: "-5" }).limit, 1);
  assert.equal(parseDeliveryFilters({ limit: "banana" }).limit, DELIVERY_PAGE_SIZE);
});

test("an unparseable date is no filter rather than 1970", () => {
  // `new Date("last tuesday")` is Invalid Date, and a comparison against it
  // matches nothing -- an empty table that looks like an answer.
  assert.equal(parseDeliveryFilters({ since: "last tuesday" }).since, null);
  assert.equal(
    parseDeliveryFilters({ since: "2026-08-01T00:00:00Z" }).since?.toISOString(),
    "2026-08-01T00:00:00.000Z"
  );
});

// ---------------------------------------------------------------------------
// The reason a suppression was lifted (§13.7)
// ---------------------------------------------------------------------------

test("a lift needs a reason that says something", () => {
  // §13.7 requires a reason on removal and not on addition. Adding one stops
  // mail; removing one starts mail to an address that a provider, or the
  // person, previously said to stop mailing -- and this string is the only
  // record of why we overrode that.
  assert.equal(suppressionRemovalProblem("short"), "reason_too_short");
  assert.equal(suppressionRemovalProblem("x".repeat(600)), "reason_too_long");

  // A required field answered with "test" is a required field that has been
  // defeated. Checked before the length rule: most non-answers are short, and
  // answering them with "too short" teaches the writer to pad rather than to
  // explain.
  for (const boilerplate of [
    "test",
    "  N/A ",
    "none",
    "OK.",
    "cleanup",
    "No reason given.",
    "please remove",
    "As discussed",
    "customer asked",
  ]) {
    assert.equal(
      suppressionRemovalProblem(boilerplate),
      "reason_is_boilerplate",
      `"${boilerplate}" was accepted as a reason`
    );
  }

  // Short and meaningless are different verdicts, and the message differs.
  assert.equal(suppressionRemovalProblem("wrong"), "reason_too_short");

  assert.equal(
    suppressionRemovalProblem(
      "Address owner confirmed the bounce was their mail server outage, ticket SUP-4120."
    ),
    null
  );
  // A real reason that happens to contain a listed word is fine: the list
  // matches whole answers, not substrings.
  assert.equal(
    suppressionRemovalProblem("Bounced from our own test account during staging."),
    null
  );
});
